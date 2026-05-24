const { Telegraf, Markup } = require('telegraf');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const http = require('http');

// Config from Environment Variables
const BOT_TOKEN = process.env.BOT_TOKEN;
const ALLOWED_CHAT_ID = process.env.ALLOWED_CHAT_ID; // Security check

if (!BOT_TOKEN) {
    console.error("❌ Error: BOT_TOKEN environment variable missing!");
    process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const userSessions = {};
const sessionDir = path.join(__dirname, 'sessions');

// Helper: Phone number clean karne ke liye (Sabhie countries ke liye compatible)
function cleanNum(num) {
    return num.replace(/[^0-9]/g, ''); // Sirf digits rakhega
}

// Security Middleware
bot.use(async (ctx, next) => {
    if (ALLOWED_CHAT_ID && ctx.from.id.toString() !== ALLOWED_CHAT_ID.toString()) {
        return ctx.reply("🔒 Yeh ek private bot hai. Aapko ise use karne ki permission nahi hai.");
    }
    await next();
});

// WhatsApp Connection Function
async function initWhatsApp(ctx, userId, usePairingCode = false, phoneNumber = '') {
    if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
    }

    // Restore session if exists in env
    if (process.env.SESSION_DATA && !fs.existsSync(path.join(sessionDir, 'creds.json'))) {
        try {
            fs.writeFileSync(path.join(sessionDir, 'creds.json'), Buffer.from(process.env.SESSION_DATA, 'base64').toString('utf-8'));
            console.log("ℹ️ WhatsApp session restored from Environment Variables.");
        } catch (e) {
            console.error("❌ Session restore karne me fail:", e);
        }
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    // Optimized socket configuration for cloud platforms
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ['Render Server', 'Chrome', '20.0.0'],
        printQRInTerminal: false,
        mobile: false
    });

    userSessions[userId] = sock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // QR Code handler
        if (qr && !usePairingCode) {
            try {
                const qrBuffer = await QRCode.toBuffer(qr);
                await ctx.replyWithPhoto({ source: qrBuffer }, {
                    caption: '📸 Is QR Code ko apne WhatsApp (Linked Devices) se scan karein.'
                });
            } catch (err) {
                console.error("QR Error:", err);
                ctx.reply('❌ QR Code generate karne me dikkat aayi.');
            }
        }

        if (connection === 'open') {
            ctx.reply('✅ WhatsApp Connect ho gaya hai!');
            
            try {
                const credsRaw = fs.readFileSync(path.join(sessionDir, 'creds.json'));
                const base64Session = Buffer.from(credsRaw).toString('base64');
                console.log("\n=================== RENDER WORKAROUND ===================");
                console.log("KEY: SESSION_DATA");
                console.log(`VALUE: ${base64Session}`);
                console.log("=========================================================\n");
                
                ctx.reply("💡 Render Par Permanent Login Ke Liye: Apne Render dashboard logs check karein aur 'SESSION_DATA' env variable set karein.");
            } catch (e) {
                console.error(e);
            }
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                console.log('🔄 Reconnecting WhatsApp...');
                initWhatsApp(ctx, userId, false);
            } else {
                ctx.reply('❌ Aap WhatsApp se logout ho chuke hain. Dubara /login karein.');
                delete userSessions[userId];
                try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}
            }
        }
    });

    // Pairing Code Request Handler (With stable delay)
    if (usePairingCode && phoneNumber) {
        setTimeout(async () => {
            try {
                const formattedNumber = cleanNum(phoneNumber);
                console.log(`Pairing code requested for: ${formattedNumber}`);
                
                let code = await sock.requestPairingCode(formattedNumber);
                code = code?.match(/.{1,4}/g)?.join('-') || code;
                
                await ctx.reply(`🔑 Aapka Pairing Code hai:\n\n\`${code}\`\n\nIs code ko apne WhatsApp notification me enter karein.`, { parse_mode: 'Markdown' });
            } catch (err) {
                console.error("Pairing Code Error:", err);
                ctx.reply('❌ Pairing code request fail ho gaya. Kripya check karein ki number WhatsApp par active hai ya thoda ruk kar try karein.');
            }
        }, 6000); // 6 seconds wait
    }
}

