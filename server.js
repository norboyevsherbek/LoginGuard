const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const session = require('express-session');
const http = require('http');
const { Server } = require('socket.io');
const { Telegraf } = require('telegraf');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const geoip = require('geoip-lite');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = 3000;

// Papkalarni tekshirish
if (!fs.existsSync('./public/uploads')) {
    fs.mkdirSync('./public/uploads', { recursive: true });
}

// Rasm yuklash (Multer) sozlamalari
const storage = multer.diskStorage({
    destination: './public/uploads/',
    filename: (req, file, cb) => {
        cb(null, 'avatar-' + req.session.userId + '-' + Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// Telegram Bot Sozlamalari
const TELEGRAM_BOT_TOKEN = '8901554970:AAHBdjtt0SGXq9gTjWpo1x6bSioc3RmFRhc'; 
const ADMIN_CHAT_ID = '8058840101'; 
const BOT_USERNAME = '@logingoardbot'; 

app.locals.botUsername = BOT_USERNAME;
let bot;
if (TELEGRAM_BOT_TOKEN && TELEGRAM_BOT_TOKEN.length > 30) {
    bot = new Telegraf(TELEGRAM_BOT_TOKEN);
    bot.use((ctx, next) => next());
    bot.launch()
       .then(() => console.log("✅ Telegraf Bot ishga tushdi!"))
       .catch(err => console.error("❌ Bot xatosi:", err));
}

function notifyAdmin(text) {
    if (bot && ADMIN_CHAT_ID) {
        bot.telegram.sendMessage(ADMIN_CHAT_ID, text, { parse_mode: 'HTML' }).catch(err => {});
    }
}

// Express sozlamalari
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public')); 

const sessionMiddleware = session({ 
    secret: 'loginguard-secret-key', 
    resave: false, 
    saveUninitialized: true 
});
app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

// Ma'lumotlar bazasi (SQLite)
const db = new sqlite3.Database('./database.sqlite');
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT, role TEXT, telegram_chat_id TEXT, session_token TEXT, avatar TEXT, is_2fa_enabled INTEGER DEFAULT 0, is_blocked INTEGER DEFAULT 0)`);
    db.run(`CREATE TABLE IF NOT EXISTS login_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, ip_address TEXT, device_info TEXT, login_time DATETIME DEFAULT CURRENT_TIMESTAMP, location TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS blocked_ips (id INTEGER PRIMARY KEY AUTOINCREMENT, ip_address TEXT UNIQUE)`);
    db.run(`CREATE TABLE IF NOT EXISTS failed_login_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, ip_address TEXT, attempt_time DATETIME DEFAULT CURRENT_TIMESTAMP, location TEXT)`);
    
    // Eski bazaga yangi ustunlar qoshish (xato bermasligi uchun e'tiborsiz qoldiriladi)
    db.run(`ALTER TABLE users ADD COLUMN is_2fa_enabled INTEGER DEFAULT 0`, (err) => {});
    db.run(`ALTER TABLE users ADD COLUMN is_blocked INTEGER DEFAULT 0`, (err) => {});
    db.run(`ALTER TABLE login_logs ADD COLUMN location TEXT`, (err) => {});
    db.run(`ALTER TABLE failed_login_logs ADD COLUMN location TEXT`, (err) => {});

    // ADMIN PAROLI (Doimiy User!1 qilib belgilandi)
    bcrypt.hash('User!1', 10, (err, hash) => {
        db.run(`UPDATE users SET password = ? WHERE username = 'admin'`, [hash], function(err) {
            if (this.changes === 0) {
                db.run(`INSERT INTO users (username, password, role) VALUES ('admin', ?, 'admin')`, [hash]);
            }
        });
    });
});

// Yordamchi funksiyalar
function getFlagEmoji(countryCode) {
    if (!countryCode) return '🌍';
    const codePoints = countryCode.toUpperCase().split('').map(char => 127397 + char.charCodeAt());
    return String.fromCodePoint(...codePoints);
}

function getLocation(ip) {
    if (ip === '127.0.0.1' || ip === '::1') return "💻 Lokal tarmoq";
    const geo = geoip.lookup(ip);
    if (geo) return `${getFlagEmoji(geo.country)} ${geo.country}, ${geo.city || 'Noma\'lum shahar'}`;
    return "🌍 Noma'lum";
}

function getDeviceInfo(ua) {
    if (!ua) return "Noma'lum qurilma";
    let os = "Noma'lum OS", browser = "Noma'lum Brauzer";
    if (ua.includes("Windows")) os = "Windows"; 
    else if (ua.includes("Mac OS")) os = "MacOS"; 
    else if (ua.includes("Android")) os = "Android"; 
    else if (ua.includes("iPhone")) os = "iOS";
    
    if (ua.includes("Chrome")) browser = "Chrome"; 
    else if (ua.includes("Safari") && !ua.includes("Chrome")) browser = "Safari";
    
    return `${os} / ${browser}`;
}

// Himoya qatlamlari
const requireAuth = (req, res, next) => {
    if (!req.session.userId) return res.redirect('/login');
    db.get(`SELECT session_token, is_blocked FROM users WHERE id = ?`, [req.session.userId], (err, user) => {
        if (!user || user.session_token !== req.session.token || user.is_blocked === 1) { 
            req.session.destroy(); 
            return res.redirect('/login'); 
        }
        next();
    });
};

const requireAdmin = (req, res, next) => {
    if (req.session.role === 'admin') {
        next();
    } else {
        res.status(403).send("Ruxsat yo'q");
    }
};

// ===============================================
// TELEGRAM BOT MANTIG'I (CHAT VA 2FA UCHUN)
// ===============================================
if (bot) {
    bot.start((ctx) => handleBotConnection(ctx, ctx.payload));
    bot.on('text', (ctx) => {
        const text = ctx.message.text.trim();
        const chatId = ctx.chat.id.toString();

        // 1. ADMIN TOMONIDAN JONLI CHATGA JAVOB YUBORISH
        if (chatId === ADMIN_CHAT_ID && !text.toLowerCase().startsWith('start') && !text.toLowerCase().startsWith('/start')) {
            io.emit('message', { username: 'Admin (Telegram)', text: text, role: 'admin' });
            return ctx.reply("📨 Javobingiz saytdagi foydalanuvchiga yuborildi!", { disable_notification: true });
        }

        // 2. FOYDALANUVCHINI 2FA GA ULANISHI
        let username = text;
        if (text.toLowerCase().startsWith('start ')) username = text.substring(6).trim();
        else if (text.toLowerCase().startsWith('/start ')) username = text.substring(7).trim();
        handleBotConnection(ctx, username);
    });

    function handleBotConnection(ctx, requestedUsername) {
        const chatId = ctx.chat.id; 
        if (!requestedUsername) {
            return ctx.replyWithHTML("👋 <b>Salom! Bu LoginGuard boti.</b>\n\nSaytdagi profilingizni ulash uchun loginingizni yozib yuboring.\nMasalan: <code>admin</code>\n\n<i>Yoki saytdan kelgan chat xabarlariga to'g'ridan-to'g'ri shu yerda javob yozishingiz mumkin.</i>");
        }
        
        db.get(`SELECT * FROM users WHERE username = ?`, [requestedUsername], (err, user) => {
            if (!user) return ctx.replyWithHTML(`❌ <b>${requestedUsername}</b> logini tizimda topilmadi. To'g'ri login yozganingizga ishonch hosil qiling.`);
            
            db.run(`UPDATE users SET telegram_chat_id = ?, is_2fa_enabled = 1 WHERE id = ?`, [chatId.toString(), user.id], () => {
                const tempPassword = Math.floor(100000 + Math.random() * 900000).toString(); 
                bcrypt.hash(tempPassword, 10, (err, hash) => {
                    db.run(`UPDATE users SET password = ? WHERE id = ?`, [hash, user.id], () => {
                        ctx.replyWithHTML(`✅ <b>Muvaffaqiyatli ulandi!</b>\n2FA tizimi faollashdi.\n\nLoginingiz: <code>${user.username}</code>\nYangi vaqtinchalik parol: <code>${tempPassword}</code>\n\nEndi saytga qaytib, sahifani bitta yangilang (Refresh)!`);
                    });
                });
            });
        });
    }
}

// ===============================================
// MARSHRUTLAR (ROUTING)
// ===============================================
app.get('/', (req, res) => res.render('index'));
app.get('/login', (req, res) => res.render('login', { error: null, success: null }));

const failedAttempts = {}; 

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    let ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress; 
    if(ipAddress === '::1') ipAddress = '127.0.0.1'; 
    
    const now = Date.now();

    // Spam kirishni oldini olish
    if (failedAttempts[ipAddress] && failedAttempts[ipAddress].blockUntil > now) {
        return res.render('login', { error: `Ko'p xato! ${Math.ceil((failedAttempts[ipAddress].blockUntil - now) / 1000)} soniya kuting.`, success: null });
    }

    // IP bloklanganligini tekshirish
    db.get(`SELECT * FROM blocked_ips WHERE ip_address = ?`, [ipAddress], (err, blocked) => {
        if (blocked) return res.render('login', { error: "XATOLIK: Sizning IP bloklangan!", success: null });
        
        db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, user) => {
            if (!user) return recordFailedAttempt(ipAddress, username, res);
            if (user.is_blocked === 1) return res.render('login', { error: "Hisobingiz administrator tomonidan bloklangan!", success: null });

            bcrypt.compare(password, user.password, (err, isMatch) => {
                if (isMatch) {
                    delete failedAttempts[ipAddress]; // Muvaffaqiyatli bo'lsa xatolarni tozalash
                    
                    if (user.telegram_chat_id && user.is_2fa_enabled === 1) {
                        const otp = Math.floor(100000 + Math.random() * 900000).toString();
                        req.session.pendingUserId = user.id; 
                        req.session.pendingUsername = user.username; 
                        req.session.pendingRole = user.role; 
                        req.session.pendingAvatar = user.avatar; 
                        req.session.otp = otp;
                        
                        bot.telegram.sendMessage(user.telegram_chat_id, `🔐 <b>2FA KOD:</b> <code>${otp}</code>`, { parse_mode: 'HTML' }).catch(e=>{});
                        return res.render('login', { error: null, success: "Telegramga kod yuborildi!", requires2FA: true });
                    } else {
                        const sessionToken = Math.random().toString(36).substring(2); 
                        const deviceInfo = getDeviceInfo(req.headers['user-agent']);
                        const location = getLocation(ipAddress);
                        
                        db.run(`UPDATE users SET session_token = ? WHERE id = ?`, [sessionToken, user.id], () => {
                            req.session.token = sessionToken; 
                            req.session.userId = user.id; 
                            req.session.username = user.username; 
                            req.session.role = user.role; 
                            req.session.avatar = user.avatar;
                            
                            db.run(`INSERT INTO login_logs (user_id, ip_address, device_info, location) VALUES (?, ?, ?, ?)`, [user.id, ipAddress, deviceInfo, location]);
                            return res.redirect('/dashboard');
                        });
                    }
                } else {
                    return recordFailedAttempt(ipAddress, username, res);
                }
            });   
        });
    });
});

