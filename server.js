const express = require('express');
const rateLimit = require('express-rate-limit');
const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const cors = require('cors');
const axios = require('axios');
const midtransClient = require('midtrans-client');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { Redis } = require('@upstash/redis');
const { notifyOps, runReminders, logAudit } = require('./ops');
const { createPendingLicense } = require('./licenses');
const { getTpl } = require('./templates');
const trial = require('./trial');

const { approvePendingPayment, finalizeApprovedPayment } = require('./finance');

// 💰 Parse nominal dari caption
const parseAmount = (text) => {
  const t = String(text || '').toLowerCase().replace(/rp/g, ' ').trim();
  let m = t.match(/(\d+(?:[.,]\d+)?)\s*(rb|ribu|k)\b/);
  if (m) return Math.round(parseFloat(m[1].replace(',', '.')) * 1000);
  m = t.match(/\d[\d.,]*/);
  if (m) {
    const num = parseFloat(m[0].replace(/\./g, '').replace(',', '.'));
    if (!isNaN(num) && num >= 1000) return Math.round(num);
    if (!isNaN(num) && num > 0) return Math.round(num * 1000);
  }
  return null;
};

// 🧠 DETEKSI CHANNEL DARI TEKS USER (gopay/ovo/shopeepay/dana/bank dll)
const detectChannel = (text) => {
  const t = String(text || '').toLowerCase();
  if (t.includes('shopeepay') || t.includes('shopee') || t.includes('spay')) return 'shopeepay';
  if (t.includes('ovo')) return 'ovo';
  if (t.includes('dana')) return 'dana';
  if (t.includes('gopay') || t.includes('go-pay')) return 'gopay';
  if (t.includes('linkaja')) return 'linkaja';
  if (t.includes('bca')) return 'bca';
  if (t.includes('bri')) return 'bri';
  if (t.includes('bni')) return 'bni';
  if (t.includes('mandiri')) return 'mandiri';
  if (t.includes('bsi') || t.includes('syariah')) return 'bsi';
  if (t.includes('seabank') || t.includes('sea bank')) return 'seabank';
  if (t.includes('bank') || t.includes('transfer') || t.includes('m-banking') || t.includes('mobile banking')) return 'bank';
  return null;
};

// 🎛️ TOMBOL PILIHAN CHANNEL PEMBAYARAN
const CHANNEL_KB = { inline_keyboard: [
  [ { text: '💙 GoPay', callback_data: 'pay_ch:gopay' }, { text: '💜 OVO', callback_data: 'pay_ch:ovo' }, { text: '🧡 ShopeePay', callback_data: 'pay_ch:shopeepay' } ],
  [ { text: '💛 DANA', callback_data: 'pay_ch:dana' }, { text: '🏦 Transfer Bank', callback_data: 'pay_ch:bank' }, { text: '❓ Lain/QRIS', callback_data: 'pay_ch:qris' } ]
] };

const sendChannelPicker = async (chatId) => {
  await sendTelegramMessage(chatId, '💳 <b>Terakhir:</b> kamu bayar pakai aplikasi apa?\nKetuk salah satu di bawah:', { parse_mode: 'HTML', reply_markup: CHANNEL_KB });
};

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
const BOT_USERNAME = process.env.BOT_USERNAME || 'aphelion_gatekeeper_bot';

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

const PROOF_TTL_MS = 15 * 60 * 1000;
const proofRef = (uid) => db.collection('pending_proofs').doc(String(uid));

// ===== 💰 FINALIZE BUKTI BAYAR (dengan channel dinamis) =====
const finalizeProof = async (uid, data) => {
  const channelFinal = data.channel || 'qris';
  const ref = await db.collection('pending_payments').add({
    uid: String(uid), username: data.username || null, firstName: data.firstName || null,
    amount: data.amount, channel: channelFinal, proofFileId: data.fileId || null,
    caption: data.caption || '', status: 'pending',
    createdAt: new Date().toISOString(), chatId: data.chatId || uid
  });
  const markup = { inline_keyboard: [[
    { text: '✅ APPROVE', callback_data: `pay_approve:${ref.id}` },
    { text: '❌ TOLAK', callback_data: `pay_reject:${ref.id}` }
  ]] };
  try {
    await sendTelegramMessage(process.env.OWNER_TELEGRAM_ID,
      `💰 <b>PEMBAYARAN MENUNGGU APPROVE</b>\nUID: <code>${uid}</code>\nUser: @${data.username || '-'}\nNominal: Rp ${data.amount.toLocaleString('id-ID')}\nChannel: <b>${channelFinal.toUpperCase()}</b>\nCaption: ${escapeHtml(data.caption || '-')}\n\n<i>Edit nominal bisa lewat Admin Panel → Finance.</i>`,
      { parse_mode: 'HTML', reply_markup: markup });
  } catch (e) { console.error('Kirim kartu approve gagal:', e.message); }
  await notifyOps(`💰 <b>Bukti bayar masuk</b>\n@${data.username || uid} • Rp ${data.amount.toLocaleString('id-ID')} • ${channelFinal.toUpperCase()}`, { safe: `💰 Bukti bayar @${data.username || uid}`, type: 'pay' });
  return ref.id;
};

