const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const express = require('express');
const { GoogleGenAI } = require('@google/genai');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// 1. Express Server (Live QR + Render 24/7 Keep-Alive)
const app = express();
const PORT = process.env.PORT || 8000;
let latestQR = "";
let isConnected = false;

app.get('/', (req, res) => {
    if (isConnected) {
        return res.send('<h2>🚀 Drake Unified DM & Group Bot is Online!</h2>');
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
const processedMsgIds = new Set();
const groupReplyModes = new Map(); // groupJid -> 'all' | 'mentions_only' (default: 'mentions_only')
const groupNameCache = new Map();

function extractText(m) {
    if (!m) return "";
    return m.conversation
        || m.extendedTextMessage?.text
        || m.ephemeralMessage?.message?.conversation
        || m.ephemeralMessage?.message?.extendedTextMessage?.text
        || m.viewOnceMessage?.message?.conversation
        || m.viewOnceMessage?.message?.extendedTextMessage?.text
        || "";
}

// --- DATABASE HELPERS ---
async function getPersonalMemory() {
    try {
        const { data, error } = await supabase
            .from('drake_memory')
            .select('data')
            .eq('id', 'main')
            .single();

        if (error || !data) return { owner_name: "Himnish", core_memories: [] };
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
        console.error("❌ Exception saving drake_memory:", e.message);
    }
}

async function getBusinessMemory() {
    try {
        const { data, error } = await supabase
            .from('business_instructions')
            .select('data')
            .eq('id', 'main')
            .single();

        if (error || !data) return { business_name: "BOMBEAT", location: "Mumbai", owner_instructions: [] };
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
        console.error("❌ Exception saving business_instructions:", e.message);
        return false;
    }
}

async function getChatRecord(recordId) {
    try {
        const { data, error } = await supabase
            .from('chats_history')
            .select('chat_history, overall_info, sender_name')
            .eq('phone_number', String(recordId))
            .maybeSingle();

        if (error || !data) return { chat_history: [], overall_info: "", sender_name: "" };
        return {
            chat_history: Array.isArray(data.chat_history) ? data.chat_history.slice(-10) : [],
            overall_info: data.overall_info || "",
            sender_name: data.sender_name || ""
        };
    } catch (e) {
        return { chat_history: [], overall_info: "", sender_name: "" };
    }
}

async function saveChatRecord(recordId, displayName, history, overallInfo) {
    const trimmedHistory = Array.isArray(history) ? history.slice(-10) : [];
    const safeOverall = typeof overallInfo === "string" ? overallInfo : "";

    try {
        const { error } = await supabase
            .from('chats_history')
            .upsert({
                phone_number: String(recordId),
                sender_name: String(displayName || "Client"),
                chat_history: trimmedHistory,
                overall_info: safeOverall,
                updated_at: new Date().toISOString()
            }, { onConflict: 'phone_number' });

        if (error) {
            console.error("❌ SUPABASE WRITE ERROR (chats_history):", error.message);
        } else {
            console.log(`💾 [SUCCESS] Updated chats_history for ${displayName} (${recordId})`);
        }
    } catch (e) {
        console.error("❌ Exception saving chats_history:", e.message);
    }
}

async function getAllChatsForAnalysis() {
    try {
        const { data, error } = await supabase
            .from('chats_history')
            .select('phone_number, sender_name, chat_history, overall_info, updated_at');
        if (error || !data) return [];
        return data;
    } catch (e) {
        return [];
    }
}

// APPEND-ONLY FACT EXTRACTOR: Never deletes existing facts; skips casual chit-chat
async function appendPermanentFactIfWorthwhile({
    recordId,
    displayName,
    senderPhone,
    senderName,
    isGroup,
    isOwnerSender,
    latestMsg,
    currentHistory
}) {
    // Quick filter: skip ultra-short greetings/fillers so casual chit-chat doesn't waste tokens
    const clean = latestMsg.trim();
    if (clean.length < 12 && !/\d/.test(clean)) return;

    try {
        // Re-fetch latest record so concurrent group messages never overwrite saved facts
        const latestRecord = await getChatRecord(recordId);
        const existingFacts = latestRecord.overall_info || "";

        const prompt = `
You are a strict memory archivist. Decide if the latest message contains any PERMANENT, WORTHWHILE FACT about the person (e.g., their background/story, event requirements, budget, dates, location, preferences, role, contact details, or important decisions).
Ignore casual chit-chat ("yo", "what's up", "ok", "haha", "u up?", generic banter).

Context: ${isGroup ? `WhatsApp Group "${displayName}"` : `Direct Chat with ${displayName}`}
Speaker: ${senderName} (Phone: ${senderPhone})${isOwnerSender ? " [BOSS / OWNER]" : ""}
Already Saved Facts (DO NOT DELETE OR REPEAT THESE):
${existingFacts || "None yet."}

Latest Message: "${clean}"

Instructions:
- If there is NO new concrete fact worth remembering permanently, output ONLY the exact word: NONE
- If there IS a new concrete fact, output ONLY 1 to 2 ultra-short bullet points (max 12 words each) starting with "- ".
- ${isGroup ? `Include the speaker's name & phone number in each bullet, e.g., "- ${senderName} (${senderPhone}): ..."` : `Keep each bullet ultra-short, e.g., "- Wants solo singer for 10k on Dec 12"`}
- NEVER repeat anything already covered in "Already Saved Facts".
`;

        const res = await ai.models.generateContent({
            model: 'gemini-3.5-flash-lite',
            contents: prompt
        });

        const output = (res.text || "").trim();
        if (!output || output.toUpperCase() === "NONE" || !output.includes("-")) {
            return;
        }

        const newBullets = output
            .split("\n")
            .map(line => line.trim())
            .filter(line => line.startsWith("- "));

        if (newBullets.length === 0) return;

        const updatedFacts = existingFacts
            ? `${existingFacts.trim()}\n${newBullets.join("\n")}`
            : newBullets.join("\n");

        await saveChatRecord(
            recordId,
            displayName || latestRecord.sender_name,
            currentHistory,
            updatedFacts
        );
        console.log(`🧠 [LEARNED FACT] Appended to ${recordId}: ${newBullets.join(" | ")}`);
    } catch (e) {
        console.error("⚠️ Fact extraction skipped:", e.message);
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
            console.log(`⚠️ Connection closed (code: ${statusCode}). Reconnect: ${shouldReconnect}`);
            if (shouldReconnect) startDrake();
        } else if (connection === 'open') {
            latestQR = "";
            isConnected = true;
            console.log('🚀 Drake Unified DM & Group Bot is online and connected!');
        }
    });

    // --- MESSAGE HANDLING LOOP ---
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message) continue;

            const msgId = msg.key.id;
            if (!msgId) continue;

            // 1. Prevent infinite loops & duplicate event processing
            if (botSentIds.has(msgId)) {
                botSentIds.delete(msgId);
                continue;
            }
            if (processedMsgIds.has(msgId)) continue;
            processedMsgIds.add(msgId);
            if (processedMsgIds.size > 500) {
                const firstKey = processedMsgIds.values().next().value;
                processedMsgIds.delete(firstKey);
            }

            const remoteJid = msg.key.remoteJid || "";
            if (remoteJid.includes('status@broadcast')) continue;

            const isGroup = remoteJid.endsWith('@g.us');
            const participantJid = isGroup ? (msg.key.participant || "") : remoteJid;

            // Identify if sender is Boss (Himnish)
            const isSelfOrigin = Boolean(msg.key.fromMe);
            const rawPhone = isGroup
                ? participantJid.split('@')[0].split(':')[0]
                : (isSelfOrigin ? OWNER_PHONE : remoteJid.split('@')[0].split(':')[0]);

            const senderName = isSelfOrigin
                ? "Himnish"
                : (msg.pushName || (rawPhone.includes(OWNER_PHONE) ? "Himnish" : "Member"));

            const isOwner = (
                isSelfOrigin ||
                rawPhone.includes(OWNER_PHONE) ||
                senderName.toLowerCase().includes('himnish')
            );

            // Ignore outgoing messages sent from the bot's own phone unless it's self-chat or Himnish speaking in a group
            const isSelfDM = !isGroup && isSelfOrigin && (remoteJid.includes(OWNER_PHONE) || remoteJid.includes('@lid'));
            if (!isGroup && isSelfOrigin && !isSelfDM) continue;

            const messageText = extractText(msg.message);
            if (!messageText) continue;

            const reply = async (text) => {
                const sent = await sock.sendMessage(remoteJid, { text }, { quoted: msg });
                if (sent?.key?.id) {
                    botSentIds.add(sent.key.id);
                    processedMsgIds.add(sent.key.id);
                }
            };

            const notifyOwner = async (alertText) => {
                try {
                    const targetJid = sock.user?.id ? sock.user.id.replace(/:\d+@/, '@') : OWNER_JID;
                    const sent = await sock.sendMessage(targetJid, { text: alertText });
                    if (sent?.key?.id) {
                        botSentIds.add(sent.key.id);
                        processedMsgIds.add(sent.key.id);
                    }
                } catch (err) {
                    console.error("❌ Failed to send escalation alert:", err.message);
                }
            };

            // ==================== GROUP CHAT HANDLING ====================
            if (isGroup) {
                let groupName = groupNameCache.get(remoteJid);
                if (!groupName) {
                    try {
                        const meta = await sock.groupMetadata(remoteJid);
                        groupName = meta?.subject || "WhatsApp Group";
                        groupNameCache.set(remoteJid, groupName);
                    } catch (_) {
                        groupName = "WhatsApp Group";
                    }
                }

                console.log(`👥 Group [${groupName}] | ${senderName} (${rawPhone}) [Owner:${isOwner}]: ${messageText}`);

                // Fetch group's row in chats_history (last 10 msgs + permanent facts per member)
                const groupRecord = await getChatRecord(remoteJid);
                let groupHistory = groupRecord.chat_history;
                const groupOverallInfo = groupRecord.overall_info;

                // Record incoming message into group's last-10 window
                groupHistory.push({
                    role: isOwner ? 'boss' : 'user',
                    sender: senderName,
                    phone: rawPhone,
                    content: messageText,
                    timestamp: new Date().toISOString()
                });
                groupHistory = groupHistory.slice(-10);

                // Check if Boss is changing group reply behavior
                if (isOwner) {
                    const lower = messageText.toLowerCase();
                    if (
                        lower.includes("don't reply to every") ||
                        lower.includes("dont reply to every") ||
                        lower.includes("stop replying to all") ||
                        lower.includes("reply only when mentioned") ||
                        lower.includes("dont reply all")
                    ) {
                        groupReplyModes.set(remoteJid, 'mentions_only');
                        const ack = "Got it, Boss. I'll stay quiet on random group chatter and only reply to you or when someone calls me.";
                        groupHistory.push({ role: 'assistant', sender: 'Drake', content: ack, timestamp: new Date().toISOString() });
                        await saveChatRecord(remoteJid, groupName, groupHistory.slice(-10), groupOverallInfo);
                        await reply(ack);
                        continue;
                    }

                    if (
                        lower.includes("reply to all") ||
                        lower.includes("reply to everyone") ||
                        lower.includes("reply every")
                    ) {
                        groupReplyModes.set(remoteJid, 'all');
                        const ack = "Copy that, Boss—I'm active for everyone in this group now.";
                        groupHistory.push({ role: 'assistant', sender: 'Drake', content: ack, timestamp: new Date().toISOString() });
                        await saveChatRecord(remoteJid, groupName, groupHistory.slice(-10), groupOverallInfo);
                        await reply(ack);
                        continue;
                    }
                }

                // Decide whether Drake should reply to this group message:
                // - ALWAYS reply if Boss (Himnish) sent it
                // - Otherwise reply if mode is 'all', OR if someone mentioned "drake" / quoted Drake
                const currentGroupMode = groupReplyModes.get(remoteJid) || 'mentions_only';
                const botJidNumber = sock.user?.id ? sock.user.id.split(':')[0].split('@')[0] : "";
                const quotedParticipant = msg.message?.extendedTextMessage?.contextInfo?.participant || "";
                const isReplyToBot = botJidNumber && quotedParticipant.includes(botJidNumber);
                const isMentioned = messageText.toLowerCase().includes('drake') || (botJidNumber && messageText.includes(botJidNumber));

                const shouldReplyInGroup = isOwner || currentGroupMode === 'all' || isReplyToBot || isMentioned;

                // Always save the group's last-10 window & extract permanent member facts in the background
                await saveChatRecord(remoteJid, groupName, groupHistory, groupOverallInfo);
                appendPermanentFactIfWorthwhile({
                    recordId: remoteJid,
                    displayName: groupName,
                    senderPhone: rawPhone,
                    senderName,
                    isGroup: true,
                    isOwnerSender: isOwner,
                    latestMsg: messageText,
                    currentHistory: groupHistory
                });

                if (!shouldReplyInGroup) {
                    continue;
                }

                const personalMemory = await getPersonalMemory();
                const businessMemory = await getBusinessMemory();
                const learnedRules = (businessMemory.owner_instructions || []).map(r => `- ${r}`).join('\n');
                const recent10 = groupHistory.map(m => `[${m.sender} (${m.phone || ''})]: ${m.content}`).join('\n');

                const groupPrompt = `
You are Drake, Himnish's AI assistant & co-pilot inside the WhatsApp group "${groupName}".
IMPORTANT IDENTITY RULE: Himnish (phone containing ${OWNER_PHONE}) is your BOSS and creator. Always recognize him as Boss, be sharp and loyal to him, and treat other members respectfully while knowing Himnish runs the show.

Core Memory (drake_memory): ${JSON.stringify(personalMemory)}
Business Rules (if relevant): ${learnedRules || "None"}

Saved Permanent Facts About Members in This Group:
${groupOverallInfo || "No saved member facts yet."}

Last 10 Messages in Group:
${recent10}

Latest Message from ${senderName} (${rawPhone})${isOwner ? " [YOUR BOSS HIMNISH]" : ""}: "${messageText}"

Reply naturally, concisely, and with wit—fit for a WhatsApp group chat (no robotic paragraphs).
Drake:`;

                try {
                    const res = await ai.models.generateContent({
                        model: 'gemini-3.5-flash-lite',
                        contents: groupPrompt
                    });
                    const replyText = (res.text || "").trim();
                    if (replyText) {
                        groupHistory.push({
                            role: 'assistant',
                            sender: 'Drake',
                            content: replyText,
                            timestamp: new Date().toISOString()
                        });
                        groupHistory = groupHistory.slice(-10);
                        await saveChatRecord(remoteJid, groupName, groupHistory, groupOverallInfo);
                        await reply(replyText);
                    }
                } catch (e) {
                    console.error("❌ Group Gemini error:", e.message);
                }
                continue;
            }

            // ==================== DIRECT MESSAGE (DM) HANDLING ====================
            const senderPhone = isSelfDM ? OWNER_PHONE : rawPhone;
            console.log(`📩 DM | ${senderName} (${senderPhone}) | Owner:${isOwner} | Mode:${currentOwnerMode} | ${messageText}`);

            // Mode switching for Boss
            if (isOwner) {
                const lowerMsg = messageText.trim().toLowerCase();
                if (lowerMsg.includes('activate business mode')) {
                    currentOwnerMode = 'business';
                    await reply("💼 Business Mode Activated. Drop rules, pricing, or escalation triggers—I'll save them to `business_instructions`.");
                    continue;
                }
                if (lowerMsg.includes('deactivate business mode')) {
                    currentOwnerMode = 'personal';
                    await reply("👤 Personal Mode Activated.");
                    continue;
                }
            }

            const record = await getChatRecord(senderPhone);
            let userHistory = record.chat_history;
            let overallInfo = record.overall_info;

            // ==================== OWNER DM (PERSONAL / BUSINESS / ANALYST) ====================
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
                        : `⚠️ Failed saving to \`business_instructions\`.`;

                    try {
                        const bizPrompt = `You are Drake, Himnish's co-founder/AI brain for BOMBEAT. Himnish added this rule: "${instruction}". Give a quick, sharp 2-line take on it.`;
                        const res = await ai.models.generateContent({ model: 'gemini-3.5-flash-lite', contents: bizPrompt });
                        if (res.text) replyText = `${replyText}\n\n${res.text.trim()}`;
                    } catch (e) {
                        console.error("⚠️ Business opinion error:", e.message);
                    }

                    userHistory.push({ role: 'user', sender: senderName, phone: senderPhone, content: messageText, timestamp: new Date().toISOString() });
                    userHistory.push({ role: 'assistant', sender: 'Drake', content: replyText, timestamp: new Date().toISOString() });
                    userHistory = userHistory.slice(-10);

                    await saveChatRecord(senderPhone, senderName, userHistory, overallInfo);
                    await reply(replyText);
                    continue;
                }

                // Personal Mode
                const lowerMsg = messageText.toLowerCase();
                let replyText = "";

                if (lowerMsg.includes('remember') || lowerMsg.includes('note this') || lowerMsg.includes('save this')) {
                    if (!Array.isArray(personalMemory.core_memories)) personalMemory.core_memories = [];
                    personalMemory.core_memories.push({
                        memory: messageText,
                        timestamp: new Date().toISOString()
                    });
                    await savePersonalMemory(personalMemory);
                    replyText = "Saved directly to `drake_memory`, Boss. 🧠";
                } else if (isAnalysisRequest(messageText)) {
                    const allRows = await getAllChatsForAnalysis();
                    const otherRows = allRows.filter(r => !String(r.phone_number).includes(OWNER_PHONE));

                    const compactDump = otherRows.map(r => {
                        const last10 = (r.chat_history || []).slice(-10).map(m => `  [${m.timestamp}] ${m.sender || m.role}: ${m.content}`).join('\n');
                        return `Chat: ${r.sender_name || 'Unknown'} (${r.phone_number}) | Updated: ${r.updated_at}\nSaved Facts:\n${r.overall_info || 'None'}\nLast 10 Messages:\n${last10}`;
                    }).join('\n\n');

                    const currentIST = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
                    const analysisPrompt = `
You are Drake, Himnish's personal AI assistant and analyst.
Current IST Time: ${currentIST}
Core Memory (drake_memory): ${JSON.stringify(personalMemory)}

All WhatsApp DMs & Groups in Database:
${compactDump || "No records yet."}

Answer Himnish's question accurately using the saved facts and last-10 messages above.
Himnish: ${messageText}
Drake:`;

                    try {
                        const res = await ai.models.generateContent({
                            model: 'gemini-3.5-flash-lite',
                            contents: analysisPrompt
                        });
                        replyText = (res.text || "").trim() || "Nothing concrete in the logs yet.";
                    } catch (e) {
                        console.error("❌ Analysis Gemini error:", e.message);
                        replyText = "Hit an API snag pulling the analysis—try again in a second.";
                    }
                } else {
                    const recent10 = userHistory.slice(-10).map(m => `${m.role}: ${m.content}`).join('\n');
                    const personalPrompt = `
You are Drake, Himnish's personal AI assistant. Be sharp, natural, loyal, and real.
Core Memory (drake_memory): ${JSON.stringify(personalMemory)}
Permanent Facts Saved About Himnish:
${overallInfo || "None yet."}

Last 10 messages with Himnish:
${recent10 || "None"}

Himnish: ${messageText}
Drake:`;

                    try {
                        const res = await ai.models.generateContent({
                            model: 'gemini-3.5-flash-lite',
                            contents: personalPrompt
                        });
                        replyText = (res.text || "").trim();
                    } catch (e) {
                        console.error("❌ Personal Gemini error:", e.message);
                        continue; // Don't spam fallback messages if API hiccups
                    }
                }

                if (!replyText) continue;

                userHistory.push({ role: 'user', sender: senderName, phone: senderPhone, content: messageText, timestamp: new Date().toISOString() });
                userHistory.push({ role: 'assistant', sender: 'Drake', content: replyText, timestamp: new Date().toISOString() });
                userHistory = userHistory.slice(-10);

                await saveChatRecord(senderPhone, senderName, userHistory, overallInfo);
                await reply(replyText);

                // Extract & append any permanent facts from Himnish's message without blocking the reply
                appendPermanentFactIfWorthwhile({
                    recordId: senderPhone,
                    displayName: senderName,
                    senderPhone,
                    senderName,
                    isGroup: false,
                    isOwnerSender: true,
                    latestMsg: messageText,
                    currentHistory: userHistory
                });
                continue;
            }

            // ==================== CLIENT DM ====================
            const businessMemory = await getBusinessMemory();
            const personalMemory = await getPersonalMemory();
            const learnedRules = (businessMemory.owner_instructions || []).map(r => `- ${r}`).join('\n');
            const recent10 = userHistory.slice(-10).map(m => `${m.role} (${m.sender || senderName}): ${m.content}`).join('\n');

            const clientPrompt = `
You are Drake, the AI assistant for BOMBEAT (live music & event booking in Mumbai).
Personal identity context (drake_memory): ${JSON.stringify(personalMemory)}
Client Name: ${senderName} (${senderPhone})
Permanent Saved Facts About This Client:
${overallInfo || "New client, no saved facts yet."}

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

            let replyText = "";
            let shouldEscalate = false;
            let ownerAlert = "";

            try {
                const res = await ai.models.generateContent({
                    model: 'gemini-3.5-flash-lite',
                    contents: clientPrompt
                });

                let raw = (res.text || "").trim().replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
                try {
                    const parsed = JSON.parse(raw);
                    replyText = parsed.reply_to_client || raw;
                    shouldEscalate = Boolean(parsed.escalate_to_owner);
                    ownerAlert = parsed.owner_alert || "";
                } catch (_) {
                    replyText = raw;
                }
            } catch (e) {
                console.error("❌ Client Gemini error:", e.message);
                continue; // Avoid sending glitch spam if API throws transiently
            }

            if (!replyText) continue;

            userHistory.push({ role: 'user', sender: senderName, phone: senderPhone, content: messageText, timestamp: new Date().toISOString() });
            userHistory.push({ role: 'assistant', sender: 'Drake', content: replyText, timestamp: new Date().toISOString() });
            userHistory = userHistory.slice(-10);

            await saveChatRecord(senderPhone, senderName, userHistory, overallInfo);
            await reply(replyText);

            // Append any worthwhile facts (budget, date, story, requirement) permanently without deleting old ones
            appendPermanentFactIfWorthwhile({
                recordId: senderPhone,
                displayName: senderName,
                senderPhone,
                senderName,
                isGroup: false,
                isOwnerSender: false,
                latestMsg: messageText,
                currentHistory: userHistory
            });

            if (shouldEscalate && ownerAlert) {
                await notifyOwner(`🚨 *BOMBEAT Check-In*\n*Client:* ${senderName} (${senderPhone})\n*Said:* "${messageText}"\n*Drake asks:* ${ownerAlert}`);
            }
        }
    });
}

startDrake();
