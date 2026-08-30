const express = require('express');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const { getFirestore } = require('firebase-admin/firestore');
const { notifyOps, runReminders } = require('./ops');
const { getTpl, DEFAULT_TPL, VARS } = require('./templates');

const db = getFirestore();
const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET;
const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
const VIP_GROUP_ID = process.env.VIP_GROUP_ID || '-1004477570254';
const PUBLIC_GROUP_ID = process.env.PUBLIC_GROUP_ID || null;
const ALL_GROUPS = [PUBLIC_GROUP_ID, VIP_GROUP_ID].filter(Boolean);

// 🎭 avatar eksklusif per role
const OWNER_AVATARS = ['owner_1', 'owner_2', 'owner_3', 'owner_4', 'owner_5', 'owner_6'];
const ADMIN_AVATARS = ['admin_1', 'admin_2', 'admin_3', 'admin_4', 'admin_5', 'admin_6'];
const REACT_EMOJI = ['👍', '✅', '🔥', '', '😮'];

const escapeHtml = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------- HELPERS ----------
const logAudit = async (admin, action, target = null, meta = {}) => {
  try {
    const exp = new Date(); exp.setDate(exp.getDate() + 180);
    await db.collection('audit_logs').add({ admin: admin || 'system', action, target, meta, at: new Date().toISOString(), exp });
  } catch (e) { console.error('Audit log gagal:', e.message); }
};

const serializeUser = (id, u) => ({
  id,
  uid: u.uid || null,
  username: u.username || null,
  email: u.email || null,
  token: u.token || null,
  deviceId: u.deviceId || null,
  status: u.status || null,
  expiredAt: u.expiredAt && u.expiredAt.toDate ? u.expiredAt.toDate().toISOString() : null,
  createdAt: u.createdAt || null
});

const sendTG = async (chatId, text, options = {}) => {
  try {
    const r = await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text, ...options });

    // ===== 💾 TRACKING PESAN GRUP =====
    if (String(chatId) === String(VIP_GROUP_ID) || String(chatId) === String(PUBLIC_GROUP_ID)) {
      const mid = r.data.result.message_id;
      db.collection('bot_messages').add({
        chatId: String(chatId),
        messageId: mid,
        at: new Date().toISOString()
      }).catch(() => {});
    }
    // ===============================================

    return r.data;
  } catch (error) {
    if (options.parse_mode) {
      try {
        const r2 = await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text });
        return r2.data;
      } catch (e2) { console.error('Plain resend gagal:', e2.message); }
    }
    throw error;
  }
};

const broadcastAll = async (text) => {
  for (const gid of ALL_GROUPS) {
    try { await sendTG(gid, text, { parse_mode: 'HTML' }); } catch (e) { console.error('Broadcast gagal:', e.message); }
  }
};

const liveHumans = async (gid) => {
  try {
    const [c, a] = await Promise.all([
      axios.post(`${TELEGRAM_API}/getChatMemberCount`, { chat_id: gid }),
      axios.post(`${TELEGRAM_API}/getChatAdministrators`, { chat_id: gid })
    ]);
    return Math.max((c.data.result || 0) - (a.data.result || []).length, 0);
  } catch (e) { return 0; }
};

const kickFromGroup = async (userId) => {
  await axios.post(`${TELEGRAM_API}/banChatMember`, { chat_id: VIP_GROUP_ID, user_id: userId });
  await axios.post(`${TELEGRAM_API}/unbanChatMember`, { chat_id: VIP_GROUP_ID, user_id: userId });
};

// ---------- MIDDLEWARE RBAC ----------
const requireAuth = async (req, res, next) => {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  let payload;
  try { payload = jwt.verify(token, JWT_SECRET); }
  catch (e) { return res.status(401).json({ error: 'Token invalid/kadaluarsa' }); }
  try {
    const doc = await db.collection('admin_accounts').doc(payload.sub).get();
    if (!doc.exists || doc.data().active !== true) {
      return res.status(401).json({ error: 'Akun nonaktif. Sesi berakhir.' });
    }
    const epoch = doc.data().epoch || 0;
    if ((payload.ep || 0) !== epoch) {
      return res.status(401).json({ error: 'Sesi berakhir. Login ulang.' });
    }
    req.admin = payload;
    next();
  } catch (e) { return res.status(500).json({ error: e.message }); }
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
    const epoch = acc.epoch || 0;
    const token = jwt.sign({ sub: uname, role: acc.role, ep: epoch }, JWT_SECRET, { expiresIn: '12h' });
    await logAudit(uname, 'LOGIN');
    await notifyOps(`🔐 <b>Login</b>: ${uname} (${acc.role})`, { safe: `🔐 Login: ${uname}` });
    res.json({ token, role: acc.role, username: uname });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/auth/me', requireAuth, async (req, res) => {
  const d = await db.collection('admin_accounts').doc(req.admin.sub).get();
  res.json({ username: req.admin.sub, role: req.admin.role, avatar: d.exists ? (d.data().avatar || null) : null });
});

router.post('/auth/avatar', requireAuth, async (req, res) => {
  const avatar = String(req.body.avatar || '');
  const set = req.admin.role === 'owner' ? OWNER_AVATARS : ADMIN_AVATARS;
  if (!set.includes(avatar)) return res.status(400).json({ error: 'Avatar tidak tersedia untuk role Anda' });
  await db.collection('admin_accounts').doc(req.admin.sub).update({ avatar });
  res.json({ status: 'OK' });
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
      bot: { maintenance: settings.maintenance === true, lastCronRun: settings.lastCronRun || null },
      community: {
        vipHumans: await liveHumans(VIP_GROUP_ID),
        publicHumans: PUBLIC_GROUP_ID ? await liveHumans(PUBLIC_GROUP_ID) : 0
      }
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
        return res.json({ users: d.exists ? [serializeUser(qq, d.data())] : [], nextCursor: null });
      }
      const snap = await db.collection('users').where('username', '==', qq.toLowerCase()).limit(limit).get();
      return res.json({ users: snap.docs.map(x => serializeUser(x.id, x.data())), nextCursor: null });
    }
    if (status) {
      const snap = await db.collection('users').where('status', '==', status).limit(200).get();
      const sorted = snap.docs
        .map(x => ({ id: x.id, u: x.data() }))
        .sort((a, b) => (b.u.expiredAt && b.u.expiredAt.toMillis ? b.u.expiredAt.toMillis() : 0) - (a.u.expiredAt && a.u.expiredAt.toMillis ? a.u.expiredAt.toMillis() : 0));
      return res.json({ users: sorted.map(x => serializeUser(x.id, x.u)), nextCursor: null });
    }
    let ref = db.collection('users').orderBy('expiredAt', 'desc').limit(limit);
    if (cursor) ref = ref.startAfter(new Date(parseInt(cursor)));
    const snap = await ref.get();
    const users = snap.docs.map(x => serializeUser(x.id, x.data()));
    const last = snap.docs[snap.docs.length - 1];
    res.json({ users, nextCursor: last && last.data().expiredAt ? last.data().expiredAt.toMillis() : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/users/:uid', requireAuth, async (req, res) => {
  const d = await db.collection('users').doc(req.params.uid).get();
  if (!d.exists) return res.status(404).json({ error: 'User tidak ditemukan' });
  res.json(serializeUser(d.id, d.data()));
});

