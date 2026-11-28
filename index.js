const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const express = require('express');
const mqtt = require('mqtt');
const { GoogleGenAI } = require('@google/genai');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// 1. Express Server (Live QR + Render 24/7 Keep-Alive)
const app = express();
const PORT = process.env.PORT || 8000;
let latestQR = "";
let isConnected = false;

// 2. MQTT Setup (WSS TLS on Port 8884 matching your Hub settings)
const MQTT_URL = process.env.MQTT_URL || 'wss://broker.hivemq.com:8884/mqtt';
const MQTT_PREFIX = (process.env.MQTT_PREFIX || 'bombeat/lights').replace(/^\/+|\/+$/g, '');
let mqttConnected = false;
let latestHubTelemetry = "NO TELEMETRY";

const mqttOptions = {
    clientId: 'drake-cloud-hub-' + Math.random().toString(16).substring(2, 10),
    clean: true,
    reconnectPeriod: 3000,
    connectTimeout: 10000,
};
if (process.env.MQTT_USERNAME) {
    mqttOptions.username = process.env.MQTT_USERNAME;
    mqttOptions.password = process.env.MQTT_PASSWORD || '';
}

const mqttClient = mqtt.connect(MQTT_URL, mqttOptions);

mqttClient.on('connect', () => {
    mqttConnected = true;
    console.log(`⚡ [MQTT] Connected to ${MQTT_URL}`);
    mqttClient.subscribe(`${MQTT_PREFIX}/status`, { qos: 0 });
});

mqttClient.on('message', (topic, payload) => {
    if (topic === `${MQTT_PREFIX}/status`) {
        latestHubTelemetry = payload.toString();
        console.log(`📡 [MQTT STATUS] ${latestHubTelemetry}`);
    }
});

mqttClient.on('error', (err) => {
    console.error('❌ [MQTT ERROR]', err.message);
});

mqttClient.on('close', () => {
    mqttConnected = false;
});

function publishMqtt(subtopic, payload) {
    const topic = `${MQTT_PREFIX}/${subtopic}`;
    if (!mqttClient || !mqttClient.connected) {
        console.error(`❌ Cannot publish to ${topic}: MQTT disconnected`);
        return false;
    }
    mqttClient.publish(topic, String(payload), { qos: 0, retain: false });
    console.log(`📤 [MQTT PUB] ${topic} <= ${payload}`);
    return true;
}

function hexToClkPacket(hexColor) {
    const clean = (hexColor || '#FFFFFF').replace('#', '').padEnd(6, '0');
    const r = (parseInt(clean.slice(0, 2), 16) || 0).toString(16).toUpperCase().padStart(2, '0');
    const g = (parseInt(clean.slice(2, 4), 16) || 0).toString(16).toUpperCase().padStart(2, '0');
    const b = (parseInt(clean.slice(4, 6), 16) || 0).toString(16).toUpperCase().padStart(2, '0');
    return `7E 00 05 03 ${r} ${g} ${b} 00 EF`;
}

// Execute any light command or preset
function executeLightCommand(cmd) {
    if (!cmd || typeof cmd !== 'object') return false;
    const { target, state, hex } = cmd;

    if (target === 'all') {
        const ok = publishMqtt('all', state === 'OFF' ? 'OFF' : 'ON');
        if (ok && state === 'ON' && hex) {
            setTimeout(() => publishMqtt('clk/rgb', hexToClkPacket(hex)), 800);
        }
        return ok;
    }

    if (target === 'clk') {
        if (state === 'OFF') {
            return publishMqtt('clk', 'OFF');
        }
        if (hex) {
            publishMqtt('clk', 'ON');
            setTimeout(() => publishMqtt('clk/rgb', hexToClkPacket(hex)), 350);
            return true;
        }
        return publishMqtt('clk', 'ON');
    }

    if (target === 'gatt') {
        return publishMqtt('gatt', state === 'OFF' ? 'OFF' : 'ON');
    }

    if (target === 'preset' && cmd.preset_data) {
        const p = cmd.preset_data;
        if (p.clk_state === 'OFF') {
            publishMqtt('clk', 'OFF');
        } else if (p.clk_state === 'ON') {
            publishMqtt('clk', 'ON');
            if (p.clk_hex) {
                setTimeout(() => publishMqtt('clk/rgb', hexToClkPacket(p.clk_hex)), 400);
            }
        }
        if (p.gatt_state) {
            setTimeout(() => publishMqtt('gatt', p.gatt_state), 2000); // Staggered 2s delay matching ESP32 bridge
        }
        return true;
    }

    return false;
}

