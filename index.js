const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const express = require('express');
const { GoogleGenAI } = require('@google/genai');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// 1. Express Server (Live QR + UptimeRobot 24/7 Keep-Alive)
const app = express();
const PORT = process.env.PORT || 8000;
let latestQR = "";
let isConnected = false;

app.get('/', (req, res) => {
    if (isConnected) {
        return res.send('<h2>🚀 Drake Analyst & Unified Bot is Online 24/7!</h2>');
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

// Track mode per owner session (Default: Personal mode)
const ownerModes = new Map(); // phone -> 'personal' | 'business'

// --- DATABASE HELPERS ---
async function getPersonalMemory() {
    try {
        const { data, error } = await supabase
            .from('drake_memory')
            .select('data')
            .eq('id', 'main')
            .single();

        if (error || !data) {
            return { owner_name: "Himnish", core_memories: [] };
        }
        return data.data;
    } catch (e) {
        return { owner_name: "Himnish", core_memories: [] };
    }
}

async function savePersonalMemory(jsonPayload) {
    try {
        await supabase
            .from('drake_memory')
            .upsert({ id: 'main', data: jsonPayload });
        console.log("💾 [SUCCESS] drake_memory updated in Supabase!");
    } catch (e) {
        console.error("Error saving drake_memory:", e.message);
    }
}

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
        return { business_name: "BOMBEAT", location: "Mumbai (Naigaon)", owner_instructions: [] };
    }
}

async function saveBusinessMemory(jsonPayload) {
    try {
        await supabase
            .from('business_instructions')
            .upsert({ id: 'main', data: jsonPayload });
        console.log("💾 [SUCCESS] business_instructions updated in Supabase!");
    } catch (e) {
        console.error("Error saving business_instructions:", e.message);
    }
}

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
            .upsert({ 
                phone_number: phone, 
                chat_history: history,
                updated_at: new Date().toISOString()
            });
    } catch (e) {
        console.error("Error saving WhatsApp_memory:", e.message);
    }
}