// Xato urinishlarni yozib olish funksiyasi
function recordFailedAttempt(ipAddress, username, res) {
    const location = getLocation(ipAddress);
    db.run(`INSERT INTO failed_login_logs (username, ip_address, location) VALUES (?, ?, ?)`, [username, ipAddress, location], () => {
        if (!failedAttempts[ipAddress]) failedAttempts[ipAddress] = { count: 0, blockUntil: 0 };
        failedAttempts[ipAddress].count += 1; 
        
        let attempts = failedAttempts[ipAddress].count;
        if (attempts === 5) {
            failedAttempts[ipAddress].blockUntil = Date.now() + (30 * 1000);
            notifyAdmin(`⚠️ <b>30 SONIYA BLOK</b>\nLogin: <code>${username}</code>\nIP: <code>${ipAddress}</code>\n📍 ${location}`);
            return res.render('login', { error: `5 ta xato! 30 soniya kuting.`, success: null });
        } else if (attempts >= 7) {
            failedAttempts[ipAddress].blockUntil = Date.now() + (60 * 1000); 
            notifyAdmin(`🚨 <b>1 DAQIQA BLOK</b>\nLogin: <code>${username}</code>\nIP: <code>${ipAddress}</code>\n📍 ${location}`);
            return res.render('login', { error: `Juda ko'p xato! 1 daqiqa kuting.`, success: null });
        }
        return res.render('login', { error: "Parol yoki login noto'g'ri!", success: null });
    });
}

