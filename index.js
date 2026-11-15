const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const express = require('express');
const { GoogleGenAI } = require('@google/genai');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// 1. Dummy Web Server to satisfy Render's open port requirement
const app = express();
const PORT = process.env.PORT || 8000;
app.get('/', (req, res) => res.send('🚀 Drake WhatsApp Bot is Online!'));
app.listen(PORT, '0.0.0.0', () => console.log(`🌐 Health server listening on port ${PORT}`));

// 2. Initialize Gemini & Supabase
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const OWNER_PHONE = '9372486797';

// --- SUPABASE STORAGE HELPERS ---
async function getMemoryData() {
    try {
        const { data, error } = await supabase
            .from('drake_commands')
            .select('data')
            .eq('id', 'main')
            .single();

        if (error || !data) {
            return { business_name: "BOMBEAT", location: "Mumbai (Naigaon)", owner_instructions: [] };
        }
        return data.data;
    } catch (e) {
        console.error("Error fetching memory from Supabase:", e.message);
        return { business_name: "BOMBEAT", location: "Mumbai (Naigaon)", owner_instructions: [] };
    }
}

async function saveMemoryData(jsonPayload) {
    try {
        const { error } = await supabase
            .from('drake_commands')
            .upsert({ id: 'main', data: jsonPayload });

        if (error) console.error("Error saving to Supabase:", error.message);
        else console.log("💾 [SUCCESS] Memory synced to Supabase table 'drake_commands'!");
    } catch (e) {
        console.error("Exception saving memory:", e.message);
    }
}

// --- LIGHTWEIGHT WHATSAPP SOCKET CONNECTION ---
async function startDrake() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false // We handle QR printing cleanly below
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('📱 Scan this QR code with your WhatsApp:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom)
                ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
                : true;
            console.log('⚠️ Connection closed. Reconnecting:', shouldReconnect);
            if (shouldReconnect) startDrake();
        } else if (connection === 'open') {
            console.log('🚀 Drake Supabase-Backed WhatsApp Bot is online and connected!');
        }
    });

    // --- MESSAGE HANDLING LOOP ---
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;

            const remoteJid = msg.key.remoteJid;
            if (remoteJid.includes('status@broadcast') || remoteJid.includes('@g.us')) continue;

            const senderPhone = remoteJid.split('@')[0];
            const senderName = msg.pushName || "Client";
            const messageText = msg.message.conversation || msg.message.extendedTextMessage?.text || "";

            if (!messageText) continue;

            console.log(`📩 Incoming | Name: ${senderName} | ID/Phone: ${senderPhone} | Msg: ${messageText}`);

            let memory = await getMemoryData();
            if (!memory.owner_instructions) memory.owner_instructions = [];

            const isOwner = (
                senderPhone.includes(OWNER_PHONE) ||
                senderName.toLowerCase().includes('himnish') ||
                messageText.trim().startsWith('!train')
            );

            // ==================== OWNER TRAINING MODE ====================
            if (isOwner) {
                let instruction = messageText.trim();
                if (instruction.startsWith('!train')) {
                    instruction = instruction.replace('!train', '').trim();
                }

                console.log("👑 OWNER TRAINING MODE TRIGGERED! Saving to Supabase...");
                memory.owner_instructions.push(instruction);
                await saveMemoryData(memory);

                const ownerPrompt = `
                You are Drake, Himnish's personal AI assistant and the brain behind BOMBEAT. 
                Himnish (your owner) just taught you this rule: "${instruction}"
                Acknowledge him concisely, confirm it's saved permanently to Supabase (table 'drake_commands'), and state the total rule count (${memory.owner_instructions.length}).
                `;

                try {
                    const response = await ai.models.generateContent({
                        model: 'gemini-3.5-flash-lite',
                        contents: ownerPrompt,
                    });
                    await sock.sendMessage(remoteJid, { text: response.text.trim() }, { quoted: msg });
                } catch (e) {
                    await sock.sendMessage(remoteJid, { text: `Boss, saved to Supabase! (${memory.owner_instructions.length} rules total)` }, { quoted: msg });
                }
                continue;
            }

            // ==================== CUSTOMER CHAT ====================
            const learnedGuidelines = memory.owner_instructions.map(rule => `- ${rule}`).join('\n');

            const SYSTEM_PROMPT = `
            You are Drake, the AI assistant for BOMBEAT, a live music entertainment and event coordination business based in Mumbai (Naigaon).
            Your job is to handle customer inquiries on WhatsApp professionally, pitch performers, and close bookings based *strictly* on the rules and pricing Himnish has taught you below.

            BUSINESS IDENTITY:
            - Business Name: BOMBEAT
            - Location: Mumbai (Naigaon)

            RULES & POLICIES TAUGHT BY HIMNISH:
            ${learnedGuidelines || "No specific rules taught yet."}

            Tone: Friendly, helpful, and natural. Adhere strictly to Himnish's directives above.
            `;

            const prompt = `${SYSTEM_PROMPT}\n\nClient Name: ${senderName}\nuser: ${messageText}\nassistant:`;

            try {
                const response = await ai.models.generateContent({
                    model: 'gemini-3.5-flash-lite',
                    contents: prompt,
                });
                await sock.sendMessage(remoteJid, { text: response.text.trim() }, { quoted: msg });
            } catch (e) {
                console.error("Gemini Error:", e);
                await sock.sendMessage(remoteJid, { text: "Sorry, I'm having a brief technical hiccup. I'll get back to you shortly!" }, { quoted: msg });
            }
        }
    });
}

startDrake();
