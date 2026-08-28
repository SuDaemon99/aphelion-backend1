const express = require('express');
const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const cors = require('cors');
const axios = require('axios');
const midtransClient = require('midtrans-client');

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

// Cek apakah Firebase sudah diinit
if (getApps().length === 0) {
  initializeApp({
    credential: cert(serviceAccount)
  });
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

// Helper function untuk send Telegram message
const sendTelegramMessage = async (chatId, text, options = {}) => {
  try {
    const payload = {
      chat_id: chatId,
      text: text,
      ...options
    };
    const response = await axios.post(`${TELEGRAM_API}/sendMessage`, payload);
    return response.data;
  } catch (error) {
    console.error('Error sending Telegram message:', error.message);
    throw error;
  }
};

// Helper function untuk create invite link
const createInviteLink = async (chatId, options = {}) => {
  try {
    const payload = {
      chat_id: chatId,
      ...options
    };
    const response = await axios.post(`${TELEGRAM_API}/createChatInviteLink`, payload);
    return response.data.result;
  } catch (error) {
    console.error('Error creating invite link:', error.message);
    throw error;
  }
};

console.log('Bot Telegram dikonfigurasi untuk Vercel Webhook...');

// --- 3. KONFIGURASI MIDTRANS SNAP ---
const snap = new midtransClient.Snap({
  isProduction: true,
  serverKey: process.env.MIDTRANS_SERVER_KEY,
  clientKey: process.env.MIDTRANS_CLIENT_KEY
});

// --- 4. ENDPOINT RUTE BACKEND ---

app.get('/', (req, res) => {
  res.json({ status: 'OK', message: 'Aphelion Backend System & Bot is Running Smoothly on Vercel!' });
});

// A. Endpoint Webhook untuk Menerima Pesan dari Telegram
app.post('/api/telegram-webhook', async (req, res) => {
  try {
    const update = req.body;

    if (update.message && update.message.text) {
      const msg = update.message;
      const chatId = msg.chat.id;
      const username = msg.chat.username;
      const text = msg.text;

      if (text.startsWith('/start') || text.startsWith('/beli')) {
        if (!username) {
          await sendTelegramMessage(chatId, "⚠️ <b>Akses Tertunda!</b> Lu belum memasang Username Telegram. Pasang dulu di pengaturan profil lu agar AI kami bisa mengenali dan mengamankan data lu.");
        } else {
          const userId = username.replace('@', '').toLowerCase();
          await db.collection('telegram_chats').doc(userId).set({ chatId: chatId });

          const pesan = `🌌 <b>[ APHELION SYSTEM PROTOCOL INITIATED ]</b> 🌌\n\nStatus Akses: 🔴 <i>UNAUTHORIZED</i>\nUser Terdeteksi: <b>@${username}</b>\n\nSistem eksklusif Aphelion tidak terbuka untuk umum. Ini adalah <i>private circle</i> bagi mereka yang menginginkan supremasi sistem mutlak.\n\n⚡ <b>Kenapa bergabung?</b>\nAkses VIP memberikan lu token bypass dan modifikasi sistem tingkat dewa yang tidak akan lu temukan di publik.\n\nBuktikan lu layak masuk. Lakukan otorisasi dan amankan slot lu sekarang sebelum kuota penuh:\n👉 <b><a href="${PAYMENT_WEB_URL}">[ KLIK UNTUK REGISTRASI & PEMBAYARAN ]</a></b>\n\n<i>Note: Masukkan persis username <b>@${username}</b> di form pembayaran agar sistem kami bisa membuka gerbang otomatis untuk lu.</i>`;
          
          await sendTelegramMessage(chatId, pesan, { parse_mode: 'HTML', disable_web_page_preview: true });
        }
      }
    }

    if (update.message && update.message.new_chat_members) {
      const msg = update.message;
      const chatId = msg.chat.id;
      const newMembers = msg.new_chat_members;

      for (const member of newMembers) {
        if (!member.is_bot) {
          const pesan = `⚠️ <b>SYSTEM ALERT: NEW ENTITY DETECTED</b> ⚠️\n\nSelamat datang di ruang tunggu Aphelion, <a href="tg://user?id=${member.id}">${member.first_name}</a>.\n\nLu saat ini berada di zona publik. Kekuatan sesungguhnya (VIP Mod, Token Bypass, & Private Community) tersembunyi di balik tembok eksklusif kami.\n\nPunya nyali buat <i>upgrade</i> level lu?\nLangsung chat AI Penjaga Gerbang kami di @aphelion_gatekeeper_bot dan ketik <b>/beli</b> untuk mengklaim kunci VIP lu sekarang.`;
          
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

// B. Endpoint Meminta Snap Token (Gateway)
app.post('/api/get-snap-token', async (req, res) => {
  try {
    const { username, email, amount } = req.body;

    if (!username || !email || !amount) {
      return res.status(400).json({ error: 'Username, Email, dan Nominal wajib diisi!' });
    }

    const payAmount = parseInt(amount);
    if (payAmount < 10000) {
      return res.status(400).json({ error: 'Minimal pembayaran adalah Rp 10.000!' });
    }

    const userId = username.replace('@', '').toLowerCase();
    const orderId = 'APHELION-' + Date.now();

    const parameter = {
      transaction_details: {
        order_id: orderId,
        gross_amount: payAmount
      },
      custom_field1: userId,
      custom_field2: email,
      customer_details: {
        first_name: userId,
        email: email
      },
      item_details: [{
        id: 'aphelion-sub',
        price: payAmount,
        quantity: 1,
        name: 'Aphelion VIP Access'
      }]
    };

    const transaction = await snap.createTransaction(parameter);
    res.json({ token: transaction.token, redirect_url: transaction.redirect_url });
  } catch (error) {
    console.error('Midtrans Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// C. Route Webhook Midtrans (Auto-Invite & DM Token)
app.post('/api/payment-webhook', async (req, res) => {
  try {
    const notification = req.body;
    const transactionStatus = notification.transaction_status;
    const fraudStatus = notification.fraud_status;

    const userId = notification.custom_field1;
    const userEmail = notification.custom_field2;

    if (transactionStatus == 'capture' || transactionStatus == 'settlement') {
      if (fraudStatus == 'accept' || !fraudStatus) {

        const tokenMod = 'APHELION-' + Math.random().toString(36).substring(2, 10).toUpperCase();
        const expiredDate = new Date();
        expiredDate.setDate(expiredDate.getDate() + 30);

        await db.collection('users').doc(userId).set({
          username: userId,
          email: userEmail || 'tidak_ada_email',
          token: tokenMod,
          deviceId: null,
          expiredAt: expiredDate,
          status: 'ACTIVE'
        });

        console.log(`Pembayaran lunas: ${userId}. Token: ${tokenMod}`);

        try {
          const chatDoc = await db.collection('telegram_chats').doc(userId).get();
          if (chatDoc.exists) {
            const chatId = chatDoc.data().chatId;
            const invite = await createInviteLink(VIP_GROUP_ID, { member_limit: 1 });

            const msg = `✅ <b>[ TRANSACTION VERIFIED: ACCESS GRANTED ]</b> ✅\n\nSelamat datang di <i>Elite Circle</i> Aphelion. Pembayaran lu berhasil divalidasi.\n\n🔑 <b>TOKEN OTORISASI MOD LU:</b>\n<code>${tokenMod}</code>\n\nBergegaslah, gerbang VIP telah terbuka. Gunakan link sekali-pakai ini untuk masuk ke markas utama:\n👉 <b>${invite.invite_link}</b>\n\n⚠️ <b>PERINGATAN PROTOKOL:</b>\nToken di atas akan mengunci <b>Device ID (HWID)</b> HP lu saat login Mod pertama kali. Sistem keamanan kami sangat ketat. Berbagi token = <b>BANNED PERMANEN</b> tanpa <i>refund</i>.`;

            await sendTelegramMessage(chatId, msg, { parse_mode: 'HTML' });
          }
        } catch (err) {
          console.error("Gagal mengirim DM/Invite Link:", err.message);
        }
      }
    }

    res.status(200).json({ status: 'OK' });
  } catch (error) {
    console.error('Webhook Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// D. Route Verifikasi Token Mod & Binding HWID (Device ID)
app.post('/api/mod/verify', async (req, res) => {
  try {
    const { username, token, deviceId } = req.body;

    if (!username || !token || !deviceId) {
      return res.status(400).json({ error: 'Username, Token, dan Device ID wajib dikirim dari App!' });
    }

    const userId = username.replace('@', '').toLowerCase();
    const userDoc = await db.collection('users').doc(userId).get();

    if (!userDoc.exists) {
      return res.status(404).json({ status: 'NOT_FOUND', message: 'User tidak terdaftar!' });
    }

    const userData = userDoc.data();

    if (userData.token !== token) {
      return res.status(401).json({ status: 'INVALID_TOKEN', message: 'Token salah atau tidak valid!' });
    }

    const now = new Date();
    const expDate = userData.expiredAt.toDate();
    if (now > expDate) {
      return res.status(403).json({ status: 'EXPIRED', message: 'Masa aktif akses lu sudah habis!' });
    }

    if (!userData.deviceId) {
      await db.collection('users').doc(userId).update({ deviceId: deviceId });
      console.log(`[HWID BOUND] Token ${token} dikunci ke Device ID: ${deviceId}`);
    } else if (userData.deviceId !== deviceId) {
      console.log(`[HWID MISMATCH] Upaya bypass HWID pada user: ${userId}`);
      return res.status(403).json({ status: 'HWID_MISMATCH', message: 'Akses Ditolak! Token ini sudah terikat di perangkat lain.' });
    }

    res.status(200).json({ status: 'ACTIVE', message: 'Otentikasi Berhasil!', expiredAt: expDate });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// E. Endpoint Admin Kick (Cabut Akses Paksa)
app.post('/api/admin/kick', async (req, res) => {
  try {
    const { admin_secret, username, reason } = req.body;
    
    if (admin_secret !== process.env.CRON_SECRET) {
      return res.status(403).json({ error: 'Akses ditolak! Lu bukan Admin.' });
    }

    const userId = username.replace('@', '').toLowerCase();
    await db.collection('users').doc(userId).update({ status: 'BANNED' });

    const chatDoc = await db.collection('telegram_chats').doc(userId).get();
    if (chatDoc.exists) {
      const numericId = chatDoc.data().chatId;
      
      await axios.post(`${TELEGRAM_API}/banChatMember`, { chat_id: VIP_GROUP_ID, user_id: numericId });
      await axios.post(`${TELEGRAM_API}/unbanChatMember`, { chat_id: VIP_GROUP_ID, user_id: numericId });
      
      const msg = `🚫 <b>[ PROTOKOL ELIMINASI AKTIF ]</b> 🚫\n\nAkses VIP lu telah <b>DICABUT PAKSA</b> oleh sistem. \nToken Mod: 🔴 <i>DESTROYED</i>\n\n<b>Alasan:</b> <i>${reason || 'Pelanggaran keamanan / Aturan sistem.'}</i>\n\nDi Aphelion, aturan adalah mutlak.`;
      await sendTelegramMessage(numericId, msg, { parse_mode: 'HTML' });
    }

    res.json({ status: 'KICKED', message: `User ${username} berhasil ditendang dan diblokir dari Mod.` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// F. Endpoint Cron Job (Pengecek Masa Aktif Otomatis)
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
      const userData = doc.data();
      const userId = userData.username;

      await db.collection('users').doc(userId).update({ status: 'EXPIRED' });
      expiredCount++;

      const chatDoc = await db.collection('telegram_chats').doc(userId).get();
      if (chatDoc.exists) {
        const numericId = chatDoc.data().chatId;
        try {
          await axios.post(`${TELEGRAM_API}/banChatMember`, { chat_id: VIP_GROUP_ID, user_id: numericId });
          await axios.post(`${TELEGRAM_API}/unbanChatMember`, { chat_id: VIP_GROUP_ID, user_id: numericId });
          
          const msg = `⏳ <b>[ SYSTEM WARNING: AKSES EXPIRED ]</b> ⏳\n\nWaktu lu habis. Masa aktif langganan VIP dan Token Mod lu telah kedaluwarsa hari ini. \nStatus Mod: 🔴 <i>LOCKED</i>\n\nJangan biarkan supremasi lu hilang begitu saja. Lakukan perpanjangan sekarang untuk memulihkan akses dan kembali ke dalam VIP:\n👉 <b><a href="${PAYMENT_WEB_URL}">[ KLIK UNTUK PERPANJANG AKSES ]</a></b>`;
          await sendTelegramMessage(numericId, msg, { parse_mode: 'HTML', disable_web_page_preview: true });
        } catch (err) {
          console.error(`Gagal kick/DM user ${userId}:`, err.message);
        }
      }
    }

    res.status(200).json({ status: 'CRON_SUCCESS', user_expired: expiredCount });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- 5. EKSPOR UNTUK VERCEL ---
module.exports = app;