// --- BOT COMMANDS ---
bot.start((ctx) => {
    ctx.reply('👋 Welcome! Commands:\n/login - Connect WhatsApp\n/getpic <number> - Download DP\n/chat - View active chats');
});

bot.command('login', (ctx) => {
    ctx.reply('Login method select karein:', Markup.inlineKeyboard([
        Markup.button.callback('QR Code Se', 'login_qr'),
        Markup.button.callback('Pairing Code Se', 'login_code')
    ]));
});

bot.action('login_qr', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.reply('⌛ QR Code generate ho raha hai...');
    initWhatsApp(ctx, ctx.from.id, false);
});

bot.action('login_code', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.reply('📞 Apna number country code ke sath bhejein (Bina + ke):\n\nExample:\nIndia: `/number 919876543210`\nRussia: `/number 77079335643`', { parse_mode: 'Markdown' });
});

bot.command('number', (ctx) => {
    const text = ctx.message.text.replace(/\/number/g, '').trim();
    if (!text) return ctx.reply('❌ Sahi format: `/number 77079335643`', { parse_mode: 'Markdown' });
    
    ctx.reply('⌛ Pairing Code request kiya ja raha hai, kripya 6 seconds wait karein...');
    initWhatsApp(ctx, ctx.from.id, true, text);
});

bot.command('getpic', async (ctx) => {
    const sock = userSessions[ctx.from.id];
    if (!sock) return ctx.reply('❌ Pehle /login karke WhatsApp link karein.');

    const args = ctx.message.text.replace(/\/getpic/g, '').trim();
    if (!args) return ctx.reply('❌ Sahi format: `/getpic 77079335643`', { parse_mode: 'Markdown' });

    const targetNumber = cleanNum(args);
    await ctx.reply('🔍 Profile picture search ki ja rahi hai...');

    try {
        const ppUrl = await sock.profilePictureUrl(`${targetNumber}@s.whatsapp.net`, 'image');
        if (ppUrl) {
            await ctx.replyWithPhoto(ppUrl, { caption: `📸 +${targetNumber} ki profile picture.` });
        } else {
            ctx.reply('😔 Is number par koi public profile picture nahi mili.');
        }
    } catch (err) {
        ctx.reply('❌ DP nahi mil saki (Number galat hai ya privacy restrictions hain).');
    }
});

bot.command('chat', async (ctx) => {
    const sock = userSessions[ctx.from.id];
    if (!sock) return ctx.reply('❌ Pehle /login karke WhatsApp link karein.');

    await ctx.reply('📂 Chats load ho rahi hain...');
    try {
        const chats = await sock.store?.chats?.all() || Object.values(sock.contacts || {});
        if (chats.length === 0) return ctx.reply('📭 Abhi koi active chat history nahi mili.');

        let chatList = '💬 *WhatsApp Chats:*\n\n';
        chats.slice(0, 15).forEach((chat, index) => {
            const name = chat.name || chat.verifiedName || chat.id.split('@')[0];
            chatList += `${index + 1}. *${name}* (${chat.id.split('@')[0]})\n`;
        });
        ctx.reply(chatList, { parse_mode: 'Markdown' });
    } catch (err) {
        ctx.reply('❌ Chats load karne me dikkat aayi.');
    }
});

// Render Web Server Setup
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running safely!');
}).listen(PORT, () => {
    console.log(`Web server active on port ${PORT}`);
});

bot.launch().then(() => console.log('🚀 Telegram Bot Active!'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
            }
        }
    });

    // Pairing Code Request Handler (With stable delay)
    if (usePairingCode && phoneNumber) {
        setTimeout(async () => {
            try {
                const formattedNumber = cleanNum(phoneNumber);
                console.log(`Pairing code requested for: ${formattedNumber}`);
                
                let code = await sock.requestPairingCode(formattedNumber);
                code = code?.match(/.{1,4}/g)?.join('-') || code;
                
                await ctx.reply(`🔑 Aapka Pairing Code hai:\n\n\`${code}\`\n\nIs code ko apne WhatsApp notification me enter karein.`, { parse_mode: 'Markdown' });
            } catch (err) {
                console.error("Pairing Code Error:", err);
                ctx.reply('❌ Pairing code request fail ho gaya. Kripya check karein ki number WhatsApp par active hai ya thoda ruk kar try karein.');
            }
        }, 6000); // 6 seconds wait
    }
}

