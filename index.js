// language: JavaScript, file: index.js, target: Node.js (Render Web Service)
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';
import http from 'http';
import sharp from 'sharp';
import ytdl from 'ytdl-core';

// --- CONFIGURATION ---
const PHONE_NUMBER = "2349014094846"; 
const AUTH_FOLDER = fs.existsSync('/var/data') ? '/var/data/auth_info_baileys' : './auth_info_baileys';
const CONFIG_FILE = fs.existsSync('/var/data') ? '/var/data/bot_config.json' : './bot_config.json';

// --- DUMMY WEB SERVER ---
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running.\n');
}).listen(PORT, () => console.log(`Web server on port ${PORT}`));

// Default Config
if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ awayMode: false, awayMessage: "I'm currently offline. I'll reply later." }));
}

async function getConfig() {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

async function saveConfig(config) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config));
}

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
            console.log('✅ Bot connected to WhatsApp!');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message) return;
        if (msg.key.remoteJid === 'status@broadcast') return; // Ignore status updates

        const sender = msg.key.remoteJid;
        // Extract text safely
        const text = msg.message.conversation || 
                     msg.message.extendedTextMessage?.text || 
                     msg.message.imageMessage?.caption || "";

        // LOOP PREVENTER: If the message starts with a secret bot tag, ignore it
        if (text.includes('[CinderBot]')) return; 

        const config = await getConfig();

        // --- COMMANDS ---
        if (text === '.ping') {
            return await sock.sendMessage(sender, { text: '🏓 Pong! [CinderBot]' });
        }

        if (text === '.away on') {
            config.awayMode = true;
            await saveConfig(config);
            return await sock.sendMessage(sender, { text: '✅ Away mode ON. [CinderBot]' });
        }

        if (text === '.away off') {
            config.awayMode = false;
            await saveConfig(config);
            return await sock.sendMessage(sender, { text: '✅ Away mode OFF. [CinderBot]' });
        }

        if (text.startsWith('.setaway ')) {
            config.awayMessage = text.slice(9);
            await saveConfig(config);
            return await sock.sendMessage(sender, { text: `✅ Away message updated. [CinderBot]` });
        }

        // --- AUTO-RESPONDER ---
        if (config.awayMode && !text.startsWith('.')) {
            // Append the bot tag to prevent an infinite loop
            await sock.sendMessage(sender, { text: config.awayMessage + " [CinderBot]" });
            return;
        }

        // --- STICKER MAKER ---
        if (msg.message.imageMessage) {
            await sock.sendMessage(sender, { text: '⏳ Converting... [CinderBot]' });
            try {
                const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                const stickerBuffer = await sharp(buffer)
                    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                    .webp()
                    .toBuffer();
                await sock.sendMessage(sender, { sticker: stickerBuffer });
            } catch (e) {
                await sock.sendMessage(sender, { text: '❌ Failed to create sticker. [CinderBot]' });
            }
            return;
        }

        // --- MEDIA SCRAPER (YouTube) ---
        if (text.startsWith('https://www.youtube.com/') || text.startsWith('https://youtu.be/')) {
            await sock.sendMessage(sender, { text: '⏳ Downloading... [CinderBot]' });
            try {
                const info = await ytdl.getInfo(text);
                const format = ytdl.chooseFormat(info.formats, { quality: 'lowest', filter: 'audioandvideo' });
                
                if (format && format.contentLength < 16 * 1024 * 1024) {
                    const stream = ytdl(text, { format });
                    const chunks = [];
                    for await (const chunk of stream) { chunks.push(chunk); }
                    const buffer = Buffer.concat(chunks);
                    
                    await sock.sendMessage(sender, { video: buffer, caption: `🎥 ${info.videoDetails.title} [CinderBot]` });
                } else {
                    await sock.sendMessage(sender, { text: '❌ Video too large (Max 16MB). [CinderBot]' });
                }
            } catch (e) {
                await sock.sendMessage(sender, { text: '❌ Download failed. YouTube might be blocking the server. [CinderBot]' });
            }
            return;
        }

        if (text.startsWith('.')) {
            await sock.sendMessage(sender, { text: '❓ Unknown command. [CinderBot]' });
        }
    });
}

connectToWhatsApp();
