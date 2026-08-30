const express = require('express');
const rateLimit = require('express-rate-limit');
const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const cors = require('cors');
const axios = require('axios');
const midtransClient = require('midtrans-client');
const crypto = require('crypto');
const { notifyOps, runReminders } = require('./ops');
const { getTpl } = require('./templates');

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

// 🚦 RATE LIMIT: anti-spam invoice & anti brute-force verify
const snapLimiter = rateLimit({ windowMs: 60 * 1000, max: 5 });
const verifyLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 });

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const VIP_GROUP_ID = process.env.VIP_GROUP_ID || '-1004477570254';
const PAYMENT_WEB_URL = process.env.PAYMENT_WEB_URL || 'https://aphelion-pay.vercel.app';
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

const escapeHtml = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const sendTelegramMessage = async (chatId, text, options = {}) => {
  try {
    const response = await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text, ...options });
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
  isProduction: isProduction,
  serverKey: isProduction ? process.env.MIDTRANS_SERVER_KEY : process.env.MIDTRANS_SANDBOX_SERVER_KEY,
  clientKey: isProduction ? process.env.MIDTRANS_CLIENT_KEY : process.env.MIDTRANS_SANDBOX_CLIENT_KEY
});

app.get('/', (req, res) => {
  res.json({ status: 'OK', message: 'Aphelion Backend System & Bot is Running Smoothly on Vercel!' });
});

