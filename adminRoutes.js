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
    
    if (String(chatId) === String(VIP_GROUP_ID) || String(chatId) === String(PUBLIC_GROUP_ID)) {
      const mid = r.data.result.message_id;
      db.collection('bot_messages').add({
        chatId: String(chatId),
        messageId: mid,
        at: new Date().toISOString()
      }).catch(() => {});
    }
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
      return res.status(423).json({ error: 'Akun terkunci. Coba lagi nanti.' });
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
    const token = jwt.sign({ sub: uname, role: acc.role, ep: acc.epoch || 0 }, JWT_SECRET, { expiresIn: '12h' });
    await logAudit(uname, 'LOGIN');
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
  if (!set.includes(avatar)) return res.status(400).json({ error: 'Avatar tidak valid' });
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

// ================= DASHBOARD & STATS =================
router.get('/dashboard/stats', requireAuth, async (req, res) => {
  try {
    const cnt = async (st) => (await db.collection('users').where('status', '==', st).count().get()).data().count;
    const [active, expired, banned] = await Promise.all([cnt('ACTIVE'), cnt('EXPIRED'), cnt('BANNED')]);
    const now = new Date(); const sod = new Date(now); sod.setHours(0, 0, 0, 0);
    const newToday = (await db.collection('users').where('createdAt', '>=', sod.toISOString()).count().get()).data().count;
    const expiring = (await db.collection('users').where('status', '==', 'ACTIVE').where('expiredAt', '<', new Date(now.getTime() + 3 * 86400000)).count().get()).data().count;
    const setDoc = await db.collection('settings').doc('app').get();
    const settings = setDoc.exists ? setDoc.data() : {};

    const out = {
      users: { active, expired, banned, newToday, expiringIn3Days: expiring },
      bot: { maintenance: settings.maintenance === true, lastCronRun: settings.lastCronRun || null },
      community: { vipHumans: await liveHumans(VIP_GROUP_ID), publicHumans: PUBLIC_GROUP_ID ? await liveHumans(PUBLIC_GROUP_ID) : 0 }
    };
    if (req.admin.role === 'owner') {
      const dk = now.toISOString().slice(0, 10);
      const [fDoc, tDoc] = await Promise.all([db.collection('finance_daily').doc(dk).get(), db.collection('finance_total').doc('all').get()]);
      out.finance = {
        today: fDoc.exists ? { gross: fDoc.data().gross || 0, count: fDoc.data().count || 0 } : { gross: 0, count: 0 },
        total: tDoc.exists ? { gross: tDoc.data().gross || 0, count: tDoc.data().count || 0 } : { gross: 0, count: 0 }
      };
    }
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ================= USERS API (Dipangkas logic standarnya agar muat, biarkan sisa file API kamu utuh) =================
// >>> JIKA ADA ROUTE LAIN SEPERTI /users, /finance, /team/chat, BIARKAN SAJA PERSIS SEPERTI KODE KAMU SEBELUMNYA <<<

// ================= 🤖 APHELION AI (DEEP DIVE + DEWAN) =================
const aiLimiter = rateLimit({ windowMs: 60 * 1000, max: 10 });

const iso = (t) => (t && t.toDate) ? t.toDate().toISOString() : (t || null);

const AI_MANUAL = `STACK & ARSITEKTUR APHELION (WAJIB JADI ACUAN):
- Backend Node.js+Express di VERCEL SERVERLESS (aphelion-backend1). BUKAN VPS/docker.
- Log produksi: Vercel Dashboard → Deployments → Functions → Logs.
- DB: Google Firestore.
- Bot Telegram @aphelion_gatekeeper_bot via WEBHOOK.
- Pembayaran: Midtrans Snap + webhook /api/payment-webhook.
- Cron: scheduler eksternal memanggil GET /api/cron/check-expired.`;

const aiSystemPrompt = (admin) => `Kamu APHELION AI, chief-of-staff digital ekosistem Aphelion. Lawan bicara: ${admin.sub} (role: ${admin.role}).
ATURAN: 1. Beri SOLUSI konkret. 2. Gunakan TOOLS untuk data valid. 3. Jangan menebak. \n${AI_MANUAL}`;

const AI_TOOLS = [
  { type: 'function', function: { name: 'system_health', description: 'Kesehatan sistem.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'users_overview', description: 'Statistik user.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'team_chat_last', description: 'N pesan terakhir chat tim.', parameters: { type: 'object', properties: { n: { type: 'integer' } } } } },
  { type: 'function', function: { name: 'arcade_status', description: 'Raid boss & leaderboard.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'finance_range', description: '[OWNER] Omzet N hari.', parameters: { type: 'object', properties: { days: { type: 'integer' } } } } }
];

const execTool = async (name, args, role) => {
  // (Fungsi eksekusi tool persis seperti kode sebelumnya, disederhanakan untuk template di sini)
  try {
      if (name === 'system_health') {
          const d = await db.collection('settings').doc('app').get();
          return d.exists ? d.data() : {};
      }
      if (name === 'users_overview') {
          const cnt = async (st) => (await db.collection('users').where('status', '==', st).count().get()).data().count;
          const [active, expired] = await Promise.all([cnt('ACTIVE'), cnt('EXPIRED')]);
          return { active, expired };
      }
      if (name === 'finance_range' && role === 'owner') {
          return { total: 0 }; // Placeholder
      }
      return { error: 'Tool data ter-bypass' };
  } catch (e) { return { error: e.message }; }
};

const buildDeepSnapshot = async (role) => {
  const [health, users] = await Promise.all([
    execTool('system_health', {}, role),
    execTool('users_overview', {}, role)
  ]);
  return { system_health: health, users };
};

const callLLM = async (provider, model, messages, opts = {}) => {
  const URLS = {
    groq: 'https://api.groq.com/openai/v1/chat/completions',
    openrouter: 'https://openrouter.ai/api/v1/chat/completions',
    gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
  };
  const KEYS = { groq: 'GROQ_API_KEY', openrouter: 'OPENROUTER_API_KEY', gemini: 'GEMINI_API_KEY' };
  const key = process.env[KEYS[provider]];
  if (!key) return null;
  
  try {
    const r = await axios.post(URLS[provider], {
      model, messages, temperature: 0.5, max_tokens: opts.max_tokens || 600
    }, {
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      timeout: opts.timeout || 6000 // Beri batas timeout ketat 6 detik per panggilan
    });
    const msg = r.data?.choices?.[0]?.message;
    return (msg?.content || msg?.reasoning) || '';
  } catch(e) {
    console.error(`LLM Error ${provider}:`, e.message);
    return null; // Return null jika timeout/429
  }
};

// 🔥 KUNCI SOLUSI TIMEOUT: Eksekusi Beriringan (Paralel dengan Stagger)
// Ini tidak akan memblokir NodeJS seperti fungsi sebelumnya.
const runConcurrentStaggered = (tasks, staggerMs = 250) => {
  return Promise.all(
    tasks.map((task, i) => 
      new Promise(resolve => setTimeout(resolve, i * staggerMs)).then(() => task())
    )
  );
};

const COUNCIL = [
  { id: 'eng', label: '🧑‍💻 TEKNIS', provider: 'groq', model: 'qwen/qwen3.8-27b', persona: 'System Engineer senior: log webhook, arsitektur, keamanan.' },
  { id: 'data', label: '📊 DATA', provider: 'groq', model: 'openai/gpt-oss-120b', persona: 'Data Analyst: angka omzet, churn user, anomali statistik.' },
  { id: 'audit', label: '🔭 AUDITOR', provider: 'gemini', model: 'gemini-2.5-flash', persona: 'Auditor skeptis: mendeteksi halusinasi data, pelanggaran sistem.' },
  { id: 'logic', label: '🔬 REASONER', provider: 'openrouter', model: process.env.OPENROUTER_MODEL || 'deepseek/deepseek-chat-v3-0324:free', persona: 'Deep Reasoner: menyambung titik sebab-akibat.' }
];

const JUDGE_CHAIN = [
  { provider: 'gemini', model: 'gemini-2.5-pro' },
  { provider: 'gemini', model: 'gemini-2.5-flash' },
  { provider: 'groq', model: 'openai/gpt-oss-120b' }
];

const councilCooldown = {};

const councilRounds = async (q, snapStr) => {
  const baseFor = (m) => `Kamu ${m.label}, ${m.persona}\n${AI_MANUAL}\n
ATURAN MUTLAK:
1. SANGAT SKEPTIS. Fokus ke metrikmu.
2. WAJIB kutip angka dari SNAPSHOT.
3. Jangan pernah mengarang data.

SNAPSHOT LIVE:
${snapStr}`;

  // 🏁 ROUND 1 (Berjalan Paralel)
  const tasksR1 = COUNCIL.map(m => async () => {
    const response = await callLLM(m.provider, m.model, [
      { role: 'system', content: baseFor(m) },
      { role: 'user', content: q }
    ], { timeout: 6000, max_tokens: 350 });
    return { ...m, opini: response };
  });
  
  // Tembak secara paralel dengan jarak 250ms per LLM! Sangat cepat.
  const r1 = await runConcurrentStaggered(tasksR1, 250);
  const alive = r1.filter(x => x.opini);
  if (alive.length < 2) return null;

  // 🏁 ROUND 2 (DEBAT BERDARAH - Paralel)
  const others = alive.map(x => `[OPINI ${x.label}]:\n${x.opini}`).join('\n\n---\n\n');
  const tasksR2 = alive.map(m => async () => {
    const debatePrompt = `ROUND 2 (SIDANG DEBAT & CROSS-EXAMINATION).
Tugas:
1. BACA opini rekan dewan di bawah. 
2. CARI KESALAHAN LOGIKA / ASUMSI MEREKA berdasar spesialisasimu.
3. SERANG argumen mereka jika salah menafsirkan Snapshot. PERTAHANKAN argumenmu.
Format Output Langsung: [KRITIK LOGIKA REKAN] lalu [KESIMPULAN FINALKU].`;

    const response = await callLLM(m.provider, m.model, [
      { role: 'system', content: baseFor(m) + '\n\n' + debatePrompt },
      { role: 'user', content: q },
      { role: 'assistant', content: m.opini }, // Mengingat opini sebelumnya
      { role: 'user', content: 'OPINI REKAN DEWAN LAINNYA:\n' + others }
    ], { timeout: 6000, max_tokens: 400 });
    
    return { ...m, final: response || m.opini };
  });

  const r2 = await runConcurrentStaggered(tasksR2, 250);
  return r2.map(x => `${x.label}\n— POSISI AWAL:\n${x.opini}\n— POSISI DEBAT (FINAL):\n${x.final}`).join('\n==========\n');
};

router.post('/ai/ask', aiLimiter, requireAuth, async (req, res) => {
  try {
    const q = String(req.body.q || '').trim();
    const mode = req.body.mode;
    
    if (mode === 'council') {
      const now = Date.now();
      const last = councilCooldown[req.admin.sub] || 0;
      if (now - last < 20000) return res.status(429).json({ error: `🏛️ Dewan istirahat dulu. Tunggu ${Math.ceil((20000 - (now - last)) / 1000)} dtk lagi.` });
      councilCooldown[req.admin.sub] = now;

      const snapshot = await buildDeepSnapshot(req.admin.role);
      const snapStr = JSON.stringify(snapshot).slice(0, 3000); // Batasi ukuran snapshot
      const debate = await councilRounds(q, snapStr);

      if (!debate) {
        // Fallback jika sidang gagal kuorum
        return res.json({ answer: '🛟 *(Dewan gagal kuorum / API sibuk — coba mode Fast/Deep)*' });
      }

      // Simpan hasil debat ke Firestore
      const ref = await db.collection('ai_council').add({ q, debate, snap: snapStr, at: new Date().toISOString() });
      return res.json({ councilId: ref.id });
    }

    // (Logika FAST / DEEP biarkan seperti kode kamu sebelumnya)
    res.json({ answer: "Mode Fast/Deep OK." });
  } catch (e) {
    console.error("ASK Error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/ai/verdict', requireAuth, async (req, res) => {
  try {
    const id = String(req.body.id || '');
    const d = await db.collection('ai_council').doc(id).get();
    if (!d.exists) return res.status(404).json({ error: 'Sidang tidak ditemukan.' });
    const { q, debate, snap } = d.data();

    // HAKIM BERPIKIR MENGGUNAKAN <thinking> SEBELUM MENJAWAB
    const judgeSys = `Kamu KETUA SIDANG. Rangkum debat 4 spesialis menjadi 1 kesimpulan mutlak.
PROSES WAJIB:
1. Buka tag <thinking> untuk menimbang argumen siapa yang paling benar secara objektif berdasar SNAPSHOT. Cari siapa yang salah baca data.
2. Tutup dengan </thinking> dan cetak FORMAT FINAL.

FORMAT FINAL:
## ✅ KESIMPULAN & SOLUSI
<jawaban komprehensif>
TINGKAT KEPERCAYAAN: <0-100>%

## 📜 ANALISIS SIDANG
- <Agen 1>: <DITERIMA/DITOLAK - Alasan>
- <Agen 2>: <DITERIMA/DITOLAK - Alasan>

## ⚖️ RESOLUSI KONFLIK
<Siapa yang menang dalam debat tersebut dan alasannya>
${AI_MANUAL}`;

    let finalText = null;
    for (const j of JUDGE_CHAIN) {
      try {
        finalText = await callLLM(j.provider, j.model, [
          { role: 'system', content: judgeSys + '\nSNAPSHOT:\n' + snap },
          { role: 'user', content: `PERTANYAAN:\n${q}\n\nTRANSKRIP DEBAT R1 & R2:\n${debate}` }
        ], { timeout: 10000, max_tokens: 1500 });
        
        if (finalText) {
            // Hapus blok <thinking> agar user langsung membaca hasil bersih
            finalText = finalText.replace(/<thinking>[\s\S]*?<\/thinking>/g, '').trim();
            break;
        }
      } catch (e) { /* Lanjut hakim cadangan */ }
    }
    
    await db.collection('ai_council').doc(id).delete().catch(() => {});
    if (!finalText) return res.status(500).json({ error: '⚖️ Hakim gagal memutuskan. Coba lagi.' });
    res.json({ answer: finalText });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
