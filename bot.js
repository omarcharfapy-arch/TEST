const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const gplay = require('google-play-scraper');
const axios = require('axios');
const http = require('http');
const PQueue = require('p-queue').default;
const NodeCache = require('node-cache');

const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    red: '\x1b[31m',
    magenta: '\x1b[35m',
    black: '\x1b[30m',
    bgGreen: '\x1b[42m',
};

const log = {
    info: (msg) => console.log(`${colors.cyan}ℹ${colors.reset} ${msg}`),
    success: (msg) => console.log(`${colors.green}✓${colors.reset} ${msg}`),
    error: (msg) => console.log(`${colors.red}✗${colors.reset} ${msg}`),
    warn: (msg) => console.log(`${colors.yellow}⚠${colors.reset} ${msg}`),
    code: (msg) => console.log(`${colors.bgGreen}${colors.black}${colors.bright} ${msg} ${colors.reset}`),
    magenta: (msg) => console.log(`${colors.magenta}${msg}${colors.reset}`),
};

const MAX_FILE_SIZE_MB = 2048;
const CACHE_DURATION = 15 * 60 * 1000;
const QUEUE_CONCURRENCY = 100;
const SCRAPER_QUEUE_CONCURRENCY = parseInt(process.env.SCRAPER_QUEUE_CONCURRENCY || '25'); // Limit concurrent scraper calls

const DEVELOPER_INFO = {
    name: 'Omar Xaraf',
    instagram: 'https://instagram.com/Omarxarafp',
    instagramUrl: 'https://instagram.com/Omarxarafp',
    contact: '@Omarxarafp',
    thumbnail: 'https://i.imgur.com/7FZJvPp.jpeg'
};

const SENT_KEEP_TTL = 2 * 60 * 60; // 2 hours for files recently sent

const requestQueue = new PQueue({ concurrency: QUEUE_CONCURRENCY });
const scraperQueue = new PQueue({ concurrency: SCRAPER_QUEUE_CONCURRENCY });
const appCache = new NodeCache({ stdTTL: CACHE_DURATION / 1000, checkperiod: 120 });
const requestTracker = new Map();

appCache.on('del', (key, value) => {
    if (value && value.filename) {
        const filePath = path.join('downloads', value.filename);
        setTimeout(() => {
            try {
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                    log.info(`🗑️ Cleanup: ${value.filename} (cache expired)`);
                }
            } catch (err) {
                log.warn(`Failed to delete cached file: ${value.filename}`);
            }
        }, 1000);
    }
});

appCache.on('expired', (key, value) => {
    if (value && value.filename) {
        const filePath = path.join('downloads', value.filename);
        setTimeout(() => {
            try {
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                    log.info(`🗑️ Cleanup: ${value.filename} (cache TTL expired)`);
                }
            } catch (err) {
                log.warn(`Failed to delete expired file: ${value.filename}`);
            }
        }, 1000);
    }
});

let sock;
const SCRAPER_SERVER_URL = process.env.SCRAPER_SERVER_URL || 'http://127.0.0.1:8001';
let scraperServerProcess = null;

const scraperClient = axios.create({ baseURL: SCRAPER_SERVER_URL, timeout: 30000, httpAgent: new http.Agent({ keepAlive: true }) });

