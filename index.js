// language: JavaScript, file: index.js, target: Node.js (Render)
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';
import sharp from 'sharp';
import ytdl from 'ytdl-core';

// --- CONFIGURATION ---
const PHONE_NUMBER = "2349014094846"; // Your pairing number
const AUTH_FOLDER = './auth_info_baileys';
const CONFIG_FILE = './bot_config.json';

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

    // Pairing Code Logic
    if (!sock.authState.creds.registered) {
        console.log(`Requesting pairing code for ${PHONE_NUMBER}...`);
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(PHONE_NUMBER);
                console.log(`\n===========================================`);
                console.log(`YOUR PAIRING CODE: ${code}`);
                console.log(`Go to WhatsApp -> Linked Devices -> Link with Phone Number`);
                console.log(`===========================================\n`);
            } catch (err) {
                console.log("Error getting pairing code:", err);
            }
        }, 3000);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed. Reconnecting...', shouldReconnect);
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            console.log('✅ Bot is successfully connected to WhatsApp!');
        }
    });

    // --- MESSAGE HANDLER ---
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        const pushName = msg.pushName || "User";
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
        const config = await getConfig();

        // --- COMMANDS ---
        if (text === '.ping') {
            return await sock.sendMessage(sender, { text: '🏓 Pong!' });
        }

        if (text === '.away on') {
            config.awayMode = true;
            await saveConfig(config);
            return await sock.sendMessage(sender, { text: '✅ Away mode is now ON.' });
        }

        if (text === '.away off') {
            config.awayMode = false;
            await saveConfig(config);
            return await sock.sendMessage(sender, { text: '✅ Away mode is now OFF.' });
        }

        if (text.startsWith('.setaway ')) {
            config.awayMessage = text.slice(9);
            await saveConfig(config);
            return await sock.sendMessage(sender, { text: `✅ Away message updated: "${config.awayMessage}"` });
        }

        // --- FEATURE 2: AUTO-RESPONDER ---
        // If away mode is ON, and the message isn't a command, reply with the away message
        if (config.awayMode && !text.startsWith('.')) {
            await sock.sendMessage(sender, { text: config.awayMessage });
            return; // Stop processing so it doesn't trigger other features
        }

        // --- FEATURE 6: STICKER MAKER ---
        // If user sends an image (conversation is empty, but imageMessage exists)
        if (msg.message.imageMessage) {
            await sock.sendMessage(sender, { text: '⏳ Converting image to sticker...' });
            try {
                const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                
                // Resize and convert to webp using sharp
                const stickerBuffer = await sharp(buffer)
                    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                    .webp()
                    .toBuffer();

                await sock.sendMessage(sender, { sticker: stickerBuffer });
            } catch (e) {
                console.log("Sticker error:", e);
                await sock.sendMessage(sender, { text: '❌ Failed to create sticker.' });
            }
            return;
        }

        // --- FEATURE 3: MEDIA SCRAPER (YouTube) ---
        if (text.startsWith('https://www.youtube.com/') || text.startsWith('https://youtu.be/')) {
            await sock.sendMessage(sender, { text: '⏳ Downloading video from YouTube... (This may take a minute)' });
            try {
                const info = await ytdl.getInfo(text);
                const format = ytdl.chooseFormat(info.formats, { quality: 'lowest', filter: 'audioandvideo' });
                
                if (format && format.contentLength < 16 * 1024 * 1024) { // Check if under 16MB for WhatsApp limit
                    const stream = ytdl(text, { format });
                    const chunks = [];
                    for await (const chunk of stream) {
                        chunks.push(chunk);
                    }
                    const buffer = Buffer.concat(chunks);
                    
                    await sock.sendMessage(sender, { 
                        video: buffer, 
                        caption: `🎥 ${info.videoDetails.title}\n\nDownloaded by CinderBot` 
                    });
                } else {
                    await sock.sendMessage(sender, { text: '❌ Video is too large (WhatsApp limit is ~16MB). Try a shorter video.' });
                }
            } catch (e) {
                console.log("YouTube error:", e);
                await sock.sendMessage(sender, { text: '❌ Failed to download YouTube video.' });
            }
            return;
        }

        // Default fallback for unrecognized commands
        if (text.startsWith('.')) {
            await sock.sendMessage(sender, { text: '❓ Unknown command. Try .ping, .away on, .away off' });
        }
    });
}

connectToWhatsApp();