// ===== 💳 KARTU QRIS (pengganti halaman web) =====
const sendQrisMessage = async (chatId) => {
  const setDoc = await db.collection('settings').doc('app').get();
  const st = setDoc.exists ? setDoc.data() : {};
  const price = st.price ? parseInt(st.price) : 10000;
  const planDays = st.planDays ? parseInt(st.planDays) : 30;
  const caption = await getTpl('pay_qris', { price: price.toLocaleString('id-ID'), planDays });
  const markup = { inline_keyboard: [
    [ { text: '📖 PANDUAN LENGKAP', callback_data: 'pay_guide' }, { text: '🎁 TRIAL GRATIS', callback_data: 'trial_claim' } ],
    [ { text: '💬 BANTUAN', url: 'https://t.me/' + (process.env.OWNER_TELEGRAM_USER || 'Mr_PH0B05') } ]
  ] };
  const fileId = st.qrisFileId || process.env.QRIS_FILE_ID || null;
  if (fileId) {
    try {
      await axios.post(`${TELEGRAM_API}/sendPhoto`, {
        chat_id: chatId, photo: fileId, caption,
        parse_mode: 'HTML', reply_markup: markup
      });
      return;
    } catch (e) { console.error('sendPhoto QRIS gagal:', e.message); }
  }
  await sendTelegramMessage(chatId,
    '🖼 <b>Gambar QRIS belum dipasang.</b>\nOwner: kirim foto QRIS ke chat ini dengan caption <code>/setqris</code>\n\n' + caption,
    { parse_mode: 'HTML', reply_markup: markup });
};

const sendPayGuide = async (chatId) => {
  const setDoc = await db.collection('settings').doc('app').get();
  const st = setDoc.exists ? setDoc.data() : {};
  const price = st.price ? parseInt(st.price) : 10000;
  const planDays = st.planDays ? parseInt(st.planDays) : 30;
  const guide = await getTpl('pay_guide', { price: price.toLocaleString('id-ID'), planDays });
  await sendTelegramMessage(chatId, guide, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [
      [ { text: '🔙 KEMBALI KE QRIS', callback_data: 'pay_qris' }, { text: '🎁 TRIAL GRATIS', callback_data: 'trial_claim' } ]
    ] }
  });
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

// ===== 🔑 SELF-SERVICE RECOVERY =====
const shortPkg = (p) => p ? String(p).split('.').pop() : '-';
const maskTok = (t) => !t ? '-' : (t.length > 8 ? t.slice(0, 4) + '-****-****-' + t.slice(-4) : t);

const findLicensesByTg = async (tgUid, tgUsername) => {
  const out = [];
  try {
    const d = await db.collection('users').doc(String(tgUid)).get();
    if (d.exists) out.push({ id: d.id, ...d.data() });
  } catch (e) {}
  if (tgUsername) {
    try {
      const s = await db.collection('users').where('username', '==', String(tgUsername).toLowerCase()).limit(5).get();
      s.docs.forEach(x => { if (!out.find(o => o.id === x.id)) out.push({ id: x.id, ...x.data() }); });
    } catch (e) {}
  }
  return out;
};

const boundOk = (lic, from) =>
  String(lic.id) === String(from.id) ||
  (lic.username && String(lic.username).replace(/^@/, '').toLowerCase() === String(from.username || '').toLowerCase());

const handleResetEntry = async (msg) => {
  const tgUid = String(msg.from.id);
  const tgUser = msg.from.username || null;
  await db.collection('telegram_chats').doc(tgUid).set({
    chatId: msg.chat.id, username: tgUser, firstName: msg.from.first_name || null, updatedAt: new Date().toISOString()
  }, { merge: true });
  const lics = await findLicensesByTg(tgUid, tgUser);
  if (!lics.length) {
    await sendTelegramMessage(msg.chat.id, '❓ Tidak ditemukan lisensi atas akun Telegram ini.\nKalau kamu yakin punya token, hubungi admin lewat menu ✈️ di layar login.');
    return;
  }
  const rows = lics.slice(0, 3).map(l => {
    const st = l.status === 'ACTIVE' ? '🟢 ACTIVE' : l.status === 'EXPIRED' ? '🟠 EXPIRED' : l.status === 'PENDING' ? '🎫 PENDING' : '⚫ ' + (l.status || '-');
    const exp = l.expiredAt && l.expiredAt.toDate ? l.expiredAt.toDate().toLocaleDateString('id-ID') : '-';
    return `• <code>${l.packageName || '-'}</code> — ${st}\n  Token: <code>${maskTok(l.token)}</code> • Exp: ${exp}`;
  }).join('\n');
  const kb = { inline_keyboard: [] };
  lics.slice(0, 3).forEach(l => {
    kb.inline_keyboard.push([{ text: `🔄 Reset HWID — ${shortPkg(l.packageName)}`, callback_data: `rs_req:${l.id}` }]);
    kb.inline_keyboard.push([{ text: `🔑 Kirim Ulang Token — ${shortPkg(l.packageName)}`, callback_data: `rs_token:${l.id}` }]);
  });
  kb.inline_keyboard.push([{ text: '💬 Chat Admin', url: 'https://t.me/' + (process.env.OWNER_TELEGRAM_USER || 'Mr_PH0B05') }]);
  await sendTelegramMessage(msg.chat.id,
    `🔐 <b>PULIHKAN AKSES</b>\nHalo @${tgUser || tgUid}! Lisensi terdaftar atas akunmu:\n\n${rows}\n\nPilih tindakan di bawah. Request reset perlu approval owner/admin1 (maks 1×24 jam).`,
    { parse_mode: 'HTML', reply_markup: kb });
};

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

