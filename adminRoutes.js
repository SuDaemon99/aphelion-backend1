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

// 🎭 ganti avatar sendiri (sesuai set role)
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
        today: fDoc.exists ? { gross: f.data().gross || 0, count: f.data().count || 0 } : { gross: 0, count: 0 },
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
  const limit = 30;
  let ref = db.collection('audit_logs').orderBy('at', 'desc').limit(limit);
  if (req.query.cursor) ref = ref.startAfter(String(req.query.cursor));
  const snap = await ref.get();
  const logs = snap.docs.map(x => ({ id: x.id, ...x.data() }));
  const last = snap.docs[snap.docs.length - 1];
  res.json({ logs, nextCursor: last ? last.data().at : null });
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

// 💬 chat list + pinned terbaru
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

// 💬 kirim chat (bawa avatar + replyTo)
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
  
  // 🔔 FCM: push chat baru ke semua HP admin (kecuali pengirim sendiri)
  const snap = await db.collection('fcm_tokens').get();
  const myToken = req.body.fcmToken || ''; // opsional, biar gak push ke diri sendiri
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

// ✅ centang dibaca: map username → lastChatRead
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

// 🎯 reaksi toggle
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

// 📌 pin / unpin (owner)
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

// 🗑 hapus (sendiri atau owner)
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
  await db.collection('settings').doc('app').set({ maintenance: enabled, updatedAt: new Date().toISOString(), updatedBy: req.admin.sub }, { merge: true });
  await logAudit(req.admin.sub, 'MAINTENANCE', null, { enabled, duration });

  const msg = await getTpl(enabled ? 'maintenance_on' : 'maintenance_off', { durasi: duration });
  await broadcastAll(msg);
  await notifyOps(`🛠 <b>Maintenance ${enabled ? 'ON' : 'OFF'}</b> oleh ${req.admin.sub} (${duration})`, { safe: `🛠 Maintenance ${enabled ? 'ON' : 'OFF'} oleh ${req.admin.sub}`, type: 'maint' });
  await pushMaint(enabled, duration, req.admin.sub);
  await pushAllAdmins('🛠 Maintenance', `Maintenance ${enabled ? 'ON' : 'OFF'} (${duration}) oleh ${req.admin.sub}`, 'maint');
  res.json({ status: 'OK', maintenance: enabled });
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
      passHash: await bcrypt.hash(newPassword, 10),
      epoch,
      failCount: 0,
      lockedUntil: null
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

// ================= ARCADE RAID (boss mingguan bersama) =================
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

// push otomatis: maintenance & raid tumbang
const pushMaint = (on, dur, by) => pushAll('🛠 Maintenance', `Maintenance ${on ? 'ON' : 'OFF'} (${dur}) oleh ${by}`, 'maint');
const pushRaidKill = (by) => pushAll('👹 RAID TUMBANG!', `GALAXY WARDEN ditumbangkan oleh ${by}! Squad 🏅`, 'critical');

// ================= CLEAN PESAN BOT [OWNER] =================
router.post('/bot/clean', requireAuth, requireOwner, async (req, res) => {
  try {
    const target = req.body.target === 'public' ? 'public' : 'vip';
    const gid = target === 'vip' ? VIP_GROUP_ID : PUBLIC_GROUP_ID;
    if (!gid) return res.status(400).json({ error: 'Group ID belum diset' });

    // 1) ID bot
    const me = await axios.post(`${TELEGRAM_API}/getMe`);
    const botId = me.data.result.id;

    // 2) Scan history — DIBATASI 300 biar aman di bawah timeout Vercel 10 dtk
    const MAX_SCAN = 300;
    let ids = [];
    let offset = 0;
    while (offset < MAX_SCAN) {
      const h = await axios.post(`${TELEGRAM_API}/getChatHistory`, { chat_id: gid, offset, limit: 100 });
      const msgs = h.data.result || [];
      if (!msgs.length) break;
      for (const m of msgs) if (m.from && m.from.id === botId) ids.push(m.message_id);
      offset += 100;
      if (msgs.length < 100) break;
    }

    if (!ids.length) return res.json({ status: 'OK', deleted: 0 });

    // 3) Hapus batch (deleteMessages max 100 per call), fallback satu-satu
    let deleted = 0;
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100);
      try {
        await axios.post(`${TELEGRAM_API}/deleteMessages`, { chat_id: gid, message_ids: batch });
        deleted += batch.length;
      } catch (e) {
        for (const mid of batch) {
          try { await axios.post(`${TELEGRAM_API}/deleteMessage`, { chat_id: gid, message_id: mid }); deleted++; } catch (e2) { }
        }
      }
    }

    await logAudit(req.admin.sub, 'CLEAN_GROUP', target, { deleted });
    await notifyOps(`🧹 <b>Clean Grup</b> ${target} oleh ${req.admin.sub}: ${deleted} pesan dihapus`, { safe: `🧹 Clean ${target}: ${deleted} pesan dihapus` });
    res.json({ status: 'OK', deleted });
  } catch (e) {
    // 🔍 error detail dari Telegram biar gampang debug
    const desc = (e.response && e.response.data && e.response.data.description) ? e.response.data.description : e.message;
    console.error('CLEAN ERROR:', desc);
    res.status(500).json({ error: desc });
  }
});

module.exports = router;
