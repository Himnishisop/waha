const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const express = require('express');
const { GoogleGenAI } = require('@google/genai');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// 1. Express Server (Live QR code visualizer + Render keep-alive port)
const app = express();
const PORT = process.env.PORT || 8000;
let latestQR = "";
let isConnected = false;

app.get('/', (req, res) => {
    if (isConnected) {
        return res.send('<h2>🚀 Drake BOMBEAT WhatsApp Bot is Online & Connected to Supabase!</h2>');
    }
    if (!latestQR) {
        return res.send('<h2>⏳ Generating QR code... Refresh in 3 seconds.</h2><script>setTimeout(()=>location.reload(), 3000)</script>');
    }
    const qrImgUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(latestQR)}`;
    res.send(`
        <div style="font-family:sans-serif;text-align:center;margin-top:50px;">
            <h2>📱 Scan with WhatsApp (Linked Devices)</h2>
            <img src="${qrImgUrl}" style="border:10px solid #fff;box-shadow:0 0 15px rgba(0,0,0,0.2);" />
            <p>Page auto-refreshes every 15 seconds.</p>
            <script>setTimeout(()=>location.reload(), 15000)</script>
        </div>
    `);
});

app.listen(PORT, '0.0.0.0', () => console.log(`🌐 Server listening on port ${PORT}`));

// 2. Initialize Gemini & Supabase
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const OWNER_PHONE = '9372486797';

// --- DATABASE HELPERS (Business Instructions Table) ---
async function getBusinessMemory() {
    try {
        const { data, error } = await supabase
            .from('business_instructions')
            .select('data')
            .eq('id', 'main')
            .single();

        if (error || !data) {
            return { business_name: "BOMBEAT", location: "Mumbai (Naigaon)", owner_instructions: [] };
        }
        return data.data;
    } catch (e) {
        console.error("Error fetching business_instructions:", e.message);
        return { business_name: "BOMBEAT", location: "Mumbai (Naigaon)", owner_instructions: [] };
    }
}

async function saveBusinessMemory(jsonPayload) {
    try {
        const { error } = await supabase
            .from('business_instructions')
            .upsert({ id: 'main', data: jsonPayload });
        if (error) console.error("Error saving business_instructions:", error.message);
        else console.log("💾 [SUCCESS] business_instructions updated in Supabase!");
    } catch (e) {
        console.error("Exception saving business_instructions:", e.message);
    }
}

// --- DATABASE HELPERS (WhatsApp Memory Table) ---
async function getChatHistory(phone) {
    try {
        const { data, error } = await supabase
            .from('WhatsApp_memory')
            .select('chat_history')
            .eq('phone_number', phone)
            .single();
        if (error || !data) return [];
        return data.chat_history;
    } catch (e) {
        return [];
    }
}

async function saveChatHistory(phone, history) {
    try {
        await supabase
            .from('WhatsApp_memory')
            .upsert({ phone_number: phone, chat_history: history });
    } catch (e) {
        console.error("Error saving WhatsApp_memory:", e.message);
    }
}

// --- LIGHTWEIGHT WHATSAPP SOCKET CONNECTION ---
async function startDrake() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'),
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            latestQR = qr;
            isConnected = false;
            console.log('📱 New QR generated! Open your Render URL to scan it.');
        }
        if (connection === 'close') {
            isConnected = false;
            const statusCode = (lastDisconnect?.error instanceof Boom)
                ? lastDisconnect.error.output.statusCode
                : 0;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startDrake();
        } else if (connection === 'open') {
            latestQR = "";
            isConnected = true;
            console.log('🚀 Drake BOMBEAT WhatsApp Bot is online and connected!');
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

            console.log(`📩 Incoming | Name: ${senderName} | Phone: ${senderPhone} | Msg: ${messageText}`);

            let businessMemory = await getBusinessMemory();
            if (!businessMemory.owner_instructions) businessMemory.owner_instructions = [];

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

                console.log("👑 OWNER TRAINING MODE TRIGGERED! Saving to business_instructions...");
                businessMemory.owner_instructions.push(instruction);
                await saveBusinessMemory(businessMemory);

                const ownerPrompt = `
                You are Drake, Himnish's personal AI assistant and the business brain behind BOMBEAT. 
                Himnish (your owner) just trained you with this business rule: "${instruction}"
                Acknowledge him concisely, confirm it's saved permanently to Supabase (table 'business_instructions'), and state the total rule count (${businessMemory.owner_instructions.length}).
                `;

                try {
                    const response = await ai.models.generateContent({
                        model: 'gemini-3.5-flash-lite',
                        contents: ownerPrompt,
                    });
                    await sock.sendMessage(remoteJid, { text: response.text.trim() }, { quoted: msg });
                } catch (e) {
                    await sock.sendMessage(remoteJid, { text: `Boss, saved to business_instructions! (${businessMemory.owner_instructions.length} rules total)` }, { quoted: msg });
                }
                continue;
            }

            // ==================== CUSTOMER CHAT & MEMORY EXTRACTION ====================
            let userHistory = await getChatHistory(senderPhone);
            const learnedGuidelines = businessMemory.owner_instructions.map(rule => `- ${rule}`).join('\n');

            const SYSTEM_PROMPT = `
            You are Drake, the AI assistant for BOMBEAT, a live music entertainment and event coordination business based in Mumbai (Naigaon).
            Your job is to handle customer inquiries on WhatsApp professionally, pitch performers, and close bookings based *strictly* on the rules and pricing Himnish has taught you below.

            BUSINESS IDENTITY:
            - Business Name: BOMBEAT
            - Location: Mumbai (Naigaon)

            BUSINESS INSTRUCTIONS & POLICIES:
            ${learnedGuidelines || "No specific business instructions taught yet."}

            Tone: Friendly, helpful, and natural. Adhere strictly to Himnish's directives above.
            `;

            const transcript = userHistory.slice(-6).map(m => `${m.role}: ${m.content}`).join('\n');
            const prompt = `${SYSTEM_PROMPT}\n\nConversation History:\n${transcript}\nuser: ${messageText}\nassistant:`;

            try {
                const response = await ai.models.generateContent({
                    model: 'gemini-3.5-flash-lite',
                    contents: prompt,
                });
                const replyText = response.text.trim();

                // Save turn to WhatsApp_memory table
                userHistory.push({ role: 'user', content: messageText, timestamp: new Date().toISOString() });
                userHistory.push({ role: 'assistant', content: replyText, timestamp: new Date().toISOString() });
                await saveChatHistory(senderPhone, userHistory);

                // Auto-learn business feedback if customer talks about pricing or booking terms
                if (messageText.toLowerCase().includes("budget") || messageText.toLowerCase().includes("price") || messageText.toLowerCase().includes("book")) {
                    try {
                        const reflectionPrompt = `Analyze this customer interaction and extract any implicit business lesson or pricing feedback learned: "Client: ${messageText} | Bot: ${replyText}". If a clear rule was demonstrated, state it in 1 short sentence. If none, reply "NONE".`;
                        const refRes = await ai.models.generateContent({ model: 'gemini-3.5-flash-lite', contents: reflectionPrompt });
                        const lesson = refRes.text.trim();
                        if (lesson && lesson !== "NONE" && !businessMemory.owner_instructions.includes(lesson)) {
                            businessMemory.owner_instructions.push(`Auto-learned from chat (${senderPhone}): ${lesson}`);
                            await saveBusinessMemory(businessMemory);
                        }
                    } catch (err) {
                        // Silent catch for background reflection
                    }
                }

                await sock.sendMessage(remoteJid, { text: replyText }, { quoted: msg });
            } catch (e) {
                console.error("Gemini Error:", e);
                await sock.sendMessage(remoteJid, { text: "Sorry, I'm having a brief technical hiccup. I'll get back to you shortly!" }, { quoted: msg });
            }
        }
    });
}

startDrake();