// --- BOT COMMANDS ---
bot.start((ctx) => {
    ctx.reply('👋 Welcome! Commands:\n/login - Connect WhatsApp\n/getpic <number> - Download DP\n/chat - View active chats');
});

bot.command('login', (ctx) => {
    ctx.reply('Login method select karein:', Markup.inlineKeyboard([
        Markup.button.callback('QR Code Se', 'login_qr'),
        Markup.button.callback('Pairing Code Se', 'login_code')
    ]));
});

bot.action('login_qr', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.reply('⌛ QR Code generate ho raha hai...');
    initWhatsApp(ctx, ctx.from.id, false);
});

bot.action('login_code', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.reply('📞 Apna number country code ke sath bhejein (Bina + ke):\n\nExample:\nIndia: `/number 919876543210`\nRussia: `/number 77079335643`', { parse_mode: 'Markdown' });
});

bot.command('number', (ctx) => {
    const text = ctx.message.text.replace(/\/number/g, '').trim();
    if (!text) return ctx.reply('❌ Sahi format: `/number 77079335643`', { parse_mode: 'Markdown' });
    
    ctx.reply('⌛ Pairing Code request kiya ja raha hai, kripya 6 seconds wait karein...');
    initWhatsApp(ctx, ctx.from.id, true, text);
});

bot.command('getpic', async (ctx) => {
    const sock = userSessions[ctx.from.id];
    if (!sock) return ctx.reply('❌ Pehle /login karke WhatsApp link karein.');

    const args = ctx.message.text.replace(/\/getpic/g, '').trim();
    if (!args) return ctx.reply('❌ Sahi format: `/getpic 77079335643`', { parse_mode: 'Markdown' });

    const targetNumber = cleanNum(args);
    await ctx.reply('🔍 Profile picture search ki ja rahi hai...');

    try {
        const ppUrl = await sock.profilePictureUrl(`${targetNumber}@s.whatsapp.net`, 'image');
        if (ppUrl) {
            await ctx.replyWithPhoto(ppUrl, { caption: `📸 +${targetNumber} ki profile picture.` });
        } else {
            ctx.reply('😔 Is number par koi public profile picture nahi mili.');
        }
    } catch (err) {
        ctx.reply('❌ DP nahi mil saki (Number galat hai ya privacy restrictions hain).');
    }
});

bot.command('chat', async (ctx) => {
    const sock = userSessions[ctx.from.id];
    if (!sock) return ctx.reply('❌ Pehle /login karke WhatsApp link karein.');

    await ctx.reply('📂 Chats load ho rahi hain...');
    try {
        const chats = await sock.store?.chats?.all() || Object.values(sock.contacts || {});
        if (chats.length === 0) return ctx.reply('📭 Abhi koi active chat history nahi mili.');

        let chatList = '💬 *WhatsApp Chats:*\n\n';
        chats.slice(0, 15).forEach((chat, index) => {
            const name = chat.name || chat.verifiedName || chat.id.split('@')[0];
            chatList += `${index + 1}. *${name}* (${chat.id.split('@')[0]})\n`;
        });
        ctx.reply(chatList, { parse_mode: 'Markdown' });
    } catch (err) {
        ctx.reply('❌ Chats load karne me dikkat aayi.');
    }
});

// Render Web Server Setup
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running safely!');
}).listen(PORT, () => {
    console.log(`Web server active on port ${PORT}`);
});

bot.launch().then(() => console.log('🚀 Telegram Bot Active!'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
            }
        }
    });

    // Pairing Code Request Handler (With stable delay)
    if (usePairingCode && phoneNumber) {
        setTimeout(async () => {
            try {
                const formattedNumber = cleanNum(phoneNumber);
                console.log(`Pairing code requested for: ${formattedNumber}`);
                
                let code = await sock.requestPairingCode(formattedNumber);
                code = code?.match(/.{1,4}/g)?.join('-') || code;
                
                await ctx.reply(`🔑 Aapka Pairing Code hai:\n\n\`${code}\`\n\nIs code ko apne WhatsApp notification me enter karein.`, { parse_mode: 'Markdown' });
            } catch (err) {
                console.error("Pairing Code Error:", err);
                ctx.reply('❌ Pairing code request fail ho gaya. Kripya check karein ki number WhatsApp par active hai ya thoda ruk kar try karein.');
            }
        }, 6000); // 6 seconds ka wait taaki connection stable ho jaye
    }
}

