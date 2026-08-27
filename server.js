const express = require('express');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const cors = require('cors');
const { Bot: TelegramBot } = require('node-telegram-bot-api');
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

initializeApp({
  credential: cert(serviceAccount)
});

const db = getFirestore();
const app = express();

app.use(express.json());
app.use(cors());

// --- 2. KONFIGURASI BOT TELEGRAM & URL ---
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const VIP_GROUP_ID = process.env.VIP_GROUP_ID || '-1004477570254';
const PAYMENT_WEB_URL = process.env.PAYMENT_WEB_URL || 'https://aphelion-pay.vercel.app';

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);

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
          await bot.sendMessage(chatId, "⚠️ Lu belum pasang Username Telegram! Pasang dulu di pengaturan profil lu biar sistem bisa ngenalin data lu.");
        } else {
          const userId = username.replace('@', '').toLowerCase();
          await db.collection('telegram_chats').doc(userId).set({ chatId: chatId });

          const pesan = `🌌 **Selamat Datang di Aphelion System!**\n\nUntuk mendapatkan akses Mod VIP dan Token, silakan lakukan pendaftaran dan pembayaran melalui gateway resmi kami:\n👉 ${PAYMENT_WEB_URL}\n\nPastikan lu mengisi form dengan username **@${username}** agar sistem bisa memproses akses lu secara otomatis.`;
          await bot.sendMessage(chatId, pesan, { parse_mode: 'Markdown', disable_web_page_preview: true });
        }
      }
    }

    if (update.message && update.message.new_chat_members) {
      const msg = update.message;
      const chatId = msg.chat.id;
      const newMembers = msg.new_chat_members;

      for (const member of newMembers) {
        if (!member.is_bot) {
          const pesan = `Halo [${member.first_name}](tg://user?id=${member.id})! Selamat datang di Aphelion Publik 🌌\n\nMau akses Mod VIP dan Token System? Langsung DM/Chat gua di @aphelion_gatekeeper_bot dan ketik perintah **/beli** untuk mendapatkan link pendaftaran resmi.`;
          await bot.sendMessage(chatId, pesan, { parse_mode: 'Markdown' });
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
        name: 'Aphelion System Access'
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
            const invite = await bot.createChatInviteLink(VIP_GROUP_ID, { member_limit: 1 });

            const msg = `🔥 **PEMBAYARAN BERHASIL!** 🔥\n\nSelamat datang di ekosistem Aphelion.\n\n🔑 **TOKEN MOD LU:** \`${tokenMod}\`\n\nSilakan bergabung ke Grup VIP melalui link sekali-pakai ini:\n👉 ${invite.invite_link}\n\n*Catatan: Saat login Mod nanti, token ini akan otomatis mengunci Device ID HP lu. Jangan berikan token ini ke siapapun.*`;

            await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
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

// --- 5. EKSPOR UNTUK VERCEL ---
module.exports = app;