router.post('/users/:uid/extend', requireAuth, async (req, res) => {
  try {
    const days = parseInt(req.body.days) || 30;
    const d = await db.collection('users').doc(req.params.uid).get();
    if (!d.exists) return res.status(404).json({ error: 'User tidak ditemukan' });
    const u = d.data(); const now = new Date();
    const base = (u.status === 'ACTIVE' && u.expiredAt && u.expiredAt.toDate() > now) ? u.expiredAt.toDate() : now;
    const newExp = new Date(base.getTime() + days * 86400000);
    await db.collection('users').doc(req.params.uid).update({ expiredAt: newExp, status: 'ACTIVE', remindedH3: false, remindedH1: false });
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
      try { await sendTG(chatDoc.data().chatId, await getTpl('ban_dm', { alasan: escapeHtml(reason) }), { parse_mode: 'HTML' }); } catch (e) {}
    }
    await logAudit(req.admin.sub, 'BAN', req.params.uid, { reason });
    await notifyOps(`🚫 <b>BAN</b> oleh ${req.admin.sub}\nUID <code>${req.params.uid}</code> — ${reason}`, { safe: `🚫 BAN oleh ${req.admin.sub} • UID ${req.params.uid}`, critical: true });
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
  await notifyOps(`🟢 <b>UNBAN</b> oleh ${req.admin.sub}\nUID <code>${req.params.uid}</code> → ${st}`, { safe: `🟢 UNBAN oleh ${req.admin.sub} • UID ${req.params.uid}` });
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
    await sendTG(chatId, await getTpl('resend_dm', { token: u.token }), {
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
  try {
    const limit = 100;
    const { cursor, from, to } = req.query;
    let ref = db.collection('audit_logs');
    if (from) ref = ref.where('at', '>=', `${String(from)}T00:00:00Z`);
    if (to) ref = ref.where('at', '<=', `${String(to)}T23:59:59Z`);
    ref = ref.orderBy('at', 'desc').limit(limit);
    if (cursor) ref = ref.startAfter(String(cursor));
    const snap = await ref.get();
    const logs = snap.docs.map(x => ({ id: x.id, ...x.data() }));
    const last = snap.docs[snap.docs.length - 1];
    res.json({ logs, nextCursor: last ? last.data().at : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/audit-logs/purge', requireAuth, requireOwner, async (req, res) => {
  try {
    const days = parseInt(req.body.days) || 90;
    if (days < 7) return res.status(400).json({ error: 'Demi keamanan, minimal retensi 7 hari.' });
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    let deleted = 0;
    while (true) {
      const snap = await db.collection('audit_logs').where('at', '<', cutoff).limit(400).get();
      if (snap.empty) break;
      const b = db.batch();
      snap.docs.forEach(d => b.delete(d.ref));
      await b.commit();
      deleted += snap.size;
      if (snap.size < 400) break;
    }
    await logAudit(req.admin.sub, 'PURGE_AUDIT', null, { days, deleted });
    await notifyOps(`🗑 <b>Audit purge</b> oleh ${req.admin.sub}: ${deleted} entri > ${days} hari dihapus`, { safe: `🗑 Audit purge: ${deleted} entri lama` });
    res.json({ status: 'OK', deleted });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ================= TEAM FEED & CHAT =================
router.get('/feed', requireAuth, async (req, res) => {
  try {
    const limit = 30;
    let ref = db.collection('ops_feed').orderBy('at', 'desc').limit(limit);
    if (req.query.cursor) ref = ref.startAfter(String(req.query.cursor));
    const snap = await ref.get();
    const isOwner = req.admin.role === 'owner';
    const logs = snap.docs.map(x => {
      const d = x.data();
      return { id: x.id, text: isOwner ? d.full : (d.safe || d.full), at: d.at };
    });
    const last = snap.docs[snap.docs.length - 1];
    res.json({ logs, nextCursor: last ? last.data().at : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/feed/seen', requireAuth, async (req, res) => {
  await db.collection('team_meta').doc(req.admin.sub).set({ lastFeedSeen: new Date().toISOString() }, { merge: true });
  res.json({ status: 'OK' });
});

router.get('/team/chat', requireAuth, async (req, res) => {
  const limit = 50;
  let ref = db.collection('team_chat').orderBy('at', 'desc').limit(limit);
  if (req.query.cursor) ref = ref.startAfter(String(req.query.cursor));
  const snap = await ref.get();
  const logs = snap.docs.map(x => ({ id: x.id, ...x.data() }));
  const last = snap.docs[snap.docs.length - 1];
  const pinSnap = await db.collection('team_chat').where('pinned', '==', true).limit(50).get();
  const pins = pinSnap.docs.sort((a, b) => (b.data().at || '').localeCompare(a.data().at || ''));
  const pinned = pins.length ? { id: pins[0].id, ...pins[0].data() } : null;
  res.json({ logs, nextCursor: last ? last.data().at : null, pinned });
});

router.post('/team/chat', requireAuth, async (req, res) => {
  const text = String((req.body || {}).text || '').trim();
  if (!text) return res.status(400).json({ error: 'Text wajib' });
  if (text.length > 500) return res.status(400).json({ error: 'Maksimal 500 karakter' });
  const exp = new Date(); exp.setDate(exp.getDate() + 180);
  const doc = {
    sender: req.admin.sub, role: req.admin.role, text,
    avatar: req.body.avatar || null,
    at: new Date().toISOString(), exp
  };
  if (req.body.replyTo && req.body.replyTo.id) {
    doc.replyTo = {
      id: String(req.body.replyTo.id),
      sender: String(req.body.replyTo.sender || ''),
      text: String(req.body.replyTo.text || '').slice(0, 80)
    };
  }
  await db.collection('team_chat').add(doc);

  const snap = await db.collection('fcm_tokens').get();
  const tokens = snap.docs
    .filter(d => d.id !== req.admin.sub)
    .map(d => d.data().token)
    .filter(Boolean);
  if (tokens.length && messaging) {
    try {
      await messaging.sendEachForMulticast({
        tokens,
        data: { title: '💬 Chat Baru', body: `${req.admin.sub}: ${text.slice(0, 60)}`, type: 'chat' }
      });
    } catch (e) { console.error('Push chat gagal:', e.message); }
  }
  res.json({ status: 'OK' });
});

router.post('/team/chat/seen', requireAuth, async (req, res) => {
  await db.collection('team_meta').doc(req.admin.sub).set({ lastChatRead: new Date().toISOString() }, { merge: true });
  res.json({ status: 'OK' });
});

router.get('/team/reads', requireAuth, async (req, res) => {
  try {
    const accs = await db.collection('admin_accounts').get();
    const metas = await db.collection('team_meta').get();
    const metaMap = {};
    metas.docs.forEach(x => { metaMap[x.id] = x.data().lastChatRead || null; });
    const out = {};
    accs.docs.forEach(a => { out[a.id] = metaMap[a.id] || null; });
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/team/chat/:id/react', requireAuth, async (req, res) => {
  try {
    const emoji = String(req.body.emoji || '');
    if (!REACT_EMOJI.includes(emoji)) return res.status(400).json({ error: 'Emoji tidak didukung' });
    const ref = db.collection('team_chat').doc(req.params.id);
    const d = await ref.get();
    if (!d.exists) return res.status(404).json({ error: 'Pesan tidak ditemukan' });
    const reactions = d.data().reactions || {};
    const had = (reactions[emoji] || []).includes(req.admin.sub);
    for (const k of Object.keys(reactions)) {
      reactions[k] = (reactions[k] || []).filter(u => u !== req.admin.sub);
    }
    if (!had) reactions[emoji] = [...(reactions[emoji] || []), req.admin.sub];
    for (const k of Object.keys(reactions)) if (!(reactions[k] || []).length) delete reactions[k];
    await ref.update({ reactions });
    res.json({ status: 'OK' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/team/chat/:id/pin', requireAuth, requireOwner, async (req, res) => {
  try {
    const ref = db.collection('team_chat').doc(req.params.id);
    const d = await ref.get();
    if (!d.exists) return res.status(404).json({ error: 'Pesan tidak ditemukan' });
    const pinned = !(d.data().pinned === true);
    await ref.update({ pinned });
    res.json({ status: 'OK', pinned });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/team/chat/:id/delete', requireAuth, async (req, res) => {
  try {
    const ref = db.collection('team_chat').doc(req.params.id);
    const d = await ref.get();
    if (!d.exists) return res.status(404).json({ error: 'Pesan tidak ditemukan' });
    const data = d.data();
    if (data.sender !== req.admin.sub && req.admin.role !== 'owner') {
      return res.status(403).json({ error: 'Tidak bisa hapus pesan orang lain' });
    }
    await ref.update({ deleted: true, text: '' });
    res.json({ status: 'OK' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/team/unread', requireAuth, async (req, res) => {
  try {
    const meta = await db.collection('team_meta').doc(req.admin.sub).get();
    const lastChat = meta.exists && meta.data().lastChatRead ? meta.data().lastChatRead : '1970-01-01T00:00:00Z';
    const lastFeed = meta.exists && meta.data().lastFeedSeen ? meta.data().lastFeedSeen : '1970-01-01T00:00:00Z';
    const chatSnap = await db.collection('team_chat').where('at', '>', lastChat).get();
    const chat = chatSnap.docs.filter(x => x.data().sender !== req.admin.sub && x.data().deleted !== true).length;
    const feedSnap = await db.collection('ops_feed').where('at', '>', lastFeed).get();
    const types = feedSnap.docs.map(x => x.data().type || 'system');
    let sound = null;
    if (req.admin.role === 'owner' && types.includes('pay')) sound = 'pay';
    else if (types.includes('critical')) sound = 'critical';
    else if (types.includes('maint')) sound = 'maint';
    res.json({ chat, feed: feedSnap.size, sound });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ================= TEMPLATES PESAN BOT [OWNER] =================
router.get('/templates', requireAuth, requireOwner, async (req, res) => {
  try {
    const snap = await db.collection('templates').get();
    const custom = {};
    snap.docs.forEach(d => { custom[d.id] = d.data().text; });
    const list = Object.keys(DEFAULT_TPL).map(key => ({
      key,
      vars: VARS[key] || [],
      custom: !!custom[key],
      text: custom[key] || DEFAULT_TPL[key]
    }));
    res.json({ templates: list });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/templates/:key', requireAuth, requireOwner, async (req, res) => {
  try {
    const key = req.params.key;
    if (!DEFAULT_TPL[key]) return res.status(404).json({ error: 'Template tidak dikenal' });
    const text = String(req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Text wajib' });
    if (text.length > 4000) return res.status(400).json({ error: 'Maksimal 4000 karakter' });
    await db.collection('templates').doc(key).set({ text, updatedAt: new Date().toISOString(), updatedBy: req.admin.sub });
    await logAudit(req.admin.sub, 'TEMPLATE_UPDATE', key);
    await notifyOps(`📝 <b>Pesan bot diubah</b>: ${key} oleh ${req.admin.sub}`, { safe: `📝 Template diubah: ${key}` });
    res.json({ status: 'OK' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/templates/:key', requireAuth, requireOwner, async (req, res) => {
  try {
    const key = req.params.key;
    if (!DEFAULT_TPL[key]) return res.status(404).json({ error: 'Template tidak dikenal' });
    await db.collection('templates').doc(key).delete();
    await logAudit(req.admin.sub, 'TEMPLATE_RESET', key);
    await notifyOps(`♻️ <b>Template direset</b>: ${key} oleh ${req.admin.sub}`, { safe: `♻️ Template reset: ${key}` });
    res.json({ status: 'OK' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ================= BOT CONTROL [OWNER] =================
router.get('/bot/health', requireAuth, requireOwner, async (req, res) => {
  const s = await db.collection('settings').doc('app').get();
  res.json({ ...(s.exists ? s.data() : {}), memberCount: await liveHumans(VIP_GROUP_ID) });
});

router.post('/bot/maintenance', requireAuth, requireOwner, async (req, res) => {
  const enabled = req.body.enabled === true;
  const duration = String(req.body.duration || 'belum dipastikan');

  await db.collection('settings').doc('app').set({
    maintenance: enabled,
    updatedAt: new Date().toISOString(),
    updatedBy: req.admin.sub
  }, { merge: true });
  await logAudit(req.admin.sub, 'MAINTENANCE', null, { enabled, duration });

  res.json({ status: 'OK', maintenance: enabled });

  setImmediate(async () => {
    try {
      const msg = await getTpl(enabled ? 'maintenance_on' : 'maintenance_off', { durasi: duration });
      await broadcastAll(msg);
      await notifyOps(`🛠 <b>Maintenance ${enabled ? 'ON' : 'OFF'}</b> oleh ${req.admin.sub} (${duration})`, {
        safe: `🛠 Maintenance ${enabled ? 'ON' : 'OFF'} oleh ${req.admin.sub}`,
        type: 'maint'
      });
      await pushMaint(enabled, duration, req.admin.sub);
    } catch (e) { console.error('Background maintenance task failed:', e.message); }
  });
});

router.post('/bot/broadcast', requireAuth, requireOwner, async (req, res) => {
  const { target, text } = req.body || {};
  if (!text) return res.status(400).json({ error: 'Text wajib' });
  const gid = target === 'vip' ? VIP_GROUP_ID : PUBLIC_GROUP_ID;
  if (!gid) return res.status(400).json({ error: 'Group ID belum diset' });
  const wrapped = await getTpl('broadcast_kop', { text: String(text) });
  await sendTG(gid, wrapped, { parse_mode: 'HTML' });
  await logAudit(req.admin.sub, 'BROADCAST', target, { length: text.length });
  await notifyOps(`📢 <b>Broadcast</b> ke ${target} oleh ${req.admin.sub}`, { safe: `📢 Broadcast ke ${target} oleh ${req.admin.sub}` });
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
  let reminded = 0;
  try { reminded = await runReminders(); } catch (e) {}
  await db.collection('settings').doc('app').set({ lastCronRun: now.toISOString() }, { merge: true });
  await logAudit(req.admin.sub, 'CRON_RUN', null, { expired: n, reminded });
  await notifyOps(`⏰ <b>Cron manual</b> oleh ${req.admin.sub}: ${n} expired • ${reminded} reminder`, { safe: `⏰ Cron oleh ${req.admin.sub}: ${n} expired • ${reminded} reminder` });
  res.json({ status: 'CRON_SUCCESS', user_expired: n, reminders_sent: reminded });
});

// ================= SETTINGS [OWNER] =================
router.post('/settings/update', requireAuth, requireOwner, async (req, res) => {
  const { price, planDays } = req.body || {};
  const patch = {};
  if (price) patch.price = parseInt(price);
  if (planDays) patch.planDays = parseInt(planDays);
  if (req.body.vipHumans !== undefined) patch.vipHumans = parseInt(req.body.vipHumans);
  if (req.body.publicHumans !== undefined) patch.publicHumans = parseInt(req.body.publicHumans);
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Tidak ada yang diupdate' });
  patch.updatedAt = new Date().toISOString();
  patch.updatedBy = req.admin.sub;
  await db.collection('settings').doc('app').set(patch, { merge: true });
  await logAudit(req.admin.sub, 'SETTINGS_UPDATE', null, patch);
  await notifyOps(`⚙️ <b>Settings</b> diubah ${req.admin.sub}`, { safe: `⚙️ Settings diubah ${req.admin.sub}` });

  if (patch.price || patch.planDays) {
    const cur = await db.collection('settings').doc('app').get();
    const p = cur.exists && cur.data().price ? cur.data().price : 10000;
    const d = cur.exists && cur.data().planDays ? cur.data().planDays : 30;
    const info = await getTpl('settings_info', { harga: Number(p).toLocaleString('id-ID'), hari: d });
    await broadcastAll(info);
  }
  res.json({ status: 'OK' });
});

// ================= ADMIN ACCOUNTS [OWNER] =================
router.get('/admins', requireAuth, requireOwner, async (req, res) => {
  const snap = await db.collection('admin_accounts').get();
  res.json({ admins: snap.docs.map(x => { const a = x.data(); return { username: a.username, role: a.role, active: a.active, lastLoginAt: a.lastLoginAt, avatar: a.avatar || null }; }) });
});

router.post('/admins', requireAuth, requireOwner, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password || password.length < 8) return res.status(400).json({ error: 'Username & password (min 8) wajib' });
  const uname = String(username).toLowerCase();
  const ex = await db.collection('admin_accounts').doc(uname).get();
  if (ex.exists) return res.status(409).json({ error: 'Username sudah ada' });
  await db.collection('admin_accounts').doc(uname).set({
    username: uname, passHash: await bcrypt.hash(password, 10), role: 'admin', active: true,
    createdAt: new Date().toISOString(), lastLoginAt: null, failCount: 0, lockedUntil: null, epoch: 0, avatar: null
  });
  await logAudit(req.admin.sub, 'ADMIN_CREATE', uname);
  await notifyOps(`👥 <b>Admin baru</b>: ${uname} dibuat oleh ${req.admin.sub}`, { safe: `👥 Admin baru: ${uname}` });
  res.json({ status: 'CREATED' });
});

router.post('/admins/:username/reset-password', requireAuth, requireOwner, async (req, res) => {
  try {
    const { newPassword } = req.body || {};
    if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: 'Password min. 8 karakter' });
    const t = await db.collection('admin_accounts').doc(req.params.username).get();
    if (!t.exists) return res.status(404).json({ error: 'Tidak ditemukan' });
    if (t.data().role === 'owner') return res.status(403).json({ error: 'Owner mengganti password lewat menu Ganti Password' });
    const epoch = (t.data().epoch || 0) + 1;
    await db.collection('admin_accounts').doc(req.params.username).update({
      passHash: await bcrypt.hash(newPassword, 10), epoch, failCount: 0, lockedUntil: null
    });
    await logAudit(req.admin.sub, 'ADMIN_RESET_PASS', req.params.username);
    await notifyOps(`🔑 <b>Password direset</b>: ${req.params.username} oleh ${req.admin.sub} (sesi lama diputus)`, { safe: `🔑 Reset pass: ${req.params.username}`, critical: true });
    res.json({ status: 'OK' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/admins/:username/deactivate', requireAuth, requireOwner, async (req, res) => {
  const t = await db.collection('admin_accounts').doc(req.params.username).get();
  if (!t.exists) return res.status(404).json({ error: 'Tidak ditemukan' });
  if (t.data().role === 'owner' || req.params.username === req.admin.sub) return res.status(403).json({ error: 'Tidak bisa menonaktifkan owner / diri sendiri' });
  await db.collection('admin_accounts').doc(req.params.username).update({ active: false });
  await logAudit(req.admin.sub, 'ADMIN_DEACTIVATE', req.params.username);
  await notifyOps(`⛔ <b>Admin dinonaktifkan</b>: ${req.params.username} oleh ${req.admin.sub}`, { safe: `⛔ Admin nonaktif: ${req.params.username}`, critical: true });
  res.json({ status: 'OK' });
});

router.post('/admins/:username/activate', requireAuth, requireOwner, async (req, res) => {
  await db.collection('admin_accounts').doc(req.params.username).update({ active: true });
  await logAudit(req.admin.sub, 'ADMIN_ACTIVATE', req.params.username);
  res.json({ status: 'OK' });
});

// ================= ARCADE =================
router.get('/arcade/leaderboard', requireAuth, async (req, res) => {
  try {
    const range = req.query.range || 'weekly';
    const since = range === 'daily' ? new Date(Date.now() - 86400000).toISOString()
      : range === 'weekly' ? new Date(Date.now() - 7 * 86400000).toISOString()
      : '1970-01-01T00:00:00Z';
    const snap = await db.collection('arcade_scores').where('at', '>=', since).orderBy('at', 'desc').limit(500).get();
    const best = {};
    snap.docs.forEach(d => { const s = d.data(); if (!best[s.username] || s.score > best[s.username].score) best[s.username] = s; });
    const list = Object.values(best).sort((a, b) => b.score - a.score).slice(0, 20);
    res.json({ scores: list });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/arcade/score', requireAuth, async (req, res) => {
  const score = parseInt(req.body.score) || 0;
  if (score <= 0) return res.json({ status: 'IGNORED' });
  await db.collection('arcade_scores').add({ username: req.admin.sub, score, ship: String(req.body.ship || '-'), at: new Date().toISOString() });
  res.json({ status: 'OK' });
});

const weekKey = () => {
  const d = new Date();
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil((((d - jan1) / 86400000) + jan1.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${week}`;
};

router.get('/arcade/raid', requireAuth, async (req, res) => {
  try {
    const wk = weekKey();
    const ref = db.collection('arcade_raid').doc(wk);
    let d = await ref.get();
    if (!d.exists) {
      await ref.set({ week: wk, hpMax: 100000, hpLeft: 100000, killedBy: null });
      d = await ref.get();
    }
    res.json(d.data());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/arcade/raid/damage', requireAuth, async (req, res) => {
  try {
    const wk = weekKey();
    const dmg = parseInt(req.body.dmg) || 0;
    const ref = db.collection('arcade_raid').doc(wk);
    let d = await ref.get();
    if (!d.exists) {
      await ref.set({ week: wk, hpMax: 100000, hpLeft: 100000, killedBy: null });
      d = await ref.get();
    }
    const cur = d.data();
    if (cur.killedBy) return res.json({ status: 'ALREADY_DEAD', hpLeft: cur.hpLeft, killedBy: cur.killedBy });
    let hpLeft = cur.hpLeft - dmg;
    let killedBy = null;
    if (hpLeft <= 0) {
      hpLeft = 0; killedBy = req.admin.sub;
      await notifyOps(`👹 <b>RAID</b>: GALAXY WARDEN tumbang oleh ${req.admin.sub}! Seluruh squad dapat badge 🏅`, { safe: `👹 Raid boss tumbang oleh ${req.admin.sub}!` });
      await pushRaidKill(req.admin.sub);
      await pushAllAdmins('👹 RAID TUMBANG!', `GALAXY WARDEN ditumbangkan oleh ${req.admin.sub}! Squad 🏅`, 'critical');
    }
    await ref.update({ hpLeft, killedBy });
    res.json({ status: 'OK', hpLeft, killedBy });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ================= FCM PUSH =================
let messaging = null;
try { messaging = require('firebase-admin/messaging').getMessaging(); } catch (e) { messaging = null; }

router.post('/fcm-token', requireAuth, async (req, res) => {
  const token = String(req.body.token || '');
  if (!token) return res.status(400).json({ error: 'Token wajib' });
  await db.collection('fcm_tokens').doc(req.admin.sub).set({
    token, role: req.admin.role, updatedAt: new Date().toISOString()
  });
  res.json({ status: 'OK' });
});

const pushAll = async (title, body, type) => {
  if (!messaging) return;
  try {
    const snap = await db.collection('fcm_tokens').get();
    const tokens = snap.docs.map(d => d.data().token).filter(Boolean);
    if (!tokens.length) return;
    const msg = { tokens, data: { title, body, type: type || 'info' } };
    if (messaging.sendEachForMulticast) await messaging.sendEachForMulticast(msg);
    else await messaging.sendMulticast(msg);
  } catch (e) { console.error('Push gagal:', e.message); }
};

const pushMaint = (on, dur, by) => pushAll('🛠 Maintenance', `Maintenance ${on ? 'ON' : 'OFF'} (${dur}) oleh ${by}`, 'maint');
const pushRaidKill = (by) => pushAll('👹 RAID TUMBANG!', `GALAXY WARDEN ditumbangkan oleh ${by}! Squad 🏅`, 'critical');
const pushAllAdmins = pushAll;

// ================= CLEAN PESAN BOT [OWNER] =================
router.post('/bot/clean', requireAuth, requireOwner, async (req, res) => {
  const target = req.body.target === 'public' ? 'public' : 'vip';
  const gid = target === 'vip' ? VIP_GROUP_ID : PUBLIC_GROUP_ID;
  if (!gid) return res.status(400).json({ error: `Group ID ${target} belum diset.` });

  try {
    const snap = await db.collection('bot_messages').where('chatId', '==', String(gid)).limit(1000).get();
    if (snap.empty) return res.json({ status: 'OK', deleted: 0, failed: 0, note: 'Data kosong.' });

    const ids = snap.docs.map(d => d.data().messageId);
    const docRefs = snap.docs.map(d => d.ref);

    let deleted = 0, failed = 0;
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100);
      try {
        await axios.post(`${TELEGRAM_API}/deleteMessages`, { chat_id: gid, message_ids: batch });
        deleted += batch.length;
      } catch (e) {
        for (const mid of batch) {
          try {
            await axios.post(`${TELEGRAM_API}/deleteMessage`, { chat_id: gid, message_id: mid });
            deleted++;
          } catch (e2) { failed++; }
        }
      }
    }

    for (let i = 0; i < docRefs.length; i += 400) {
      const batchDB = db.batch();
      docRefs.slice(i, i + 400).forEach(ref => batchDB.delete(ref));
      await batchDB.commit();
    }

    await logAudit(req.admin.sub, 'CLEAN_GROUP', target, { deleted, failed });
    await notifyOps(`🧹 <b>Clean Grup</b> ${target} oleh ${req.admin.sub}: ${deleted} dihapus${failed ? `, ${failed} gagal` : ''}`, { safe: `🧹 Clean ${target}: ${deleted} dihapus` });
    res.json({ status: 'OK', deleted, failed });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

router.post('/team/chat/clear', requireAuth, requireOwner, async (req, res) => {
  try {
    const countSnap = await db.collection('team_chat').count().get();
    const total = countSnap.data().count || 0;
    if (total === 0) return res.json({ status: 'OK', deleted: 0, note: 'Chat sudah kosong' });

    let deleted = 0;
    while (true) {
      const snap = await db.collection('team_chat').limit(400).get();
      if (snap.empty) break;
      const batch = db.batch();
      snap.docs.forEach(doc => batch.delete(doc.ref));
      await batch.commit();
      deleted += snap.size;
      if (snap.size < 400) break;
    }

    const metaSnap = await db.collection('team_meta').get();
    if (!metaSnap.empty) {
      const resetBatch = db.batch();
      metaSnap.docs.forEach(doc => resetBatch.update(doc.ref, { lastChatRead: '1970-01-01T00:00:00Z' }));
      await resetBatch.commit();
    }

    await logAudit(req.admin.sub, 'CLEAR_ALL_CHAT', null, { deleted });
    await notifyOps(`🧹 <b>Chat Tim Dibersihkan</b> oleh ${req.admin.sub}`, { safe: `🧹 Chat tim dibersihkan oleh ${req.admin.sub}`, type: 'critical' });
    res.json({ status: 'OK', deleted });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/feed/clear', requireAuth, requireOwner, async (req, res) => {
  try {
    const countSnap = await db.collection('ops_feed').count().get();
    if ((countSnap.data().count || 0) === 0) return res.json({ status: 'OK', deleted: 0, note: 'Feed kosong' });

    let deleted = 0;
    while (true) {
      const snap = await db.collection('ops_feed').limit(400).get();
      if (snap.empty) break;
      const batch = db.batch();
      snap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
      deleted += snap.size;
      if (snap.size < 400) break;
    }

    await logAudit(req.admin.sub, 'CLEAR_FEED', null, { deleted });
    await notifyOps(`🧹 <b>Riwayat Aktivitas dibersihkan</b> oleh ${req.admin.sub}`, { safe: `🧹 Aktivitas dibersihkan oleh ${req.admin.sub}` });
    res.json({ status: 'OK', deleted });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ================= 🤖 APHELION AI =================
const aiLimiter = rateLimit({ windowMs: 60 * 1000, max: 10 });

const iso = (t) => (t && t.toDate) ? t.toDate().toISOString() : (t || null);

const maskUser = (u) => ({
  uid: u.uid || u.id || null,
  username: u.username || null,
  email: u.email ? (String(u.email).split('@')[0].slice(0, 2) + '***@' + (String(u.email).split('@')[1] || '')) : null,
  status: u.status || null,
  expiredAt: iso(u.expiredAt),
  createdAt: u.createdAt || null,
  hwidBound: !!u.deviceId
});

const AI_MANUAL = `STACK & ARSITEKTUR APHELION (WAJIB JADI ACUAN):
- Backend Node.js+Express di VERCEL SERVERLESS (aphelion-backend1). BUKAN VPS/docker. JANGAN sarankan docker/systemctl/crontab.
- Log produksi: Vercel Dashboard → Deployments → Functions → Logs.
- DB: Google Firestore (users, transactions, finance_daily, finance_total, settings, admin_accounts, audit_logs, ops_feed, team_chat, telegram_chats, templates, arcade_scores, arcade_raid, fcm_tokens, bot_messages).
- Bot Telegram @aphelion_gatekeeper_bot via WEBHOOK /api/telegram-webhook.
- Pembayaran: Midtrans Snap (halaman aphelion-pay) + webhook /api/payment-webhook → settlement = user ACTIVE + invite VIP.
- Cron: scheduler eksternal memanggil GET /api/cron/check-expired.
- App admin: Android Compose + FCM push. App user: mod Android, verify token + binding HWID.
- Arcade: shooter internal admin (leaderboard + raid boss mingguan 100K HP).
- Bisnis: langganan VIP, grup Telegram VIP + publik.`;

const aiSystemPrompt = (admin) => `Kamu APHELION AI, chief-of-staff digital ekosistem Aphelion. Lawan bicara: ${admin.sub} (role: ${admin.role}).
ATURAN:
1. Bahasa Indonesia santai-profesional, ringkas, terstruktur, beri SOLUSI konkret.
2. Gunakan TOOLS untuk mendalami data sebelum menjawab soal sistem. Jangan menebak.
3. Data tidak ada → katakan jujur.
4. Token/HWID/email lengkap/password/API key sudah di-mask sistem — jangan coba membukanya.
5. Non-owner DILARANG menerima finance/audit (tools menolak otomatis).
6. Rekomendasi teknis WAJIB konsisten dengan MANUAL stack.
` + AI_MANUAL;

const AI_TOOLS = [
  { type: 'function', function: { name: 'system_health', description: 'Kesehatan sistem.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'users_overview', description: 'Statistik user.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'search_user', description: 'Cari user by UID/username (data ter-mask).', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } } },
  { type: 'function', function: { name: 'user_timeline', description: 'Profil ter-mask + riwayat transaksi.', parameters: { type: 'object', properties: { uid: { type: 'string' } }, required: ['uid'] } } },
  { type: 'function', function: { name: 'finance_range', description: '[OWNER] Omzet N hari.', parameters: { type: 'object', properties: { days: { type: 'integer' } } } } },
  { type: 'function', function: { name: 'transactions_last', description: '[OWNER] N transaksi terakhir.', parameters: { type: 'object', properties: { limit: { type: 'integer' } } } } },
  { type: 'function', function: { name: 'audit_search', description: '[OWNER] Cari audit log.', parameters: { type: 'object', properties: { admin: { type: 'string' }, action: { type: 'string' }, days: { type: 'integer' } } } } },
  { type: 'function', function: { name: 'team_chat_last', description: 'N pesan terakhir chat tim.', parameters: { type: 'object', properties: { n: { type: 'integer' } } } } },
  { type: 'function', function: { name: 'templates_list', description: 'Semua template pesan bot.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'arcade_status', description: 'Raid boss + top 5 leaderboard.', parameters: { type: 'object', properties: {} } } }
];

const execTool = async (name, args, role) => {
  const deny = { error: 'AKSES DITOLAK: data ini khusus owner.' };
  switch (name) {
    case 'system_health': {
      const d = await db.collection('settings').doc('app').get();
      const s = d.exists ? d.data() : {};
      return { maintenance: s.maintenance === true, price: s.price || null, planDays: s.planDays || null, lastCronRun: s.lastCronRun || null, lastTelegramPing: s.lastTelegramPing || null, lastPaymentPing: s.lastPaymentPing || null };
    }
    case 'users_overview': {
      const cnt = async (st) => (await db.collection('users').where('status', '==', st).count().get()).data().count;
      const [active, expired, banned] = await Promise.all([cnt('ACTIVE'), cnt('EXPIRED'), cnt('BANNED')]);
      const newWeek = (await db.collection('users').where('createdAt', '>=', new Date(Date.now() - 7 * 86400000).toISOString()).count().get()).data().count;
      const exp = await db.collection('users').where('status', '==', 'ACTIVE').where('expiredAt', '<', new Date(Date.now() + 3 * 86400000)).orderBy('expiredAt', 'asc').limit(10).get();
      return { active, expired, banned, newLast7Days: newWeek, expiringIn3Days: exp.docs.map(x => ({ uid: x.id, username: x.data().username || null, expiredAt: iso(x.data().expiredAt) })) };
    }
    case 'search_user': {
      const qq = String(args.q || '').trim().toLowerCase();
      if (!qq) return { error: 'param q wajib' };
      if (/^\d{5,15}$/.test(qq)) {
        const d = await db.collection('users').doc(qq).get();
        if (d.exists) return maskUser({ id: d.id, ...d.data() });
      }
      const s = await db.collection('users').where('username', '==', qq).limit(1).get();
      return s.empty ? { error: 'User tidak ditemukan' } : maskUser({ id: s.docs[0].id, ...s.docs[0].data() });
    }
    case 'user_timeline': {
      const uid = String(args.uid || '');
      const d = await db.collection('users').doc(uid).get();
      if (!d.exists) return { error: 'User tidak ditemukan' };
      const tx = await db.collection('transactions').where('uid', '==', uid).orderBy('paidAt', 'desc').limit(10).get();
      return { user: maskUser({ id: d.id, ...d.data() }), transactions: tx.docs.map(x => ({ orderId: x.data().orderId, amount: x.data().amount, channel: x.data().channel, status: x.data().status, paidAt: x.data().paidAt })) };
    }
    case 'finance_range': {
      if (role !== 'owner') return deny;
      const days = Math.min(parseInt(args.days) || 7, 30);
      const daily = [];
      for (let i = 0; i < days; i++) {
        const dk = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
        const f = await db.collection('finance_daily').doc(dk).get();
        daily.push({ date: dk, gross: f.exists ? (f.data().gross || 0) : 0, count: f.exists ? (f.data().count || 0) : 0 });
      }
      const t = await db.collection('finance_total').doc('all').get();
      return { daily, total: t.exists ? { gross: t.data().gross || 0, count: t.data().count || 0 } : { gross: 0, count: 0 } };
    }
    case 'transactions_last': {
      if (role !== 'owner') return deny;
      const lim = Math.min(parseInt(args.limit) || 10, 20);
      const s = await db.collection('transactions').orderBy('paidAt', 'desc').limit(lim).get();
      return s.docs.map(x => ({ orderId: x.data().orderId, uid: x.data().uid, amount: x.data().amount, channel: x.data().channel, status: x.data().status, paidAt: x.data().paidAt }));
    }
    case 'audit_search': {
      if (role !== 'owner') return deny;
      const days = Math.min(parseInt(args.days) || 7, 90);
      let ref = db.collection('audit_logs').where('at', '>=', new Date(Date.now() - days * 86400000).toISOString());
      if (args.admin) ref = ref.where('admin', '==', String(args.admin));
      if (args.action) ref = ref.where('action', '==', String(args.action));
      const s = await ref.orderBy('at', 'desc').limit(30).get();
      return s.docs.map(x => ({ admin: x.data().admin, action: x.data().action, target: x.data().target, at: x.data().at }));
    }
    case 'team_chat_last': {
      const n = Math.min(parseInt(args.n) || 15, 30);
      const s = await db.collection('team_chat').orderBy('at', 'desc').limit(n).get();
      return s.docs.map(x => `${x.data().sender}: ${x.data().deleted ? '(dihapus)' : x.data().text}`);
    }
    case 'templates_list': {
      const snap = await db.collection('templates').get();
      const custom = {};
      snap.docs.forEach(d => { custom[d.id] = d.data().text; });
      return Object.keys(DEFAULT_TPL).map(k => ({ key: k, custom: !!custom[k], text: custom[k] || DEFAULT_TPL[k] }));
    }
    case 'arcade_status': {
      const wk = weekKey();
      const r = await db.collection('arcade_raid').doc(wk).get();
      const lb = await db.collection('arcade_scores').where('at', '>=', new Date(Date.now() - 7 * 86400000).toISOString()).orderBy('at', 'desc').limit(200).get();
      const best = {};
      lb.docs.forEach(d => { const s = d.data(); if (!best[s.username] || s.score > best[s.username].score) best[s.username] = s.score; });
      const top = Object.entries(best).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([u, sc]) => ({ username: u, score: sc }));
      return { week: wk, raid: r.exists ? { hpMax: r.data().hpMax, hpLeft: r.data().hpLeft, killedBy: r.data().killedBy } : null, top5: top };
    }
    default:
      return { error: 'Tool tidak dikenal: ' + name };
  }
};

const AI_MODELS = [process.env.AI_MODEL || 'qwen/qwen3.8-27b', 'qwen/qwen3.6-27b', 'openai/gpt-oss-20b'];

const callGroq = async (messages, preferModel) => {
  const models = preferModel ? [preferModel, ...AI_MODELS] : AI_MODELS;
  let lastErr = null;
  for (const model of models) {
    try {
      const r = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
        model, messages, tools: AI_TOOLS, tool_choice: 'auto', temperature: 0.4, max_tokens: 800
      }, {
        headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        timeout: 6000
      });
      return r.data;
    } catch (e) {
      const code = e.response && e.response.data && e.response.data.error && e.response.data.error.code;
      lastErr = e;
      if (code === 'rate_limit_exceeded') continue;
      throw e;
    }
  }
  throw lastErr;
};

const callLLM = async (provider, model, messages, opts = {}) => {
  const URLS = {
    groq: 'https://api.groq.com/openai/v1/chat/completions',
    openrouter: 'https://openrouter.ai/api/v1/chat/completions',
    gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
  };
  const KEYS = { groq: 'GROQ_API_KEY', openrouter: 'OPENROUTER_API_KEY', gemini: 'GEMINI_API_KEY' };
  const key = process.env[KEYS[provider]];
  if (!key) throw new Error('Key belum diset: ' + KEYS[provider]);
  const r = await axios.post(URLS[provider], {
    model, messages, temperature: 0.4, max_tokens: opts.max_tokens || 600
  }, {
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    timeout: opts.timeout || 5000
  });
  const msg = r.data && r.data.choices && r.data.choices[0] && r.data.choices[0].message;
  return (msg && (msg.content || msg.reasoning)) || '';
};

const callLLMSafe = async (m, messages, opts = {}) => {
  try { return await callLLM(m.provider, m.model, messages, opts); }
  catch (e) {
    const st = e.response?.status;
    const code = e.response?.data?.error?.code;
    console.error(`COUNCIL ${m.id} FAIL [${m.provider}/${m.model}] :: ${String(e.message).slice(0, 100)}`);
    if (st === 429 || code === 'rate_limit_exceeded') {
      await new Promise(r => setTimeout(r, 1200));
      try { return await callLLM(m.provider, m.model, messages, opts); } catch (e2) { return null; }
    }
    return null;
  }
};

const COUNCIL = [
  { id: 'eng', label: '🧑‍💻 TEKNIS', provider: 'groq', model: 'qwen/qwen3.8-27b', persona: 'System Engineer senior: log webhook, cron, HWID, keamanan serverless.' },
  { id: 'data', label: '📊 DATA', provider: 'groq', model: 'openai/gpt-oss-120b', persona: 'Data Analyst: angka omzet, retensi user, anomali transaksi.' },
  { id: 'audit', label: '🔭 AUDITOR', provider: 'gemini', model: 'gemini-2.5-flash', persona: 'Auditor skeptis: mendeteksi pelanggaran SOP, celah akses, log admin.' },
  { id: 'logic', label: '🔬 REASONER', provider: 'openrouter', model: process.env.OPENROUTER_MODEL || 'deepseek/deepseek-chat-v3-0324:free', persona: 'Deep Reasoner: menyambung titik sebab-akibat antar data.' }
];

const JUDGE_CHAIN = [
  { provider: 'gemini', model: 'gemini-2.5-pro' },
  { provider: 'gemini', model: 'gemini-2.5-flash' },
  { provider: 'groq', model: 'openai/gpt-oss-120b' }
];

const councilCooldown = {};

// ─────────────────────────────────────────────────────────────────────────────
// buildDeepSnapshot — pakai Promise.allSettled supaya 1 error Firestore
// tidak kill semua fetch sekaligus
// ─────────────────────────────────────────────────────────────────────────────
const buildDeepSnapshot = async (role) => {
  const safe = (r) => r.status === 'fulfilled' ? r.value : { error: 'fetch_failed' };

  const [health, users, chat, arcade] = await Promise.allSettled([
    execTool('system_health', {}, role),
    execTool('users_overview', {}, role),
    execTool('team_chat_last', { n: 10 }, role),
    execTool('arcade_status', {}, role)
  ]);

  const snap = {
    system_health: safe(health),
    users: safe(users),
    team_chat: safe(chat),
    arcade: safe(arcade)
  };

  if (role === 'owner') {
    const [fin, tx, aud] = await Promise.allSettled([
      execTool('finance_range', { days: 7 }, role),
      execTool('transactions_last', { limit: 5 }, role),
      execTool('audit_search', { days: 7 }, role)
    ]);
    snap.finance_7d = safe(fin);
    snap.transactions = safe(tx);
    snap.audit_7d = safe(aud);
  }

  return snap;
};

// ─────────────────────────────────────────────────────────────────────────────
// councilRounds — FIX UTAMA TIMEOUT
// Sebelumnya: sequential runWithDelay → worst case 65s → TIMEOUT
// Sekarang:   parallel + stagger ringan → worst case ~13s → AMAN
// ─────────────────────────────────────────────────────────────────────────────
const councilRounds = async (q, snapStr) => {
  const STAGGER_MS   = 350;   // jeda antar spawn tiap agen (hindari burst rate limit)
  const CALL_TIMEOUT = 5000;  // timeout per LLM call
  const CALL_TOKENS  = 300;   // max_tokens per panggilan (lebih kecil = lebih cepat)

  const baseFor = (m) =>
    `Kamu ${m.label}, ${m.persona}\n${AI_MANUAL}\nATURAN MUTLAK:\n` +
    `1. Jadilah SANGAT SKEPTIS. Jangan mudah setuju.\n` +
    `2. Fokus HANYA pada metrik/data yang relevan dengan spesialisasimu.\n` +
    `3. WAJIB kutip angka/fakta SPESIFIK dari SNAPSHOT.\n` +
    `4. Akhiri jawaban dengan "CONFIDENCE: <0-100>".\n\n` +
    `SNAPSHOT LIVE:\n${snapStr}`;

  // ── ROUND 1: Semua agen jalan PARALEL dengan stagger ringan ──────────────
  const r1Settled = await Promise.allSettled(
    COUNCIL.map((m, i) =>
      new Promise(res => setTimeout(res, i * STAGGER_MS))
        .then(() => callLLMSafe(m, [
          { role: 'system', content: baseFor(m) },
          { role: 'user',   content: q }
        ], { timeout: CALL_TIMEOUT, max_tokens: CALL_TOKENS }))
        .then(opini => ({ ...m, opini: opini || null }))
    )
  );

  const alive = r1Settled
    .filter(r => r.status === 'fulfilled' && r.value?.opini)
    .map(r => r.value);

  if (alive.length < 2) return null; // kuorum gagal → caller pakai fallback solo

  // Ringkasan Round 1 untuk dibagikan ke semua agen di Round 2
  const r1Digest = alive
    .map(x => `[${x.label}]:\n${x.opini}`)
    .join('\n\n---\n\n');

  const agenLabels = alive.map(x => x.label).join(', ');

  const debateInstruction =
    `== ROUND 2: DEBAT SILANG ==\n` +
    `Kamu sudah baca opini rekan-rekanmu di bawah. TUGASMU:\n\n` +
    `1. PILIH SATU agen untuk dikritik, sebutkan labelnya eksplisit: pilih dari "${agenLabels}".\n` +
    `2. KRITIK BERBASIS DATA: "Aku tidak setuju dengan [LABEL] karena snapshot menunjukkan [ANGKA/FAKTA]..."\n` +
    `3. Jika opini Round 1-mu ternyata keliru setelah baca data rekan → REVISI posisimu. Jangan gengsi.\n` +
    `4. Jika posisimu benar → SERANG BALIK dengan fakta snapshot yang mereka abaikan.\n` +
    `5. Maks 220 kata. Wajib akhiri: "CONFIDENCE AKHIR: <0-100>".\n\n` +
    `OPINI REKAN DEWAN (Round 1):\n${r1Digest}`;

  // ── ROUND 2: Debat silang, juga PARALEL dengan stagger ───────────────────
  const r2Settled = await Promise.allSettled(
    alive.map((m, i) =>
      new Promise(res => setTimeout(res, i * STAGGER_MS))
        .then(() => callLLMSafe(m, [
          { role: 'system',    content: baseFor(m) },
          { role: 'user',      content: q },
          { role: 'assistant', content: m.opini },   // anchor opini R1 sebagai konteks agen
          { role: 'user',      content: debateInstruction }
        ], { timeout: CALL_TIMEOUT, max_tokens: CALL_TOKENS }))
        .then(final => ({ ...m, final: final || m.opini }))
    )
  );

  const r2 = r2Settled
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value);

  // Fallback: kalau R2 semua gagal, kembalikan R1 saja daripada null
  if (r2.length === 0) {
    return alive
      .map(x => `${x.label}\n— OPINI (Round 1 only):\n${x.opini}`)
      .join('\n=====\n');
  }

  return r2
    .map(x =>
      `${x.label}\n` +
      `— OPINI AWAL (R1):\n${x.opini}\n` +
      `— POSISI SETELAH DEBAT (R2):\n${x.final}`
    )
    .join('\n=====\n');
};

// ================= ENDPOINT AI =================
router.post('/ai/ask', aiLimiter, requireAuth, async (req, res) => {
  try {
    const q = String(req.body.q || '').trim();
    const mode = req.body.mode === 'deep' ? 'deep' : req.body.mode === 'council' ? 'council' : 'fast';
    if (!q) return res.status(400).json({ error: 'Pertanyaan kosong' });
    if (q.length > 500) return res.status(400).json({ error: 'Maksimal 500 karakter' });

    if (mode === 'council') {
      const now = Date.now();
      const last = councilCooldown[req.admin.sub] || 0;
      if (now - last < 20000) return res.status(429).json({ error: `🏛️ Dewan istirahat dulu. Tunggu ${Math.ceil((20000 - (now - last)) / 1000)} dtk lagi.` });
      councilCooldown[req.admin.sub] = now;

      const snapshot = await buildDeepSnapshot(req.admin.role);
      const snapStr = JSON.stringify(snapshot);
      const debate = await councilRounds(q, snapStr);

      if (!debate) {
        // Dewan tidak kuorum → fallback ke solo deep
        const messages = [
          { role: 'system', content: aiSystemPrompt(req.admin) + '\n(Catatan: dewan tidak kuorum — jawab solo secara mendalam.)' },
          { role: 'user', content: q }
        ];
        let solo = '(tanpa jawaban)';
        for (let round = 0; round < 3; round++) {
          const data = await callGroq(messages, 'openai/gpt-oss-120b');
          const msg = data.choices[0].message;
          if (msg.tool_calls && msg.tool_calls.length) {
            messages.push({ role: 'assistant', content: msg.content || null, tool_calls: msg.tool_calls });
            for (const tc of msg.tool_calls.slice(0, 3)) {
              let out;
              try { out = await execTool(tc.function.name, JSON.parse(tc.function.arguments || '{}'), req.admin.role); }
              catch (e) { out = { error: e.message }; }
              messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(out) });
            }
            continue;
          }
          solo = msg.content || solo;
          break;
        }
        return res.json({ answer: '🛟 *(Dewan gagal kuorum — beralih ke analisis Solo-Deep)*\n\n' + solo });
      }

      const ref = await db.collection('ai_council').add({ q, debate, snap: snapStr, at: new Date().toISOString() });
      return res.json({ councilId: ref.id });
    }

    // ── FAST / DEEP Mode ──────────────────────────────────────────────────
    const histDoc = await db.collection('ai_chats').doc(req.admin.sub).get();
    const history = histDoc.exists ? (histDoc.data().history || []) : [];

    const messages = [
      { role: 'system', content: aiSystemPrompt(req.admin) },
      ...history,
      { role: 'user', content: q }
    ];
    if (mode === 'deep') messages.push({ role: 'system', content: 'MODE DEEP: analisis mendalam, terstruktur, sertakan data & rekomendasi konkret.' });

    let answer = '(tanpa jawaban)';
    for (let round = 0; round < 3; round++) {
      const data = await callGroq(messages, mode === 'deep' ? 'openai/gpt-oss-120b' : null);
      const msg = data.choices[0].message;
      if (msg.tool_calls && msg.tool_calls.length) {
        messages.push({ role: 'assistant', content: msg.content || null, tool_calls: msg.tool_calls });
        for (const tc of msg.tool_calls.slice(0, 3)) {
          let out;
          try {
            const args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
            out = await execTool(tc.function.name, args, req.admin.role);
          } catch (e) { out = { error: e.message }; }
          messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(out) });
        }
        continue;
      }
      answer = msg.content || answer;
      break;
    }

    const newHist = [...history, { role: 'user', content: q }, { role: 'assistant', content: (answer || '').slice(0, 800) }].slice(-4);
    await db.collection('ai_chats').doc(req.admin.sub).set({ history: newHist, updatedAt: new Date().toISOString() });
    res.json({ answer });
  } catch (e) {
    const gcode = e.response?.data?.error?.code;
    if (gcode === 'rate_limit_exceeded') return res.status(429).json({ error: '⏳ AI lagi antre. Coba 15 detik lagi ya.' });
    res.status(500).json({ error: 'AI error: ' + (e.response?.data?.error?.message || e.message) });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// /ai/council/prepare — Step 1 multi-step (opsional, untuk Hobby plan)
// Jalankan buildDeepSnapshot + Round 1, simpan ke Firestore, return prepareId
// ─────────────────────────────────────────────────────────────────────────────
router.post('/ai/council/prepare', aiLimiter, requireAuth, async (req, res) => {
  try {
    const q = String(req.body.q || '').trim();
    if (!q) return res.status(400).json({ error: 'Pertanyaan kosong' });
    if (q.length > 500) return res.status(400).json({ error: 'Maksimal 500 karakter' });

    const snapshot = await buildDeepSnapshot(req.admin.role);
    const snapStr = JSON.stringify(snapshot);

    const STAGGER_MS   = 350;
    const CALL_TIMEOUT = 4500;
    const CALL_TOKENS  = 280;

    const baseFor = (m) =>
      `Kamu ${m.label}, ${m.persona}\n${AI_MANUAL}\n` +
      `Fokus spesialisasimu. Kutip fakta dari SNAPSHOT. Akhiri: "CONFIDENCE: <0-100>".\n\n` +
      `SNAPSHOT:\n${snapStr}`;

    const r1Settled = await Promise.allSettled(
      COUNCIL.map((m, i) =>
        new Promise(res => setTimeout(res, i * STAGGER_MS))
          .then(() => callLLMSafe(m, [
            { role: 'system', content: baseFor(m) },
            { role: 'user',   content: q }
          ], { timeout: CALL_TIMEOUT, max_tokens: CALL_TOKENS }))
          .then(opini => ({ label: m.label, id: m.id, provider: m.provider, model: m.model, opini: opini || null }))
      )
    );

    const r1 = r1Settled
      .filter(r => r.status === 'fulfilled' && r.value?.opini)
      .map(r => r.value);

    const ref = await db.collection('ai_council').add({
      q, snapStr, r1, stage: 'r1_done', at: new Date().toISOString()
    });

    res.json({ prepareId: ref.id, agents: r1.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// /ai/council/debate — Step 2 multi-step (opsional, untuk Hobby plan)
// Ambil r1 dari Firestore, jalankan Round 2, simpan debate, return councilId
// ─────────────────────────────────────────────────────────────────────────────
router.post('/ai/council/debate', aiLimiter, requireAuth, async (req, res) => {
  try {
    const id = String(req.body.prepareId || '');
    if (!id) return res.status(400).json({ error: 'prepareId wajib' });

    const d = await db.collection('ai_council').doc(id).get();
    if (!d.exists || d.data().stage !== 'r1_done') {
      return res.status(404).json({ error: 'Prepare tidak ditemukan atau sudah kedaluwarsa.' });
    }

    const { q, snapStr, r1 } = d.data();
    const alive = (r1 || []).filter(x => x.opini);
    if (alive.length < 2) {
      // Kurang dari 2 agen sukses di R1 → langsung ke verdict solo
      await db.collection('ai_council').doc(id).update({ debate: alive.map(x => `${x.label}\n${x.opini}`).join('\n=====\n'), snap: snapStr, stage: 'debate_done' });
      return res.json({ councilId: id });
    }

    const r1Digest  = alive.map(x => `[${x.label}]:\n${x.opini}`).join('\n\n---\n\n');
    const agenLabels = alive.map(x => x.label).join(', ');

    const debateInstruction =
      `== ROUND 2: DEBAT SILANG ==\n` +
      `Pilih 1 agen untuk dikritik (${agenLabels}). Kritik berbasis data snapshot.\n` +
      `Maks 200 kata. Akhiri: "CONFIDENCE AKHIR: <0-100>".\n\n` +
      `OPINI REKAN (R1):\n${r1Digest}`;

    const STAGGER_MS   = 350;
    const CALL_TIMEOUT = 4500;
    const CALL_TOKENS  = 260;

    const baseFor = (m) =>
      `Kamu ${m.label}, ${m.persona}\n${AI_MANUAL}\n\nSNAPSHOT:\n${snapStr}`;

    const r2Settled = await Promise.allSettled(
      alive.map((x, i) => {
        const m = COUNCIL.find(c => c.id === x.id) || COUNCIL[i % COUNCIL.length];
        return new Promise(res => setTimeout(res, i * STAGGER_MS))
          .then(() => callLLMSafe(m, [
            { role: 'system',    content: baseFor(m) },
            { role: 'user',      content: q },
            { role: 'assistant', content: x.opini },
            { role: 'user',      content: debateInstruction }
          ], { timeout: CALL_TIMEOUT, max_tokens: CALL_TOKENS }))
          .then(final => ({ ...x, final: final || x.opini }));
      })
    );

    const r2 = r2Settled
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value);

    const debate = (r2.length > 0 ? r2 : alive)
      .map(x =>
        `${x.label}\n` +
        `— R1:\n${x.opini}\n` +
        `— R2:\n${x.final || x.opini}`
      )
      .join('\n=====\n');

    await db.collection('ai_council').doc(id).update({ debate, snap: snapStr, stage: 'debate_done' });
    res.json({ councilId: id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// /ai/verdict — Hakim merangkum hasil debat dewan
// ─────────────────────────────────────────────────────────────────────────────
router.post('/ai/verdict', requireAuth, async (req, res) => {
  try {
    const id = String(req.body.id || '');
    const d = await db.collection('ai_council').doc(id).get();
    if (!d.exists) return res.status(404).json({ error: 'Sidang tidak ditemukan.' });
    const { q, debate, snap } = d.data();

    const judgeSys = `Kamu KETUA SIDANG, profesor senior paling berpengalaman. Tugasmu merangkum debat 4 spesialis menjadi 1 kesimpulan final yang sangat akurat.

PROSES KERJAMU WAJIB SEPERTI INI:
1. Gunakan tag <thinking> untuk menganalisis isi debat agen. Siapa agen yang datanya paling valid berdasarkan snapshot? Siapa yang berhalusinasi?
2. Setelah merenung, tutup dengan </thinking> dan keluarkan format final secara persis.

FORMAT FINAL WAJIB (keluarkan setelah thinking):
## ✅ KESIMPULAN & SOLUSI
<Jawaban final yang komprehensif, langsung ke akar masalah, dan beri solusi konkret yang bisa dieksekusi>

TINGKAT KEPERCAYAAN: <0-100>%

## 📜 ANALISIS SIDANG
- <Nama Agen 1>: <Poin dia - DITERIMA/DITOLAK - Alasan>
- <Nama Agen 2>: <Poin dia - DITERIMA/DITOLAK - Alasan>
- ...

## ⚖️ RESOLUSI KONFLIK
<Jelaskan argumen mana yang menang dalam debat tersebut dan mengapa>

${AI_MANUAL}`;

    let finalText = null;
    for (const j of JUDGE_CHAIN) {
      try {
        finalText = await callLLM(j.provider, j.model, [
          { role: 'system', content: judgeSys + '\nSNAPSHOT:\n' + snap },
          { role: 'user', content: `PERTANYAAN:\n${q}\n\nTRANSKRIP SIDANG DEBAT (Round 1 & 2):\n${debate}` }
        ], { timeout: 10000, max_tokens: 900 }); // ← turun dari 12000ms / 1500 tokens

        // Buang bagian <thinking> agar tidak bocor ke layar user
        if (finalText) {
          finalText = finalText.replace(/<thinking>[\s\S]*?<\/thinking>/g, '').trim();
          break;
        }
      } catch (e) { /* lanjut ke model hakim cadangan */ }
    }

    await db.collection('ai_council').doc(id).delete().catch(() => {});
    if (!finalText) return res.status(500).json({ error: '⚖️ Semua hakim sedang antre. Coba lagi ±15 dtk.' });
    res.json({ answer: finalText });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
