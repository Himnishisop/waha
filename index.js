const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { GoogleGenAI } = require('@google/genai');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// 1. Initialize Clients
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
        
        if (error) {
            console.error("Error saving to Supabase:", error.message);
        } else {
            console.log("💾 [SUCCESS] Memory synced to Supabase table 'drake_commands'!");
        }
    } catch (e) {
        console.error("Exception saving memory:", e.message);
    }
}

// --- OPTIMIZED WHATSAPP CLIENT FOR CLOUD ---
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        executablePath: '/usr/bin/google-chrome-stable', // Points to Linux Chrome inside Docker
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ],
        headless: true
    }
});

client.on('qr', (qr) => {
    console.log('📱 Scan this QR code with your WhatsApp:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('🚀 Drake Supabase-Backed WhatsApp Bot is online and connected!');
});

// --- MESSAGE HANDLING LOOP ---
client.on('message', async (msg) => {
    if (msg.fromMe || msg.from.includes('status')) return;

    const contact = await msg.getContact();
    const senderPhone = contact.number || msg.from.replace('@c.us', '');
    const senderName = contact.pushname || contact.name || "Client";
    const messageText = msg.body;

    console.log(`📩 Incoming | Name: ${senderName} | Phone: ${senderPhone} | Msg: ${messageText}`);

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
        
        Acknowledge him concisely, confirm it's saved permanently to Supabase (table 'drake_commands'), and state the total rule count.
        `;

        try {
            const response = await ai.models.generateContent({
                model: 'gemini-3.5-flash-lite',
                contents: ownerPrompt,
            });
            await msg.reply(response.text.strip());
        } catch (e) {
            await msg.reply(`Boss, saved to Supabase! (AI note: ${e.message})`);
        }
        return;
    }

    // ==================== CUSTOMER CHAT ====================
    const learnedGuidelines = memory.owner_instructions
        .map(rule => `- ${rule}`)
        .join('\n');

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
        const replyText = response.text.strip();
        await msg.reply(replyText);
    } catch (e) {
        console.error("Gemini Error:", e);
        await msg.reply("Sorry, I'm having a brief technical hiccup. I'll get back to you shortly!");
    }
});

client.initialize();