// Fetch ALL chats across the database for Analyst Mode
async function getAllWhatsAppChats() {
    try {
        const { data, error } = await supabase
            .from('WhatsApp_memory')
            .select('phone_number, chat_history, updated_at');
        if (error || !data) return [];
        return data;
    } catch (e) {
        console.error("Error fetching all WhatsApp chats:", e.message);
        return [];
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
            console.log('🚀 Drake Analyst & Unified Bot is online and connected!');
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

            const isOwner = (
                senderPhone.includes(OWNER_PHONE) ||
                senderName.toLowerCase().includes('himnish')
            );

            if (isOwner && !ownerModes.has(senderPhone)) {
                ownerModes.set(senderPhone, 'personal');
            }

            // ==================== OWNER COMMANDS (MODE SWITCHING) ====================
            if (isOwner) {
                const lowerMsg = messageText.trim().toLowerCase();

                if (lowerMsg.includes('activate business mode')) {
                    ownerModes.set(senderPhone, 'business');
                    await sock.sendMessage(remoteJid, { text: "💼 Business Mode Activated. Drop new rules, pricing, or workflows and I'll lock them into `business_instructions`." }, { quoted: msg });
                    continue;
                }

                if (lowerMsg.includes('deactivate business mode')) {
                    ownerModes.set(senderPhone, 'personal');
                    await sock.sendMessage(remoteJid, { text: "👤 Personal Mode Activated. Ask me for today's chat audit, lead breakdown, or drop things for me to remember." }, { quoted: msg });
                    continue;
                }
            }

            // Fetch Memories
            let personalMemory = await getPersonalMemory();
            let businessMemory = await getBusinessMemory();
            let userHistory = await getChatHistory(senderPhone);

            // ==================== OWNER CHAT (PERSONAL / ANALYST / BUSINESS) ====================
            if (isOwner) {
                const currentMode = ownerModes.get(senderPhone) || 'personal';

                if (currentMode === 'business') {
                    // Business Mode Training (Also shares opinion on the rule!)
                    let instruction = messageText.trim();
                    if (instruction.startsWith('!train')) instruction = instruction.replace('!train', '').trim();
                    if (!businessMemory.owner_instructions) businessMemory.owner_instructions = [];
                    businessMemory.owner_instructions.push(instruction);
                    await saveBusinessMemory(businessMemory);

                    const bizPrompt = `You are Drake, Himnish's co-founder/AI brain for BOMBEAT. Himnish just added this business rule: "${instruction}". 
                    Confirm it's saved to 'business_instructions' (${businessMemory.owner_instructions.length} total) and give a quick, honest, sharp opinion on whether this rule helps close Mumbai live music clients or if there's any catch.`;

                    try {
                        const res = await ai.models.generateContent({ model: 'gemini-3.5-flash-lite', contents: bizPrompt });
                        await sock.sendMessage(remoteJid, { text: res.text.trim() }, { quoted: msg });
                    } catch (e) {
                        await sock.sendMessage(remoteJid, { text: `👑 [Business] Saved rule! (${businessMemory.owner_instructions.length} total)` }, { quoted: msg });
                    }
                    continue;
                } else {
                    // PERSONAL MODE: Memory Saving + Full Business & Chat Analyst
                    let replyText = "";
                    const lowerMsg = messageText.toLowerCase();

                    // Check if owner wants to save a personal memory
                    if (lowerMsg.includes('remember') || lowerMsg.includes('note this') || lowerMsg.includes('save this')) {
                        if (!personalMemory.core_memories) personalMemory.core_memories = [];
                        personalMemory.core_memories.push({
                            memory: messageText,
                            timestamp: new Date().toISOString()
                        });
                        await savePersonalMemory(personalMemory);
                        replyText = "Locked into `drake_memory` permanently, Boss. 🧠";
                    } else {
                        // Fetch ALL WhatsApp chats (excluding owner's own number) so Drake can act as a full analyst
                        const allChats = await getAllWhatsAppChats();
                        const clientChats = allChats.filter(c => !c.phone_number.includes(OWNER_PHONE));

                        // Format client logs cleanly with timestamps and names
                        const formattedLogs = clientChats.map(c => {
                            const msgs = (c.chat_history || []).map(m => `  [${m.timestamp}] ${m.role} (${m.sender || 'Client'}): ${m.content}`).join('\n');
                            return `--- Client Phone: ${c.phone_number} | Last Active: ${c.updated_at} ---\n${msgs}`;
                        }).join('\n\n');

                        const transcript = userHistory.slice(-10).map(m => `[${m.timestamp}] ${m.role}: ${m.content}`).join('\n');
                        const personalContext = JSON.stringify(personalMemory);
                        const currentISTTime = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

                        const analystPrompt = `
                        You are Drake, Himnish's personal AI assistant, right-hand strategist, and full data analyst.
                        Current Date & Time (IST): ${currentISTTime}
                        
                        Your Core Memory (drake_memory): ${personalContext}
                        
                        ALL CLIENT WHATSAPP CHATS IN DATABASE (WhatsApp_memory):
                        ${formattedLogs || "No client chats recorded in the database yet."}

                        YOUR CAPABILITIES & PERSONA:
                        1. **Full Chat Analyst:** If Himnish asks "what was up today", "how many chats happened", "who seems serious", "anything weird", or asks for an update/audit:
                           - Count the exact number of unique client chats (specifically check timestamps matching today's date in IST, as well as overall).
                           - Identify **Serious Leads** (clients asking about dates, budgets, venues, packages, singers/DJs) with their name & phone number.
                           - Flag **Weird / Time-wasters / Unclear chats** (spam, random texts, lowballers, or strange requests).
                           - Give your **Candid Opinion & Action Plan**: Explicitly tell Himnish who he should personally message/call right now to close the deal and why.
                        2. **Conversational Partner:** For normal personal chats, respond naturally with wit, candor, and full awareness of your recent conversation history below.

                        Recent Personal Conversation with Himnish:
                        ${transcript}

                        Himnish: ${messageText}
                        Drake:`;

                        const response = await ai.models.generateContent({
                            model: 'gemini-3.5-flash-lite',
                            contents: analystPrompt,
                        });
                        replyText = response.text.trim();
                    }

                    // Save owner's personal chat turn to WhatsApp_memory as well
                    userHistory.push({ role: 'user', sender: senderName, phone: senderPhone, content: messageText, timestamp: new Date().toISOString() });
                    userHistory.push({ role: 'assistant', sender: 'Drake', content: replyText, timestamp: new Date().toISOString() });
                    await saveChatHistory(senderPhone, userHistory);

                    await sock.sendMessage(remoteJid, { text: replyText }, { quoted: msg });
                    continue;
                }
            }

            // ==================== REGULAR CLIENT CHAT (BOMBEAT) ====================
            const learnedGuidelines = (businessMemory.owner_instructions || []).map(rule => `- ${rule}`).join('\n');
            const personalContext = JSON.stringify(personalMemory);

            const SYSTEM_PROMPT = `
            You are Drake, the AI assistant for BOMBEAT, a live music entertainment and event coordination business based in Mumbai (Naigaon).
            You know who you are talking to based on the WhatsApp history provided. 
            Personal background/identity (drake_memory): ${personalContext}

            BUSINESS INSTRUCTIONS & POLICIES:
            ${learnedGuidelines || "No specific business instructions taught yet."}

            Tone: Sharp, professional, helpful, and natural. Keep track of what the client said previously in the chat history.
            `;

            const transcript = userHistory.slice(-12).map(m => `[${m.timestamp}] ${m.role} (${m.sender || senderName}): ${m.content}`).join('\n');
            const prompt = `${SYSTEM_PROMPT}\n\nClient Name: ${senderName} (Phone: ${senderPhone})\nFull Chat History:\n${transcript}\nuser: ${messageText}\nassistant:`;

            try {
                const response = await ai.models.generateContent({
                    model: 'gemini-3.5-flash-lite',
                    contents: prompt,
                });
                const replyText = response.text.trim();

                // Save full turn with timestamp and sender metadata into WhatsApp_memory
                userHistory.push({ role: 'user', sender: senderName, phone: senderPhone, content: messageText, timestamp: new Date().toISOString() });
                userHistory.push({ role: 'assistant', sender: 'Drake', content: replyText, timestamp: new Date().toISOString() });
                await saveChatHistory(senderPhone, userHistory);

                await sock.sendMessage(remoteJid, { text: replyText }, { quoted: msg });
            } catch (e) {
                console.error("Gemini Error:", e);
                await sock.sendMessage(remoteJid, { text: "Sorry, having a brief technical hiccup. I'll get back to you shortly!" }, { quoted: msg });
            }
        }
    });
}

startDrake();
