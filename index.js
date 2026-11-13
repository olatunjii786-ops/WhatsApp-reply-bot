// language: JavaScript, file: index.js, target: Node.js (Render Web Service)
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';
import http from 'http';
import sharp from 'sharp';
import ytdl from 'ytdl-core';

// --- CONFIGURATION ---
const PHONE_NUMBER = "2349014094846"; 
const MY_JID = "2349014094846@s.whatsapp.net"; 
const AUTH_FOLDER = fs.existsSync('/var/data') ? '/var/data/auth_info_baileys' : './auth_info_baileys';
const CONFIG_FILE = fs.existsSync('/var/data') ? '/var/data/bot_config.json' : './bot_config.json';
const COOLDOWN_FILE = fs.existsSync('/var/data') ? '/var/data/cooldowns.json' : './cooldowns.json';

// --- DUMMY WEB SERVER (Keeps Render Free Tier Happy) ---
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('CinderBot Secretary is running.\n');
}).listen(PORT, () => console.log(`Web server listening on port ${PORT}`));

// --- STATE MANAGEMENT ---
if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ awayMode: false, awayMessage: "I'm currently offline. I'll reply later." }));
}
const getConfig = () => JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
const saveConfig = (config) => fs.writeFileSync(CONFIG_FILE, JSON.stringify(config));

if (!fs.existsSync(COOLDOWN_FILE)) {
    fs.writeFileSync(COOLDOWN_FILE, JSON.stringify({}));
}
const getCooldowns = () => JSON.parse(fs.readFileSync(COOLDOWN_FILE, 'utf8'));
const saveCooldowns = (data) => fs.writeFileSync(COOLDOWN_FILE, JSON.stringify(data));


async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        printQRInTerminal: false,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ["Ubuntu", "Chrome", "20.0.04"]
    });

    // Pairing Code
    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(PHONE_NUMBER);
                console.log(`\n===========================================`);
                console.log(`YOUR PAIRING CODE: ${code}`);
                console.log(`Go to WhatsApp -> Linked Devices -> Link with Phone Number`);
                console.log(`===========================================\n`);
            } catch (err) { console.log("Pairing error:", err); }
        }, 3000);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            if (lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut) connectToWhatsApp();
        } else if (connection === 'open') {
            console.log('✅ Bot is successfully connected to WhatsApp!');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message) return;
        if (msg.key.remoteJid === 'status@broadcast') return;
        if (msg.key.remoteJid.endsWith('@g.us')) return; // DEAF TO GROUPS

        const sender = msg.key.remoteJid;
        const text = msg.message.conversation || 
                     msg.message.extendedTextMessage?.text || 
                     msg.message.imageMessage?.caption || "";
        const isMe = msg.key.fromMe || sender === MY_JID;

        // ==========================================
        // PART 1: YOUR PERSONAL COMMANDS
        // ==========================================
        if (isMe) {
            if (text.includes('[CinderBot]')) return; // Ignore bot's own replies
            if (!text.startsWith('.')) return; // Ignore normal messages you send to yourself

            const config = await getConfig();

            // 2-second delay to prevent WhatsApp rate limiting
            await new Promise(r => setTimeout(r, 2000));

            if (text === '.ping') return await sock.sendMessage(MY_JID, { text: '🏓 Pong! [CinderBot]' });
            if (text === '.away on') { config.awayMode = true; saveConfig(config); return await sock.sendMessage(MY_JID, { text: '✅ Away mode ON. [CinderBot]' }); }
            if (text === '.away off') { config.awayMode = false; saveConfig(config); return await sock.sendMessage(MY_JID, { text: '✅ Away mode OFF. [CinderBot]' }); }
            if (text.startsWith('.setaway ')) { config.awayMessage = text.slice(9); saveConfig(config); return await sock.sendMessage(MY_JID, { text: `✅ Away message updated. [CinderBot]` }); }

            // Sticker Maker
            if (msg.message.imageMessage) {
                await sock.sendMessage(MY_JID, { text: '⏳ Converting image... [CinderBot]' });
                try {
                    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                    const stickerBuffer = await sharp(buffer).resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).webp().toBuffer();
                    await sock.sendMessage(MY_JID, { sticker: stickerBuffer });
                } catch (e) { await sock.sendMessage(MY_JID, { text: '❌ Failed to create sticker. [CinderBot]' }); }
                return;
            }

            // YouTube Downloader
            if (text.startsWith('https://www.youtube.com/') || text.startsWith('https://youtu.be/')) {
                await sock.sendMessage(MY_JID, { text: '⏳ Downloading video... [CinderBot]' });
                try {
                    const info = await ytdl.getInfo(text);
                    const format = ytdl.chooseFormat(info.formats, { quality: 'lowest', filter: 'audioandvideo' });
                    if (format && format.contentLength < 16 * 1024 * 1024) {
                        const stream = ytdl(text, { format });
                        const chunks = [];
                        for await (const chunk of stream) { chunks.push(chunk); }
                        const buffer = Buffer.concat(chunks);
                        await sock.sendMessage(MY_JID, { video: buffer, caption: `🎥 ${info.videoDetails.title} [CinderBot]` });
                    } else {
                        await sock.sendMessage(MY_JID, { text: '❌ Video too large (Max 16MB). [CinderBot]' });
                    }
                } catch (e) { await sock.sendMessage(MY_JID, { text: '❌ Download failed. YouTube might be blocking the server. [CinderBot]' }); }
                return;
            }
        }

        // ==========================================
        // PART 2: REPLYING TO OTHERS (THE SECRETARY)
        // ==========================================
        if (!isMe) {
            const config = await getConfig();
            
            if (!config.awayMode) return;

            // Check the 24-Hour Cooldown
            const cooldowns = getCooldowns();
            const now = Date.now();
            const lastReplied = cooldowns[sender] || 0;
            const twentyFourHours = 24 * 60 * 60 * 1000;

            if (now - lastReplied < twentyFourHours) {
                console.log(`Ignored ${sender} - in 24hr cooldown.`);
                return;
            }

            try {
                await sock.sendMessage(sender, { text: config.awayMessage });
                console.log(`Auto-replied to ${sender}.`);
                
                cooldowns[sender] = now;
                saveCooldowns(cooldowns);
            } catch (e) {
                console.log("Failed to send auto-reply:", e);
            }
        }
    });
}

connectToWhatsApp();