app.get('/', (req, res) => {
    if (isConnected) {
        return res.send(`<h2>🚀 Drake Unified Bot is Online!</h2><p>MQTT (${MQTT_URL}): <b>${mqttConnected ? 'CONNECTED' : 'DISCONNECTED'}</b> | Hub: <b>${latestHubTelemetry}</b></p>`);
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

// 3. Initialize Gemini & Supabase
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const OWNER_PHONE = '9372486797';
const OWNER_JID = `91${OWNER_PHONE}@s.whatsapp.net`;

let currentOwnerMode = 'personal';
let activeSock = null;
const botSentIds = new Set();
const processedMsgIds = new Set();
const groupReplyModes = new Map();
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

        if (error || !data) return { owner_name: "Himnish", core_memories: [], light_presets: {} };
        const mem = data.data || {};
        if (!mem.core_memories) mem.core_memories = [];
        if (!mem.light_presets) mem.light_presets = {};
        return mem;
    } catch (e) {
        return { owner_name: "Himnish", core_memories: [], light_presets: {} };
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
        if (error) return false;
        return true;
    } catch (e) {
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
        await supabase
            .from('chats_history')
            .upsert({
                phone_number: String(recordId),
                sender_name: String(displayName || "Client"),
                chat_history: trimmedHistory,
                overall_info: safeOverall,
                updated_at: new Date().toISOString()
            }, { onConflict: 'phone_number' });
    } catch (e) {
        console.error("❌ Exception saving chats_history:", e.message);
    }
}

async function getAllChatsForAnalysis() {
    try {
        const { data, error } = await supabase
            .from('chats_history')
            .select('phone_number, sender_name, chat_history, overall_info, updated_at');
        return error || !data ? [] : data;
    } catch (e) {
        return [];
    }
}

// --- PERSISTENT SCHEDULER ENGINE ---
async function createScheduleItem({ title, action_type, payload, run_at, recurrence }) {
    try {
        const { data, error } = await supabase
            .from('drake_schedules')
            .insert({
                title,
                action_type,
                payload,
                run_at,
                recurrence: recurrence || 'once',
                active: true
            })
            .select()
            .single();

        if (error) {
            console.error("❌ Failed to save schedule:", error.message);
            return null;
        }
        return data;
    } catch (e) {
        console.error("❌ Schedule exception:", e.message);
        return null;
    }
}

async function getActiveSchedules() {
    try {
        const { data } = await supabase
            .from('drake_schedules')
            .select('*')
            .eq('active', true)
            .order('run_at', { ascending: true });
        return data || [];
    } catch (e) {
        return [];
    }
}

async function cancelSchedules(keyword) {
    try {
        if (!keyword || keyword.toLowerCase() === 'all') {
            await supabase.from('drake_schedules').update({ active: false }).eq('active', true);
            return true;
        }
        const activeList = await getActiveSchedules();
        for (const item of activeList) {
            if ((item.title || '').toLowerCase().includes(keyword.toLowerCase())) {
                await supabase.from('drake_schedules').update({ active: false }).eq('id', item.id);
            }
        }
        return true;
    } catch (e) {
        return false;
    }
}

// Background loop checking due schedules every 15 seconds
setInterval(async () => {
    try {
        const nowIso = new Date().toISOString();
        const { data: dueItems, error } = await supabase
            .from('drake_schedules')
            .select('*')
            .eq('active', true)
            .lte('run_at', nowIso);

        if (error || !dueItems || dueItems.length === 0) return;

        for (const item of dueItems) {
            console.log(`⏰ [EXECUTING SCHEDULE] ${item.title} (${item.action_type})`);

            if (item.action_type === 'light') {
                executeLightCommand(item.payload);
                if (activeSock) {
                    const targetJid = activeSock.user?.id ? activeSock.user.id.replace(/:\d+@/, '@') : OWNER_JID;
                    const sent = await activeSock.sendMessage(targetJid, {
                        text: `⏰ *Scheduled Light Action Executed:* ${item.title}`
                    });
                    if (sent?.key?.id) botSentIds.add(sent.key.id);
                }
            } else if (item.action_type === 'whatsapp_msg' && activeSock) {
                const rawTarget = String(item.payload?.phone || OWNER_PHONE).replace(/\D/g, '');
                let targetJid;
                if (String(item.payload?.phone || '').includes('@')) {
                    targetJid = item.payload.phone;
                } else if (rawTarget.includes(OWNER_PHONE)) {
                    targetJid = activeSock.user?.id ? activeSock.user.id.replace(/:\d+@/, '@') : OWNER_JID;
                } else {
                    const formatted = rawTarget.length === 10 ? `91${rawTarget}` : rawTarget;
                    targetJid = `${formatted}@s.whatsapp.net`;
                }

                const sent = await activeSock.sendMessage(targetJid, { text: item.payload?.message || item.title });
                if (sent?.key?.id) {
                    botSentIds.add(sent.key.id);
                    processedMsgIds.add(sent.key.id);
                }
            }

            if (item.recurrence === 'daily') {
                const nextRun = new Date(new Date(item.run_at).getTime() + 24 * 60 * 60 * 1000).toISOString();
                await supabase.from('drake_schedules').update({ run_at: nextRun }).eq('id', item.id);
            } else {
                await supabase.from('drake_schedules').update({ active: false }).eq('id', item.id);
            }
        }
    } catch (e) {
        console.error("⚠️ Scheduler loop error:", e.message);
    }
}, 15000);

// APPEND-ONLY FACT EXTRACTOR
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
    const clean = latestMsg.trim();
    if (clean.length < 12 && !/\d/.test(clean)) return;

    try {
        const latestRecord = await getChatRecord(recordId);
        const existingFacts = latestRecord.overall_info || "";

        const prompt = `
You are a strict memory archivist. Decide if the latest message contains any PERMANENT, WORTHWHILE FACT about the person (background/story, requirements, budget, dates, location, preferences, role).
Ignore casual chit-chat, greetings, or one-off light commands.

Context: ${isGroup ? `WhatsApp Group "${displayName}"` : `Direct Chat with ${displayName}`}
Speaker: ${senderName} (Phone: ${senderPhone})${isOwnerSender ? " [BOSS]" : ""}
Already Saved Facts (DO NOT DELETE OR REPEAT):
${existingFacts || "None yet."}

Latest Message: "${clean}"

Instructions:
- If NO new concrete fact worth remembering permanently, output ONLY: NONE
- If YES, output ONLY 1 to 2 ultra-short bullet points starting with "- ".
- ${isGroup ? `Include speaker name & phone: "- ${senderName} (${senderPhone}): ..."` : `Keep ultra-short: "- Wants solo singer for 10k"`}
- NEVER repeat already saved facts.
`;

        const res = await ai.models.generateContent({
            model: 'gemini-3.5-flash-lite',
            contents: prompt
        });

        const output = (res.text || "").trim();
        if (!output || output.toUpperCase() === "NONE" || !output.includes("-")) return;

        const newBullets = output.split("\n").map(l => l.trim()).filter(l => l.startsWith("- "));
        if (newBullets.length === 0) return;

        const updatedFacts = existingFacts
            ? `${existingFacts.trim()}\n${newBullets.join("\n")}`
            : newBullets.join("\n");

        await saveChatRecord(recordId, displayName || latestRecord.sender_name, currentHistory, updatedFacts);
    } catch (e) {
        console.error("⚠️ Fact extraction skipped:", e.message);
    }
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
    activeSock = sock;

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
            console.log('🚀 Drake Unified Bot (MQTT WSS:8884 + Scheduler + Memory) is online!');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message) continue;
            const msgId = msg.key.id;
            if (!msgId) continue;

            if (botSentIds.has(msgId)) {
                botSentIds.delete(msgId);
                continue;
            }
            if (processedMsgIds.has(msgId)) continue;
            processedMsgIds.add(msgId);
            if (processedMsgIds.size > 500) {
                processedMsgIds.delete(processedMsgIds.values().next().value);
            }

            const remoteJid = msg.key.remoteJid || "";
            if (remoteJid.includes('status@broadcast')) continue;

            const isGroup = remoteJid.endsWith('@g.us');
            const participantJid = isGroup ? (msg.key.participant || "") : remoteJid;

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

                const groupRecord = await getChatRecord(remoteJid);
                let groupHistory = groupRecord.chat_history;
                const groupOverallInfo = groupRecord.overall_info;

                groupHistory.push({
                    role: isOwner ? 'boss' : 'user',
                    sender: senderName,
                    phone: rawPhone,
                    content: messageText,
                    timestamp: new Date().toISOString()
                });
                groupHistory = groupHistory.slice(-10);

                if (isOwner) {
                    const lower = messageText.toLowerCase();
                    if (lower.includes("don't reply to every") || lower.includes("dont reply to every") || lower.includes("stop replying to all") || lower.includes("reply only when mentioned")) {
                        groupReplyModes.set(remoteJid, 'mentions_only');
                        const ack = "Got it, Boss. Replying only to you or when mentioned.";
                        groupHistory.push({ role: 'assistant', sender: 'Drake', content: ack, timestamp: new Date().toISOString() });
                        await saveChatRecord(remoteJid, groupName, groupHistory.slice(-10), groupOverallInfo);
                        await reply(ack);
                        continue;
                    }
                    if (lower.includes("reply to all") || lower.includes("reply to everyone")) {
                        groupReplyModes.set(remoteJid, 'all');
                        const ack = "Copy that, Boss—active for everyone in this group now.";
                        groupHistory.push({ role: 'assistant', sender: 'Drake', content: ack, timestamp: new Date().toISOString() });
                        await saveChatRecord(remoteJid, groupName, groupHistory.slice(-10), groupOverallInfo);
                        await reply(ack);
                        continue;
                    }
                }

                const currentGroupMode = groupReplyModes.get(remoteJid) || 'mentions_only';
                const botJidNumber = sock.user?.id ? sock.user.id.split(':')[0].split('@')[0] : "";
                const quotedParticipant = msg.message?.extendedTextMessage?.contextInfo?.participant || "";
                const isReplyToBot = botJidNumber && quotedParticipant.includes(botJidNumber);
                const isMentioned = messageText.toLowerCase().includes('drake') || (botJidNumber && messageText.includes(botJidNumber));
                const shouldReplyInGroup = isOwner || currentGroupMode === 'all' || isReplyToBot || isMentioned;

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

                if (!shouldReplyInGroup) continue;

                const personalMemory = await getPersonalMemory();
                const recent10 = groupHistory.map(m => `[${m.sender} (${m.phone || ''})]: ${m.content}`).join('\n');

                const groupPrompt = `
You are Drake, Himnish's AI assistant inside the WhatsApp group "${groupName}".
Himnish (${OWNER_PHONE}) is your BOSS.
Core Memory: ${JSON.stringify(personalMemory)}
Saved Permanent Facts About Group Members:
${groupOverallInfo || "None yet."}
Last 10 Messages:
${recent10}
Latest from ${senderName} (${rawPhone})${isOwner ? " [BOSS]" : ""}: "${messageText}"
Reply naturally and briefly for a group chat:`;

                try {
                    const res = await ai.models.generateContent({ model: 'gemini-3.5-flash-lite', contents: groupPrompt });
                    const replyText = (res.text || "").trim();
                    if (replyText) {
                        groupHistory.push({ role: 'assistant', sender: 'Drake', content: replyText, timestamp: new Date().toISOString() });
                        await saveChatRecord(remoteJid, groupName, groupHistory.slice(-10), groupOverallInfo);
                        await reply(replyText);
                    }
                } catch (e) {
                    console.error("❌ Group Gemini error:", e.message);
                }
                continue;
            }

            // ==================== DIRECT MESSAGE (DM) HANDLING ====================
            const senderPhone = isSelfDM ? OWNER_PHONE : rawPhone;

            if (isOwner) {
                const lowerMsg = messageText.trim().toLowerCase();
                if (lowerMsg.includes('activate business mode')) {
                    currentOwnerMode = 'business';
                    await reply("💼 Business Mode Activated. Drop rules, pricing, or escalation triggers.");
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

            // ==================== OWNER DM (LIGHTS + SCHEDULES + PRESETS + ANALYST) ====================
            if (isOwner) {
                const personalMemory = await getPersonalMemory();

                if (currentOwnerMode === 'business') {
                    const businessMemory = await getBusinessMemory();
                    let instruction = messageText.trim().replace(/^!train\s*/i, '');
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
                    } catch (_) {}

                    userHistory.push({ role: 'user', sender: senderName, phone: senderPhone, content: messageText, timestamp: new Date().toISOString() });
                    userHistory.push({ role: 'assistant', sender: 'Drake', content: replyText, timestamp: new Date().toISOString() });
                    await saveChatRecord(senderPhone, senderName, userHistory.slice(-10), overallInfo);
                    await reply(replyText);
                    continue;
                }

                // Personal Mode with Structured Action Router (Lights, Presets, Schedules, Memory, Analysis, Chat)
                const allRows = await getAllChatsForAnalysis();
                const otherRows = allRows.filter(r => !String(r.phone_number).includes(OWNER_PHONE));
                const activeSchedules = await getActiveSchedules();
                const nowIso = new Date().toISOString();
                const nowIst = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
                const recent10 = userHistory.slice(-10).map(m => `${m.role}: ${m.content}`).join('\n');

                const compactChatsDump = otherRows.map(r => {
                    const msgs = (r.chat_history || []).slice(-10).map(m => `  [${m.timestamp}] ${m.sender || m.role}: ${m.content}`).join('\n');
                    return `Chat: ${r.sender_name || 'Unknown'} (${r.phone_number}) | Updated: ${r.updated_at}\nSaved Facts:\n${r.overall_info || 'None'}\nLast 10:\n${msgs}`;
                }).join('\n\n');

                const ownerBrainPrompt = `
You are Drake, Himnish's personal AI assistant, smart-room controller, and scheduler.
Current UTC ISO Time: ${nowIso}
Current IST Time (Asia/Kolkata, UTC+05:30): ${nowIst}
MQTT Connection Status: ${mqttConnected ? "CONNECTED" : "DISCONNECTED"} | Hub Telemetry: ${latestHubTelemetry}

HARDWARE & LIGHTS SPECS:
- "all": Master all lights ("ON" or "OFF", optional hex for CLK).
- "clk" (also called CLK-BLEDDM / side lights / RGB strip): Supports "ON", "OFF", and RGB hex colors (e.g. "#FF0000" red, "#0000FF" blue, "#800080" purple, "#FF6400" orange, "#FFFFFF" white, "#D90429" crimson).
- "gatt" (also called GATT--DEMO / neon light): Binary "ON" or "OFF" only (no colors).
- Saved Light Presets in Memory: ${JSON.stringify(personalMemory.light_presets || {})}

Core Memory (drake_memory): ${JSON.stringify(personalMemory.core_memories || [])}
Active Schedules: ${JSON.stringify(activeSchedules)}
Permanent Facts About Himnish: ${overallInfo || "None yet."}

Other Chats & Groups Database (use ONLY if Himnish asks to analyze/check chats or what someone said):
${compactChatsDump || "None"}

Recent 10 Messages with Himnish:
${recent10 || "None"}

Himnish's Latest Message: "${messageText}"

Decide what action(s) to take and respond ONLY in valid raw JSON (no markdown fences):
{
  "reply": "Your natural, sharp, loyal response to Himnish",
  "light_cmd": null OR {
    "target": "all" | "clk" | "gatt" | "preset",
    "state": "ON" | "OFF",
    "hex": "#RRGGBB or null",
    "preset_name": "name if applying a saved preset, else null"
  },
  "save_preset": null OR {
    "name": "lowercase preset name (e.g. chill, gaming, studio, red mode)",
    "clk_state": "ON" | "OFF",
    "clk_hex": "#RRGGBB or null",
    "gatt_state": "ON" | "OFF"
  },
  "save_memory": null OR "Fact or memory string if Himnish explicitly asked you to remember/note/save something",
  "schedule_action": null OR {
    "operation": "create" | "cancel" | "list",
    "cancel_keyword": "keyword or 'all' if operation is cancel",
    "title": "Short label for schedule",
    "action_type": "light" | "whatsapp_msg",
    "run_at_iso": "Exact ISO-8601 UTC timestamp converted from IST (+05:30) for when to execute",
    "recurrence": "once" | "daily",
    "light_payload": null OR { "target": "all"|"clk"|"gatt"|"preset", "state": "ON"|"OFF", "hex": "#RRGGBB or null", "preset_name": "optional" },
    "msg_payload": null OR { "phone": "target phone number (or ${OWNER_PHONE} for self reminder)", "message": "exact WhatsApp message text to send" }
  }
}
`;

                let replyText = "";
                try {
                    const res = await ai.models.generateContent({
                        model: 'gemini-3.5-flash-lite',
                        contents: ownerBrainPrompt
                    });

                    let raw = (res.text || "").trim().replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
                    let parsed = null;
                    try {
                        parsed = JSON.parse(raw);
                    } catch (_) {
                        replyText = raw;
                    }

                    if (parsed) {
                        replyText = parsed.reply || "Done, Boss.";

                        // 1. Save Light Preset if requested
                        if (parsed.save_preset && parsed.save_preset.name) {
                            const pName = parsed.save_preset.name.toLowerCase().trim();
                            personalMemory.light_presets[pName] = {
                                clk_state: parsed.save_preset.clk_state || "ON",
                                clk_hex: parsed.save_preset.clk_hex || null,
                                gatt_state: parsed.save_preset.gatt_state || "ON"
                            };
                            await savePersonalMemory(personalMemory);
                        }

                        // 2. Save Core Memory if requested
                        if (parsed.save_memory) {
                            personalMemory.core_memories.push({
                                memory: parsed.save_memory,
                                timestamp: new Date().toISOString()
                            });
                            await savePersonalMemory(personalMemory);
                        }

                        // 3. Execute Immediate Light Command
                        if (parsed.light_cmd) {
                            if (parsed.light_cmd.target === 'preset' && parsed.light_cmd.preset_name) {
                                const pData = personalMemory.light_presets[parsed.light_cmd.preset_name.toLowerCase().trim()];
                                if (pData) {
                                    parsed.light_cmd.preset_data = pData;
                                }
                            }
                            const ok = executeLightCommand(parsed.light_cmd);
                            if (!ok) {
                                replyText += "\n⚠️ (MQTT broker isn't connected right now—check Render logs.)";
                            }
                        }

                        // 4. Handle Schedule Creation / Cancellation
                        if (parsed.schedule_action) {
                            const sa = parsed.schedule_action;
                            if (sa.operation === 'create' && sa.run_at_iso) {
                                let schedPayload = sa.action_type === 'light' ? (sa.light_payload || {}) : (sa.msg_payload || {});
                                if (sa.action_type === 'light' && schedPayload.target === 'preset' && schedPayload.preset_name) {
                                    schedPayload.preset_data = personalMemory.light_presets[schedPayload.preset_name.toLowerCase().trim()] || null;
                                }
                                await createScheduleItem({
                                    title: sa.title || "Scheduled Task",
                                    action_type: sa.action_type || 'light',
                                    payload: schedPayload,
                                    run_at: sa.run_at_iso,
                                    recurrence: sa.recurrence || 'once'
                                });
                            } else if (sa.operation === 'cancel') {
                                await cancelSchedules(sa.cancel_keyword || 'all');
                            }
                        }
                    }
                } catch (e) {
                    console.error("❌ Owner brain error:", e.message);
                    continue;
                }

                if (!replyText) continue;

                userHistory.push({ role: 'user', sender: senderName, phone: senderPhone, content: messageText, timestamp: new Date().toISOString() });
                userHistory.push({ role: 'assistant', sender: 'Drake', content: replyText, timestamp: new Date().toISOString() });
                userHistory = userHistory.slice(-10);

                await saveChatRecord(senderPhone, senderName, userHistory, overallInfo);
                await reply(replyText);

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
Personal identity context: ${JSON.stringify(personalMemory.core_memories || [])}
Client Name: ${senderName} (${senderPhone})
Permanent Saved Facts About This Client:
${overallInfo || "New client, no saved facts yet."}

Business Instructions & Rules:
${learnedRules || "No custom rules set yet."}

Escalation Rule:
If the client's message triggers a rule where Himnish asked to be messaged/confirmed, OR if you are unsure/dicey about availability, custom pricing, or promises, set "escalate_to_owner": true and write a clear question in "owner_alert". Otherwise false.

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
                continue;
            }

            if (!replyText) continue;

            userHistory.push({ role: 'user', sender: senderName, phone: senderPhone, content: messageText, timestamp: new Date().toISOString() });
            userHistory.push({ role: 'assistant', sender: 'Drake', content: replyText, timestamp: new Date().toISOString() });
            userHistory = userHistory.slice(-10);

            await saveChatRecord(senderPhone, senderName, userHistory, overallInfo);
            await reply(replyText);

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
