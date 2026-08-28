const express = require('express');
const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const cors = require('cors');
const axios = require('axios');
const midtransClient = require('midtrans-client');
const crypto = require('crypto');

// --- 1. INISIALISASI FIREBASE PAKAI BASE64 ---
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

app.use(express.json());
app.use(cors());

// --- 2. KONFIGURASI BOT TELEGRAM & URL ---
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const VIP_GROUP_ID = process.env.VIP_GROUP_ID || '-1004477570254';
const PAYMENT_WEB_URL = process.env.PAYMENT_WEB_URL || 'https://aphelion-pay.vercel.app';
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// Helper: escape HTML biar nama user nggak ngerusak parse_mode HTML
const escapeHtml = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const sendTelegramMessage = async (chatId, text, options = {}) => {
  try {
    const response = await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text, ...options });
    return response.data;
  } catch (error) {
    console.error('Error sending Telegram message:', error.response ? JSON.stringify(error.response.data) : error.message);
    throw error;
  }
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

// --- 3. KONFIGURASI MIDTRANS SNAP ---
const MIDTRANS_MODE = process.env.MIDTRANS_MODE || 'production';
const isProduction = MIDTRANS_MODE === 'production';

const snap = new midtransClient.Snap({
  isProduction: isProduction,
  serverKey: isProduction ? process.env.MIDTRANS_SERVER_KEY : process.env.MIDTRANS_SANDBOX_SERVER_KEY,
  clientKey: isProduction ? process.env.MIDTRANS_CLIENT_KEY : process.env.MIDTRANS_SANDBOX_CLIENT_KEY
});

// --- 4. ENDPOINT RUTE BACKEND ---

app.get('/', (req, res) => {
  res.json({ status: 'OK', message: 'Aphelion Backend System & Bot is Running Smoothly on Vercel!' });
});

