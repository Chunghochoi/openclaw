require('dotenv').config();
const { Telegraf } = require('telegraf');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { getToolsSchema, executeTool } = require('./realtime_helper');

// --- RENDER WEB SERVER (BẮT BUỘC ĐỂ KHÔNG BỊ CRASH TRÊN RENDER) ---
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('OpenClaw Bot is alive and running on Render!'));
app.listen(port, () => console.log(`🌍 Health check server listening on port ${port}`));

// --- INIT BOT ---
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const ALLOWED_USER = parseInt(process.env.TELEGRAM_ALLOWED_USER_ID, 10);
const CONFIG = require('./openclaw.json');

// --- STATE MANAGEMENT (HỖ TRỢ RENDER PERSISTENT DISK) ---
// Nếu bạn cấu hình ổ cứng trên Render ở thư mục /data, session sẽ lưu ở đó.
const dataDir = process.env.DATA_DIR || __dirname; 
const STATE_FILE = path.join(dataDir, 'sessions.json');

function loadState() {
    try { 
        if (!fs.existsSync(STATE_FILE)) fs.writeFileSync(STATE_FILE, '{}');
        return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); 
    } catch (e) { 
        console.error("Lỗi đọc state:", e);
        return {}; 
    }
}
function saveState(state) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function getSession(chatId) {
    let state = loadState();
    if (!state[chatId]) {
        state[chatId] = {
            mode: 'default',
            custom_default_model: process.env.DEFAULT_MODEL,
            custom_codex_model: process.env.CODEX_MODEL,
            history:[]
        };
        saveState(state);
    }
    return state[chatId];
}

function updateSession(chatId, updates) {
    let state = loadState();
    state[chatId] = { ...state[chatId], ...updates };
    saveState(state);
}

// --- MIDDLEWARE AUTH ---
bot.use((ctx, next) => {
    if (ctx.from && ctx.from.id === ALLOWED_USER) return next();
});

// --- COMMANDS ---
bot.command('codex', (ctx) => {
    updateSession(ctx.chat.id, { mode: 'codex' });
    ctx.reply('👨‍💻[Code Mode: ENABLED] Chuyển sang profile chuyên lập trình.');
});

bot.command('stop', (ctx) => {
    updateSession(ctx.chat.id, { mode: 'default' });
    ctx.reply('✅ [Code Mode: DISABLED] Quay về trợ lý mặc định.');
});

bot.command('model', (ctx) => {
    const modelId = ctx.message.text.split(' ')[1];
    if (!modelId) return ctx.reply('⚠️ Cú pháp: /model <model-id>');
    updateSession(ctx.chat.id, { custom_default_model: modelId });
    ctx.reply(`🔄 Đã đổi Default Model thành: ${modelId}`);
});

bot.command('model_c', (ctx) => {
    const modelId = ctx.message.text.split(' ')[1];
    if (!modelId) return ctx.reply('⚠️ Cú pháp: /model_c <model-id>');
    updateSession(ctx.chat.id, { custom_codex_model: modelId });
    ctx.reply(`🔄 Đã đổi Codex Model thành: ${modelId}`);
});

bot.command('clear', (ctx) => {
    updateSession(ctx.chat.id, { history:[] });
    ctx.reply('🧹 Đã xóa context chat hiện tại.');
});

// --- OPENROUTER CALLER ---
async function callLLM(session, userMessage) {
    const isCodex = session.mode === 'codex';
    const currentModel = isCodex ? session.custom_codex_model : session.custom_default_model;
    const systemPrompt = isCodex ? CONFIG.profiles.codex.system_prompt : CONFIG.profiles.default.system_prompt;

    let messages =[
        { role: 'system', content: systemPrompt },
        ...session.history.slice(-10), 
        { role: 'user', content: userMessage }
    ];

    const payload = {
        model: currentModel,
        messages: messages
    };

    // Chỉ bật Tools (Web/Weather) khi ở chế độ Chat thường.
    // Tắt Tools ở chế độ Codex vì các model Uncensored/Open-source thường không hỗ trợ.
    if (!isCodex) {
        payload.tools = getToolsSchema();
        payload.tool_choice = 'auto';
    }
    try {
        let response = await axios.post(process.env.OPENROUTER_BASE_URL, payload, {
            headers: {
                'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://openclaw.render.com',
                'X-Title': 'OpenClaw Gateway'
            },
            timeout: 60000
        });

        let responseMsg = response.data.choices[0].message;

        if (responseMsg.tool_calls) {
            messages.push(responseMsg); 
            for (let tool of responseMsg.tool_calls) {
                const funcArgs = JSON.parse(tool.function.arguments);
                const toolResult = await executeTool(tool.function.name, funcArgs);
                messages.push({
                    tool_call_id: tool.id,
                    role: "tool",
                    name: tool.function.name,
                    content: JSON.stringify(toolResult)
                });
            }
            payload.messages = messages;
            delete payload.tools; 
            
            response = await axios.post(process.env.OPENROUTER_BASE_URL, payload, {
                headers: { 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}` }
            });
            responseMsg = response.data.choices[0].message;
        }

        session.history.push({ role: 'user', content: userMessage });
        session.history.push({ role: 'assistant', content: responseMsg.content });
        if (session.history.length > 20) session.history = session.history.slice(-20);
        
        return { text: responseMsg.content, model: currentModel };
    } catch (error) {
        console.error("OpenRouter Error:", error.response?.data || error.message);
        throw error;
    }
}

// --- MESSAGE HANDLER ---
bot.on('text', async (ctx) => {
    if (ctx.chat.type !== 'private' && CONFIG.system_config.requireMention_in_group) {
        if (!ctx.message.text.includes(`@${ctx.botInfo.username}`)) return;
    }

    const session = getSession(ctx.chat.id);
    const userText = ctx.message.text.replace(`@${ctx.botInfo.username}`, '').trim();
    if (!userText) return;

    try {
        ctx.sendChatAction('typing');
        const result = await callLLM(session, userText);
        updateSession(ctx.chat.id, { history: session.history });
        const modeEmoji = session.mode === 'codex' ? '💻' : '🤖';
        const suffix = `\n\n_${modeEmoji} Model: ${result.model}_`;
        await ctx.reply(result.text + suffix, { parse_mode: 'Markdown' });
    } catch (error) {
        ctx.reply('❌ Lỗi Gateway (Model ID sai định dạng, hết token, hoặc mạng lỗi).');
    }
});

bot.launch().then(() => console.log("🚀 Telegram Bot is polling!"));

// Graceful stop cho Render
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
