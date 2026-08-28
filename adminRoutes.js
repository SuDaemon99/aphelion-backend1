const express = require('express');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const { getFirestore } = require('firebase-admin/firestore');

const db = getFirestore();
const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET;
const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
const VIP_GROUP_ID = process.env.VIP_GROUP_ID || '-1004477570254';
const PUBLIC_GROUP_ID = process.env.PUBLIC_GROUP_ID || null;

// ---------- HELPERS ----------
const logAudit = async (admin, action, target = null, meta = {}) => {
  try {
    const exp = new Date(); exp.setDate(exp.getDate() + 180);
    await db.collection('audit_logs').add({ admin: admin || 'system', action, target, meta, at: new Date().toISOString(), exp });
  } catch (e) { console.error('Audit log gagal:', e.message); }
};

const sendTG = async (chatId, text, options = {}) => {
  const r = await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text, ...options });
  return r.data;
};

const kickFromGroup = async (userId) => {
  await axios.post(`${TELEGRAM_API}/banChatMember`, { chat_id: VIP_GROUP_ID, user_id: userId });
  await axios.post(`${TELEGRAM_API}/unbanChatMember`, { chat_id: VIP_GROUP_ID, user_id: userId });
};

// ---------- MIDDLEWARE RBAC ----------
const requireAuth = (req, res, next) => {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try { req.admin = jwt.verify(token, JWT_SECRET); next(); }
  catch (e) { return res.status(401).json({ error: 'Token invalid/kadaluarsa' }); }
};

const requireOwner = (req, res, next) => {
  if (!req.admin || req.admin.role !== 'owner') return res.status(403).json({ error: 'Khusus owner' });
  next();
};

const loginLimiter = rateLimit({ windowMs: 60 * 1000, max: 5 });

// ================= AUTH =================
router.post('/auth/login', loginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Username & password wajib' });
    const uname = String(username).toLowerCase();
    const doc = await db.collection('admin_accounts').doc(uname).get();
    if (!doc.exists) return res.status(401).json({ error: 'Kredensial salah' });
    const acc = doc.data();
    if (!acc.active) return res.status(403).json({ error: 'Akun nonaktif' });
    if (acc.lockedUntil && acc.lockedUntil.toDate && acc.lockedUntil.toDate() > new Date()) {
      return res.status(423).json({ error: 'Akun terkunci 15 menit (5x gagal). Coba lagi nanti.' });
    }
    const ok = await bcrypt.compare(String(password), acc.passHash);
    if (!ok) {
      const fails = (acc.failCount || 0) + 1;
      const patch = { failCount: fails };
      if (fails >= 5) { const l = new Date(); l.setMinutes(l.getMinutes() + 15); patch.lockedUntil = l; patch.failCount = 0; }
      await db.collection('admin_accounts').doc(uname).update(patch);
      return res.status(401).json({ error: 'Kredensial salah' });
    }
    await db.collection('admin_accounts').doc(uname).update({ failCount: 0, lockedUntil: null, lastLoginAt: new Date().toISOString() });
    const token = jwt.sign({ sub: uname, role: acc.role }, JWT_SECRET, { expiresIn: '12h' });
    await logAudit(uname, 'LOGIN');
    res.json({ token, role: acc.role, username: uname });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/auth/me', requireAuth, async (req, res) => {
  res.json({ username: req.admin.sub, role: req.admin.role });
});

