const axios = require('axios');
const { getFirestore } = require('firebase-admin/firestore');

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
const OWNER_TELEGRAM_ID = process.env.OWNER_TELEGRAM_ID || null;

const notifyOps = async (full, opts = {}) => {
  const db = getFirestore();
  const type = opts.type || (opts.critical ? 'critical' : 'system');
  try {
    const exp = new Date(); exp.setDate(exp.getDate() + 180);
    await db.collection('ops_feed').add({
      full,
      safe: opts.safe || full,
      type,
      at: new Date().toISOString(),
      exp
    });
  } catch (e) { console.error('ops_feed write gagal:', e.message); }

  if (opts.critical && OWNER_TELEGRAM_ID) {
    try {
      await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: OWNER_TELEGRAM_ID, text: full, parse_mode: 'HTML' });
    } catch (e) { console.error('DM kritis gagal:', e.message); }
  }
};

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
    const dateStr = u.expiredAt.toDate().toLocaleString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
    const chatDoc = await db.collection('telegram_chats').doc(doc.id).get();
    const chatId = chatDoc.exists ? chatDoc.data().chatId : doc.id;
    try {
      if (daysLeft === 3 && !u.remindedH3) {
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId, parse_mode: 'HTML',
          text: `⏰ <b>PENGINGAT RAMAH</b>\n\nHalo! Langganan VIP Anda akan berakhir dalam <b>3 hari</b> (${dateStr}).\n\nPerpanjang sekarang agar tetap nyaman di grup VIP tanpa jeda:\n👉 ketik /beli di chat ini.\n\nTerima kasih! 🌌`
        });
        await db.collection('users').doc(doc.id).update({ remindedH3: true });
        sent++;
      } else if (daysLeft === 1 && !u.remindedH1) {
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId, parse_mode: 'HTML',
          text: `🚨 <b>PEMBERITAHUAN TERAKHIR</b>\n\nLangganan VIP Anda berakhir <b>besok/hari ini</b> (${dateStr}). Setelah itu Anda otomatis dikeluarkan dari grup VIP.\n\n👉 Ketik /beli untuk perpanjang sekarang. Sampai jumpa di dalam! 🌌`
        });
        await db.collection('users').doc(doc.id).update({ remindedH1: true });
        sent++;
      }
    } catch (e) { console.error('Reminder gagal:', e.message); }
  }
  return sent;
};

module.exports = { notifyOps, runReminders };