// --- BOT COMMANDS ---
bot.start((ctx) => {
    ctx.reply('👋 Welcome! Commands:\n/login - Connect WhatsApp\n/getpic <number> - Download DP\n/chat - View active chats');
});

bot.command('login', (ctx) => {
    ctx.reply('Login method select karein:', Markup.inlineKeyboard([
        Markup.button.callback('QR Code Se', 'login_qr'),
        Markup.button.callback('Pairing Code Se', 'login_code')
    ]));
});

bot.action('login_qr', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.reply('⌛ QR Code generate ho raha hai...');
    initWhatsApp(ctx, ctx.from.id, false);
});

bot.action('login_code', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.reply('📞 Apna number country code ke sath bhejein (Bina + ke):\n\nExample:\nIndia: `/number 919876543210`\nRussia: `/number 77079335643`', { parse_mode: 'Markdown' });
});

bot.command('number', (ctx) => {
    const text = ctx.message.text.replace(/\/number/g, '').trim();
    if (!text) return ctx.reply('❌ Sahi format: `/number 77079335643`', { parse_mode: 'Markdown' });
    
    ctx.reply('⌛ Pairing Code request kiya ja raha hai, kripya 6 seconds wait karein...');
    initWhatsApp(ctx, ctx.from.id, true, text);
});

bot.command('getpic', async (ctx) => {
    const sock = userSessions[ctx.from.id];
    if (!sock) return ctx.reply('❌ Pehle /login karke WhatsApp link karein.');

    const args = ctx.message.text.replace(/\/getpic/g, '').trim();
    if (!args) return ctx.reply('❌ Sahi format: `/getpic 77079335643`', { parse_mode: 'Markdown' });

    const targetNumber = cleanNum(args);
    await ctx.reply('🔍 Profile picture search ki ja rahi hai...');

    try {
        const ppUrl = await sock.profilePictureUrl(`${targetNumber}@s.whatsapp.net`, 'image');
        if (ppUrl) {
            await ctx.replyWithPhoto(ppUrl, { caption: `📸 +${targetNumber} ki profile picture.` });
        } else {
            ctx.reply('😔 Is number par koi public profile picture nahi mili.');
        }
    } catch (err) {
        ctx.reply('❌ DP nahi mil saki (Number galat hai ya privacy restrictions hain).');
    }
});

bot.command('chat', async (ctx) => {
    const sock = userSessions[ctx.from.id];
    if (!sock) return ctx.reply('❌ Pehle /login karke WhatsApp link karein.');

    await ctx.reply('📂 Chats load ho rahi hain...');
    try {
        const chats = await sock.store?.chats?.all() || Object.values(sock.contacts || {});
        if (chats.length === 0) return ctx.reply('📭 Abhi koi active chat history nahi mili.');

        let chatList = '💬 *WhatsApp Chats:*\n\n';
        chats.slice(0, 15).forEach((chat, index) => {
            const name = chat.name || chat.verifiedName || chat.id.split('@')[0];
            chatList += `${index + 1}. *${name}* (${chat.id.split('@')[0]})\n`;
        });
        ctx.reply(chatList, { parse_mode: 'Markdown' });
    } catch (err) {
        ctx.reply('❌ Chats load karne me dikkat aayi.');
    }
});

// Render Web Server Setup
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running safely!');
}).listen(PORT, () => {
    console.log(`Web server active on port ${PORT}`);
});