// ===== 📍 LOCATION PING =====
const pingLimiter = rateLimit({ windowMs: 2 * 1000, max: 1, keyGenerator: (req) => req.body?.jwt || req.ip });

app.post('/api/user/ping', pingLimiter, async (req, res) => {
  try {
    const { jwt: jwtToken, deviceId, lat, lng, accuracy, speed, bearing, battery, netType, appState, consent, paused } = req.body || {};
    
    if (!jwtToken) return res.status(401).json({ error: 'JWT Token wajib' });
    if (typeof lat !== 'number' || typeof lng !== 'number') return res.status(400).json({ error: 'Koordinat tidak valid' });

    let decoded;
    try {
      decoded = jwt.verify(jwtToken, JWT_USER_SECRET);
    } catch (e) {
      return res.status(401).json({ status: 'INVALID_JWT', message: 'Sesi tidak valid atau kedaluwarsa' });
    }

    const uid = decoded.uid;
    
    if (decoded.status !== 'ACTIVE') return res.status(403).json({ status: 'INACTIVE' });
    if (decoded.deviceId !== deviceId) return res.status(403).json({ status: 'HWID_MISMATCH' });
    if (consent !== true) return res.status(200).json({ status: 'NO_CONSENT' });
    
    if (paused === true) {
      try { await redis.set(`loc:${uid}`, JSON.stringify({ uid, paused: true, ts: new Date().toISOString() }), { ex: 60 }); } 
      catch(e){ console.error("Redis paused error:", e.message); }
      return res.status(200).json({ status: 'PAUSED' });
    }

    const now = new Date();
    const point = {
      uid, lat, lng, accuracy: typeof accuracy === 'number' ? accuracy : null,
      speed: typeof speed === 'number' ? speed : null, bearing: typeof bearing === 'number' ? bearing : null,
      battery: typeof battery === 'number' ? battery : null, netType: netType || null, 
      appState: appState || 'foreground', consent: true, paused: false, ts: now.toISOString()
    };

    try { await redis.set(`loc:${uid}`, JSON.stringify(point), { ex: 60 }); } 
    catch(redisErr) { console.error("Redis loc error:", redisErr.message); }

    try {
        const lastDbWrite = await redis.get(`last_db_write:${uid}`);
        if (!lastDbWrite) {
          await db.collection('user_locations').doc(uid).set(point, { merge: true });
          await db.collection('location_history').doc(uid).collection('points').add({
            lat, lng, accuracy: point.accuracy, speed: point.speed, bearing: point.bearing, ts: point.ts
          });
          await redis.set(`last_db_write:${uid}`, 'done', { ex: 300 }); 
        }
    } catch (dbErr) { }

    res.status(200).json({ status: 'OK', ts: now.toISOString(), pingInterval: 60 });
  } catch (e) {
    console.error('PING ERROR:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ===== A. WEBHOOK TELEGRAM =====
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

      // ===== 💳 PILIH CHANNEL PEMBAYARAN =====
      if (cb.data && cb.data.startsWith('pay_ch:')) {
        const ch = cb.data.split(':')[1];
        const uidC = String(cb.from.id);
        await answerCallbackQuery(cb.id, 'Mencatat channel...');
        const pRefC = proofRef(uidC);
        const pDocC = await pRefC.get();
        if (!pDocC.exists || !pDocC.data().fileId || !pDocC.data().amount) {
          await sendTelegramMessage(cb.message.chat.id, '⏳ Sesi kadaluarsa. Kirim ulang foto bukti + nominalnya ya.');
          return res.status(200).json({ status: 'ok' });
        }
        const dC = pDocC.data();
        await pRefC.delete();
        await finalizeProof(uidC, { username: dC.username, firstName: dC.firstName, chatId: dC.chatId || cb.message.chat.id, amount: dC.amount, fileId: dC.fileId, caption: dC.caption || '', channel: ch });
        await sendTelegramMessage(cb.message.chat.id, `✅ Channel tercatat: <b>${ch.toUpperCase()}</b>. Bukti menunggu verifikasi owner/admin1!`, { parse_mode: 'HTML' });
        return res.status(200).json({ status: 'ok' });
      }

      // ===== 💳 QRIS & PANDUAN (pengganti halaman web) =====
      if (cb.data === 'pay_qris') {
        await answerCallbackQuery(cb.id, 'Menyiapkan QRIS...');
        await sendQrisMessage(cb.message.chat.id);
        return res.status(200).json({ status: 'ok' });
      }
      if (cb.data === 'pay_guide') {
        await answerCallbackQuery(cb.id, 'Memuat panduan...');
        await sendPayGuide(cb.message.chat.id);
        return res.status(200).json({ status: 'ok' });
      }

      // ===== 🔄 REQUEST RESET HWID =====
      if (cb.data && cb.data.startsWith('rs_req:')) {
        const licId = cb.data.split(':')[1];
        await answerCallbackQuery(cb.id, 'Memproses...');
        const d = await db.collection('users').doc(licId).get();
        if (!d.exists) { await sendTelegramMessage(cb.message.chat.id, '❌ Data lisensi tidak ditemukan.'); return res.status(200).json({ status: 'ok' }); }
        const lic = d.data();
        if (!boundOk(lic, cb.from)) { await sendTelegramMessage(cb.message.chat.id, '⛔ Lisensi ini tidak terikat ke akun Telegram kamu.'); return res.status(200).json({ status: 'ok' }); }
        if (lic.status === 'BANNED' || lic.status === 'REVOKED') { await sendTelegramMessage(cb.message.chat.id, '⛔ Status lisensi ' + lic.status + '. Hubungi admin langsung.'); return res.status(200).json({ status: 'ok' }); }
        if (lic.lastResetReqAt && Date.now() - new Date(lic.lastResetReqAt).getTime() < 7 * 86400000) {
          await sendTelegramMessage(cb.message.chat.id, '⏳ Kamu sudah request reset dalam 7 hari terakhir. Tunggu respons admin atau chat langsung.'); return res.status(200).json({ status: 'ok' });
        }
        const req = await db.collection('reset_requests').add({
          licId, tgUid: String(cb.from.id), username: cb.from.username || null,
          oldDeviceId: lic.deviceId || null, status: 'pending', at: new Date().toISOString()
        });
        await d.ref.update({ lastResetReqAt: new Date().toISOString() });
        const mk = { inline_keyboard: [[
          { text: '✅ APPROVE RESET', callback_data: `rs_approve:${req.id}` },
          { text: '❌ TOLAK', callback_data: `rs_reject:${req.id}` }
        ]] };
        try {
          await sendTelegramMessage(process.env.OWNER_TELEGRAM_ID,
            `🔄 <b>REQUEST RESET HWID</b>\nUser: @${cb.from.username || cb.from.id}\nApp: <code>${lic.packageName || '-'}</code>\nDevice lama: <code>${lic.deviceId || '-'}</code>\nStatus: ${lic.status || '-'}\n\nApprove = lepas ikatan device, user bisa login di HP baru.`,
            { parse_mode: 'HTML', reply_markup: mk });
        } catch (e) {}
        await notifyOps(`🔄 <b>Request reset HWID</b>\n@${cb.from.username || cb.from.id} • ${lic.packageName || '-'}`, { safe: `🔄 Request reset @${cb.from.username || cb.from.id}`, type: 'critical' });
        await pushAllAdmins('🔄 RESET HWID REQUEST', `@${cb.from.username || cb.from.id} • ${shortPkg(lic.packageName)}`, 'critical');
        await sendTelegramMessage(cb.message.chat.id, '✅ Request terkirim! Kamu akan diberi tahu di chat ini begitu disetujui owner/admin1.');
        return res.status(200).json({ status: 'ok' });
      }

      // ===== 🔑 KIRIM ULANG TOKEN =====
      if (cb.data && cb.data.startsWith('rs_token:')) {
        const licId = cb.data.split(':')[1];
        await answerCallbackQuery(cb.id, 'Memproses...');
        const d = await db.collection('users').doc(licId).get();
        if (!d.exists) { await sendTelegramMessage(cb.message.chat.id, '❌ Data lisensi tidak ditemukan.'); return res.status(200).json({ status: 'ok' }); }
        const lic = d.data();
        if (!boundOk(lic, cb.from)) { await sendTelegramMessage(cb.message.chat.id, '⛔ Lisensi ini tidak terikat ke akun Telegram kamu.'); return res.status(200).json({ status: 'ok' }); }
        if (lic.lastSelfTokenAt && Date.now() - new Date(lic.lastSelfTokenAt).getTime() < 24 * 3600000) {
          await sendTelegramMessage(cb.message.chat.id, '⏳ Token sudah dikirim ulang dalam 24 jam terakhir. Scroll chat lama atau hubungi admin.'); return res.status(200).json({ status: 'ok' });
        }
        await d.ref.update({ lastSelfTokenAt: new Date().toISOString() });
        await sendTelegramMessage(cb.message.chat.id,
          `🔑 Token lisensi kamu (<code>${lic.packageName || '-'}</code>):\n<code>${lic.token || '-'}</code>\n\n⚠️ JANGAN bagikan ke siapapun. Token terikat 1 device setelah login pertama.`,
          { parse_mode: 'HTML' });
        await logAudit('self:' + (cb.from.username || cb.from.id), 'TOKEN_SELF_RESEND', licId);
        await notifyOps(`🔑 <b>Token self-resend</b>\n@${cb.from.username || cb.from.id} • ${lic.packageName || '-'}`, { safe: `🔑 Self-resend @${cb.from.username || cb.from.id}` });
        return res.status(200).json({ status: 'ok' });
      }

      // ===== ✅❌ APPROVE / REJECT RESET =====
      if (cb.data && (cb.data.startsWith('rs_approve:') || cb.data.startsWith('rs_reject:'))) {
        const [act, reqId] = cb.data.split(':');
        await answerCallbackQuery(cb.id, 'Memproses...');
        if (String(cb.from.id) !== String(process.env.OWNER_TELEGRAM_ID)) {
          await sendTelegramMessage(cb.message.chat.id, '⛔ Approve reset via Telegram khusus OWNER. Admin1 bisa lewat Admin Panel.'); return res.status(200).json({ status: 'ok' });
        }
        const r = await db.collection('reset_requests').doc(reqId).get();
        if (!r.exists || r.data().status !== 'pending') { await sendTelegramMessage(cb.message.chat.id, 'Request sudah diproses sebelumnya.'); return res.status(200).json({ status: 'ok' }); }
        const rd = r.data();
        if (act === 'rs_approve') {
          await db.collection('users').doc(rd.licId).update({ deviceId: null, deviceInfo: null });
          await r.ref.update({ status: 'approved', by: cb.from.username || 'owner', decidedAt: new Date().toISOString() });
          await logAudit('owner_tg', 'RESET_HWID', rd.licId, { via: 'self_request' });
          try { await sendTelegramMessage(rd.tgUid, '✅ <b>Reset HWID disetujui!</b>\nBuka aplikasi dan login ulang pakai token kamu di perangkat baru. Jika token juga hilang, pakai tombol 🔑 Kirim Ulang Token.', { parse_mode: 'HTML' }); } catch (e) {}
          try { await axios.post(`${TELEGRAM_API}/editMessageText`, { chat_id: cb.message.chat.id, message_id: cb.message.message_id, text: `✅ RESET APPROVED oleh @${cb.from.username || 'owner'} • UID ${rd.licId}`, parse_mode: 'HTML' }); } catch (e) {}
        } else {
          await r.ref.update({ status: 'rejected', by: cb.from.username || 'owner', decidedAt: new Date().toISOString() });
          try { await sendTelegramMessage(rd.tgUid, '❌ Request reset HWID kamu ditolak. Hubungi admin untuk keterangan.'); } catch (e) {}
          try { await axios.post(`${TELEGRAM_API}/editMessageText`, { chat_id: cb.message.chat.id, message_id: cb.message.message_id, text: `❌ RESET DITOLAK oleh @${cb.from.username || 'owner'} • UID ${rd.licId}`, parse_mode: 'HTML' }); } catch (e) {}
        }
        return res.status(200).json({ status: 'ok' });
      }

      if (cb.data && (cb.data.startsWith('pay_approve:') || cb.data.startsWith('pay_reject:'))) {
        const [action, pid] = cb.data.split(':');
        await answerCallbackQuery(cb.id, 'Memproses...');
        if (String(cb.from.id) !== String(process.env.OWNER_TELEGRAM_ID)) {
          try { await sendTelegramMessage(cb.message.chat.id, '⛔ Approve via Telegram khusus OWNER. Admin1 approve lewat Admin Panel.'); } catch (e) {}
          return res.status(200).json({ status: 'ok' });
        }
        if (action === 'pay_approve') {
          const result = await approvePendingPayment(db, pid, cb.from.username || 'owner', 0);
          if (!result.ok) {
            try { await sendTelegramMessage(cb.message.chat.id, '❌ Gagal approve: ' + result.error); } catch (e) {}
            return res.status(200).json({ status: 'ok' });
          }
          await finalizeApprovedPayment(db, {
            sendTG: sendTelegramMessage, getTpl, createInviteLink,
            vipGroupId: VIP_GROUP_ID, pushAll: pushAllAdmins, notifyOps
          }, result);
          try {
            await axios.post(`${TELEGRAM_API}/editMessageText`, {
              chat_id: cb.message.chat.id, message_id: cb.message.message_id,
              text: `✅ <b>APPROVED</b> oleh @${cb.from.username || 'owner'}\nOrder: ${result.orderId}\nNominal: Rp ${result.amount.toLocaleString('id-ID')}\nUser: @${result.username || '-'} → ACTIVE s/d ${result.expiredAt.toLocaleDateString('id-ID')}`,
              parse_mode: 'HTML'
            });
          } catch (e) {}
          await logAudit('owner_tg', 'FINANCE_APPROVE', pid, { orderId: result.orderId, amount: result.amount });
        } else {
          const reason = 'Ditolak owner via Telegram';
          await db.collection('pending_payments').doc(pid).update({ status: 'rejected', rejectedBy: cb.from.username || 'owner', rejectedAt: new Date().toISOString(), reason });
          const pd = await db.collection('pending_payments').doc(pid).get();
          if (pd.exists && pd.data().chatId) {
            try { await sendTelegramMessage(pd.data().chatId, `❌ Pembayaran kamu ditolak. Alasan: ${reason}\nHubungi admin jika ini kesalahan.`); } catch (e) {}
          }
          try {
            await axios.post(`${TELEGRAM_API}/editMessageText`, {
              chat_id: cb.message.chat.id, message_id: cb.message.message_id,
              text: `❌ <b>DITOLAK</b> oleh @${cb.from.username || 'owner'}\nAlasan: ${reason}`, parse_mode: 'HTML'
            });
          } catch (e) {}
          await logAudit('owner_tg', 'FINANCE_REJECT', pid, { reason });
        }
        return res.status(200).json({ status: 'ok' });
      }

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

      // 💰 SMART PAIRING (dengan deteksi channel)
      if (msg.chat.type === 'private' && !text.startsWith('/')) {
        const amt = parseAmount(text);
        const pRef = proofRef(uid);
        const pDoc = await pRef.get().catch(() => null);
        const fresh = pDoc && pDoc.exists && (Date.now() - new Date(pDoc.data().updatedAt || 0).getTime()) < PROOF_TTL_MS;

        if (amt && fresh && pDoc.data().fileId) {
          const d = pDoc.data();
          const ch = detectChannel(text) || d.channel || null;
          if (ch) {
            await pRef.delete();
            await finalizeProof(uid, { username: d.username, firstName: d.firstName, chatId: d.chatId || msg.chat.id, amount: amt, fileId: d.fileId, caption: text, channel: ch });
            await sendTelegramMessage(msg.chat.id, `✅ Nominal Rp ${amt.toLocaleString('id-ID')} + foto + channel (<b>${ch}</b>) cocok! Menunggu verifikasi.`, { parse_mode: 'HTML' });
          } else {
            await pRef.set({ ...d, amount: amt, caption: text, updatedAt: new Date().toISOString() });
            await sendChannelPicker(msg.chat.id);
          }
          return res.status(200).json({ status: 'ok' });
        }
        if (amt) {
          const ch = detectChannel(text);
          await pRef.set({ uid, amount: amt, caption: text, channel: ch, username: msg.from.username || null, firstName: msg.from.first_name || null, chatId: msg.chat.id, fileId: null, updatedAt: new Date().toISOString() });
          await sendTelegramMessage(msg.chat.id, `💵 Nominal Rp ${amt.toLocaleString('id-ID')} dicatat!${ch ? ` Channel: <b>${ch}</b>.` : ''}\nSekarang kirim foto buktinya 📸`, { parse_mode: 'HTML' });
          return res.status(200).json({ status: 'ok' });
        }
        if (fresh && pDoc.data().fileId) {
          await sendTelegramMessage(msg.chat.id, '❓ Nominal tidak terbaca. Ketik seperti ini:\n<code>bayar 20000 shopeepay</code>', { parse_mode: 'HTML' });
          return res.status(200).json({ status: 'ok' });
        }
      }
      
      // 🔑 DEEP-LINK: Lupa Token / Ganti HP
      if (msg.chat.type === 'private' && (text.startsWith('/start reset_') || text === '/pulihkan' || text.startsWith('/pulihkan '))) {
        await handleResetEntry(msg);
        return res.status(200).json({ status: 'ok' });
      }

      // 📖 DEEP-LINK: Panduan 3 Langkah
      if (msg.chat.type === 'private' && text.startsWith('/start panduan_')) {
        const trialSet = await trial.getTrialSettings(db);
        const trialDays = trialSet.days || 7;
        
        const panduan = `📖 <b>CARA MULAI APHELION</b>
<i>3 Langkah Mudah</i>

━━━━━━━━━━━━━━━━━━━━━━━

<b>1️⃣ PILIH PAKET</b>

• Trial: Klik tombol 🎁 di welcome message
• VIP: Klik tombol 💳 di welcome message

Bot akan kirim <b>kode lisensi otomatis</b> ke chat ini.

━━━━━━━━━━━━━━━━━━━━━━━

<b>2️⃣ AKTIVASI DI APP</b>

• Buka aplikasi Aphelion
• Masuk ke menu <b>Login/Aktivasi</b>
• Paste kode lisensi dari bot
• Klik tombol <b>"Aktivasi"</b>

━━━━━━━━━━━━━━━━━━━━━━━

<b>3️⃣ SELESAI! 🎉</b>

✅ Semua fitur premium langsung aktif
✅ Trial: ${trialDays} hari
✅ VIP: 30 hari (bisa diperpanjang)

━━━━━━━━━━━━━━━━━━━━━━━

💡 <b>TIPS PENTING</b>

📸 Screenshot kode lisensi untuk backup
🔒 1 kode = 1 device (anti-joki)
⚠️ Jangan share kode ke siapapun
🆘 Ada masalah? Ketik <code>/help</code> di chat ini

━━━━━━━━━━━━━━━━━━━━━━━

🚀 <b>Siap mulai? Pilih paket kamu sekarang!</b>`;

        const markup = {
          inline_keyboard: [
            [
              { text: '🎁 TRIAL GRATIS', callback_data: 'trial_claim' },
              { text: '💳 DONASI VIP', callback_data: 'pay_qris' }
            ],
            [
              { text: '❓ BANTUAN', url: `https://t.me/${process.env.OWNER_TELEGRAM_USER || 'Mr_PH0B05'}` }
            ]
          ]
        };

        await sendTelegramMessage(msg.chat.id, panduan, { 
          parse_mode: 'HTML', 
          reply_markup: markup 
        });
        return res.status(200).json({ status: 'ok' });
      }

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
          } catch (e) { }

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
              [{ text: '💳 BAYAR VIA QRIS', callback_data: 'pay_qris' }],
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

      // ===== 🛠 /setqris VIA TEKS (owner kirim teks dulu, foto menyusul) =====
      if (isBotAdmin && (text === '/setqris' || text.startsWith('/setqris '))) {
        // Jalur A: reply ke foto QRIS
        if (msg.reply_to_message && msg.reply_to_message.photo) {
          const fid = msg.reply_to_message.photo[msg.reply_to_message.photo.length - 1].file_id;
          await db.collection('settings').doc('app').set({ qrisFileId: fid, qrisUpdatedAt: new Date().toISOString() }, { merge: true });
          await sendTelegramMessage(msg.chat.id, '✅ Gambar QRIS tersimpan (via reply)! Otomatis dipakai di menu pembayaran semua user.');
          return res.status(200).json({ status: 'ok' });
        }
        // Jalur B: teks dulu → foto berikutnya otomatis jadi QRIS
        await db.collection('admin_flags').doc(uid).set({ awaitQris: true, at: new Date().toISOString() });
        await sendTelegramMessage(msg.chat.id, '📤 <b>Mode QRIS aktif:</b> kirim FOTO QRIS sekarang (tanpa caption juga boleh).', { parse_mode: 'HTML' });
        return res.status(200).json({ status: 'ok' });
      }

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

    // ===== 💰 BUKTI BAYAR (dengan deteksi channel otomatis) =====
    if (update.message && update.message.photo && update.message.chat.type === 'private') {
      const msg = update.message;
      const uid = String(msg.from.id);
      const caption = msg.caption || '';
      const fileId = msg.photo[msg.photo.length - 1].file_id;

      const isAdm = (uid === String(process.env.OWNER_TELEGRAM_ID)) ||
        (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(s => s.trim()).filter(Boolean).includes(uid);

      // 🖼 /setqris via caption (owner kirim foto + caption /setqris)
      if (isAdm && caption.trim().startsWith('/setqris')) {
        await db.collection('settings').doc('app').set({ qrisFileId: fileId, qrisUpdatedAt: new Date().toISOString() }, { merge: true });
        await sendTelegramMessage(msg.chat.id, '✅ Gambar QRIS tersimpan (via caption)! Otomatis dipakai di menu pembayaran semua user.');
        return res.status(200).json({ status: 'ok' });
      }

      // 🖼 /setqris via flag (owner kirim /setqris dulu, lalu foto tanpa caption)
      if (isAdm) {
        const flagDoc = await db.collection('admin_flags').doc(uid).get().catch(() => null);
        if (flagDoc && flagDoc.exists && flagDoc.data().awaitQris) {
          await db.collection('admin_flags').doc(uid).delete();
          await db.collection('settings').doc('app').set({ qrisFileId: fileId, qrisUpdatedAt: new Date().toISOString() }, { merge: true });
          await sendTelegramMessage(msg.chat.id, '✅ Gambar QRIS tersimpan! Otomatis dipakai di menu pembayaran semua user.');
          return res.status(200).json({ status: 'ok' });
        }
      }

      const base = { username: msg.from.username || null, firstName: msg.from.first_name || null, chatId: msg.chat.id };
      const amount = parseAmount(caption);

      // C1: foto + caption nominal → deteksi channel atau tanyakan
      if (amount) {
        const ch = detectChannel(caption);
        if (ch) {
          await finalizeProof(uid, { ...base, amount, fileId, caption, channel: ch });
          await sendTelegramMessage(msg.chat.id, `✅ Bukti + nominal + channel (<b>${ch}</b>) diterima! Menunggu verifikasi owner/admin1.`, { parse_mode: 'HTML' });
        } else {
          await proofRef(uid).set({ uid, fileId, caption, username: base.username, firstName: base.firstName, chatId: base.chatId, amount, updatedAt: new Date().toISOString() });
          await sendChannelPicker(msg.chat.id);
        }
        return res.status(200).json({ status: 'ok' });
      }

      // C2: foto menyusul setelah nominal → jodohkan
      const pRef = proofRef(uid);
      const pDoc = await pRef.get();
      if (pDoc.exists && pDoc.data().amount && (Date.now() - new Date(pDoc.data().updatedAt || 0).getTime()) < PROOF_TTL_MS) {
        const amt = pDoc.data().amount;
        const cap = pDoc.data().caption || caption;
        const ch = pDoc.data().channel || detectChannel(cap) || null;
        if (ch) {
          await pRef.delete();
          await finalizeProof(uid, { ...base, amount: amt, fileId, caption: cap, channel: ch });
          await sendTelegramMessage(msg.chat.id, `✅ Foto + nominal Rp ${amt.toLocaleString('id-ID')} + channel (<b>${ch}</b>) cocok! Menunggu verifikasi.`, { parse_mode: 'HTML' });
        } else {
          await pRef.set({ ...pDoc.data(), fileId, updatedAt: new Date().toISOString() });
          await sendChannelPicker(msg.chat.id);
        }
        return res.status(200).json({ status: 'ok' });
      }

      // C3: foto dulu, nominal menyusul
      await pRef.set({ uid, fileId, caption, username: base.username, firstName: base.firstName, chatId: base.chatId, amount: null, updatedAt: new Date().toISOString() });
      await sendTelegramMessage(msg.chat.id, '📸 Foto bukti disimpan!\nSekarang ketik nominal + aplikasi (opsional), contoh:\n<code>bayar 20000 shopeepay</code>', { parse_mode: 'HTML' });
      return res.status(200).json({ status: 'ok' });
    }

    // ===== 🎉 WELCOME MESSAGE (PSYCHOLOGY-OPTIMIZED) =====
    if (update.message && update.message.new_chat_members) {
      const msg = update.message;
      const chatId = msg.chat.id;
      const isVip = String(chatId) === String(VIP_GROUP_ID);

      for (const member of update.message.new_chat_members) {
        if (!member.is_bot) {
          const uid = String(member.id);
          const username = member.username || '-';
          const firstName = member.first_name || 'Teman';
          const tanggal = new Date().toLocaleDateString('id-ID', { 
            day: 'numeric', month: 'long', year: 'numeric' 
          });
          
          const setDoc = await db.collection('settings').doc('app').get();
          const price = (setDoc.exists && setDoc.data().price) ? parseInt(setDoc.data().price) : 10000;
          const planDays = (setDoc.exists && setDoc.data().planDays) ? parseInt(setDoc.data().planDays) : 30;
          
          const trialSet = await trial.getTrialSettings(db);
          const trialDays = trialSet.days || 7;

          const pesan = `👋 Halo <b>${escapeHtml(firstName)}</b>! Selamat datang di komunitas Aphelion

📋 <b>PROFIL KAMU</b>
🆔 UID: <code>${uid}</code>
👤 Username: @${escapeHtml(username)}
📅 Bergabung: ${tanggal}

━━━━━━━━━━━━━━━━━━━━━━━

🏠 <b>APA ITU APHELION?</b>

Aphelion = <b>Tools Premium</b> untuk:
🛵 Driver Ojol (Grab, Gojek, dll)
🎮 Mobile Gamer
📍 Fake GPS & Location Spoofing
🔧 Produktivitas & Automation

━━━━━━━━━━━━━━━━━━━━━━━

🚀 <b>APHELION VIP = AKSES PENUH</b>

✅ Unlock semua fitur premium
✅ Update prioritas & beta access
✅ Support langsung developer
✅ Bebas iklan & watermark
✅ Anti-banned system

━━━━━━━━━━━━━━━━━━━━━━━

🎁 <b>PILIH JALAN MASUK</b>

<b>1️⃣ TRIAL GRATIS ${trialDays} HARI</b>
   → 1x seumur hidup per device
   → Full akses, tanpa batas
   → Coba dulu sebelum commit

<b>2️⃣ DONASI VIP (Mulai Rp ${price.toLocaleString('id-ID')})</b>
   → Akses ${planDays} hari penuh
   → Donasi lebih = apresiasi dev
   → Semua nominal = akses sama
   → Pembayaran QRIS / GoPay / ShopeePay / OVO / DANA / Bank

━━━━━━━━━━━━━━━━━━━━━━━

⚠️ <b>PERINGATAN KEAMANAN</b>

🚫 Admin & bot <b>TIDAK PERNAH</b>:
   • Japri / chat personal duluan
   • Minta password / OTP / token
   • Minta transfer ke rekening pribadi

✅ <b>ADMIN RESMI</b> (selain ini = PENIPU):
   👑 @Mr_PH0B05 (Owner)
   🛡️ @Draven_89 (Admin)
   🛡️ @MrDeimos823 (Admin)

💳 <b>PEMBAYARAN RESMI</b>:
   • QRIS Merchant (semua e-wallet & bank)
   • Token dikirim otomatis setelah verifikasi

━━━━━━━━━━━━━━━━━━━━━━━

👇 <b>KETUK TOMBOL DI BAWAH</b>
(Otomatis buka chat pribadi bot)`;

          const markup = {
            inline_keyboard: [
              [
                { text: '🎁 CLAIM TRIAL GRATIS', url: `https://t.me/${BOT_USERNAME}?start=trial_${uid}` },
                { text: '💳 DONASI VIP', url: `https://t.me/${BOT_USERNAME}?start=beli_${uid}` }
              ],
              [
                { text: '📖 CARA MULAI (3 LANGKAH)', url: `https://t.me/${BOT_USERNAME}?start=panduan_${uid}` }
              ],
              [
                { text: '🛡️ LAPOR PENIPU', url: `https://t.me/${process.env.OWNER_TELEGRAM_USER || 'Mr_PH0B05'}` }
              ]
            ]
          };

          await sendTelegramMessage(chatId, pesan, { 
            parse_mode: 'HTML', 
            reply_markup: markup,
            disable_web_page_preview: true 
          });
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
        } catch (e) { }

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

        try { await db.collection('trial_claims').doc(uid).delete(); } catch (e) { }

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

    const jwtPayload = {
      uid: uid,
      status: u.status,
      expiredAt: u.expiredAt && u.expiredAt.toDate ? u.expiredAt.toDate().toISOString() : null,
      deviceId: deviceId
    };
    const jwtToken = jwt.sign(jwtPayload, JWT_USER_SECRET, { expiresIn: '30d' });

    res.status(200).json({ 
      status: 'ACTIVE', 
      firstLogin: false, 
      message: 'Otentikasi Berhasil!', 
      expiredAt: u.expiredAt && u.expiredAt.toDate ? u.expiredAt.toDate().toISOString() : null,
      jwt: jwtToken
    });
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