// 2FA Tasdiqlash
app.post('/verify-2fa', (req, res) => {
    let ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress; 
    if(ipAddress === '::1') ipAddress = '127.0.0.1';
    
    if (req.session.otp && req.session.otp === req.body.otp) {
        const sessionToken = Math.random().toString(36).substring(2); 
        const deviceInfo = getDeviceInfo(req.headers['user-agent']);
        const location = getLocation(ipAddress);
        
        db.run(`UPDATE users SET session_token = ? WHERE id = ?`, [sessionToken, req.session.pendingUserId], () => {
            req.session.token = sessionToken; 
            req.session.userId = req.session.pendingUserId; 
            req.session.username = req.session.pendingUsername; 
            req.session.role = req.session.pendingRole; 
            req.session.avatar = req.session.pendingAvatar;
            
            db.run(`INSERT INTO login_logs (user_id, ip_address, device_info, location) VALUES (?, ?, ?, ?)`, [req.session.userId, ipAddress, deviceInfo, location]);
            res.redirect('/dashboard');
        });
    } else {
        res.render('login', { error: "Tasdiqlash kodi xato!", success: null, requires2FA: true });
    }
});

app.post('/forgot-password', (req, res) => {
    db.get(`SELECT * FROM users WHERE username = ?`, [req.body.username], (err, user) => {
        if (!user) return res.json({ success: false, message: "Bunday tizimda yo'q!" });
        res.json({ success: true, message: "Botga o'ting", redirectUrl: `https://t.me/${BOT_USERNAME.replace('@', '')}?start=${user.username}` });
    });
});

