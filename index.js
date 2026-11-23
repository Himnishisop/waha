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
        return res.send('<h2>🚀 Drake Fast Memory Bot is Online!</h2>');
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
const OWNER_JID = `91${OWNER_PHONE}@s.whatsapp.net`;

let currentOwnerMode = 'personal'; // 'personal' | 'business'
const botSentIds = new Set();

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
        return data.data || { owner_name: "Himnish", core_memories: [] };
    } catch (e) {
        return { owner_name: "Himnish", core_memories: [] };
    }
}

async function savePersonalMemory(jsonPayload) {
    try {
        const { error } = await supabase
            .from('drake_memory')
            .upsert({ id: 'main', data: jsonPayload }, { onConflict: 'id' });
        if (error) console.error("❌ Error saving drake_memory:", error.message);
        else console.log("💾 [SUCCESS] drake_memory updated!");
    } catch (e) {
        console.error("Exception saving drake_memory:", e.message);
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
            return { business_name: "BOMBEAT", location: "Mumbai", owner_instructions: [] };
        }
        return data.data || { business_name: "BOMBEAT", location: "Mumbai", owner_instructions: [] };
    } catch (e) {
        return { business_name: "BOMBEAT", location: "Mumbai", owner_instructions: [] };
    }
}

async function saveBusinessMemory(jsonPayload) {
    try {
        const { error } = await supabase
            .from('business_instructions')
            .upsert({ id: 'main', data: jsonPayload }, { onConflict: 'id' });
        if (error) {
            console.error("❌ Error saving business_instructions:", error.message);
            return false;
        }
        console.log("💾 [SUCCESS] business_instructions updated!");
        return true;
    } catch (e) {
        console.error("Exception saving business_instructions:", e.message);
        return false;
    }
}

// Fetch ONLY this number's row (last 10 chats + overall_info)
async function getNumberRecord(phone) {
    try {
        const { data, error } = await supabase
            .from('chats_history')
            .select('chat_history, overall_info, sender_name')
            .eq('phone_number', String(phone))
            .single();

        if (error || !data) {
            return { chat_history: [], overall_info: "" };
        }
        return {
            chat_history: Array.isArray(data.chat_history) ? data.chat_history.slice(-10) : [],
            overall_info: data.overall_info || ""
        };
    } catch (e) {
        return { chat_history: [], overall_info: "" };
    }
}

// Save ONLY this number's latest 10 messages + updated overall_info
async function saveNumberRecord(phone, senderName, history, overallInfo) {
    const trimmedHistory = (history || []).slice(-10);
    try {
        const { error } = await supabase
            .from('chats_history')
            .upsert({
                phone_number: String(phone),
                sender_name: senderName,
                chat_history: trimmedHistory,
                overall_info: overallInfo || "",
                updated_at: new Date().toISOString()
            }, { onConflict: 'phone_number' });

        if (error) {
            console.error("❌ SUPABASE WRITE ERROR (chats_history):", error.message);
        } else {
            console.log(`💾 [SUCCESS] Saved top-10 history & overall_info for ${senderName} (${phone})`);
        }
    } catch (e) {
        console.error("Exception saving chats_history:", e.message);
    }
}

// Only called when owner explicitly asks for analysis / cross-chat lookup
async function getAllChatsForAnalysis() {
    try {
        const { data, error } = await supabase
            .from('chats_history')
            .select('phone_number, sender_name, chat_history, overall_info, updated_at');
        if (error || !data) return [];
        return data;
    } catch (e) {
        console.error("Error fetching chats for analysis:", e.message);
        return [];
    }
}

// Update overall_info cleanly for any number (client or owner)
async function refreshOverallInfo(existingOverallInfo, senderName, isOwnerChat, latestUserMsg, latestBotReply, extraNote = "") {
    const prompt = `
You maintain a concise, high-signal "overall_info" profile for a WhatsApp contact in Supabase.
Contact: ${senderName} (${isOwnerChat ? "Owner - Himnish" : "Client/Lead"})
Current overall_info: ${existingOverallInfo || "None yet"}
Latest message from contact: "${latestUserMsg}"
Latest reply from Drake: "${latestBotReply}"
${extraNote ? `Extra note: ${extraNote}` : ""}

Update overall_info into a short, sharp summary (bullet points or compact lines).
- If Client/Lead: capture requirements, event type/date/venue, budget (e.g. wants a singer for 10k), seriousness/status, and any weirdness.
- If Owner (Himnish): capture current focus, key preferences, tasks, or things he asked to remember.
Keep it brief and factual. Output ONLY the updated overall_info text.
`;
    try {
        const res = await ai.models.generateContent({
            model: 'gemini-3.5-flash-lite',
            contents: prompt
        });
        return (res.text || existingOverallInfo || "").trim();
    } catch (e) {
        return existingOverallInfo || "";
    }
}