async function ensureScraperServer() {
    try {
        const res = await scraperClient.get(`/health`, { timeout: 2000 });
        if (res.data && res.data.status === 'ok') {
            log.success(`✅ Scraper server available: concurrency ${res.data.concurrency}`);
            return true;
        }
    } catch (e) {
        log.info('🔁 Scraper server not available, starting local server...');
    }

    try {
        // spawn the server in background
        scraperServerProcess = spawn('python3', ['scraper_server.py'], {
            detached: false,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        scraperServerProcess.stdout.on('data', (d) => log.info(`[scraper] ${d.toString().trim()}`));
        scraperServerProcess.stderr.on('data', (d) => log.warn(`[scraper-err] ${d.toString().trim()}`));
        // wait a moment and attempt health check
        const start = Date.now();
        while (Date.now() - start < 10000) {
            try {
                const res = await scraperClient.get(`/health`, { timeout: 2000 });
                if (res.data && res.data.status === 'ok') {
                    log.success('✅ Scraper server started');
                    return true;
                }
            } catch (e) {
                await new Promise(r => setTimeout(r, 250));
            }
        }
    } catch (err) {
        log.error(`Failed to start scraper server: ${err.message}`);
    }

    return false;
}

async function requestScraperServer(path, params = {}, retries = 3) {
    // request helper with retries and server spawn fallback
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const res = await scraperClient.get(path, { params, timeout: 30000 });
            return res.data;
        } catch (err) {
            log.warn(`Scraper server request failed (attempt ${attempt}/${retries}): ${err.message}`);
            // Try ensure server is running on first error
            if (attempt === 1) {
                try {
                    await ensureScraperServer();
                } catch (e) {
                    log.warn('ensureScraperServer failed while retrying');
                }
            }
            if (attempt < retries) {
                // small backoff
                await new Promise(r => setTimeout(r, 500 * attempt));
                continue;
            }
            throw err;
        }
    }
}
let isConnected = false;
let pairingCodeRequested = false;
let pairingCodeShown = false;
let reconnectAttempts = 0;
let isReconnecting = false;

log.success(`✅ Queue System: ${QUEUE_CONCURRENCY} concurrent requests`);
log.success(`✅ Cache System: ${CACHE_DURATION / 1000}s TTL`);

async function getUserPhoneNumber() {
    const readline = require('readline').createInterface({
        input: process.stdin,
        output: process.stdout
    });

    return new Promise((resolve) => {
        readline.question('Enter your phone number (with country code, e.g., 1234567890): ', (answer) => {
            readline.close();
            resolve(answer);
        });
    });
}

async function sendMessage(sock, jid, message) {
    if (message.text) {
        await sock.sendMessage(jid, {
            text: message.text
        });
    } else if (message.image) {
        await sock.sendMessage(jid, {
            image: message.image,
            caption: message.caption || ''
        });
    } else if (message.document) {
        await sock.sendMessage(jid, {
            document: message.document,
            fileName: message.fileName,
            mimetype: message.mimetype || 'application/vnd.android.package-archive'
        });
    }
}