app.post('/register', (req, res) => {
    bcrypt.hash(req.body.password, 10, (err, hash) => {
        db.run(`INSERT INTO users (username, password, role) VALUES (?, ?, 'user')`, [req.body.username, hash], function(err) {
            if (err) return res.render('login', { error: "Bunday foydalanuvchi mavjud!", success: null });
            res.render('login', { error: null, success: "Ro'yxatdan o'tdingiz." });
        });
    });
});

app.get('/admin/export-logs', requireAdmin, (req, res) => {
    db.all(`SELECT users.username, login_logs.ip_address, login_logs.location, login_logs.device_info, login_logs.login_time FROM login_logs JOIN users ON login_logs.user_id = users.id ORDER BY login_time DESC`, (err, logs) => {
        let csv = 'Login, IP Manzil, Joylashuv, Qurilma, Vaqt\n';
        logs.forEach(row => { 
            csv += `${row.username}, ${row.ip_address}, ${row.location || 'Noma\'lum'}, ${row.device_info}, ${row.login_time ? new Date(row.login_time + 'Z').toLocaleString('uz-UZ') : 'Noma\'lum'}\n`; 
        });
        res.header('Content-Type', 'text/csv; charset=utf-8'); 
        res.attachment('Kiberxavfsizlik_Jurnali.csv'); 
        return res.send(csv);
    });
});