function isAnalysisRequest(text) {
    const t = text.toLowerCase();
    return (
        t.includes('analyze') ||
        t.includes('analyse') ||
        t.includes('what did') ||
        t.includes('what was up') ||
        t.includes('how many chats') ||
        t.includes('who seems serious') ||
        t.includes('serious lead') ||
        t.includes('anything weird') ||
        t.includes('who should i') ||
        t.includes('summary of chats') ||
        t.includes('check chats') ||
        t.includes('audit')
    );
}

// --- WHATSAPP SOCKET CONNECTION ---
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
            console.log('🚀 Drake Fast Memory Bot is online and connected!');
        }
    });

    // --- MESSAGE HANDLING LOOP ---
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message) continue;

            if (botSentIds.has(msg.key.id)) {
                botSentIds.delete(msg.key.id);
                continue;
            }

            const remoteJid = msg.key.remoteJid;
            if (remoteJid.includes('status@broadcast') || remoteJid.includes('@g.us')) continue;

            const isSelfChat = msg.key.fromMe && (remoteJid.includes(OWNER_PHONE) || remoteJid.includes('@lid'));
            if (msg.key.fromMe && !isSelfChat) continue;

            const senderPhone = isSelfChat ? OWNER_PHONE : remoteJid.split('@')[0];
            const senderName = isSelfChat ? "Himnish" : (msg.pushName || "Client");
            const messageText = msg.message.conversation
                || msg.message.extendedTextMessage?.text
                || msg.message.ephemeralMessage?.message?.extendedTextMessage?.text
                || "";

            if (!messageText) continue;

            console.log(`📩 Incoming | ${senderName} (${senderPhone}) | Mode: ${currentOwnerMode} | ${messageText}`);

            const reply = async (text) => {
                const sent = await sock.sendMessage(remoteJid, { text }, { quoted: msg });
                if (sent?.key?.id) botSentIds.add(sent.key.id);
            };

            const notifyOwner = async (alertText) => {
                try {
                    const targetJid = sock.user?.id ? sock.user.id.replace(/:\d+@/, '@') : OWNER_JID;
                    const sent = await sock.sendMessage(targetJid, { text: alertText });
                    if (sent?.key?.id) botSentIds.add(sent.key.id);
                } catch (err) {
                    console.error("❌ Failed to send escalation alert:", err.message);
                }
            };

            const isOwner = (
                isSelfChat ||
                senderPhone.includes(OWNER_PHONE) ||
                senderName.toLowerCase().includes('himnish')
            );

            // ==================== MODE SWITCHING ====================
            if (isOwner) {
                const lowerMsg = messageText.trim().toLowerCase();
                if (lowerMsg.includes('activate business mode')) {
                    currentOwnerMode = 'business';
                    await reply("💼 Business Mode Activated. Drop rules, pricing, or escalation triggers—I'll save them to `business_instructions` and give you my honest take.");
                    continue;
                }
                if (lowerMsg.includes('deactivate business mode')) {
                    currentOwnerMode = 'personal';
                    await reply("👤 Personal Mode Activated. Back to personal chat, saving to `drake_memory` when you ask, and running analysis only when you ask for it.");
                    continue;
                }
            }

            // Load ONLY this number's top-10 history & overall_info
            const record = await getNumberRecord(senderPhone);
            let userHistory = record.chat_history;
            let overallInfo = record.overall_info;

            // ==================== OWNER CHAT ====================
            if (isOwner) {
                const personalMemory = await getPersonalMemory();

                if (currentOwnerMode === 'business') {
                    const businessMemory = await getBusinessMemory();
                    let instruction = messageText.trim();
                    if (instruction.startsWith('!train')) instruction = instruction.replace('!train', '').trim();
                    if (!Array.isArray(businessMemory.owner_instructions)) businessMemory.owner_instructions = [];
                    businessMemory.owner_instructions.push(instruction);
                    const saved = await saveBusinessMemory(businessMemory);

                    let replyText = saved
                        ? `👑 Saved to \`business_instructions\` (${businessMemory.owner_instructions.length} rules).`
                        : `⚠️ Failed saving to \`business_instructions\`. Check Render logs.`;

                    try {
                        const bizPrompt = `You are Drake, Himnish's co-founder/AI brain for BOMBEAT. Himnish just set this business rule: "${instruction}". Give a short, direct, honest opinion on it (max 3 lines).`;
                        const res = await ai.models.generateContent({ model: 'gemini-3.5-flash-lite', contents: bizPrompt });
                        if (res.text) replyText = `${replyText}\n\n${res.text.trim()}`;
                    } catch (e) {
                        console.error("Business opinion error:", e.message);
                    }

                    userHistory.push({ role: 'user', sender: senderName, content: messageText, timestamp: new Date().toISOString() });
                    userHistory.push({ role: 'assistant', sender: 'Drake', content: replyText, timestamp: new Date().toISOString() });
                    overallInfo = await refreshOverallInfo(overallInfo, senderName, true, messageText, replyText, `Added business rule: ${instruction}`);
                    await saveNumberRecord(senderPhone, senderName, userHistory, overallInfo);

                    await reply(replyText);
                    continue;
                }

                // --- PERSONAL MODE ---
                const lowerMsg = messageText.toLowerCase();
                let replyText = "";
                let extraNote = "";

                if (lowerMsg.includes('remember') || lowerMsg.includes('note this') || lowerMsg.includes('save this')) {
                    if (!Array.isArray(personalMemory.core_memories)) personalMemory.core_memories = [];
                    personalMemory.core_memories.push({
                        memory: messageText,
                        timestamp: new Date().toISOString()
                    });
                    await savePersonalMemory(personalMemory);
                    extraNote = `Saved to drake_memory: ${messageText}`;
                    replyText = "Saved directly to `drake_memory` and updated your overall info, Boss. 🧠";
                } else if (isAnalysisRequest(messageText)) {
                    // ONLY here do we pull all rows from chats_history to answer analysis / "what did that guy say"
                    const allRows = await getAllChatsForAnalysis();
                    const clientRows = allRows.filter(r => !String(r.phone_number).includes(OWNER_PHONE));

                    const compactDump = clientRows.map(r => {
                        const last10 = (r.chat_history || []).slice(-10).map(m => `  [${m.timestamp}] ${m.role}: ${m.content}`).join('\n');
                        return `Contact: ${r.sender_name || 'Client'} (${r.phone_number}) | Updated: ${r.updated_at}\nOverall Info: ${r.overall_info || 'N/A'}\nLast 10 Messages:\n${last10}`;
                    }).join('\n\n');

                    const currentIST = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
                    const analysisPrompt = `
You are Drake, Himnish's sharp personal assistant and analyst.
Current IST Time: ${currentIST}
Core Memory (drake_memory): ${JSON.stringify(personalMemory)}

Stored WhatsApp Records (chats_history):
${compactDump || "No client records found yet."}

Answer Himnish's question accurately using the overall_info and last-10 message logs above.
- If asking about a specific person or "what did that guy say", pinpoint that exact contact, their overall_info, and their recent messages.
- If asking about today/chats/serious leads/weird stuff/who to message, give counts, serious vs weird/time-waster breakdown, and your clear recommendation on who Himnish should hit up personally.

Himnish: ${messageText}
Drake:`;

                    try {
                        const res = await ai.models.generateContent({
                            model: 'gemini-3.5-flash-lite',
                            contents: analysisPrompt
                        });
                        replyText = (res.text || "").trim() || "Couldn't generate analysis right now.";
                    } catch (e) {
                        console.error("Analysis Gemini error:", e.message);
                        replyText = "Hit a snag running the chat analysis.";
                    }
                } else {
                    // Normal personal chat: ONLY uses Himnish's last 10 messages + overall_info + drake_memory
                    const recent10 = userHistory.slice(-10).map(m => `${m.role}: ${m.content}`).join('\n');
                    const personalPrompt = `
You are Drake, Himnish's personal AI assistant. Be sharp, natural, real, and opinionated when appropriate.
Core Memory (drake_memory): ${JSON.stringify(personalMemory)}
Your Overall Info on Himnish: ${overallInfo || "None yet."}

Last 10 messages with Himnish:
${recent10 || "None"}

Himnish: ${messageText}
Drake:`;

                    try {
                        const res = await ai.models.generateContent({
                            model: 'gemini-3.5-flash-lite',
                            contents: personalPrompt
                        });
                        replyText = (res.text || "").trim() || "Yeah?";
                    } catch (e) {
                        console.error("Personal chat Gemini error:", e.message);
                        replyText = "My bad, had a quick glitch—say that again?";
                    }
                }

                userHistory.push({ role: 'user', sender: senderName, content: messageText, timestamp: new Date().toISOString() });
                userHistory.push({ role: 'assistant', sender: 'Drake', content: replyText, timestamp: new Date().toISOString() });
                userHistory = userHistory.slice(-10);

                overallInfo = await refreshOverallInfo(overallInfo, senderName, true, messageText, replyText, extraNote);
                await saveNumberRecord(senderPhone, senderName, userHistory, overallInfo);

                await reply(replyText);
                continue;
            }

            // ==================== CLIENT CHAT (USES ONLY THIS NUMBER'S LAST 10 + OVERALL_INFO) ====================
            const businessMemory = await getBusinessMemory();
            const personalMemory = await getPersonalMemory();
            const learnedRules = (businessMemory.owner_instructions || []).map(r => `- ${r}`).join('\n');
            const recent10 = userHistory.slice(-10).map(m => `${m.role} (${m.sender || senderName}): ${m.content}`).join('\n');

            const clientPrompt = `
You are Drake, the AI assistant for BOMBEAT (live music & event booking in Mumbai).
Personal identity context (drake_memory): ${JSON.stringify(personalMemory)}
Client Name: ${senderName} (${senderPhone})
Known Overall Info about this client: ${overallInfo || "New client, no prior summary yet."}

Business Instructions & Rules:
${learnedRules || "No custom rules set yet."}

Escalation Rule:
If the client's message triggers a rule where Himnish asked to be messaged/confirmed, OR if you are unsure/dicey about availability, custom pricing, or specific promises, set "escalate_to_owner": true and write a clear question in "owner_alert". Otherwise set "escalate_to_owner": false and "owner_alert": "".

Last 10 messages in this chat:
${recent10 || "None"}

Latest client message: ${messageText}

Respond ONLY with raw JSON:
{
  "reply_to_client": "Your response to the client",
  "escalate_to_owner": true or false,
  "owner_alert": "Question for Himnish if escalate_to_owner is true, else empty string"
}
`;

            try {
                const res = await ai.models.generateContent({
                    model: 'gemini-3.5-flash-lite',
                    contents: clientPrompt
                });

                let raw = (res.text || "").trim().replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
                let replyText = "";
                let shouldEscalate = false;
                let ownerAlert = "";

                try {
                    const parsed = JSON.parse(raw);
                    replyText = parsed.reply_to_client || raw;
                    shouldEscalate = Boolean(parsed.escalate_to_owner);
                    ownerAlert = parsed.owner_alert || "";
                } catch (_) {
                    replyText = raw || "Got it! Let me check and get back to you.";
                }

                userHistory.push({ role: 'user', sender: senderName, content: messageText, timestamp: new Date().toISOString() });
                userHistory.push({ role: 'assistant', sender: 'Drake', content: replyText, timestamp: new Date().toISOString() });
                userHistory = userHistory.slice(-10);

                overallInfo = await refreshOverallInfo(overallInfo, senderName, false, messageText, replyText);
                await saveNumberRecord(senderPhone, senderName, userHistory, overallInfo);

                await reply(replyText);

                if (shouldEscalate && ownerAlert) {
                    await notifyOwner(`🚨 *BOMBEAT Check-In*\n*Client:* ${senderName} (${senderPhone})\n*Said:* "${messageText}"\n*Drake asks:* ${ownerAlert}`);
                }
            } catch (e) {
                console.error("Client chat Gemini error:", e.message);
                await reply("Sorry, had a brief hiccup—let me get right back to you!");
            }
        }
    });
}

startDrake();