async function connectToWhatsApp() {
    if (isReconnecting) {
        log.warn('إعادة اتصال جارية بالفعل، تم تجاهل المحاولة المكررة');
        return;
    }
    
    isReconnecting = true;
    // ensure scraper server is running first
    try { await ensureScraperServer(); } catch (e) { log.warn('Failed to ensure scraper server on start'); }
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version, isLatest } = await fetchLatestBaileysVersion();

    if (sock && sock.ev) {
        sock.ev.removeAllListeners();
    }

    sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: ['Windows', 'Chrome', '1.0.0'],
        connectTimeoutMs: 30000,
        keepAliveIntervalMs: 25000,
        defaultQueryTimeoutMs: 30000,
        retryRequestDelayMs: 150,
        maxMsgRetryCount: 3,
        markOnlineOnConnect: true,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        getMessage: async () => undefined,
    });

    if (!state.creds.registered && !pairingCodeRequested && !pairingCodeShown) {
        pairingCodeRequested = true;
        
        setTimeout(async () => {
            try {
                console.log('\n');
                log.info('Waiting for pairing code...');
                const phoneNumber = process.env.PHONE_NUMBER || await getUserPhoneNumber();

                if (!phoneNumber) {
                    log.error('Phone number is required for pairing');
                    return;
                }

                log.info(`Requesting pairing code for: ${phoneNumber}`);
                const code = await sock.requestPairingCode(phoneNumber.replace(/[^0-9]/g, ''));
                console.log('\n' + '='.repeat(50));
                log.code(`🔑 PAIRING CODE: ${code}`);
                console.log('='.repeat(50) + '\n');
                log.info('Open WhatsApp → Linked Devices → Link with Phone Number');
                log.info('Enter the code above to connect your bot\n');
                log.warn('⏳ Waiting for you to enter the code in WhatsApp...');
                pairingCodeShown = true;
            } catch (error) {
                log.error(`Failed to request pairing code: ${error.message}`);
                pairingCodeRequested = false;
            }
        }, 3000);
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            isConnected = false;
            
            if (statusCode === DisconnectReason.loggedOut) {
                if (!sock.authState.creds.registered) {
                    if (pairingCodeShown) {
                        log.warn('⏸️ Still waiting for you to enter the pairing code in WhatsApp...');
                    } else {
                        log.warn('⏸️ Connection closed during pairing - reconnecting...');
                        pairingCodeRequested = false;
                    }
                    
                    setTimeout(() => {
                        isReconnecting = false;
                        connectToWhatsApp();
                    }, 5000);
                } else {
                    log.error('تم تسجيل الخروج');
                    process.exit(0);
                }
            } else {
                if (reconnectAttempts >= 10) {
                    log.error('فشلت محاولات الإعادة المتعددة - توقف الاتصال');
                    isReconnecting = false;
                    setTimeout(() => connectToWhatsApp(), 30000);
                    return;
                }
                
                reconnectAttempts++;
                const delay = Math.min(reconnectAttempts * 3000, 15000);
                log.warn(`انقطاع الاتصال (${reconnectAttempts}) - إعادة بعد ${delay/1000}ث...`);
                
                setTimeout(() => {
                    isReconnecting = false;
                    connectToWhatsApp();
                }, delay);
            }
        } else if (connection === 'open') {
            isConnected = true;
            isReconnecting = false;
            reconnectAttempts = 0;
            console.log('\n');
            log.success('✅ Bot is connected successfully with pairing code!');
            log.info(`👨‍💻 المطور: ${DEVELOPER_INFO.name}`);
            log.info(`🔥 Queue: ${QUEUE_CONCURRENCY} concurrent users\n`);
        } else if (connection === 'connecting') {
            log.info('🔄 جاري الاتصال...');
        }
    });

    sock.ev.on('creds.update', saveCreds);
    
    sock.ev.on('messages.upsert', async ({ messages }) => {
        if (!isConnected || isReconnecting) {
            return;
        }

        try {
            const m = messages[0];

            if (!m.message || m.key.fromMe || !m.key.remoteJid) return;
            
            if (m.key.remoteJid === 'status@broadcast') return;

            const messageType = Object.keys(m.message)[0];
            const sender = m.key.remoteJid;

            let textMessage = '';
            if (messageType === 'conversation') {
                textMessage = m.message.conversation;
            } else if (messageType === 'extendedTextMessage') {
                textMessage = m.message.extendedTextMessage.text;
            }

            if (!textMessage || typeof textMessage !== 'string') {
                return;
            }
            
            if (textMessage.includes('Session error') || 
                textMessage.includes('decrypt') || 
                textMessage.includes('Bad MAC') ||
                textMessage.includes('MessageCounterError')) {
                return;
            }

            log.info(`📨 Message from ${sender.split('@')[0]}: ${textMessage}`);

            if (textMessage.toLowerCase() === 'hi' || textMessage.toLowerCase() === 'hello' || textMessage.toLowerCase() === 'السلام عليكم' || textMessage.toLowerCase() === 'مرحبا') {
                const welcomeMessage = `╔════════════════════════════════════════════════╗
║  🤖 *بوت تحميل التطبيقات الذكي*  ║
╚════════════════════════════════════════════════╝

✨ *أهلاً وسهلاً بك!*

📱 *كيفية الاستخدام:*
اكتب اسم التطبيق المراد تحميله

📋 *أمثلة سريعة:*
• واتساب • فري فاير • بابجي
• انستقرام • تيك توك • يوتيوب

✨ *المميزات:*
✅ تحميل سريع جداً ⚡
✅ يدعم APK و XAPK 📦
✅ أحجام حتى ${MAX_FILE_SIZE_MB}MB 💾
✅ ${QUEUE_CONCURRENCY}+ مستخدم متزامن 👥
✅ معلومات التطبيق الكاملة 📊

═════════════════════════════════════════════════
📲 *تابعني للمزيد:*
${DEVELOPER_INFO.instagram}
═════════════════════════════════════════════════`;

                await sendMessage(sock, sender, { text: welcomeMessage });
                return;
            }

            if (!textMessage.startsWith('/') && textMessage.trim().length > 0) {
                const requestId = `${sender}_${Date.now()}`;
                const queueSize = requestQueue.size + requestQueue.pending;
                
                log.info(`📊 Queue: ${queueSize} waiting, ${requestQueue.pending} processing`);
                
                requestQueue.add(async () => {
                    try {
                        await handleAppRequest(textMessage.trim(), sender, m.key, sock, requestId);
                    } catch (error) {
                        log.error(`خطأ في معالجة الطلب: ${error.message}`);
                    }
                }).catch(error => {
                    log.error(`Queue error: ${error.message}`);
                });
            }
        } catch (error) {
            log.error(`خطأ في معالجة الرسالة: ${error.message}`);
        }
    });
}