// A. Webhook Telegram (+ health ping)
app.post('/api/telegram-webhook', async (req, res) => {
  if (req.headers['x-telegram-bot-api-secret-token'] !== process.env.TELEGRAM_SECRET_TOKEN) {
    return res.status(403).send('Invalid Telegram Secret Token');
  }

  db.collection('settings').doc('app').set({ lastTelegramPing: new Date().toISOString() }, { merge: true }).catch(() => {});

  try {
    const update = req.body;

    if (update.message && update.message.text) {
      const msg = update.message;
      const uid = String(msg.from.id);
      const text = msg.text;

      if (text.startsWith('/start') || text.startsWith('/beli')) {
        if (msg.chat.type !== 'private') {
          await sendTelegramMessage(msg.chat.id, await getTpl('pm_redirect'));
        } else {
          await db.collection('telegram_chats').doc(uid).set({
            chatId: msg.chat.id,
            username: msg.from.username || null,
            firstName: msg.from.first_name || null,
            updatedAt: new Date().toISOString()
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
              if (u.status === 'BANNED') {
                statusText = '⚫ Akun diblokir';
              } else if (u.status === 'ACTIVE' && u.expiredAt && u.expiredAt.toDate() > new Date()) {
                statusText = `🟢 Aktif sampai ${u.expiredAt.toDate().toLocaleString('id-ID')}`;
              } else {
                statusText = '🟠 Langganan kedaluwarsa';
              }
            }
          } catch (e) { /* abaikan */ }

          const payLink = `${PAYMENT_WEB_URL}?uid=${uid}`;
          const pesan = await getTpl('beli_intro', {
            nama: escapeHtml(msg.from.first_name),
            status: statusText,
            link: payLink
          });

          await sendTelegramMessage(msg.chat.id, pesan, { parse_mode: 'HTML', disable_web_page_preview: true });
        }
      }
    }

    if (update.message && update.message.new_chat_members) {
      const msg = update.message;
      const chatId = msg.chat.id;
      const isVip = String(chatId) === String(VIP_GROUP_ID);

      for (const member of update.message.new_chat_members) {
        if (!member.is_bot) {
          const pesan = await getTpl(isVip ? 'welcome_vip' : 'welcome_public', {
            nama: escapeHtml(member.first_name),
            uid: member.id
          });
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

// B. Snap Token (min price + RATE LIMIT anti-spam invoice)
app.post('/api/get-snap-token', snapLimiter, async (req, res) => {
  try {
    const setDoc = await db.collection('settings').doc('app').get();
    if (setDoc.exists && setDoc.data().maintenance === true) {
      return res.status(503).json({ error: 'Sistem sedang maintenance. Coba lagi nanti.' });
    }
    const minPrice = (setDoc.exists && setDoc.data().price) ? parseInt(setDoc.data().price) : 10000;

    const { telegram_id, email, amount } = req.body;

    if (!telegram_id || !email || !amount) {
      return res.status(400).json({ error: 'Telegram ID, Email, dan Nominal wajib diisi!' });
    }
    if (!/^\d{5,15}$/.test(String(telegram_id))) {
      return res.status(400).json({ error: 'Telegram ID tidak valid. Buka halaman lewat bot!' });
    }

    const payAmount = parseInt(amount);
    if (payAmount < minPrice) {
      return res.status(400).json({ error: `Minimal pembayaran adalah Rp ${minPrice}!` });
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

// C. Webhook Midtrans (ledger + planDays dinamis + OPS alert)
app.post('/api/payment-webhook', async (req, res) => {
  try {
    const notification = req.body;

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
        await db.collection('users').doc(uid).set({
          uid: uid,
          username: username,
          email: userEmail || 'tidak_ada_email',
          token: tokenMod,
          deviceId: null,
          expiredAt: expiredDate,
          status: 'ACTIVE',
          remindedH3: false,
          remindedH1: false,
          createdAt: existingUser.exists && existingUser.data().createdAt ? existingUser.data().createdAt : new Date().toISOString()
        });

        try {
          const amount = parseInt(notification.gross_amount) || 0;
          const dateKey = new Date().toISOString().slice(0, 10);
          await db.collection('transactions').doc(notification.order_id).set({
            orderId: notification.order_id, uid, amount,
            status: transactionStatus,
            channel: notification.payment_type || 'unknown',
            email: userEmail || null, mode: MIDTRANS_MODE,
            paidAt: new Date().toISOString()
          });
          await db.collection('finance_daily').doc(dateKey).set({ date: dateKey }, { merge: true });
          await db.collection('finance_daily').doc(dateKey).update({ gross: FieldValue.increment(amount), count: FieldValue.increment(1) });
          await db.collection('finance_total').doc('all').set({ gross: FieldValue.increment(amount), count: FieldValue.increment(1) }, { merge: true });

          await notifyOps(`💰 <b>Pembayaran Masuk</b>\nRp ${amount.toLocaleString('id-ID')} • UID <code>${uid}</code>\nOrder: ${notification.order_id}`, { safe: `💰 Pembayaran masuk • UID ${uid}`, type: 'pay' });
        } catch (e) { console.error('Ledger write gagal:', e.message); }

        console.log(`Pembayaran lunas: ${uid}. Token: ${tokenMod}`);

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

          const msg = await getTpl('payment_success', {
            tanggal: expiredDate.toLocaleString('id-ID'),
            token: tokenMod,
            invite: inviteText
          });

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

// D. Verifikasi Token & Binding HWID (+ RATE LIMIT anti brute-force)
app.post('/api/mod/verify', verifyLimiter, async (req, res) => {
  try {
    const { token, deviceId } = req.body;

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
      await notifyOps(`🚨 <b>HWID MISMATCH</b>\nUID <code>${uid}</code> mencoba pakai token di perangkat lain!`, { critical: true });
      return res.status(403).json({ status: 'HWID_MISMATCH', message: 'Akses Ditolak! Token ini sudah terikat di perangkat lain.' });
    }

    res.status(200).json({ status: 'ACTIVE', message: 'Otentikasi Berhasil!', expiredAt: expDate });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// E. Cron (expiry sweep + reminders + WATCHDOG + OPS alert)
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
        await sendTelegramMessage(chatId, await getTpl('expired_dm'), { parse_mode: 'HTML' });
      } catch (err) {
        console.error(`Gagal kick/DM user ${uid}:`, err.message);
      }
    }

    let reminded = 0;
    try { reminded = await runReminders(); } catch (e) { console.error('Reminders gagal:', e.message); }

    // 🐕 WATCHDOG: kalau bot senyap > 24 jam (bukan maintenance) → alarm ke owner
    const setW = await db.collection('settings').doc('app').get();
    const st = setW.exists ? setW.data() : {};
    if (st.maintenance !== true && st.lastTelegramPing) {
      const age = Date.now() - new Date(st.lastTelegramPing).getTime();
      if (age > 26 * 3600 * 1000) {
        await notifyOps(`🚨 <b>WATCHDOG</b>\nBot tidak menerima pesan > 24 jam. Cek webhook / token Telegram!`, { critical: true });
      }
    }

    await db.collection('settings').doc('app').set({ lastCronRun: new Date().toISOString() }, { merge: true });

    if (expiredCount > 0 || reminded > 0) {
      await notifyOps(`⏰ <b>Cron</b>: ${expiredCount} expired disapu • ${reminded} reminder terkirim`, { safe: `⏰ Cron: ${expiredCount} expired • ${reminded} reminder` });
    }

    res.status(200).json({ status: 'CRON_SUCCESS', user_expired: expiredCount, reminders_sent: reminded });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// G. ADMIN PANEL API
app.use('/api/admin', require('./adminRoutes'));

module.exports = app;