// ===============================================
// ASOSIY BOSH PANEL (DASHBOARD) MANTIG'I
// ===============================================
app.get('/dashboard', requireAuth, (req, res) => {
    const filter = req.query.filter || 'all';
    let timeFilterSQL = ""; 
    let failedTimeFilterSQL = "";
    
    if (filter === 'today') { 
        timeFilterSQL = " WHERE login_logs.login_time >= datetime('now', '-24 hours')"; 
        failedTimeFilterSQL = " WHERE attempt_time >= datetime('now', '-24 hours')"; 
    } else if (filter === 'week') { 
        timeFilterSQL = " WHERE login_logs.login_time >= datetime('now', '-7 days')"; 
        failedTimeFilterSQL = " WHERE attempt_time >= datetime('now', '-7 days')"; 
    } else if (filter === 'month') { 
        timeFilterSQL = " WHERE login_logs.login_time >= datetime('now', '-30 days')"; 
        failedTimeFilterSQL = " WHERE attempt_time >= datetime('now', '-30 days')"; 
    }

    if (req.session.role === 'admin') {
        db.get(`SELECT COUNT(id) as count FROM users`, (err, countRow) => {
            const totalUsers = countRow ? countRow.count : 0;
            
            db.get(`SELECT COUNT(id) as total_logs FROM login_logs ${timeFilterSQL.replace('login_logs.', '')}`, (err, logsCountRow) => {
                const totalLogsCount = logsCountRow ? logsCountRow.total_logs : 0;
                
                db.all(`SELECT login_logs.id, users.username, users.role, login_logs.ip_address, login_logs.location, login_logs.login_time, blocked_ips.id as is_blocked FROM login_logs JOIN users ON login_logs.user_id = users.id LEFT JOIN blocked_ips ON login_logs.ip_address = blocked_ips.ip_address ${timeFilterSQL} ORDER BY login_time DESC LIMIT 50`, (err, logs) => {
                    db.all(`SELECT * FROM blocked_ips`, (err, blockedIps) => {
                        db.all(`SELECT * FROM failed_login_logs ${failedTimeFilterSQL} ORDER BY attempt_time DESC LIMIT 20`, (err, failedLogs) => {
                            const notifications = failedLogs || [];
                            res.render('dashboard', { 
                                user: req.session, 
                                logs: logs || [], 
                                blockedIpsCount: blockedIps ? blockedIps.length : 0, 
                                failedLogs: failedLogs || [], 
                                notifications: notifications, 
                                totalUsers: totalUsers, 
                                totalLogsCount: totalLogsCount, 
                                currentFilter: filter 
                            });
                        });
                    });
                });
            });
        });
    } else {
        let userTimeFilterSQL = timeFilterSQL ? timeFilterSQL.replace('WHERE ', 'AND ') : ""; 
        let userFailedTimeFilterSQL = failedTimeFilterSQL ? failedTimeFilterSQL.replace('WHERE ', 'AND ') : "";
        
        db.get(`SELECT COUNT(id) as total_logs FROM login_logs WHERE user_id = ? ${userTimeFilterSQL.replace('login_logs.', '')}`, [req.session.userId], (err, logsCountRow) => {
            const totalLogsCount = logsCountRow ? logsCountRow.total_logs : 0;
            
            db.all(`SELECT id, ip_address, location, login_time FROM login_logs WHERE user_id = ? ${userTimeFilterSQL.replace('login_logs.', '')} ORDER BY login_time DESC LIMIT 50`, [req.session.userId], (err, logs) => {
                db.all(`SELECT ip_address, location, attempt_time FROM failed_login_logs WHERE username = ? ${userFailedTimeFilterSQL} ORDER BY attempt_time DESC LIMIT 20`, [req.session.username], (err, failedLogs) => {
                    const notifications = failedLogs || [];
                    res.render('dashboard', { 
                        user: req.session, 
                        logs: logs || [], 
                        adminLogs: [], 
                        blockedIpsCount: 0, 
                        failedLogs: failedLogs || [], 
                        notifications: notifications, 
                        totalLogsCount: totalLogsCount, 
                        currentFilter: filter 
                    });
                });
            });
        });
    }
});

// ===============================================
// BILDIRISHNOMALAR
// ===============================================
app.get('/notifications', requireAuth, (req, res) => {
    if (req.session.role === 'admin') {
        db.all(`SELECT * FROM failed_login_logs ORDER BY attempt_time DESC LIMIT 100`, (err, failedLogs) => {
            const notifications = (failedLogs || []).map(f => ({
                title: 'Shubhali kirish urinishi!', 
                msg: `<b>${f.username}</b> akkauntiga <b>${f.ip_address}</b> IP manzilidan noto'g'ri parol kiritildi.`, 
                time: f.attempt_time
            }));
            res.render('notifications', { user: req.session, notifications });
        });
    } else {
        db.all(`SELECT * FROM failed_login_logs WHERE username = ? ORDER BY attempt_time DESC LIMIT 50`, [req.session.username], (err, failedLogs) => {
            const notifications = (failedLogs || []).map(f => ({
                title: 'Xavf ogohlantirishi!', 
                msg: `Sizning hisobingizga <b>${f.ip_address}</b> IP manzilidan xato parol bilan kirishga urinish bo'ldi!`, 
                time: f.attempt_time
            }));
            res.render('notifications', { user: req.session, notifications });
        });
    }
});

