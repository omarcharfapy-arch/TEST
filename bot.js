const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const gplay = require('google-play-scraper');
const axios = require('axios');
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

const DEVELOPER_INFO = {
    name: 'Omar Xaraf',
    instagram: 'https://instagram.com/Omarxarafp',
    instagramUrl: 'https://instagram.com/Omarxarafp',
    contact: '@Omarxarafp',
    thumbnail: 'https://i.imgur.com/7FZJvPp.jpeg'
};

const requestQueue = new PQueue({ concurrency: QUEUE_CONCURRENCY });
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
                const welcomeMessage = `🤖 *بوت تحميل التطبيقات*\n\n` +
                    `أرسل اسم أي تطبيق لتحميله 📱\n` +
                    `مثال: واتساب، فري فاير، بابجي\n\n` +
                    `✅ يدعم APK و XAPK\n` +
                    `✅ حجم حتى ${MAX_FILE_SIZE_MB}MB\n` +
                    `⚡ يدعم ${QUEUE_CONCURRENCY}+ مستخدم متزامن\n\n` +
                    `📲 *تابعني:* ${DEVELOPER_INFO.instagram}`;

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
        
        const result = await searchAndDownloadApp(appName);

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
                await sendMessage(sock, sender, { 
                    text: `❌ ${result.error}\n\n📲 *تابعني:* ${DEVELOPER_INFO.instagram}`
                });
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

            const pythonProcess = spawn('python3', ['scraper.py', packageName]);

            let output = '';
            let errorOutput = '';
            let processTimeout;

            processTimeout = setTimeout(() => {
                pythonProcess.kill('SIGTERM');
                log.error('⏱️ Python process timeout (120s)');
            }, 120000);

            pythonProcess.stdout.on('data', (data) => {
                output += data.toString();
            });

            pythonProcess.stderr.on('data', (data) => {
                errorOutput += data.toString();
            });

            pythonProcess.on('close', async (code) => {
                clearTimeout(processTimeout);
                const searchTime = Date.now() - startTime;
                
                if (code !== 0) {
                    log.error(`Python scraper exited with code ${code}`);
                    if (errorOutput) log.error(`Error: ${errorOutput}`);
                    resolve({ error: 'فشل البحث عن التطبيق' });
                    return;
                }

                const lines = output.trim().split('\n');
                const lastLine = lines[lines.length - 1];

                try {
                    const result = JSON.parse(lastLine);
                    
                    if (result.error) {
                        log.warn(`⚠ Scraper error: ${result.error} - NOT caching`);
                        resolve({ error: result.error });
                        return;
                    }

                    if (!result.success || !result.filename || !result.file_path) {
                        log.error(`Invalid scraper response - NOT caching`);
                        resolve({ error: 'فشل التحميل' });
                        return;
                    }

                    const filePath = result.file_path;
                    const fileSizeInBytes = result.size;
                    const fileSizeInMB = fileSizeInBytes / (1024 * 1024);

                    const resultData = {
                        name: appTitle,
                        packageName: packageName,
                        version: result.filename.match(/_([\d.]+)_/)?.[1] || 'Latest',
                        size: `${fileSizeInMB.toFixed(2)}MB`,
                        sizeMB: fileSizeInMB,
                        rating: appRating,
                        icon: appIcon,
                        filename: result.filename,
                        isXapk: result.is_xapk || false
                    };
                    
                    appCache.set(cacheKey, resultData);
                    log.success(`💾 Cached: ${appName}`);
                    
                    log.success(`⚡ Search completed in ${searchTime}ms`);
                    resolve(resultData);

                } catch (parseError) {
                    log.error(`فشل تحليل الإخراج: ${parseError.message}`);
                    resolve({ error: 'خطأ في معالجة البيانات' });
                }
            });

            pythonProcess.on('error', (error) => {
                clearTimeout(processTimeout);
                log.error(`فشل تشغيل Python: ${error.message}`);
                resolve({ error: 'خطأ في النظام' });
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
    log.info(`📊 Queue: ${requestQueue.size} waiting, ${requestQueue.pending} processing`);
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
