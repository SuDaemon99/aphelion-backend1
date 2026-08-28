const axios = require('axios');
const { getFirestore } = require('firebase-admin/firestore');

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
const ADMIN_GROUP_ID = process.env.ADMIN_GROUP_ID || null;

// 🚨 Kirim alert ke OPS ROOM (grup privat admin)
const notifyOps = async (text) => {
  if (!ADMIN_GROUP_ID) return;
  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: ADMIN_GROUP_ID, text, parse_mode: 'HTML' });
  } catch (e) { console.error('OPS alert gagal:', e.message); }
};

// ⏰ Reminder H-3 & H-1 sebelum expired
const runReminders = async () => {
  const db = getFirestore();
  const now = new Date();
  const soon = new Date(now.getTime() + 4 * 86400000);
  const snap = await db.collection('users')
    .where('status', '==', 'ACTIVE')
    .where('expiredAt', '>', now)
    .where('expiredAt', '<', soon)
    .get();
  let sent = 0;
  for (const doc of snap.docs) {
    const u = doc.data();
    const daysLeft = Math.ceil((u.expiredAt.toDate() - now) / 86400000);
    const chatDoc = await db.collection('telegram_chats').doc(doc.id).get();
    const chatId = chatDoc.exists ? chatDoc.data().chatId : doc.id;
    try {
      if (daysLeft === 3 && !u.remindedH3) {
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId, parse_mode: 'HTML',
          text: `⏰ <b>Reminder</b>\n\nLangganan VIP Anda berakhir dalam <b>3 hari</b>. Perpanjang sekarang biar akses tetap aman!\n\nKetik /beli untuk perpanjang.`
        });
        await db.collection('users').doc(doc.id).update({ remindedH3: true });
        sent++;
      } else if (daysLeft === 1 && !u.remindedH1) {
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId, parse_mode: 'HTML',
          text: `🚨 <b>PEMBERITAHUAN TERAKHIR</b>\n\nLangganan VIP Anda berakhir <b>HARI INI/BESOK</b>. Setelah itu Anda otomatis dikeluarkan dari grup.\n\nKetik /beli untuk perpanjang!`
        });
        await db.collection('users').doc(doc.id).update({ remindedH1: true });
        sent++;
      }
    } catch (e) { console.error('Reminder gagal:', e.message); }
  }
  return sent;
};

module.exports = { notifyOps, runReminders };