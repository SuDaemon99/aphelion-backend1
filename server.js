const express = require('express');
const rateLimit = require('express-rate-limit');
const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const cors = require('cors');
const axios = require('axios');
const midtransClient = require('midtrans-client');
const crypto = require('crypto');
const { notifyOps, runReminders, logAudit } = require('./ops');
const { createPendingLicense } = require('./licenses');
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
app.set('trust proxy', 1);

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
const PUBLIC_GROUP_ID = process.env.PUBLIC_GROUP_ID || '-1003951848425';
const PAYMENT_WEB_URL = process.env.PAYMENT_WEB_URL || 'https://aphelion-pay.vercel.app';
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

const escapeHtml = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const sendTelegramMessage = async (chatId, text, options = {}) => {
  try {
    const response = await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text, ...options });
    
    // ===== 💾 TRACKING PESAN GRUP (PATCH BARU) =====
    if (String(chatId) === String(VIP_GROUP_ID) || String(chatId) === String(PUBLIC_GROUP_ID)) {
      const mid = response.data.result.message_id;
      db.collection('bot_messages').add({
        chatId: String(chatId),
        messageId: mid,
        at: new Date().toISOString()
      }).catch(() => {}); // Biarkan di background agar tidak memperlambat bot
    }
    // ===============================================

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

      // =====  COMMAND ADMIN VIA TELEGRAM (whitelist owner + admin) =====
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
            await sendTelegramMessage(msg.chat.id, `❌ Package ${pkg} belum terdaftar / nonaktif. Tambahkan dulu dari Admin Panel.`);
          } else {
            const { code, masked } = await createPendingLicense(db, { packageName: pkg, durationDays: days, createdBy: `bot:${msg.from.username || uid}`, source: 'bot' });
            await logAudit(`bot:${msg.from.username || uid}`, 'TOKEN_GENERATE', pkg, { days, via: 'telegram' });
            await notifyOps(`🎫 <b>Token dibuat via BOT</b> oleh ${msg.from.username || uid}\n${masked} • ${pkg} • ${days} hari`, { safe: `🎫 Token via bot oleh ${msg.from.username || uid} • ${pkg}` });
            await sendTelegramMessage(msg.chat.id, `🎫 <b>TOKEN BARU</b>\nApp: <code>${pkg}</code>\nDurasi: ${days} hari (mulai saat login pertama)\nKode:\n<code>${code}</code>\nStatus: BELUM DIPAKAI\n⚠️ Simpan, kode tak ditampilkan ulang.`, { parse_mode: 'HTML' });
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
          if (!found) {
            await sendTelegramMessage(msg.chat.id, `❌ User @${target} tidak ditemukan.`);
          } else {
            await db.collection('users').doc(found.id).update({ deviceId: null });
            await logAudit(`bot:${msg.from.username || uid}`, 'RESET_HWID', found.id, { via: 'telegram' });
            await notifyOps(`🔄 <b>Reset device</b> @${target} via BOT oleh ${msg.from.username || uid}`, { safe: `🔄 Reset device @${target} via bot` });
            await pushAllAdmins('🔄 RESET DEVICE', `@${target} direset via bot oleh ${msg.from.username || uid}`, 'critical');
            await sendTelegramMessage(msg.chat.id, `✅ Device @${target} dilepas. Login berikutnya akan mengikat HP baru otomatis.`);
          }
        }
        return res.status(200).json({ status: 'ok' });
      }
      // ===== akhir command admin =====
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
        const isNewUser = !existingUser.exists;
        
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

        // 🔔 FCM: push user baru (hanya kalau ini PERTAMA KALI user ini dibuat)
        if (isNewUser) {
          try {
            const snapT = await db.collection('fcm_tokens').get();
            const tokens = snapT.docs.map(d => d.data().token).filter(Boolean);
            if (tokens.length && messaging) {
              await messaging.sendEachForMulticast({
                tokens,
                data: { 
                  title: '👥 User Baru!', 
                  body: `${username || 'User-' + uid} baru daftar • Rp ${parseInt(notification.gross_amount).toLocaleString('id-ID')}`, 
                  type: 'newuser' 
                }
              });
            }
          } catch (e) { console.error('Push user baru gagal:', e.message); }
        }

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
          await pushAllAdmins('💰 Donasi Masuk!', `Rp ${amount.toLocaleString('id-ID')} • UID ${uid} • ${planDays} hari`, 'pay');
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

