const axios = require('axios');
const { getFirestore } = require('firebase-admin/firestore');
const { getTpl } = require('./templates');

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
const OWNER_TELEGRAM_ID = process.env.OWNER_TELEGRAM_ID || null;
const VIP_GROUP_ID = process.env.VIP_GROUP_ID || '-1004477570254';
const escapeHtml = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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

const logAudit = async (admin, action, target = null, meta = {}) => {
  try {
    const db = getFirestore();
    const exp = new Date(); exp.setDate(exp.getDate() + 180);
    await db.collection('audit_logs').add({ admin: admin || 'system', action, target, meta, at: new Date().toISOString(), exp });
  } catch (e) { console.error('Audit log gagal:', e.message); }
};

// 🔔 REMINDER v3: jendela longgar (catch-up), dedupe per orang, flag serentak semua doc
const runReminders = async () => {
  const db = getFirestore();
  const now = new Date();
  const soon = new Date(now.getTime() + 4 * 86400000);
  const snap = await db.collection('users')
    .where('status', '==', 'ACTIVE')
    .where('expiredAt', '>', now)
    .where('expiredAt', '<', soon)
    .get();

  // 1) GROUP per orang: 1 manusia bisa punya 2 doc lisensi (Grab + Phantom)
  const persons = new Map(); // key -> { tgUid, username, docs:[{ref,u}], minExp:Date }
  for (const doc of snap.docs) {
    const u = doc.data();
    let tgUid = null;
    if (u.ownerTgUid && /^\d{5,15}$/.test(String(u.ownerTgUid))) tgUid = String(u.ownerTgUid);
    else if (/^\d{5,15}$/.test(doc.id)) tgUid = doc.id;
    const uname = u.username ? String(u.username).toLowerCase() : null;
    const key = tgUid || (uname ? 'u:' + uname : 'd:' + doc.id);
    if (!persons.has(key)) persons.set(key, { tgUid: null, username: u.username || null, docs: [], minExp: null });
    const p = persons.get(key);
    p.docs.push({ ref: doc.ref, u });
    if (tgUid && !p.tgUid) p.tgUid = tgUid;
    const exp = u.expiredAt.toDate();
    if (!p.minExp || exp < p.minExp) p.minExp = exp; // pakai expiry terdekat
  }

  let sent = 0;
  for (const [key, p] of persons.entries()) {
    const daysLeft = Math.ceil((p.minExp - now) / 86400000);
    const needH3 = p.docs.some(d => !d.u.remindedH3);
    const needH1 = p.docs.some(d => !d.u.remindedH1);
    if (!needH3 && !needH1) continue;               // orang ini sudah lengkap diingatkan
    if (daysLeft > 3) continue;                     // belum masuk jendela

    // 2) Resolve chat sekali per orang
    let chatId = null;
    if (p.tgUid) {
      const chatDoc = await db.collection('telegram_chats').doc(p.tgUid).get().catch(() => null);
      if (chatDoc && chatDoc.exists) chatId = chatDoc.data().chatId || p.tgUid;
    }
    if (!chatId && p.username) {
      try {
        const s = await db.collection('telegram_chats')
          .where('username', '==', String(p.username).toLowerCase()).limit(1).get();
        if (!s.empty) {
          chatId = s.docs[0].data().chatId || s.docs[0].id;
          if (!p.tgUid) p.tgUid = s.docs[0].id;
        }
      } catch (e) { /* abaikan */ }
    }

    // Flag serentak ke SEMUA doc orang ini (biar doc ke-2 tidak kirim duplikat)
    const markAll = async (patch) => {
      const b = db.batch();
      p.docs.forEach(d => b.update(d.ref, patch));
      await b.commit().catch(() => {});
    };

    if (!chatId) {
      const src = p.docs[0].u.source;
      if (src === 'manual' || src === 'license') continue;
      await markAll({ remindedH3: true, remindedH1: true });
      console.warn(`⚠️ Reminder skip (chat tidak ditemukan): key=${key}`);
      continue;
    }

    const dateStr = p.minExp.toLocaleString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
    try {
      if (daysLeft <= 1) {
        // 🚨 H-1 (atau catch-up telat): DM + tag grup SEKALI per orang
        if (needH1) {
          await axios.post(`${TELEGRAM_API}/sendMessage`, {
            chat_id: chatId, parse_mode: 'HTML',
            text: await getTpl('reminder_h1', { tanggal: dateStr })
          });
          if (p.username && VIP_GROUP_ID) {
            try {
              await axios.post(`${TELEGRAM_API}/sendMessage`, {
                chat_id: VIP_GROUP_ID, parse_mode: 'HTML',
                text: await getTpl('reminder_h1_group', { username: escapeHtml(p.username), tanggal: dateStr }),
                disable_web_page_preview: true
              });
            } catch (e) { console.error('H-1 group tag gagal:', e.message); }
          }
          await markAll({ remindedH1: true, remindedH3: true }); // H-3 sudah tidak relevan
          sent++;
        }
      } else if (daysLeft <= 3) {
        // ⏰ H-3 (atau catch-up H-2): DM saja
        if (needH3) {
          await axios.post(`${TELEGRAM_API}/sendMessage`, {
            chat_id: chatId, parse_mode: 'HTML',
            text: await getTpl('reminder_h3', { tanggal: dateStr })
          });
          await markAll({ remindedH3: true });
          sent++;
        }
      }
    } catch (e) {
      console.error('Reminder gagal:', e.message);
      if (e.response && e.response.status === 400) {
        await markAll({ remindedH3: true, remindedH1: true }); // chat mati/blokir → stop retry
        console.warn(`⚠️ User key=${key} ditandai skip reminder (chat tidak valid)`);
      }
    }
  }
  return sent;
};

module.exports = { notifyOps, runReminders, logAudit };