bot.launch().then(() => console.log('🚀 Telegram Bot Active!'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
                try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}
            }
        }
    });

    // Pairing Code Request Handler (With stable delay)
    if (usePairingCode && phoneNumber) {
        setTimeout(async () => {
            try {
                const formattedNumber = cleanNum(phoneNumber);
                console.log(`Pairing code requested for: ${formattedNumber}`);
                
                let code = await sock.requestPairingCode(formattedNumber);
                code = code?.match(/.{1,4}/g)?.join('-') || code;
                
                await ctx.reply(`🔑 Aapka Pairing Code hai:\n\n\`${code}\`\n\nIs code ko apne WhatsApp notification me enter karein.`, { parse_mode: 'Markdown' });
            } catch (err) {
                console.error("Pairing Code Error:", err);
                ctx.reply('❌ Pairing code request fail ho gaya. Kripya check karein ki number WhatsApp par active hai ya thoda ruk kar try karein.');
            }
        }, 6000); // Badhakar 6 seconds kiya taaki connection fully establish ho jaye
    }
}

// --- BOT COMMANDS ---
bot.start((ctx) => {
    ctx.reply('👋 Welcome! Commands:\n/login - Connect WhatsApp\n/getpic <number> - Download DP\n/chat - View active chats');
});

bot.command('login', (ctx) => {
    ctx.reply('Login method select karein:', Markup.inlineKeyboard([
        Markup.button.callback('QR Code Se', 'login_qr'),
        Markup.button.callback('Pairing Code Se', 'login_code')
    ]));
});

bot.action('login_qr', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.reply('⌛ QR Code generate ho raha hai...');
    initWhatsApp(ctx, ctx.from.id, false);
});

bot.action('login_code', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.reply('📞 Apna number country code ke sath bhejein (Bina + ke):\n\nExample:\nIndia: `/number 919876543210`\nRussia: `/number 77079335643`', { parse_mode: 'Markdown' });
});

bot.command('number', (ctx) => {
    // Regex se command ke baad ka text filter kiya
    const text = ctx.message.text.replace(/\/number/g, '').trim();
    if (!text) return ctx.reply('❌ Sahi format: `/number 77079335643`', { parse_mode: 'Markdown' });
    
    ctx.reply('⌛ Pairing Code request kiya ja raha hai, kripya 6 seconds wait karein...');
    initWhatsApp(ctx, ctx.from.id, true, text);
});

bot.command('getpic', async (ctx) => {
    const sock = userSessions[ctx.from.id];
    if (!sock) return ctx.reply('❌ Pehle /login karke WhatsApp link karein.');

    const args = ctx.message.text.replace(/\/getpic/g, '').trim();
    if (!args) return ctx.reply('❌ Sahi format: `/getpic 77079335643`', { parse_mode: 'Markdown' });

    const targetNumber = cleanNum(args);
    await ctx.reply('🔍 Profile picture search ki ja rahi hai...');

    try {
        const ppUrl = await sock.profilePictureUrl(`${targetNumber}@s.whatsapp.net`, 'image');
        if (ppUrl) {
            await ctx.replyWithPhoto(ppUrl, { caption: `📸 +${targetNumber} ki profile picture.` });
        } else {
            ctx.reply('😔 Is number par koi public profile picture nahi mili.');
        }
    } catch (err) {
        ctx.reply('❌ DP nahi mil saki (Number galat hai ya privacy restrictions hain).');
    }
});

bot.command('chat', async (ctx) => {
    const sock = userSessions[ctx.from.id];
    if (!sock) return ctx.reply('❌ Pehle /login karke WhatsApp link karein.');

    await ctx.reply('📂 Chats load ho rahi hain...');
    try {
        const chats = await sock.store?.chats?.all() || Object.values(sock.contacts || {});
        if (chats.length === 0) return ctx.reply('📭 Abhi koi active chat history nahi mili.');

        let chatList = '💬 *WhatsApp Chats:*\n\n';
        chats.slice(0, 15).forEach((chat, index) => {
            const name = chat.name || chat.verifiedName || chat.id.split('@')[0];
            chatList += `${index + 1}. *${name}* (${chat.id.split('@')[0]})\n`;
        });
        ctx.reply(chatList, { parse_mode: 'Markdown' });
    } catch (err) {
        ctx.reply('❌ Chats load karne me dikkat aayi.');
    }
});

// Render Web Server Setup
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running safely!');
}).listen(PORT, () => {
    console.log(`Web server active on port ${PORT}`);
});