app.post('/clear-notifications', requireAuth, (req, res) => {
    if (req.session.role === 'admin') {
        db.run(`DELETE FROM failed_login_logs`, () => res.redirect('/notifications'));
    } else {
        db.run(`DELETE FROM failed_login_logs WHERE username = ?`, [req.session.username], () => res.redirect('/notifications'));
    }
});

// ===============================================
// FOYDALANUVCHILARNI VA IP LARNI BOSHQARISH
// ===============================================
app.get('/admin/users', requireAuth, requireAdmin, (req, res) => { 
    db.all(`SELECT id, username, role, is_blocked FROM users`, (err, allUsers) => { 
        res.render('users', { user: req.session, allUsers: allUsers || [] }); 
    }); 
});

app.post('/admin/users/toggle-block', requireAuth, requireAdmin, (req, res) => { 
    db.get(`SELECT is_blocked FROM users WHERE id = ?`, [req.body.user_id], (err, u) => { 
        if(u) { 
            const newStatus = u.is_blocked ? 0 : 1; 
            db.run(`UPDATE users SET is_blocked = ?, session_token = NULL WHERE id = ?`, [newStatus, req.body.user_id], () => res.redirect('back')); 
        } else {
            res.redirect('back');
        } 
    }); 
});

app.post('/admin/users/edit', requireAuth, requireAdmin, (req, res) => { 
    const { user_id, new_username, new_password } = req.body; 
    if(new_password && new_password.trim() !== "") { 
        bcrypt.hash(new_password, 10, (err, hash) => { 
            db.run(`UPDATE users SET username = ?, password = ? WHERE id = ?`, [new_username, hash, user_id], () => res.redirect('back')); 
        }); 
    } else { 
        db.run(`UPDATE users SET username = ? WHERE id = ?`, [new_username, user_id], () => res.redirect('back')); 
    } 
});

app.post('/admin/users/delete', requireAuth, requireAdmin, (req, res) => { 
    db.run(`DELETE FROM users WHERE id = ?`, [req.body.user_id], () => { 
        db.run(`DELETE FROM login_logs WHERE user_id = ?`, [req.body.user_id], () => res.redirect('back')); 
    }); 
});

app.get('/admin/blocked-ips', requireAuth, requireAdmin, (req, res) => { 
    db.all(`SELECT * FROM blocked_ips`, (err, blockedIps) => { 
        res.render('blocked-ips', { user: req.session, blockedIps: blockedIps || [] }); 
    }); 
});

app.post('/admin/block-ip', requireAdmin, (req, res) => { 
    db.run(`INSERT OR IGNORE INTO blocked_ips (ip_address) VALUES (?)`, [req.body.ip_address], () => res.redirect('back')); 
});

app.post('/admin/unblock-ip', requireAdmin, (req, res) => { 
    db.run(`DELETE FROM blocked_ips WHERE ip_address = ?`, [req.body.ip_address], () => res.redirect('back')); 
});

// ===============================================
// SOZLAMALAR VA QURILMALAR
// ===============================================
app.get('/sessions', requireAuth, (req, res) => { 
    db.all(`SELECT ip_address, location, login_time, device_info FROM login_logs WHERE user_id = ? ORDER BY login_time DESC LIMIT 50`, [req.session.userId], (err, logs) => {
        res.render('sessions', { user: req.session, logs: logs || [], error: null, success: req.query.success ? "Boshqa barcha qurilmalardan chiqildi!" : null });
    }); 
});

app.get('/settings', requireAuth, (req, res) => { 
    db.get(`SELECT * FROM users WHERE id = ?`, [req.session.userId], (err, dbUser) => { 
        res.render('settings', { user: req.session, dbUser: dbUser || {}, error: null, success: null }); 
    }); 
});