async function handleAppRequest(textMessage, sender, messageKey, sock, requestId) {
    const startTime = Date.now();
    requestTracker.set(requestId, { status: 'processing', startTime: startTime });
    
    try {
        let appName = textMessage;
        
        const arabicToEnglish = {
            'واتساب': 'whatsapp',
            'واتس اب': 'whatsapp',
            'انستقرام': 'instagram',
            'انستا': 'instagram',
            'فيسبوك': 'facebook',
            'فيس بوك': 'facebook',
            'تيك توك': 'tiktok',
            'تيكتوك': 'tiktok',
            'تويتر': 'twitter',
            'تليجرام': 'telegram',
            'تلقرام': 'telegram',
            'سناب شات': 'snapchat',
            'سناب': 'snapchat',
            'يوتيوب': 'youtube',
            'ماسنجر': 'messenger',
            'مسنجر': 'messenger',
            'جيميل': 'gmail',
            'كروم': 'chrome',
            'خرائط جوجل': 'google maps',
            'خرائط': 'maps',
            'بابجي': 'pubg',
            'فري فاير': 'free fire',
            'كول اوف ديوتي': 'call of duty',
            'نتفليكس': 'netflix',
            'سبوتيفاي': 'spotify',
            'لايت': 'lite',
            'ماكس': 'max',
            'برو': 'pro',
            'بلس': 'plus',
            'تطبيق': '',
            'برنامج': ''
        };
        
        let translatedName = appName.toLowerCase();
        let wasTranslated = false;
        
        for (const [arabic, english] of Object.entries(arabicToEnglish)) {
            if (translatedName.includes(arabic)) {
                translatedName = translatedName.replace(new RegExp(arabic, 'g'), english);
                wasTranslated = true;
            }
        }
        
        appName = translatedName.replace(/\s+/g, ' ').trim();
        
        if (wasTranslated) {
            log.info(`🔄 ترجمة: ${textMessage} → ${appName}`);
        }

        log.info(`🔍 بحث عن: ${appName}`);

        if (!isConnected || isReconnecting) {
            log.warn('⏸️ تم تأجيل الطلب - البوت يعيد الاتصال');
            return;
        }
        
        await sock.sendMessage(sender, {
            react: {
                text: '🔍',
                key: messageKey
            }
        });
        
        let result = await searchAndDownloadApp(appName);
        // If server connectivity issue occurred, retry once after ensuring server is up
        if (result && result.error && result.error.includes('فشل الاتصال بخادم التحميل')) {
            log.warn('Detected scraper server connectivity issue - retrying search once');
            try {
                await ensureScraperServer();
                // small backoff
                await new Promise(r => setTimeout(r, 300));
                result = await searchAndDownloadApp(appName);
            } catch (retryErr) {
                log.warn(`Retry failed: ${retryErr.message}`);
            }
        }

        if (!result) {
            log.error(`No result returned from scraper`);
            await sendMessage(sock, sender, { 
                text: `❌ فشل في معالجة الطلب. حاول مرة أخرى.\n\n📲 *تابعني:* ${DEVELOPER_INFO.instagram}`
            });
            return;
        }

        if (result.error) {
            log.error(`خطأ: ${result.error}`);
            if (isConnected && !isReconnecting) {
                if (result.error.includes('فشل الاتصال')) {
                    const friendly = `⚠️ *خطأ في اتصال الخادم*\n\n` +
                        `لا يمكن الوصول إلى خادم التحميل الآن، سيتم إعادة المحاولة تلقائياً.` +
                        `\n
إذا استمر الخطأ، يرجى المحاولة لاحقًا.`;
                    await sendMessage(sock, sender, { text: friendly });
                } else {
                    await sendMessage(sock, sender, { 
                        text: `❌ ${result.error}\n\n📲 *تابعني:* ${DEVELOPER_INFO.instagram}`
                    });
                }
            }
            return;
        }

        if (result.sizeMB && result.sizeMB > MAX_FILE_SIZE_MB) {
            log.warn(`ملف كبير: ${result.sizeMB} MB`);
            
            await sendMessage(sock, sender, { 
                text: `⚠️ *الملف كبير جداً!*\n\n` +
                    `📱 ${result.name}\n` +
                    `💾 ${result.size}\n` +
                    `⚠️ الحد الأقصى: ${MAX_FILE_SIZE_MB}MB\n\n` +
                    `📲 *تابعني:* ${DEVELOPER_INFO.instagram}`
            });
            return;
        }

        const infoMessage = `📦 *تفاصيل التطبيق*\n\n` +
            `📱 ${result.name}\n` +
            `🔢 ${result.version}\n` +
            `💾 ${result.size}\n` +
            `⭐ ${result.rating || 'N/A'}\n\n` +
            `⏳ جاري التحميل...\n\n` +
            `📲 *تابعني:* ${DEVELOPER_INFO.instagram}`;

        if (result.icon) {
            try {
                const iconResponse = await axios.get(result.icon, { 
                    responseType: 'arraybuffer',
                    timeout: 5000
                });
                await sendMessage(sock, sender, { 
                    image: Buffer.from(iconResponse.data),
                    caption: infoMessage 
                });
            } catch (iconError) {
                await sendMessage(sock, sender, { text: infoMessage });
            }
        } else {
            await sendMessage(sock, sender, { text: infoMessage });
        }

        const filePath = path.join('downloads', result.filename);
        if (!fs.existsSync(filePath)) {
            log.error(`الملف غير موجود: ${filePath}`);
            await sendMessage(sock, sender, { 
                text: `❌ فشل العثور على الملف المحمل\n\n📲 *تابعني:* ${DEVELOPER_INFO.instagram}`
            });
            return;
        }

        const fileType = result.isXapk ? 'XAPK' : 'APK';
        log.success(`📤 إرسال ${fileType}: ${result.filename} (${result.size})`);

        await sendMessage(sock, sender, {
            document: fs.readFileSync(filePath),
            fileName: result.filename,
            mimetype: 'application/vnd.android.package-archive'
        });

        if (result.isXapk) {
            const xapkInstructions = `📦 *ملف XAPK*\n\n` +
                `⚠️ يحتوي على بيانات إضافية (OBB)\n\n` +
                `*طريقة التثبيت:*\n` +
                `1️⃣ حمّل XAPK Installer من بلاي\n` +
                `2️⃣ افتح التطبيق واختر الملف\n` +
                `3️⃣ اضغط تثبيت\n\n` +
                `📲 *تابعني:* ${DEVELOPER_INFO.instagram}`;
            
            await sendMessage(sock, sender, { text: xapkInstructions });
        }

        await sock.sendMessage(sender, {
            react: {
                text: '✅',
                key: messageKey
            }
        });

        // Refresh cache TTL to avoid deletion right after a send
        try {
            const cacheKey = appName.toLowerCase();
            const cached = appCache.get(cacheKey);
            if (cached) {
                appCache.ttl(cacheKey, SENT_KEEP_TTL);
                log.info(`🔒 Extended TTL for cached ${cacheKey} by ${SENT_KEEP_TTL}s`);
            }
        } catch (err) {
            log.warn(`Failed to extend cache TTL: ${err.message}`);
        }

        const totalTime = Date.now() - startTime;
        log.success(`✅ تم الإرسال بنجاح في ${totalTime}ms`);
        
        requestTracker.set(requestId, { status: 'completed', duration: totalTime });

    } catch (error) {
        log.error(`خطأ في المعالجة: ${error.message}`);
        requestTracker.set(requestId, { status: 'failed', error: error.message });
        
        if (isConnected && !isReconnecting) {
            await sendMessage(sock, sender, { 
                text: `❌ حدث خطأ أثناء معالجة طلبك\n\n📲 *تابعني:* ${DEVELOPER_INFO.instagram}`
            });
        }
    } finally {
        setTimeout(() => requestTracker.delete(requestId), 60000);
    }
}