// A. Endpoint Webhook Telegram
app.post('/api/telegram-webhook', async (req, res) => {
  // 🛡️ STEP 1: Validasi secret token Telegram
  if (req.headers['x-telegram-bot-api-secret-token'] !== process.env.TELEGRAM_SECRET_TOKEN) {
    return res.status(403).send('Invalid Telegram Secret Token');
  }

  try {
    const update = req.body;

    // --- Handle /start & /beli ---
    if (update.message && update.message.text) {
      const msg = update.message;
      const uid = String(msg.from.id); // 🛡️ STEP 3: ID numerik, bukan username
      const text = msg.text;

      if (text.startsWith('/start') || text.startsWith('/beli')) {
        if (msg.chat.type !== 'private') {
          await sendTelegramMessage(msg.chat.id, '📩 Silakan buka chat pribadi (PM) dengan bot ini lalu ketik /beli untuk mendapatkan link pembayaran pribadi Anda.');
        } else {
          // Simpan mapping uid -> chatId (chat pribadi)
          await db.collection('telegram_chats').doc(uid).set({
            chatId: msg.chat.id,
            username: msg.from.username || null,
            firstName: msg.from.first_name || null,
            updatedAt: new Date().toISOString()
          }, { merge: true });

          // Cek status langganan untuk ditampilkan
          let statusText = '🔴 Belum ada langganan aktif';
          try {
            const uDoc = await db.collection('users').doc(uid).get();
            if (uDoc.exists) {
              const u = uDoc.data();
              if (u.status === 'BANNED') {
                statusText = '⚫ Akun diblokir';
              } else if (u.status === 'ACTIVE' && u.expiredAt && u.expiredAt.toDate() > new Date()) {
                statusText = `🟢 Aktif sampai ${u.expiredAt.toDate().toLocaleString('id-ID')}`;
              } else {
                statusText = '🟠 Langganan kedaluwarsa';
              }
            }
          } catch (e) { /* abaikan, status default */ }

          const payLink = `${PAYMENT_WEB_URL}?uid=${uid}`;
          const pesan = `🌌 <b>Aphelion Membership Bot</b>\n\nHalo, <b>${escapeHtml(msg.from.first_name)}</b>!\n\n📌 Status langganan: ${statusText}\n\nKlik link pembayaran pribadi Anda di bawah. Identitas Telegram terdeteksi otomatis — tidak perlu mengetik username.\n\n👉 <b><a href="${payLink}">[ BUKA HALAMAN PEMBAYARAN ]</a></b>\n\nSetelah pembayaran terverifikasi, token akses & undangan grup VIP dikirim otomatis ke chat ini.`;

          await sendTelegramMessage(msg.chat.id, pesan, { parse_mode: 'HTML', disable_web_page_preview: true });
        }
      }
    }

    // --- Welcome member baru di grup publik ---
    if (update.message && update.message.new_chat_members) {
      const msg = update.message;
      const chatId = msg.chat.id;

      for (const member of update.message.new_chat_members) {
        if (!member.is_bot) {
          const pesan = `👋 Selamat datang di ruang publik Aphelion, <a href="tg://user?id=${member.id}">${escapeHtml(member.first_name)}</a>!\n\nDi sini tempat info umum, pengumuman, dan komunitas.\nUntuk paket Premium/VIP, chat bot resmi kami dan ketik <b>/beli</b>.\n\n⚠️ Keamanan: Admin & bot tidak pernah meminta password/OTP. Pembayaran hanya melalui invoice Midtrans resmi.`;
          await sendTelegramMessage(chatId, pesan, { parse_mode: 'HTML' });
        }
      }
    }

    res.status(200).json({ status: 'ok' });
  } catch (error) {
    console.error('Telegram Webhook Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// B. Endpoint Snap Token — 🛡️ STEP 3: pakai telegram_id numerik
app.post('/api/get-snap-token', async (req, res) => {
  try {
    const { telegram_id, email, amount } = req.body;

    if (!telegram_id || !email || !amount) {
      return res.status(400).json({ error: 'Telegram ID, Email, dan Nominal wajib diisi!' });
    }
    if (!/^\d{5,15}$/.test(String(telegram_id))) {
      return res.status(400).json({ error: 'Telegram ID tidak valid. Buka halaman lewat bot!' });
    }

    const payAmount = parseInt(amount);
    if (payAmount < 10000) {
      return res.status(400).json({ error: 'Minimal pembayaran adalah Rp 10.000!' });
    }

    const uid = String(telegram_id);
    const orderId = 'APHELION-' + Date.now();

    const parameter = {
      transaction_details: { order_id: orderId, gross_amount: payAmount },
      custom_field1: uid,
      custom_field2: email,
      customer_details: { first_name: 'User-' + uid, email: email },
      item_details: [{ id: 'aphelion-sub', price: payAmount, quantity: 1, name: 'Aphelion VIP Access' }]
    };

    const transaction = await snap.createTransaction(parameter);
    res.json({ token: transaction.token, redirect_url: transaction.redirect_url });
  } catch (error) {
    console.error('Midtrans Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// C. Webhook Midtrans (Auto-Invite & DM Token)
app.post('/api/payment-webhook', async (req, res) => {
  try {
    const notification = req.body;

    // 🛡️ STEP 2: Validasi signature Midtrans (pakai key sesuai mode Sandbox/Production)
    const serverKey = isProduction ? process.env.MIDTRANS_SERVER_KEY : process.env.MIDTRANS_SANDBOX_SERVER_KEY;
    const expectedSignature = crypto.createHash('sha512')
      .update(`${notification.order_id}${notification.status_code}${notification.gross_amount}${serverKey}`)
      .digest('hex');

    if (expectedSignature !== notification.signature_key) {
      console.error('Midtrans Signature Mismatch! Potential spoofing attempt.');
      return res.status(403).json({ error: 'Invalid signature' });
    }

    const transactionStatus = notification.transaction_status;
    const fraudStatus = notification.fraud_status;
    const uid = String(notification.custom_field1 || '');
    const userEmail = notification.custom_field2;

    if (transactionStatus == 'capture' || transactionStatus == 'settlement') {
      if (fraudStatus == 'accept' || !fraudStatus) {
        if (!/^\d{5,15}$/.test(uid)) {
          console.error('custom_field1 bukan Telegram ID valid:', uid);
          return res.status(200).json({ status: 'IGNORED_INVALID_UID' });
        }

        // Token akses acak kuat (bukan Math.random)
        const tokenMod = 'APHELION-' + crypto.randomBytes(4).toString('hex').toUpperCase();
        const expiredDate = new Date();
        expiredDate.setDate(expiredDate.getDate() + 30);

        // Ambil username tersimpan (opsional, hanya pelengkap)
        let username = null;
        try {
          const chatInfo = await db.collection('telegram_chats').doc(uid).get();
          if (chatInfo.exists) username = chatInfo.data().username || null;
        } catch (e) { /* abaikan */ }

        await db.collection('users').doc(uid).set({
          uid: uid,
          username: username,
          email: userEmail || 'tidak_ada_email',
          token: tokenMod,
          deviceId: null,
          expiredAt: expiredDate,
          status: 'ACTIVE'
        });

        console.log(`Pembayaran lunas: ${uid}. Token: ${tokenMod}`);

        // 🛡️ PATCH: DM token + TOMBOL INLINE VIP
        try {
          const chatDoc = await db.collection('telegram_chats').doc(uid).get();
          const chatId = chatDoc.exists ? chatDoc.data().chatId : uid;

          let inviteText = '⚠️ Link invite VIP gagal dibuat otomatis. Hubungi admin untuk diundang manual.';
          let inviteMarkup = undefined;
          try {
            const invite = await createInviteLink(VIP_GROUP_ID, { member_limit: 1 });
            inviteText = '🚪 Ketuk tombol di bawah untuk masuk (link sekali pakai, khusus akun Anda):';
            inviteMarkup = {
              inline_keyboard: [[{ text: '🚪 MASUK GRUP VIP', url: invite.invite_link }]]
            };
          } catch (invErr) {
            console.error('Gagal buat invite link VIP:', invErr.response ? JSON.stringify(invErr.response.data) : invErr.message);
          }

          const msg = `✅ <b>Pembayaran Terverifikasi</b>\n\nTerima kasih! Langganan VIP Anda aktif sampai <b>${expiredDate.toLocaleString('id-ID')}</b>.\n\n🔑 <b>Token akses Anda:</b>\n<code>${tokenMod}</code>\n\n${inviteText}\n\n⚠️ Token bersifat pribadi & terikat satu perangkat setelah aktivasi pertama. Jangan bagikan ke siapa pun.`;

          await sendTelegramMessage(chatId, msg, {
            parse_mode: 'HTML',
            ...(inviteMarkup ? { reply_markup: inviteMarkup } : {})
          });
        } catch (err) {
          console.error("Gagal mengirim DM:", err.response ? JSON.stringify(err.response.data) : err.message);
        }
      }
    }

    res.status(200).json({ status: 'OK' });
  } catch (error) {
    console.error('Webhook Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// D. Verifikasi Token & Binding HWID — 🛡️ STEP 3: cari berdasarkan TOKEN (kompatibel app lama)
app.post('/api/mod/verify', async (req, res) => {
  try {
    const { token, deviceId } = req.body; // username opsional (legacy)

    if (!token || !deviceId) {
      return res.status(400).json({ error: 'Token dan Device ID wajib dikirim dari App!' });
    }

    const snapUsers = await db.collection('users').where('token', '==', token).limit(1).get();
    if (snapUsers.empty) {
      return res.status(404).json({ status: 'NOT_FOUND', message: 'Token tidak terdaftar!' });
    }

    const doc = snapUsers.docs[0];
    const uid = doc.id;
    const userData = doc.data();

    if (userData.status === 'BANNED') {
      return res.status(403).json({ status: 'BANNED', message: 'Akun Anda diblokir.' });
    }

    const now = new Date();
    const expDate = userData.expiredAt.toDate();
    if (now > expDate) {
      return res.status(403).json({ status: 'EXPIRED', message: 'Masa aktif akses Anda sudah habis!' });
    }

    if (!userData.deviceId) {
      await db.collection('users').doc(uid).update({ deviceId: deviceId });
      console.log(`[HWID BOUND] Token dikunci ke Device ID: ${deviceId}`);
    } else if (userData.deviceId !== deviceId) {
      console.log(`[HWID MISMATCH] Upaya pemakaian token di perangkat lain: ${uid}`);
      return res.status(403).json({ status: 'HWID_MISMATCH', message: 'Akses Ditolak! Token ini sudah terikat di perangkat lain.' });
    }

    res.status(200).json({ status: 'ACTIVE', message: 'Otentikasi Berhasil!', expiredAt: expDate });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// E. Endpoint Admin Kick
app.post('/api/admin/kick', async (req, res) => {
  try {
    const { admin_secret, user_id, username, reason } = req.body;

    if (admin_secret !== process.env.CRON_SECRET) {
      return res.status(403).json({ error: 'Akses ditolak! Lu bukan Admin.' });
    }

    // Cari user: prioritas user_id numerik, fallback query username
    let uid = null;
    if (user_id && /^\d{5,15}$/.test(String(user_id))) {
      uid = String(user_id);
    } else if (username) {
      const q = await db.collection('users').where('username', '==', username.replace('@', '').toLowerCase()).limit(1).get();
      if (!q.empty) uid = q.docs[0].id;
    }

    if (!uid) return res.status(404).json({ error: 'User tidak ditemukan!' });

    await db.collection('users').doc(uid).update({ status: 'BANNED' });

    const chatDoc = await db.collection('telegram_chats').doc(uid).get();
    const chatId = chatDoc.exists ? chatDoc.data().chatId : uid;

    try { await kickFromGroup(uid); } catch (e) { console.error('Gagal kick dari grup:', e.message); }

    const msg = `🚫 <b>Akses Dicabut</b>\n\nAkses VIP Anda telah dicabut oleh admin.\nToken akses: 🔴 <i>nonaktif</i>\n\n<b>Alasan:</b> <i>${escapeHtml(reason) || 'Pelanggaran aturan.'}</i>\n\nJika merasa ini keliru, hubungi support.`;
    await sendTelegramMessage(chatId, msg, { parse_mode: 'HTML' });

    res.json({ status: 'KICKED', message: `User ${uid} berhasil ditendang.` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// F. Cron Job Pengecek Masa Aktif
app.get('/api/cron/check-expired', async (req, res) => {
  try {
    if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).send('Unauthorized CRON trigger');
    }

    const now = new Date();
    const snapshot = await db.collection('users')
      .where('status', '==', 'ACTIVE')
      .where('expiredAt', '<', now)
      .get();

    let expiredCount = 0;
    for (const doc of snapshot.docs) {
      const uid = doc.id;

      await db.collection('users').doc(uid).update({ status: 'EXPIRED' });
      expiredCount++;

      const chatDoc = await db.collection('telegram_chats').doc(uid).get();
      const chatId = chatDoc.exists ? chatDoc.data().chatId : uid;

      try {
        await kickFromGroup(uid);
        const msg = `⏳ <b>Masa Aktif Berakhir</b>\n\nLangganan VIP Anda telah berakhir hari ini. Akses grup & fitur premium dinonaktifkan.\n\nUntuk perpanjang, ketik /beli di bot ini.`;
        await sendTelegramMessage(chatId, msg, { parse_mode: 'HTML' });
      } catch (err) {
        console.error(`Gagal kick/DM user ${uid}:`, err.message);
      }
    }

    res.status(200).json({ status: 'CRON_SUCCESS', user_expired: expiredCount });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- 5. EKSPOR UNTUK VERCEL ---
module.exports = app;
