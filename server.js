const express = require('express');
const rateLimit = require('express-rate-limit');
const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const cors = require('cors');
const axios = require('axios');
const midtransClient = require('midtrans-client');
const crypto = require('crypto');
const jwt = require('jsonwebtoken'); // 🔥 TAMBAHKAN INI DI SINI
const { Redis } = require('@upstash/redis'); // 🔥 TAMBAHAN BARU
const { notifyOps, runReminders, logAudit } = require('./ops');
const { createPendingLicense } = require('./licenses');
const { getTpl } = require('./templates');
const trial = require('./trial');

if (!process.env.FIREBASE_SERVICE_ACCOUNT_B64) {
  throw new Error('FIREBASE_SERVICE_ACCOUNT_B64 environment variable is missing!');
}

let serviceAccount;
try {
  const decoded = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8');
  serviceAccount = JSON.parse(decoded);
} catch (e) {
  throw new Error('Gagal parse FIREBASE_SERVICE_ACCOUNT_B64: ' + e.message);
}

if (getApps().length === 0) {
  initializeApp({ credential: cert(serviceAccount) });
}

const db = getFirestore();
const app = express();
app.set('trust proxy', 1);

// 🔥 INISIALISASI REDIS
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

let messaging = null;
try { messaging = require('firebase-admin/messaging').getMessaging(); } catch (e) { messaging = null; }

const pushAllAdmins = async (title, body, type) => {
  if (!messaging) return;
  try {
    const snapT = await db.collection('fcm_tokens').get();
    const tokens = snapT.docs.map(d => d.data().token).filter(Boolean);
    if (!tokens.length) return;
    const msg = { tokens, data: { title, body, type: type || 'info' } };
    if (messaging.sendEachForMulticast) await messaging.sendEachForMulticast(msg);
    else await messaging.sendMulticast(msg);
  } catch (e) { console.error('Push gagal:', e.message); }
};

app.use(express.json());
app.use(cors());

const snapLimiter = rateLimit({ windowMs: 60 * 1000, max: 5 });

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const VIP_GROUP_ID = process.env.VIP_GROUP_ID || '-1004477570254';
const PUBLIC_GROUP_ID = process.env.PUBLIC_GROUP_ID || '-1003951848425';
const PAYMENT_WEB_URL = process.env.PAYMENT_WEB_URL || 'https://aphelion-pay.vercel.app';
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
// 🔥 KONFIGURASI JWT UNTUK USER (Aman, fallback ke JWT_SECRET jika JWT_USER_SECRET belum di-set di Vercel)
const JWT_USER_SECRET = process.env.JWT_USER_SECRET || process.env.JWT_SECRET;
const escapeHtml = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const sendTelegramMessage = async (chatId, text, options = {}) => {
  try {
    const response = await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text, ...options });
    if (String(chatId) === String(VIP_GROUP_ID) || String(chatId) === String(PUBLIC_GROUP_ID)) {
      const mid = response.data.result.message_id;
      db.collection('bot_messages').add({ chatId: String(chatId), messageId: mid, at: new Date().toISOString() }).catch(() => {});
    }
    return response.data;
  } catch (error) {
    if (options.parse_mode) {
      try {
        const r2 = await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text });
        return r2.data;
      } catch (e2) { console.error('Plain resend gagal:', e2.message); }
    }
    console.error('Error sending Telegram message:', error.response ? JSON.stringify(error.response.data) : error.message);
    throw error;
  }
};

const answerCallbackQuery = async (cbId, text) => {
  try { await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, { callback_query_id: cbId, text }); }
  catch (e) { /* abaikan */ }
};

const createInviteLink = async (chatId, options = {}) => {
  try {
    const response = await axios.post(`${TELEGRAM_API}/createChatInviteLink`, { chat_id: chatId, ...options });
    return response.data.result;
  } catch (error) {
    console.error('Error creating invite link:', error.response ? JSON.stringify(error.response.data) : error.message);
    throw error;
  }
};

const kickFromGroup = async (userId) => {
  await axios.post(`${TELEGRAM_API}/banChatMember`, { chat_id: VIP_GROUP_ID, user_id: userId });
  await axios.post(`${TELEGRAM_API}/unbanChatMember`, { chat_id: VIP_GROUP_ID, user_id: userId });
};

console.log('Bot Telegram dikonfigurasi untuk Vercel Webhook...');

const MIDTRANS_MODE = process.env.MIDTRANS_MODE || 'production';
const isProduction = MIDTRANS_MODE === 'production';

const snap = new midtransClient.Snap({
  isProduction,
  serverKey: isProduction ? process.env.MIDTRANS_SERVER_KEY : process.env.MIDTRANS_SANDBOX_SERVER_KEY,
  clientKey: isProduction ? process.env.MIDTRANS_CLIENT_KEY : process.env.MIDTRANS_SANDBOX_CLIENT_KEY
});