// D. LOGIN / VERIFIKASI APP PRODUKSI v2
// Aturan: 1 user • 1 aplikasi • 1 device • durasi dari login pertama • username TG terkunci
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

    // 1) BAN / REVOKED
    if (u.status === 'BANNED') return res.status(403).json({ status: 'BANNED', message: 'Akun Anda diblokir.' });
    if (u.status === 'REVOKED') return res.status(403).json({ status: 'REVOKED', message: 'Lisensi ini telah dicabut oleh admin.' });

    // 2) PACKAGE LOCK (1 user 1 app)
    if (pkg && u.packageName && u.packageName !== pkg) {
      await logAudit('system', 'LOGIN_REJECT_PACKAGE', uid, { reqPkg: pkg, tokenPkg: u.packageName, deviceId });
      return res.status(403).json({ status: 'PACKAGE_MISMATCH', message: `Lisensi ini hanya berlaku untuk ${u.packageName}.` });
    }

    // 3) PENDING → AKTIVASI (durasi MULAI SEKARANG, bind TG + device + package)
    if (u.status === 'PENDING') {
      if (!tg) return res.status(400).json({ status: 'BAD_REQUEST', message: 'Username Telegram wajib untuk aktivasi lisensi.' });
      if (!pkg) return res.status(400).json({ status: 'BAD_REQUEST', message: 'Package name wajib dikirim dari App.' });
      const days = parseInt(u.durationDays) || 30;
      const exp = new Date(now.getTime() + days * 86400000);
      await db.collection('users').doc(uid).update({
        status: 'ACTIVE',
        username: tg,
        deviceId,
        deviceInfo: deviceInfo || null,
        activatedAt: now.toISOString(),
        expiredAt: exp,
        lastLoginAt: now.toISOString(),
        lastLoginIp: ip,
        remindedH3: false,
        remindedH1: false
      });
      await logAudit('system', 'USER_LOGIN', uid, { first: true, telegram: `@${tg}`, package: pkg, device: devLabel });
      await notifyOps(`🔔 <b>AKTIVASI BARU</b>\n@${tg} aktif di ${pkg}\nDevice: ${devLabel}`, { safe: `🔔 Aktivasi: @${tg} • ${pkg} • ${devLabel}`, type: 'login' });
      await pushAllAdmins('🔔 LOGIN BARU!', `@${tg} aktif di ${pkg} • Device: ${devLabel}`, 'login');
      return res.status(200).json({ status: 'ACTIVE', firstLogin: true, message: 'Aktivasi berhasil!', expiredAt: exp.toISOString() });
    }

    // 4) EXPIRED
    if (u.status === 'EXPIRED' || (u.expiredAt && u.expiredAt.toDate && u.expiredAt.toDate() < now)) {
      if (u.status !== 'EXPIRED') await db.collection('users').doc(uid).update({ status: 'EXPIRED' });
      return res.status(403).json({ status: 'EXPIRED', message: 'Masa aktif akses Anda sudah habis!' });
    }

    // 5) TELEGRAM USERNAME LOCK (anti jual-beli akun)
    if (tg) {
      const bound = u.username ? String(u.username).replace(/^@/, '').toLowerCase() : null;
      if (bound && bound !== tg) {
        await logAudit('system', 'LOGIN_REJECT_TG', uid, { reqTg: tg, boundTg: bound, deviceId });
        return res.status(403).json({ status: 'TG_MISMATCH', message: `Akun ini terdaftar atas @${u.username}. Hubungi admin jika ini akun Anda.` });
      }
      if (!bound) await db.collection('users').doc(uid).update({ username: tg });
    }

    // 6) HWID LOCK (1 device)
    if (!u.deviceId) {
      await db.collection('users').doc(uid).update({ deviceId, deviceInfo: deviceInfo || null });
    } else if (u.deviceId !== deviceId) {
      await logAudit('system', 'LOGIN_REJECT_HWID', uid, { deviceId, bound: u.deviceId });
      await notifyOps(`🚨 <b>HWID MISMATCH</b>\nUID <code>${uid}</code> mencoba pakai token di perangkat lain!`, { critical: true });
      await pushAllAdmins('🚨 HWID MISMATCH!', `UID ${uid} mencoba pakai token di perangkat lain`, 'critical');
      return res.status(403).json({ status: 'HWID_MISMATCH', message: 'Akses Ditolak! Token ini sudah terikat di perangkat lain.' });
    }

    // 7) LOLOS → login ulang biasa (lazy-bind package utk user payment lama)
    const patchOk = { lastLoginAt: now.toISOString(), lastLoginIp: ip };
    if (pkg && !u.packageName) patchOk.packageName = pkg;
    await db.collection('users').doc(uid).update(patchOk);

    await logAudit('system', 'USER_LOGIN', uid, { first: false, telegram: u.username ? `@${u.username}` : null, package: pkg || u.packageName || null, device: devLabel });
    await notifyOps(`🔔 <b>LOGIN</b>\n@${u.username || uid} masuk di ${pkg || u.packageName || '-'}\nDevice: ${devLabel}`, { safe: `🔔 Login: @${u.username || uid} • ${pkg || u.packageName || '-'}`, type: 'login' });
    await pushAllAdmins('🔔 LOGIN', `@${u.username || uid} aktif di ${pkg || u.packageName || 'app'} • Device: ${devLabel}`, 'login');

    res.status(200).json({
      status: 'ACTIVE',
      firstLogin: false,
      message: 'Otentikasi Berhasil!',
      expiredAt: u.expiredAt && u.expiredAt.toDate ? u.expiredAt.toDate().toISOString() : null
    });
  } catch (error) {
    console.error('MOD LOGIN ERROR:', error.message);
    res.status(500).json({ error: error.message });
  }
};

app.post('/api/mod/verify', modLoginLimiter, handleModLogin);  // path LAMA tetap hidup (mod versi lama aman)
app.post('/api/mod/login', modLoginLimiter, handleModLogin);   // path BARU utk app produksi Java

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