router.post('/auth/change-password', requireAuth, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body || {};
    if (!oldPassword || !newPassword || newPassword.length < 8) return res.status(400).json({ error: 'Password baru min. 8 karakter' });
    const doc = await db.collection('admin_accounts').doc(req.admin.sub).get();
    const ok = await bcrypt.compare(oldPassword, doc.data().passHash);
    if (!ok) return res.status(401).json({ error: 'Password lama salah' });
    await db.collection('admin_accounts').doc(req.admin.sub).update({ passHash: await bcrypt.hash(newPassword, 10) });
    await logAudit(req.admin.sub, 'CHANGE_PASSWORD');
    res.json({ status: 'OK' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ================= DASHBOARD =================
router.get('/dashboard/stats', requireAuth, async (req, res) => {
  try {
    const cnt = async (st) => (await db.collection('users').where('status', '==', st).count().get()).data().count;
    const [active, expired, banned] = await Promise.all([cnt('ACTIVE'), cnt('EXPIRED'), cnt('BANNED')]);
    const now = new Date(); const sod = new Date(now); sod.setHours(0, 0, 0, 0);
    const newToday = (await db.collection('users').where('createdAt', '>=', sod.toISOString()).count().get()).data().count;
    const plus3 = new Date(now.getTime() + 3 * 86400000);
    const expiring = (await db.collection('users').where('status', '==', 'ACTIVE').where('expiredAt', '<', plus3).count().get()).data().count;
    const setDoc = await db.collection('settings').doc('app').get();
    const settings = setDoc.exists ? setDoc.data() : {};

    const out = {
      users: { active, expired, banned, newToday, expiringIn3Days: expiring },
      bot: { maintenance: settings.maintenance === true, lastCronRun: settings.lastCronRun || null }
    };
    if (req.admin.role === 'owner') {
      const dk = now.toISOString().slice(0, 10);
      const fDoc = await db.collection('finance_daily').doc(dk).get();
      const tDoc = await db.collection('finance_total').doc('all').get();
      out.finance = {
        today: fDoc.exists ? { gross: fDoc.data().gross || 0, count: fDoc.data().count || 0 } : { gross: 0, count: 0 },
        total: tDoc.exists ? { gross: tDoc.data().gross || 0, count: tDoc.data().count || 0 } : { gross: 0, count: 0 }
      };
    }
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ================= USERS =================
router.get('/users', requireAuth, async (req, res) => {
  try {
    const { status, q, cursor } = req.query;
    const limit = 20;
    if (q) {
      const qq = String(q).trim();
      if (/^\d{5,15}$/.test(qq)) {
        const d = await db.collection('users').doc(qq).get();
        return res.json({ users: d.exists ? [{ id: qq, ...d.data() }] : [], nextCursor: null });
      }
      const snap = await db.collection('users').where('username', '==', qq.toLowerCase()).limit(limit).get();
      return res.json({ users: snap.docs.map(x => ({ id: x.id, ...x.data() })), nextCursor: null });
    }
    let ref = db.collection('users').orderBy('expiredAt', 'desc');
    if (status) ref = ref.where('status', '==', status);
    ref = ref.limit(limit);
    if (cursor) ref = ref.startAfter(new Date(parseInt(cursor)));
    const snap = await ref.get();
    const users = snap.docs.map(x => ({ id: x.id, ...x.data() }));
    const last = snap.docs[snap.docs.length - 1];
    res.json({ users, nextCursor: last && last.data().expiredAt ? last.data().expiredAt.toMillis() : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/users/:uid', requireAuth, async (req, res) => {
  const d = await db.collection('users').doc(req.params.uid).get();
  if (!d.exists) return res.status(404).json({ error: 'User tidak ditemukan' });
  res.json({ id: d.id, ...d.data() });
});

router.post('/users/:uid/extend', requireAuth, async (req, res) => {
  try {
    const days = parseInt(req.body.days) || 30;
    const d = await db.collection('users').doc(req.params.uid).get();
    if (!d.exists) return res.status(404).json({ error: 'User tidak ditemukan' });
    const u = d.data(); const now = new Date();
    const base = (u.status === 'ACTIVE' && u.expiredAt && u.expiredAt.toDate() > now) ? u.expiredAt.toDate() : now;
    const newExp = new Date(base.getTime() + days * 86400000);
    await db.collection('users').doc(req.params.uid).update({ expiredAt: newExp, status: 'ACTIVE' });
    await logAudit(req.admin.sub, 'EXTEND', req.params.uid, { days });
    res.json({ status: 'OK', expiredAt: newExp.toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/users/:uid/reset-hwid', requireAuth, async (req, res) => {
  await db.collection('users').doc(req.params.uid).update({ deviceId: null });
  await logAudit(req.admin.sub, 'RESET_HWID', req.params.uid);
  res.json({ status: 'OK' });
});

router.post('/users/:uid/ban', requireAuth, async (req, res) => {
  try {
    const reason = req.body.reason || 'Pelanggaran aturan';
    await db.collection('users').doc(req.params.uid).update({ status: 'BANNED' });
    try { await kickFromGroup(req.params.uid); } catch (e) { console.error('Kick gagal:', e.message); }
    const chatDoc = await db.collection('telegram_chats').doc(req.params.uid).get();
    if (chatDoc.exists) {
      try { await sendTG(chatDoc.data().chatId, `🚫 <b>Akses Dicabut</b>\n\nAlasan: <i>${reason}</i>\nJika merasa keliru, hubungi support.`, { parse_mode: 'HTML' }); } catch (e) {}
    }
    await logAudit(req.admin.sub, 'BAN', req.params.uid, { reason });
    res.json({ status: 'BANNED' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/users/:uid/unban', requireAuth, async (req, res) => {
  const d = await db.collection('users').doc(req.params.uid).get();
  if (!d.exists) return res.status(404).json({ error: 'User tidak ditemukan' });
  const u = d.data();
  const st = (u.expiredAt && u.expiredAt.toDate() > new Date()) ? 'ACTIVE' : 'EXPIRED';
  await db.collection('users').doc(req.params.uid).update({ status: st });
  await logAudit(req.admin.sub, 'UNBAN', req.params.uid, { newStatus: st });
  res.json({ status: st });
});

router.post('/users/:uid/kick', requireAuth, async (req, res) => {
  try { await kickFromGroup(req.params.uid); } catch (e) { return res.status(500).json({ error: 'Kick gagal: ' + e.message }); }
  await logAudit(req.admin.sub, 'KICK', req.params.uid);
  res.json({ status: 'KICKED' });
});

router.post('/users/:uid/resend-token', requireAuth, async (req, res) => {
  try {
    const d = await db.collection('users').doc(req.params.uid).get();
    if (!d.exists) return res.status(404).json({ error: 'User tidak ditemukan' });
    const u = d.data();
    const chatDoc = await db.collection('telegram_chats').doc(req.params.uid).get();
    const chatId = chatDoc.exists ? chatDoc.data().chatId : req.params.uid;
    const invite = await axios.post(`${TELEGRAM_API}/createChatInviteLink`, { chat_id: VIP_GROUP_ID, member_limit: 1 });
    await sendTG(chatId, `🔑 <b>Token akses Anda:</b>\n<code>${u.token}</code>\n\n🚪 Ketuk tombol di bawah untuk masuk VIP:`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '🚪 MASUK GRUP VIP', url: invite.data.result.invite_link }]] }
    });
    await logAudit(req.admin.sub, 'RESEND_TOKEN', req.params.uid);
    res.json({ status: 'SENT' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ================= FINANCE [OWNER] =================
router.get('/finance/summary', requireAuth, requireOwner, async (req, res) => {
  try {
    const range = req.query.range || '7d';
    const days = range === 'today' ? 1 : range === '30d' ? 30 : 7;
    const out = { gross: 0, count: 0, daily: [] };
    for (let i = 0; i < days; i++) {
      const dk = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      const f = await db.collection('finance_daily').doc(dk).get();
      if (f.exists) { out.gross += f.data().gross || 0; out.count += f.data().count || 0; out.daily.push({ date: dk, gross: f.data().gross || 0, count: f.data().count || 0 }); }
    }
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/transactions', requireAuth, requireOwner, async (req, res) => {
  const limit = 20;
  let ref = db.collection('transactions').orderBy('paidAt', 'desc').limit(limit);
  if (req.query.cursor) ref = ref.startAfter(String(req.query.cursor));
  const snap = await ref.get();
  const txs = snap.docs.map(x => ({ id: x.id, ...x.data() }));
  const last = snap.docs[snap.docs.length - 1];
  res.json({ transactions: txs, nextCursor: last ? last.data().paidAt : null });
});

router.get('/finance/export', requireAuth, requireOwner, async (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const start = new Date(Date.now() - days * 86400000).toISOString();
  const snap = await db.collection('transactions').where('paidAt', '>=', start).orderBy('paidAt', 'desc').limit(1000).get();
  let csv = 'order_id,uid,amount,status,channel,mode,paid_at\n';
  for (const d of snap.docs) {
    const t = d.data();
    csv += `${t.orderId},${t.uid},${t.amount},${t.status},${t.channel},${t.mode},${t.paidAt}\n`;
  }
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=aphelion-finance-${days}d.csv`);
  res.send(csv);
});

// ================= AUDIT [OWNER] =================
router.get('/audit-logs', requireAuth, requireOwner, async (req, res) => {
  const limit = 30;
  let ref = db.collection('audit_logs').orderBy('at', 'desc').limit(limit);
  if (req.query.cursor) ref = ref.startAfter(String(req.query.cursor));
  const snap = await ref.get();
  const logs = snap.docs.map(x => ({ id: x.id, ...x.data() }));
  const last = snap.docs[snap.docs.length - 1];
  res.json({ logs, nextCursor: last ? last.data().at : null });
});

// ================= BOT CONTROL [OWNER] =================
router.get('/bot/health', requireAuth, requireOwner, async (req, res) => {
  const s = await db.collection('settings').doc('app').get();
  res.json(s.exists ? s.data() : {});
});

router.post('/bot/maintenance', requireAuth, requireOwner, async (req, res) => {
  const enabled = req.body.enabled === true;
  await db.collection('settings').doc('app').set({ maintenance: enabled, updatedAt: new Date().toISOString(), updatedBy: req.admin.sub }, { merge: true });
  await logAudit(req.admin.sub, 'MAINTENANCE', null, { enabled });
  res.json({ status: 'OK', maintenance: enabled });
});

router.post('/bot/broadcast', requireAuth, requireOwner, async (req, res) => {
  const { target, text } = req.body || {};
  if (!text) return res.status(400).json({ error: 'Text wajib' });
  const gid = target === 'vip' ? VIP_GROUP_ID : PUBLIC_GROUP_ID;
  if (!gid) return res.status(400).json({ error: 'Group ID belum diset' });
  await sendTG(gid, String(text));
  await logAudit(req.admin.sub, 'BROADCAST', target, { length: text.length });
  res.json({ status: 'SENT' });
});

router.post('/cron/run', requireAuth, requireOwner, async (req, res) => {
  const now = new Date();
  const snap = await db.collection('users').where('status', '==', 'ACTIVE').where('expiredAt', '<', now).get();
  let n = 0;
  for (const doc of snap.docs) {
    await db.collection('users').doc(doc.id).update({ status: 'EXPIRED' });
    try { await kickFromGroup(doc.id); } catch (e) {}
    n++;
  }
  await db.collection('settings').doc('app').set({ lastCronRun: now.toISOString() }, { merge: true });
  await logAudit(req.admin.sub, 'CRON_RUN', null, { expired: n });
  res.json({ status: 'CRON_SUCCESS', user_expired: n });
});

// ================= ADMIN ACCOUNTS [OWNER] =================
router.get('/admins', requireAuth, requireOwner, async (req, res) => {
  const snap = await db.collection('admin_accounts').get();
  res.json({ admins: snap.docs.map(x => { const a = x.data(); return { username: a.username, role: a.role, active: a.active, lastLoginAt: a.lastLoginAt }; }) });
});

router.post('/admins', requireAuth, requireOwner, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password || password.length < 8) return res.status(400).json({ error: 'Username & password (min 8) wajib' });
  const uname = String(username).toLowerCase();
  const ex = await db.collection('admin_accounts').doc(uname).get();
  if (ex.exists) return res.status(409).json({ error: 'Username sudah ada' });
  await db.collection('admin_accounts').doc(uname).set({
    username: uname, passHash: await bcrypt.hash(password, 10), role: 'admin', active: true,
    createdAt: new Date().toISOString(), lastLoginAt: null, failCount: 0, lockedUntil: null
  });
  await logAudit(req.admin.sub, 'ADMIN_CREATE', uname);
  res.json({ status: 'CREATED' });
});

router.post('/admins/:username/deactivate', requireAuth, requireOwner, async (req, res) => {
  const t = await db.collection('admin_accounts').doc(req.params.username).get();
  if (!t.exists) return res.status(404).json({ error: 'Tidak ditemukan' });
  if (t.data().role === 'owner' || req.params.username === req.admin.sub) return res.status(403).json({ error: 'Tidak bisa menonaktifkan owner / diri sendiri' });
  await db.collection('admin_accounts').doc(req.params.username).update({ active: false });
  await logAudit(req.admin.sub, 'ADMIN_DEACTIVATE', req.params.username);
  res.json({ status: 'OK' });
});

router.post('/admins/:username/activate', requireAuth, requireOwner, async (req, res) => {
  await db.collection('admin_accounts').doc(req.params.username).update({ active: true });
  await logAudit(req.admin.sub, 'ADMIN_ACTIVATE', req.params.username);
  res.json({ status: 'OK' });
});

module.exports = router;