app.get('/', (req, res) => {
  res.json({ status: 'OK', message: 'Aphelion Backend System & Bot is Running Smoothly on Vercel!' });
});

// ===== 🎁 HANDLER CLAIM TRIAL =====
const handleTrialClaim = async (uid, telegramUsername, chatId, firstName) => {
  try {
    const result = await trial.claimTrial(db, {
      uid, telegramUsername,
      telegramApi: TELEGRAM_API,
      publicGroupId: PUBLIC_GROUP_ID,
      source: 'bot'
    });

    if (!result.ok) {
      const tplKey = {
        'DISABLED': 'trial_disabled',
        'NOT_MEMBER': 'trial_not_member',
        'USED': 'trial_used',
        'QUOTA_FULL': 'trial_quota_full',
        'PACKAGE_INVALID': 'trial_disabled'
      }[result.code] || 'trial_disabled';
      await sendTelegramMessage(chatId, await getTpl(tplKey), { parse_mode: 'HTML' });
      return;
    }

    await sendTelegramMessage(chatId, await getTpl('trial_success', {
      nama: escapeHtml(firstName || telegramUsername || 'Teman'),
      token: result.code,
      hari: result.days,
      package: result.package
    }), { parse_mode: 'HTML' });
  } catch (e) {
    console.error('Trial claim error:', e.message);
    try { await sendTelegramMessage(chatId, '⚠️ Terjadi kesalahan. Coba lagi sebentar.'); } catch (err) {}
  }
};

// ===== 📍 LOCATION PING (FULL CACHE REDIS + FIRESTORE HYBRID) =====
const pingLimiter = rateLimit({ windowMs: 2 * 1000, max: 1, keyGenerator: (req) => req.body?.token || req.ip });