app.post('/settings/update', requireAuth, upload.single('avatar'), (req, res) => { 
    db.get(`SELECT * FROM users WHERE id = ?`, [req.session.userId], (err, user) => { 
        bcrypt.compare(req.body.current_password, user.password, (err, isMatch) => { 
            if (!isMatch) return res.render('settings', { user: req.session, dbUser: user, error: "Joriy parol noto'g'ri!", success: null }); 
            
            let finalUsername = req.body.new_username || user.username; 
            let finalAvatar = req.file ? '/uploads/' + req.file.filename : user.avatar; 
            let is2FA = req.body.enable_2fa === 'on' ? 1 : 0; 
            
            const saveToDb = (hash) => { 
                db.run(`UPDATE users SET username = ?, password = ?, avatar = ?, is_2fa_enabled = ? WHERE id = ?`, [finalUsername, hash, finalAvatar, is2FA, req.session.userId], function(err) { 
                    if (err) return res.render('settings', { user: req.session, dbUser: user, error: "Bu login band!", success: null }); 
                    
                    req.session.username = finalUsername; 
                    req.session.avatar = finalAvatar; 
                    user.is_2fa_enabled = is2FA; 
                    res.render('settings', { user: req.session, dbUser: user, error: null, success: "Ma'lumotlar yangilandi!" }); 
                }); 
            }; 
            
            if (req.body.new_password && req.body.new_password.trim() !== "") {
                bcrypt.hash(req.body.new_password, 10, (err, hash) => saveToDb(hash)); 
            } else {
                saveToDb(user.password);
            }
        }); 
    }); 
});

app.post('/settings/logout-others', requireAuth, (req, res) => { 
    const newToken = Math.random().toString(36).substring(2); 
    db.run(`UPDATE users SET session_token = ? WHERE id = ?`, [newToken, req.session.userId], () => { 
        req.session.token = newToken; 
        res.redirect('/sessions?success=1'); 
    }); 
});

// Qo'shimcha marshrutlar
app.get('/admin/add-user', requireAuth, requireAdmin, (req, res) => { 
    res.render('add-user', { user: req.session }); 
});

app.post('/admin/add-user', requireAuth, requireAdmin, (req, res) => { 
    const { username, password, role } = req.body; 
    bcrypt.hash(password, 10, (err, hash) => { 
        db.run(`INSERT INTO users (username, password, role) VALUES (?, ?, ?)`, [username, hash, role || 'user'], (err) => { 
            if (err) return res.redirect('/admin/add-user'); 
            res.redirect('/dashboard'); 
        }); 
    }); 
});

app.get('/analytics', requireAuth, (req, res) => { 
    db.all(`SELECT login_time FROM login_logs`, (err, logs) => { 
        db.all(`SELECT attempt_time FROM failed_login_logs`, (err2, failedLogs) => { 
            res.render('analytics', { user: req.session, logs: logs || [], failedLogs: failedLogs || [] }); 
        }); 
    }); 
});

app.get('/logout', (req, res) => { 
    req.session.destroy(); 
    res.redirect('/login'); 
});

// ===============================================
// JONLI CHAT UCHUN SOCKET.IO MANTIG'I
// ===============================================
io.on('connection', (socket) => {
    const req = socket.request; 
    const userRole = req.session.role || 'guest'; 
    const username = req.session.username || 'Mehmon';
    
    if (userRole === 'admin') socket.join('admins');
    
    socket.on('chatMessage', (msg) => { 
        io.emit('message', { username, text: msg, role: userRole }); 
        
        // Agar yozayotgan odam Admin bo'lmasa, uni Telegramga jo'natish
        if (userRole !== 'admin' && bot && ADMIN_CHAT_ID) {
            const telegramMsg = `💬 <b>YANGI XABAR (Jonli Chat)</b>\n👤 Foydalanuvchi: <b>${username}</b>\n📝 Matn: ${msg}`;
            bot.telegram.sendMessage(ADMIN_CHAT_ID, telegramMsg, { parse_mode: 'HTML' }).catch(err => console.error(err));
        }
    });
});

server.listen(PORT, () => console.log(`Server: http://localhost:${PORT}`));