bot.launch().then(() => console.log('🚀 Telegram Bot Active!'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
                delete userSessions[userId];
                try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}
            }
        }
    });

    if (usePairingCode && phoneNumber) {
        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(cleanNum(phoneNumber));
                code = code?.match(/.{1,4}/g)?.join('-') || code;
                await ctx.reply(`🔑 Aapka Pairing Code hai:\n\n\`${code}\`\n\nIs code ko apne WhatsApp notification me enter karein.`, { parse_mode: 'Markdown' });
            } catch (err) {
                ctx.reply('❌ Pairing code request fail ho gaya. Number format check karein.');
            }
        }, 9000);
    }
}

// --- BOT COMMANDS ---
bot.start((ctx) => {
    ctx.reply('👋 Welcome! Commands:\n/login - Connect WhatsApp\n/getpic <number> - Download DP\n/chat - View active chats');
});

bot.command('login', (ctx) => {
    ctx.reply('Login method select karein:', Markup.inlineKeyboard([
        Markup.button.callback('QR Code Se', 'login_qr'),
        Markup.button.callback('Pairing Code Se', 'login_code')
    ]));
});

bot.action('login_qr', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.reply('⌛ QR Code generate ho raha hai...');
    initWhatsApp(ctx, ctx.from.id, false);
});

bot.action('login_code', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.reply('📞 Apna number country code ke sath bhejein:\n`/number 919876543210`', { parse_mode: 'Markdown' });
});

bot.command('number', (ctx) => {
    // Yeh line message se sirf numbers nikaal legi (baaki sab remove kar degi)
    const text = ctx.message.text.replace(/\/number/g, '').trim(); 
    if (!text) return ctx.reply('❌ Sahi format: `/number 77079335643`', { parse_mode: 'Markdown' });
    ctx.reply('⌛ Pairing Code request kiya ja raha hai...');
    initWhatsApp(ctx, ctx.from.id, true, text);
});


bot.command('getpic', async (ctx) => {
    const sock = userSessions[ctx.from.id];
    if (!sock) return ctx.reply('❌ Pehle /login karke WhatsApp link karein.');

    const args = ctx.message.text.split(' ')[1];
    if (!args) return ctx.reply('❌ Sahi format: `/getpic 919876543210`', { parse_mode: 'Markdown' });

    const targetNumber = cleanNum(args);
    await ctx.reply('🔍 Profile picture search ki ja rahi hai...');

    try {
        const ppUrl = await sock.profilePictureUrl(`${targetNumber}@s.whatsapp.net`, 'image');
        if (ppUrl) {
            await ctx.replyWithPhoto(ppUrl, { caption: `📸 +${targetNumber} ki profile picture.` });
        } else {
            ctx.reply('😔 Is number par koi public profile picture nahi mili.');
        }
    } catch (err) {
        ctx.reply('❌ DP nahi mil saki (Number galat hai ya privacy rigid hai).');
    }
});

bot.command('chat', async (ctx) => {
    const sock = userSessions[ctx.from.id];
    if (!sock) return ctx.reply('❌ Pehle /login karke WhatsApp link karein.');

    await ctx.reply('📂 Chats load ho rahi hain...');
    try {
        const chats = await sock.store?.chats?.all() || Object.values(sock.contacts || {});
        if (chats.length === 0) return ctx.reply('📭 Abhi koi active chat history nahi mili.');

        let chatList = '💬 *WhatsApp Chats:*\n\n';
        chats.slice(0, 15).forEach((chat, index) => {
            const name = chat.name || chat.verifiedName || chat.id.split('@')[0];
            chatList += `${index + 1}. *${name}* (${chat.id.split('@')[0]})\n`;
        });
        ctx.reply(chatList, { parse_mode: 'Markdown' });
    } catch (err) {
        ctx.reply('❌ Chats load karne me dikkat aayi.');
    }
});

// Render Deployment Check: Render dynamic port bind karta hai, isliye dummy HTTP server running rakhna zaroori hai
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running safely!');
}).listen(PORT, () => {
    console.log(`Web server active on port ${PORT}`);
});

bot.launch().then(() => console.log('🚀 Telegram Bot Active!'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