app.post('/api/user/ping', pingLimiter, async (req, res) => {
  try {
    const { token, deviceId, lat, lng, accuracy, speed, bearing, battery, netType, appState, consent, paused } = req.body || {};
    if (!token || !deviceId) return res.status(400).json({ error: 'Token & deviceId wajib' });
    if (typeof lat !== 'number' || typeof lng !== 'number') return res.status(400).json({ error: 'Koordinat tidak valid' });

    let u = null, uid = null, trackEnabled = false;
    const cacheKey = `auth_cache:${token}`;

    // ✅ 1. CEK REDIS DENGAN ERROR HANDLING YANG BENAR
    let cachedAuth = null;
    try { 
      cachedAuth = await redis.get(cacheKey); 
    } catch (e) { 
      console.error("🚨 REDIS AUTH CACHE ERROR:", e.message);
      // CRITICAL: Jangan fallback ke Firestore! Tolak request dengan aman agar kuota tidak habis.
      return res.status(503).json({ status: 'SYNC_PAUSED', message: 'Server sedang sinkronisasi' });
    }

    if (cachedAuth) {
      const parsed = typeof cachedAuth === 'string' ? JSON.parse(cachedAuth) : cachedAuth;
      u = parsed.user;
      uid = parsed.uid;
      trackEnabled = parsed.trackEnabled;
    } else {
      // 🐢 Fallback ke Firestore HANYA jika Redis benar-benar kosong (cache miss normal)
      try {
        const settingsDoc = await db.collection('settings').doc('app').get();
        trackEnabled = settingsDoc.exists ? (settingsDoc.data().trackEnabled === true) : false;

        const snapUsers = await db.collection('users').where('token', '==', token).limit(1).get();
        if (snapUsers.empty) return res.status(404).json({ status: 'NOT_FOUND' });
        
        uid = snapUsers.docs[0].id;
        u = snapUsers.docs[0].data();

        await redis.set(cacheKey, JSON.stringify({ uid, user: u, trackEnabled }), { ex: 600 }); 
      } catch (dbErr) {
        console.error("🚨 FIRESTORE FALLBACK ERROR:", dbErr.message);
        return res.status(503).json({ status: 'SYNC_PAUSED', message: 'Database sedang sibuk' });
      }
    }

    if (!trackEnabled) return res.status(403).json({ status: 'TRACKING_DISABLED' });
    if (u.status !== 'ACTIVE') return res.status(403).json({ status: 'INACTIVE' });
    if (u.deviceId && u.deviceId !== deviceId) return res.status(403).json({ status: 'HWID_MISMATCH' });
    if (consent !== true) return res.status(200).json({ status: 'NO_CONSENT' });
    
    if (paused === true) {
      try { await redis.set(`loc:${uid}`, JSON.stringify({ uid, paused: true, ts: new Date().toISOString() }), { ex: 60 }); } 
      catch(e){ console.error("Redis paused error:", e.message); }
      return res.status(200).json({ status: 'PAUSED' });
    }

    const now = new Date();
    const point = {
      uid, username: u.username || null, packageName: u.packageName || null,
      lat, lng, accuracy: typeof accuracy === 'number' ? accuracy : null,
      speed: typeof speed === 'number' ? speed : null, bearing: typeof bearing === 'number' ? bearing : null,
      battery: typeof battery === 'number' ? battery : null, netType: netType || null, 
      appState: appState || 'foreground', consent: true, paused: false, ts: now.toISOString()
    };

    // ✅ 2. TULIS KE REDIS (Jika gagal, abaikan, JANGAN tembak Firestore)
    try { await redis.set(`loc:${uid}`, JSON.stringify(point), { ex: 60 }); } 
    catch(redisErr) { console.error("Redis loc error:", redisErr.message); }

    // ✅ 3. TULIS JEJAK KE FIRESTORE (Hanya jika Redis last_db_write berhasil dibaca)
    try {
        const lastDbWrite = await redis.get(`last_db_write:${uid}`);
        if (!lastDbWrite) {
          await db.collection('user_locations').doc(uid).set(point, { merge: true });
          await db.collection('location_history').doc(uid).collection('points').add({
            lat, lng, accuracy: point.accuracy, speed: point.speed, bearing: point.bearing, ts: point.ts
          });
          await redis.set(`last_db_write:${uid}`, 'done', { ex: 300 }); 
        }
    } catch (dbErr) { 
        console.error("🚨 FIRESTORE WRITE ERROR:", dbErr.message);
        // Jangan biarkan error ini menyebabkan loop write
    }

    res.status(200).json({ status: 'OK', ts: now.toISOString() });
  } catch (e) {
    console.error('PING ERROR:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// A. Webhook Telegram
app.post('/api/telegram-webhook', async (req, res) => {
  if (req.headers['x-telegram-bot-api-secret-token'] !== process.env.TELEGRAM_SECRET_TOKEN) {
    return res.status(403).send('Invalid Telegram Secret Token');
  }

  db.collection('settings').doc('app').set({ lastTelegramPing: new Date().toISOString() }, { merge: true }).catch(() => {});

  try {
    const update = req.body;

    if (update.callback_query) {
      const cb = update.callback_query;
      const uid = String(cb.from.id);
      if (cb.data === 'trial_claim') {
        await answerCallbackQuery(cb.id, 'Memproses permintaan trial...');
        await db.collection('telegram_chats').doc(uid).set({
          chatId: cb.message.chat.id, username: cb.from.username || null,
          firstName: cb.from.first_name || null, updatedAt: new Date().toISOString()
        }, { merge: true });
        await handleTrialClaim(uid, cb.from.username, cb.message.chat.id, cb.from.first_name);
      }
      return res.status(200).json({ status: 'ok' });
    }

    if (update.message && update.message.text) {
      const msg = update.message;
      const uid = String(msg.from.id);
      const text = msg.text;

      if (text.startsWith('/start trial') || text === '/start trial') {
        if (msg.chat.type === 'private') {
          await db.collection('telegram_chats').doc(uid).set({
            chatId: msg.chat.id, username: msg.from.username || null,
            firstName: msg.from.first_name || null, updatedAt: new Date().toISOString()
          }, { merge: true });
          await handleTrialClaim(uid, msg.from.username, msg.chat.id, msg.from.first_name);
        }
        return res.status(200).json({ status: 'ok' });
      }

      if (text === '/trial' || text.startsWith('/trial ')) {
        if (msg.chat.type === 'private') {
          await db.collection('telegram_chats').doc(uid).set({
            chatId: msg.chat.id, username: msg.from.username || null,
            firstName: msg.from.first_name || null, updatedAt: new Date().toISOString()
          }, { merge: true });
          await handleTrialClaim(uid, msg.from.username, msg.chat.id, msg.from.first_name);
        } else {
          await sendTelegramMessage(msg.chat.id, '📩 Ketik /trial di chat pribadi bot untuk klaim trial.');
        }
        return res.status(200).json({ status: 'ok' });
      }

      if (text.startsWith('/start') || text.startsWith('/beli')) {
        if (msg.chat.type !== 'private') {
          await sendTelegramMessage(msg.chat.id, await getTpl('pm_redirect'));
        } else {
          await db.collection('telegram_chats').doc(uid).set({
            chatId: msg.chat.id, username: msg.from.username || null,
            firstName: msg.from.first_name || null, updatedAt: new Date().toISOString()
          }, { merge: true });

          const setDoc2 = await db.collection('settings').doc('app').get();
          if (setDoc2.exists && setDoc2.data().maintenance === true) {
            await sendTelegramMessage(msg.chat.id, await getTpl('beli_maintenance'), { parse_mode: 'HTML' });
            return res.status(200).json({ status: 'ok' });
          }

          let statusText = '🔴 Belum ada langganan aktif';
          try {
            const uDoc = await db.collection('users').doc(uid).get();
            if (uDoc.exists) {
              const u = uDoc.data();
              if (u.status === 'BANNED') statusText = '⚫ Akun diblokir';
              else if (u.status === 'ACTIVE' && u.expiredAt && u.expiredAt.toDate() > new Date())
                statusText = `🟢 Aktif sampai ${u.expiredAt.toDate().toLocaleString('id-ID')}`;
              else statusText = '🟠 Langganan kedaluwarsa';
            }
          } catch (e) { /* abaikan */ }

          const payLink = `${PAYMENT_WEB_URL}?uid=${uid}`;
          const trialSet = await trial.getTrialSettings(db);
          const pesan = await getTpl('beli_intro', {
            nama: escapeHtml(msg.from.first_name),
            status: statusText,
            link: payLink,
            trialDays: trialSet.days
          });

          const markup = {
            inline_keyboard: [
              [{ text: '💳 BAYAR VIP', url: payLink }],
              [{ text: '🎁 COBA TRIAL GRATIS', callback_data: 'trial_claim' }]
            ]
          };

          await sendTelegramMessage(msg.chat.id, pesan, {
            parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: markup
          });
        }
      }

      const isBotAdmin = (String(uid) === String(process.env.OWNER_TELEGRAM_ID)) ||
        (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(s => s.trim()).filter(Boolean).includes(String(uid));

      if (isBotAdmin && text.startsWith('/gentoken')) {
        const parts = text.split(/\s+/);
        const pkg = parts[1];
        const days = parseInt(parts[2]) || 30;
        if (!pkg) {
          await sendTelegramMessage(msg.chat.id, 'Format: /gentoken <packageName> <hari>\nContoh: /gentoken com.deimos.phantom 30');
        } else {
          const pkgDoc = await db.collection('packages').where('packageName', '==', pkg).where('active', '==', true).limit(1).get();
          if (pkgDoc.empty) {
            await sendTelegramMessage(msg.chat.id, `❌ Package ${pkg} belum terdaftar / nonaktif.`);
          } else {
            const { code, masked } = await createPendingLicense(db, { packageName: pkg, durationDays: days, createdBy: `bot:${msg.from.username || uid}`, source: 'bot' });
            await logAudit(`bot:${msg.from.username || uid}`, 'TOKEN_GENERATE', pkg, { days, via: 'telegram' });
            await notifyOps(`🎫 <b>Token via BOT</b> oleh ${msg.from.username || uid}\n${masked} • ${pkg} • ${days} hari`, { safe: `🎫 Token via bot oleh ${msg.from.username || uid} • ${pkg}` });
            await sendTelegramMessage(msg.chat.id, `🎫 <b>TOKEN BARU</b>\nApp: <code>${pkg}</code>\nDurasi: ${days} hari\nKode:\n<code>${code}</code>\n⚠️ Simpan, kode tak ditampilkan ulang.`, { parse_mode: 'HTML' });
          }
        }
        return res.status(200).json({ status: 'ok' });
      }

      if (isBotAdmin && text.startsWith('/resetdevice')) {
        const target = String(text.split(/\s+/)[1] || '').replace(/^@/, '').toLowerCase();
        if (!target) {
          await sendTelegramMessage(msg.chat.id, 'Format: /resetdevice <username_telegram|uid>');
        } else {
          let found = null;
          const byName = await db.collection('users').where('username', '==', target).limit(1).get();
          if (!byName.empty) found = byName.docs[0];
          else { const byId = await db.collection('users').doc(target).get(); if (byId.exists) found = byId; }
          if (!found) await sendTelegramMessage(msg.chat.id, `❌ User @${target} tidak ditemukan.`);
          else {
            await db.collection('users').doc(found.id).update({ deviceId: null });
            await logAudit(`bot:${msg.from.username || uid}`, 'RESET_HWID', found.id, { via: 'telegram' });
            await notifyOps(`🔄 <b>Reset device</b> @${target} via BOT`, { safe: `🔄 Reset device @${target} via bot` });
            await pushAllAdmins('🔄 RESET DEVICE', `@${target} direset via bot oleh ${msg.from.username || uid}`, 'critical');
            await sendTelegramMessage(msg.chat.id, `✅ Device @${target} dilepas.`);
          }
        }
        return res.status(200).json({ status: 'ok' });
      }
    }

    if (update.message && update.message.new_chat_members) {
      const msg = update.message;
      const chatId = msg.chat.id;
      const isVip = String(chatId) === String(VIP_GROUP_ID);

      for (const member of update.message.new_chat_members) {
        if (!member.is_bot) {
          const trialSet = await trial.getTrialSettings(db);
          const pesan = await getTpl(isVip ? 'welcome_vip' : 'welcome_public', {
            nama: escapeHtml(member.first_name), uid: member.id, trialDays: trialSet.days
          });
          const opts = { parse_mode: 'HTML' };
          if (!isVip) {
            opts.reply_markup = { inline_keyboard: [[{ text: '🎁 COBA TRIAL GRATIS', callback_data: 'trial_claim' }]] };
          }
          await sendTelegramMessage(chatId, pesan, opts);
        }
      }
    }

    res.status(200).json({ status: 'ok' });
  } catch (error) {
    console.error('Telegram Webhook Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// B. Snap Token
app.post('/api/get-snap-token', snapLimiter, async (req, res) => {
  try {
    const setDoc = await db.collection('settings').doc('app').get();
    if (setDoc.exists && setDoc.data().maintenance === true) return res.status(503).json({ error: 'Sistem sedang maintenance.' });
    const minPrice = (setDoc.exists && setDoc.data().price) ? parseInt(setDoc.data().price) : 10000;
    const { telegram_id, email, amount } = req.body;
    if (!telegram_id || !email || !amount) return res.status(400).json({ error: 'Telegram ID, Email, dan Nominal wajib diisi!' });
    if (!/^\d{5,15}$/.test(String(telegram_id))) return res.status(400).json({ error: 'Telegram ID tidak valid.' });
    const payAmount = parseInt(amount);
    if (payAmount < minPrice) return res.status(400).json({ error: `Minimal pembayaran adalah Rp ${minPrice}!` });
    const uid = String(telegram_id);
    const orderId = 'APHELION-' + Date.now();
    const transaction = await snap.createTransaction({
      transaction_details: { order_id: orderId, gross_amount: payAmount },
      custom_field1: uid, custom_field2: email,
      customer_details: { first_name: 'User-' + uid, email },
      item_details: [{ id: 'aphelion-sub', price: payAmount, quantity: 1, name: 'Aphelion VIP Access' }]
    });
    res.json({ token: transaction.token, redirect_url: transaction.redirect_url });
  } catch (error) {
    console.error('Midtrans Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// C. Webhook Midtrans
app.post('/api/payment-webhook', async (req, res) => {
  try {
    const notification = req.body;
    const serverKey = isProduction ? process.env.MIDTRANS_SERVER_KEY : process.env.MIDTRANS_SANDBOX_SERVER_KEY;
    const expectedSignature = crypto.createHash('sha512')
      .update(`${notification.order_id}${notification.status_code}${notification.gross_amount}${serverKey}`)
      .digest('hex');
    if (expectedSignature !== notification.signature_key) return res.status(403).json({ error: 'Invalid signature' });

    const transactionStatus = notification.transaction_status;
    const fraudStatus = notification.fraud_status;
    const uid = String(notification.custom_field1 || '');
    const userEmail = notification.custom_field2;

    if (transactionStatus == 'capture' || transactionStatus == 'settlement') {
      if (fraudStatus == 'accept' || !fraudStatus) {
        if (!/^\d{5,15}$/.test(uid)) return res.status(200).json({ status: 'IGNORED_INVALID_UID' });
        db.collection('settings').doc('app').set({ lastPaymentPing: new Date().toISOString() }, { merge: true }).catch(() => {});
        const setDocP = await db.collection('settings').doc('app').get();
        const planDays = (setDocP.exists && setDocP.data().planDays) ? parseInt(setDocP.data().planDays) : 30;
        const tokenMod = 'APHELION-' + crypto.randomBytes(4).toString('hex').toUpperCase();
        const expiredDate = new Date();
        expiredDate.setDate(expiredDate.getDate() + planDays);

        let username = null;
        try {
          const chatInfo = await db.collection('telegram_chats').doc(uid).get();
          if (chatInfo.exists) username = chatInfo.data().username || null;
        } catch (e) { /* abaikan */ }

        const existingUser = await db.collection('users').doc(uid).get();
        const isNewUser = !existingUser.exists;

        await db.collection('users').doc(uid).set({
          uid, username, email: userEmail || 'tidak_ada_email',
          token: tokenMod, deviceId: existingUser.exists ? existingUser.data().deviceId : null,
          expiredAt: expiredDate, status: 'ACTIVE',
          source: 'payment', tier: 'vip',
          packageName: existingUser.exists ? existingUser.data().packageName : null,
          remindedH3: false, remindedH1: false,
          createdAt: existingUser.exists && existingUser.data().createdAt ? existingUser.data().createdAt : new Date().toISOString()
        });

        try { await db.collection('trial_claims').doc(uid).delete(); } catch (e) { /* ignore */ }

        if (isNewUser) {
          try {
            const snapT = await db.collection('fcm_tokens').get();
            const tokens = snapT.docs.map(d => d.data().token).filter(Boolean);
            if (tokens.length && messaging) {
              await messaging.sendEachForMulticast({
                tokens,
                data: { title: '👥 User Baru!', body: `${username || 'User-' + uid} • Rp ${parseInt(notification.gross_amount).toLocaleString('id-ID')}`, type: 'newuser' }
              });
            }
          } catch (e) { console.error('Push user baru gagal:', e.message); }
        }

        try {
          const amount = parseInt(notification.gross_amount) || 0;
          const dateKey = new Date().toISOString().slice(0, 10);
          await db.collection('transactions').doc(notification.order_id).set({
            orderId: notification.order_id, uid, amount, status: transactionStatus,
            channel: notification.payment_type || 'unknown', email: userEmail || null,
            mode: MIDTRANS_MODE, paidAt: new Date().toISOString()
          });
          await db.collection('finance_daily').doc(dateKey).set({ date: dateKey }, { merge: true });
          await db.collection('finance_daily').doc(dateKey).update({ gross: FieldValue.increment(amount), count: FieldValue.increment(1) });
          await db.collection('finance_total').doc('all').set({ gross: FieldValue.increment(amount), count: FieldValue.increment(1) }, { merge: true });
          await notifyOps(`💰 <b>Pembayaran Masuk</b>\nRp ${amount.toLocaleString('id-ID')} • UID <code>${uid}</code>`, { safe: `💰 Pembayaran masuk • UID ${uid}`, type: 'pay' });
          await pushAllAdmins('💰 Donasi Masuk!', `Rp ${amount.toLocaleString('id-ID')} • UID ${uid} • ${planDays} hari`, 'pay');
        } catch (e) { console.error('Ledger write gagal:', e.message); }

        try {
          const chatDoc = await db.collection('telegram_chats').doc(uid).get();
          const chatId = chatDoc.exists ? chatDoc.data().chatId : uid;
          let inviteText = '⚠️ Link invite VIP gagal dibuat otomatis.';
          let inviteMarkup = undefined;
          try {
            const invite = await createInviteLink(VIP_GROUP_ID, { member_limit: 1 });
            inviteText = '🚪 Ketuk tombol di bawah untuk masuk (link sekali pakai):';
            inviteMarkup = { inline_keyboard: [[{ text: '🚪 MASUK GRUP VIP', url: invite.invite_link }]] };
          } catch (invErr) { console.error('Gagal invite VIP:', invErr.message); }
          const msg = await getTpl('payment_success', { tanggal: expiredDate.toLocaleString('id-ID'), token: tokenMod, invite: inviteText });
          await sendTelegramMessage(chatId, msg, { parse_mode: 'HTML', ...(inviteMarkup ? { reply_markup: inviteMarkup } : {}) });
        } catch (err) { console.error("Gagal mengirim DM:", err.message); }
      }
    }
    res.status(200).json({ status: 'OK' });
  } catch (error) {
    console.error('Webhook Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// D. LOGIN APP PRODUKSI v2
const modLoginLimiter = rateLimit({ windowMs: 60 * 1000, max: 20 });

const handleModLogin = async (req, res) => {
  try {
    const { token, deviceId, telegramUsername, packageName, deviceInfo } = req.body || {};
    if (!token || !deviceId) return res.status(400).json({ error: 'Token dan Device ID wajib dikirim dari App!' });
    const tg = telegramUsername ? String(telegramUsername).trim().replace(/^@/, '').toLowerCase() : null;
    const pkg = packageName ? String(packageName).trim() : null;
    const snapUsers = await db.collection('users').where('token', '==', token).limit(1).get();
    if (snapUsers.empty) return res.status(404).json({ status: 'NOT_FOUND', message: 'Token tidak terdaftar!' });
    const doc = snapUsers.docs[0];
    const uid = doc.id;
    const u = doc.data();
    const now = new Date();
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || null;
    const devLabel = deviceInfo || deviceId;

    if (u.status === 'BANNED') return res.status(403).json({ status: 'BANNED', message: 'Akun Anda diblokir.' });
    if (u.status === 'REVOKED') return res.status(403).json({ status: 'REVOKED', message: 'Lisensi dicabut.' });

    if (pkg && u.packageName && u.packageName !== pkg) {
      await logAudit('system', 'LOGIN_REJECT_PACKAGE', uid, { reqPkg: pkg, tokenPkg: u.packageName, deviceId });
      return res.status(403).json({ status: 'PACKAGE_MISMATCH', message: `Lisensi hanya berlaku untuk ${u.packageName}.` });
    }

    if (u.status === 'PENDING') {
      if (!tg) return res.status(400).json({ status: 'BAD_REQUEST', message: 'Username Telegram wajib.' });
      if (!pkg) return res.status(400).json({ status: 'BAD_REQUEST', message: 'Package name wajib.' });

      if (u.source === 'trial') {
        const deviceUsed = await trial.checkTrialDevice(db, deviceId);
        if (deviceUsed) {
          await logAudit('system', 'LOGIN_REJECT_TRIAL_DEVICE', uid, { deviceId });
          return res.status(403).json({ status: 'TRIAL_DEVICE_USED', message: 'Perangkat ini sudah pernah menggunakan trial (1 device = 1 trial seumur hidup).' });
        }
      }

      const days = parseInt(u.durationDays) || 30;
      const exp = new Date(now.getTime() + days * 86400000);
      await db.collection('users').doc(uid).update({
        status: 'ACTIVE', username: tg, deviceId,
        deviceInfo: deviceInfo || null,
        activatedAt: now.toISOString(), expiredAt: exp,
        lastLoginAt: now.toISOString(), lastLoginIp: ip,
        remindedH3: false, remindedH1: false
      });

      if (u.source === 'trial') {
        await trial.markTrialActivated(db, uid, deviceId);
        await logAudit('system', 'TRIAL_ACTIVATE', uid, { telegram: `@${tg}`, package: pkg, device: devLabel });
        await notifyOps(`🎁 <b>TRIAL AKTIF</b>\n@${tg} • ${pkg} • ${days}d\nDevice: ${devLabel}`, { safe: `🎁 Trial aktif: @${tg}`, type: 'login' });
      } else {
        await logAudit('system', 'USER_LOGIN', uid, { first: true, telegram: `@${tg}`, package: pkg, device: devLabel });
        await notifyOps(`🔔 <b>AKTIVASI BARU</b>\n@${tg} aktif di ${pkg}\nDevice: ${devLabel}`, { safe: `🔔 Aktivasi: @${tg} • ${pkg}`, type: 'login' });
      }
      await pushAllAdmins('🔔 LOGIN BARU!', `@${tg} aktif di ${pkg} • ${devLabel}`, 'login');
      return res.status(200).json({ status: 'ACTIVE', firstLogin: true, message: 'Aktivasi berhasil!', expiredAt: exp.toISOString() });
    }

    if (u.status === 'EXPIRED' || (u.expiredAt && u.expiredAt.toDate && u.expiredAt.toDate() < now)) {
      if (u.status !== 'EXPIRED') await db.collection('users').doc(uid).update({ status: 'EXPIRED' });
      return res.status(403).json({ status: 'EXPIRED', message: 'Masa aktif habis!' });
    }

    if (tg) {
      const bound = u.username ? String(u.username).replace(/^@/, '').toLowerCase() : null;
      if (bound && bound !== tg) {
        await logAudit('system', 'LOGIN_REJECT_TG', uid, { reqTg: tg, boundTg: bound, deviceId });
        return res.status(403).json({ status: 'TG_MISMATCH', message: `Akun terdaftar atas @${u.username}.` });
      }
      if (!bound) await db.collection('users').doc(uid).update({ username: tg });
    }

    if (!u.deviceId) {
      await db.collection('users').doc(uid).update({ deviceId, deviceInfo: deviceInfo || null });
    } else if (u.deviceId !== deviceId) {
      await logAudit('system', 'LOGIN_REJECT_HWID', uid, { deviceId, bound: u.deviceId });
      await notifyOps(`🚨 <b>HWID MISMATCH</b>\nUID <code>${uid}</code>`, { critical: true });
      await pushAllAdmins('🚨 HWID MISMATCH!', `UID ${uid} device lain`, 'critical');
      return res.status(403).json({ status: 'HWID_MISMATCH', message: 'Token terikat di perangkat lain.' });
    }

    const patchOk = { lastLoginAt: now.toISOString(), lastLoginIp: ip };
    if (pkg && !u.packageName) patchOk.packageName = pkg;
    await db.collection('users').doc(uid).update(patchOk);
    await logAudit('system', 'USER_LOGIN', uid, { first: false, telegram: u.username ? `@${u.username}` : null, package: pkg || u.packageName || null, device: devLabel });
    await notifyOps(`🔔 <b>LOGIN</b>\n@${u.username || uid} • ${pkg || u.packageName || '-'}\n${devLabel}`, { safe: `🔔 Login: @${u.username || uid}`, type: 'login' });
    await pushAllAdmins('🔔 LOGIN', `@${u.username || uid} • ${devLabel}`, 'login');
    res.status(200).json({ status: 'ACTIVE', firstLogin: false, message: 'Otentikasi Berhasil!', expiredAt: u.expiredAt && u.expiredAt.toDate ? u.expiredAt.toDate().toISOString() : null });
  } catch (error) {
    console.error('MOD LOGIN ERROR:', error.message);
    res.status(500).json({ error: error.message });
  }
};

app.post('/api/mod/verify', modLoginLimiter, handleModLogin);
app.post('/api/mod/login', modLoginLimiter, handleModLogin);

// D2. Silent check
const checkLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
app.post('/api/mod/check', checkLimiter, async (req, res) => {
  try {
    const { token, deviceId, packageName } = req.body || {};
    if (!token) return res.status(400).json({ error: 'Token wajib' });
    const snap = await db.collection('users').where('token', '==', String(token)).limit(1).get();
    if (snap.empty) return res.json({ status: 'NOT_FOUND' });
    const u = snap.docs[0].data();
    const now = new Date();
    let status = u.status || 'EXPIRED';
    if (status === 'ACTIVE' && u.expiredAt && u.expiredAt.toDate && u.expiredAt.toDate() < now) status = 'EXPIRED';
    if (status === 'ACTIVE') {
      if (packageName && u.packageName && u.packageName !== packageName) status = 'PACKAGE_MISMATCH';
      else if (deviceId && u.deviceId && u.deviceId !== deviceId) status = 'HWID_MISMATCH';
    }
    res.json({ status, expiredAt: u.expiredAt && u.expiredAt.toDate ? u.expiredAt.toDate().toISOString() : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// E. Cron
app.get('/api/cron/check-expired', async (req, res) => {
  try {
    if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).send('Unauthorized');
    const now = new Date();
    const snapshot = await db.collection('users').where('status', '==', 'ACTIVE').where('expiredAt', '<', now).get();
    let expiredCount = 0;
    for (const doc of snapshot.docs) {
      const uid = doc.id;
      const u = doc.data();
      await db.collection('users').doc(uid).update({ status: 'EXPIRED' });
      expiredCount++;
      const chatDoc = await db.collection('telegram_chats').doc(uid).get();
      const chatId = chatDoc.exists ? chatDoc.data().chatId : uid;
      try {
        if (u.tier === 'trial' || u.source === 'trial') {
          await sendTelegramMessage(chatId, await getTpl('trial_expired', { nama: u.username || 'Teman' }), { parse_mode: 'HTML' });
        } else {
          try { await kickFromGroup(uid); } catch (e) {}
          await sendTelegramMessage(chatId, await getTpl('expired_dm'), { parse_mode: 'HTML' });
        }
      } catch (err) { console.error(`Gagal DM user ${uid}:`, err.message); }
    }
    let reminded = 0;
    try { reminded = await runReminders(); } catch (e) { console.error('Reminders gagal:', e.message); }

    // 📍 PURGE jejak lokasi lama sesuai retentionDays
    try {
      const setDoc = await db.collection('settings').doc('app').get();
      const retentionDays = parseInt(setDoc.exists ? setDoc.data().retentionDays : 7) || 7;
      const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
      const userSnap = await db.collection('user_locations').limit(200).get();
      let purged = 0;
      for (const udoc of userSnap.docs) {
        const uid = udoc.id;
        const oldPoints = await db.collection('location_history').doc(uid).collection('points')
          .where('ts', '<', cutoff).limit(200).get();
        if (!oldPoints.empty) {
          const batch = db.batch();
          oldPoints.docs.forEach(d => batch.delete(d.ref));
          await batch.commit();
          purged += oldPoints.size;
        }
      }
      if (purged > 0) console.log(`📍 Purged ${purged} location points > ${retentionDays}d`);
    } catch (e) { console.error('Location purge error:', e.message); }

    const setW = await db.collection('settings').doc('app').get();
    const st = setW.exists ? setW.data() : {};
    if (st.maintenance !== true && st.lastTelegramPing) {
      const age = Date.now() - new Date(st.lastTelegramPing).getTime();
      if (age > 26 * 3600 * 1000) {
        await notifyOps(`🚨 <b>WATCHDOG</b>\nBot senyap > 24 jam`, { critical: true });
      }
    }
    await db.collection('settings').doc('app').set({ lastCronRun: new Date().toISOString() }, { merge: true });
    if (expiredCount > 0 || reminded > 0) {
      await notifyOps(`⏰ <b>Cron</b>: ${expiredCount} expired • ${reminded} reminder`, { safe: `⏰ Cron: ${expiredCount} expired • ${reminded} reminder` });
    }
    res.status(200).json({ status: 'CRON_SUCCESS', user_expired: expiredCount, reminders_sent: reminded });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// G. ADMIN PANEL API
app.use('/api/admin', require('./adminRoutes'));

module.exports = app;