async function searchAndDownloadApp(appName) {
    return new Promise(async (resolve) => {
        try {
            const startTime = Date.now();
            
            const cacheKey = appName.toLowerCase();
            const cached = appCache.get(cacheKey);
            
            if (cached) {
                log.success(`⚡ Cache hit: ${appName} (instant)`);
                
                const filePath = path.join('downloads', cached.filename);
                if (fs.existsSync(filePath)) {
                    const searchTime = Date.now() - startTime;
                    log.success(`⚡ Completed in ${searchTime}ms (from cache)`);
                    return resolve(cached);
                } else {
                    log.warn('📦 Cache invalid - file missing, re-downloading');
                    appCache.del(cacheKey);
                }
            }
            
            let packageName = appName;
            let appIcon = null;
            let appRating = 'N/A';
            let appTitle = appName;
            
            try {
                log.info(`🔍 Google Play search: ${appName}...`);
                const gplayResults = await gplay.search({
                    term: appName,
                    num: 1,
                    throttle: 10
                });
                
                if (gplayResults && gplayResults.length > 0) {
                    const result = gplayResults[0];
                    
                    if (result.url && result.url.includes('id=')) {
                        const extractedId = result.url.split('id=')[1].split('&')[0];
                        if (extractedId && extractedId.includes('.')) {
                            packageName = extractedId;
                            appTitle = result.title || appName;
                            appIcon = result.icon || null;
                            appRating = result.scoreText || 'N/A';
                            log.success(`✓ Found: ${appTitle} (${packageName}) - ⭐${appRating}`);
                        } else {
                            log.warn(`⚠ Invalid package ID from Google Play, using query as-is`);
                        }
                    } else {
                        log.warn(`⚠ No package ID in Google Play result, using query as-is`);
                    }
                } else {
                    log.warn(`⚠ Google Play: no results, using query as-is`);
                }
            } catch (gplayError) {
                log.warn(`⚠ Google Play error: ${gplayError.message}, using query as-is`);
            }
            
            log.info(`🔎 APKPure download: ${packageName}...`);

            // Ensure the scraper server is available
            try {
                await ensureScraperServer();
            } catch (err) {
                log.warn('Could not ensure scraper server availability, proceeding with local call if needed');
            }

            // Use scraper server (HTTP) to get link info instead of spawning Python processes.
            scraperQueue.add(async () => {
                try {
                    const result = await requestScraperServer('/link', { package: packageName }, 3);
                // Prefer absolute file_path if provided by the scraper/server. Else fallback to local downloads/filename
                let filePath = result.file_path || (result.filename ? path.join('downloads', result.filename) : null);
                if (!filePath || !fs.existsSync(filePath)) {
                    // If we have a URL but no file on disk, request the server to perform the full download
                    if (result.url) {
                        await sendMessage(sock, sender, { text: `🔁 جاري تنزيل الملف الآن... الرجاء الانتظار قليلاً` });
                        try {
                            const dlRes = await requestScraperServer('/download', { package: result.packageName || result.package || appName }, 3);
                            // dlRes will be the response JSON
                            // If requestScraperServer didn't throw, dlRes is the JSON object, so assign to dlRes
                            // To keep behavior consistent, treat dlRes similar to axios response data
                            if (dlRes && dlRes.success) {
                                if (dlRes.file_path) {
                                    filePath = dlRes.file_path;
                                    result.filename = dlRes.filename || result.filename;
                                    result.file_path = filePath;
                                }
                            }
                            if (dlRes.data && dlRes.data.success && dlRes.data.file_path) {
                                filePath = dlRes.data.file_path;
                                result.filename = dlRes.data.filename || result.filename;
                                result.file_path = filePath;
                            }
                        } catch (err) {
                            log.error(`Download via server failed: ${err.message}`);
                        }
                    }

                    if (!filePath || !fs.existsSync(filePath)) {
                        log.error(`الملف غير موجود: ${filePath}`);
                        // if server returned a download URL, send it to the user as a fallback
                        if (result && result.url) {
                            const linkMsg = `🔗 *رابط التحميل المباشر*\n\n` +
                                `📱 ${appTitle}\n` +
                                `🔗 ${result.url}\n\n` +
                                `⚠️ ملاحظة: قد يتطلب التحميل فتح المتصفح أو برامج إدارة التحميل.`;
                            await sendMessage(sock, sender, { text: linkMsg });
                        } else {
                            await sendMessage(sock, sender, { 
                                text: `╔═══════════════════════════════════════════════╗\n║   ⚠️ *خطأ: الملف غير موجود*  ║\n╚═══════════════════════════════════════════════╝\n\n` +
                                    `❌ للأسف لم يتمكن النظام من\nالعثور على الملف المحمل\n\n🔄 *ما العمل:*\n• حاول الطلب مرة أخرى\n• استخدم اسم مختلف للتطبيق\n• تأكد من الإنترنت\n\n═══════════════════════════════════════════════\n📲 *تابعني:* ${DEVELOPER_INFO.instagram}`
                            });
                        }
                        return;
                    }
                }
                    const resultData = {
                        name: appTitle,
                        packageName: packageName,
                        version: 'Latest',
                        size: 'Unknown',
                        sizeMB: 0,
                        rating: appRating,
                        icon: appIcon,
                        filename: result.filename || `${packageName}.apk`,
                        isXapk: !!result.is_xapk,
                        file_path: result.file_path || null,
                        url: result.url || null,
                    };

                    // We don't cache link-only results that don't include a filename
                    if (resultData.filename && resultData.file_path) {
                        appCache.set(cacheKey, resultData);
                        log.success(`💾 Cached: ${appName}`);
                    }

                    return resultData;
                } catch (err) {
                    log.error(`Scraper server call failed: ${err.message}`);
                    // Improve error reporting and avoid generic message unless we've exhausted retries
                    return { error: `فشل الاتصال بخادم التحميل: ${err.message}` };
                }
            }).then((result) => {
                resolve(result);
            }).catch((error) => {
                log.error(`خطأ في البحث: ${error.message}`);
                resolve({ error: 'فشل البحث عن التطبيق' });
            });
        } catch (error) {
            log.error(`خطأ في البحث: ${error.message}`);
            resolve({ error: 'فشل البحث عن التطبيق' });
        }
    });
}

if (!fs.existsSync('downloads')) {
    fs.mkdirSync('downloads');
}

if (!fs.existsSync('auth_info_baileys')) {
    fs.mkdirSync('auth_info_baileys');
}

setInterval(() => {
    const stats = appCache.getStats();
    log.info(`📊 Cache Stats: ${stats.keys} items, ${stats.hits} hits, ${stats.misses} misses`);
    log.info(`📊 Request Queue: ${requestQueue.size} waiting, ${requestQueue.pending} processing`);
    log.info(`📊 Scraper Queue: ${scraperQueue.size} waiting, ${scraperQueue.pending} processing`);
    log.info(`📊 Active Requests: ${requestTracker.size}`);
}, 300000);

setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [requestId, data] of requestTracker.entries()) {
        const age = now - (data.startTime || 0);
        if (age > 600000) {
            requestTracker.delete(requestId);
            cleaned++;
        }
    }
    
    if (cleaned > 0) {
        log.info(`🧹 Cleaned ${cleaned} old request trackers`);
    }
}, 60000);

connectToWhatsApp();
