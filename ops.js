const axios = require('axios');
const { getFirestore } = require('firebase-admin/firestore');
const { getTpl } = require('./templates');

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

// 🔍 DIPINDAH DARI adminRoutes.js biar server.js & bot webhook bisa pakai
const logAudit = async (admin, action, target = null, meta = {}) => {
  try {
    const db = getFirestore();
    const exp = new Date(); exp.setDate(exp.getDate() + 180);
    await db.collection('audit_logs').add({ admin: admin || 'system', action, target, meta, at: new Date().toISOString(), exp });
  } catch (e) { console.error('Audit log gagal:', e.message); }
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
    const chatDoc = await db.collection('telegram_chats').doc(doc.id).get();
    if (!chatDoc.exists && (u.source === 'manual' || u.source === 'license')) continue; // user lisensi tanpa chat bot → skip reminder
    const daysLeft = Math.ceil((u.expiredAt.toDate() - now) / 86400000);
    const dateStr = u.expiredAt.toDate().toLocaleString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
    const chatId = chatDoc.exists ? chatDoc.data().chatId : doc.id;
    try {
      if (daysLeft === 3 && !u.remindedH3) {
        await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, parse_mode: 'HTML', text: await getTpl('reminder_h3', { tanggal: dateStr }) });
        await db.collection('users').doc(doc.id).update({ remindedH3: true });
        sent++;
      } else if (daysLeft === 1 && !u.remindedH1) {
        await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, parse_mode: 'HTML', text: await getTpl('reminder_h1', { tanggal: dateStr }) });
        await db.collection('users').doc(doc.id).update({ remindedH1: true });
        sent++;
      }
    } catch (e) { console.error('Reminder gagal:', e.message); }
  }
  return sent;
};

module.exports = { notifyOps, runReminders, logAudit };
