// reseller.js — MODUL BISNIS RESELLER APHELION
// Logika reseller terpusat di sini (pola sama seperti finance.js / ops.js / trial.js)
const { logAudit, notifyOps } = require('./ops');

// ===== BACA PROFIL AKUN RESELLER =====
async function getResellerAccount(db, username) {
  const d = await db.collection('admin_accounts').doc(username).get();
  if (!d.exists) return null;
  const a = d.data();
  if (a.role !== 'reseller') return null;
  return {
    username: a.username || username,
    brandName: a.brandName || username,
    active: a.active === true,
    resellerExpiry: a.resellerExpiry
      ? (a.resellerExpiry.toDate ? a.resellerExpiry.toDate() : new Date(a.resellerExpiry))
      : null,
    raw: a
  };
}

// ===== CEK RESELLER MASIH AKTIF (dipakai saat login & tiap request) =====
function isResellerActive(acc) {
  if (!acc) return false;
  if (!acc.active) return false;
  if (!acc.resellerExpiry) return true;   // expiry belum di-set = grace period (aktif)
  return acc.resellerExpiry > new Date();
}

// ===== OWNERSHIP: reseller hanya kelola member yang dia generate =====
function canManageUser(admin, userDoc) {
  if (!admin) return false;
  if (admin.role !== 'reseller') return true;   // owner & admin = akses penuh
  return (userDoc.createdBy || null) === admin.sub;
}

// ===== PERPANJANG DURASI RESELLER (owner & admin — layaknya extend member) =====
async function extendReseller(db, username, months, byName) {
  const d = await db.collection('admin_accounts').doc(username).get();
  if (!d.exists) return { ok: false, error: 'Akun tidak ditemukan' };
  const a = d.data();
  if (a.role !== 'reseller') return { ok: false, error: 'Akun ini bukan reseller' };

  const m = Math.max(1, Math.min(24, parseInt(months) || 1));
  const cur = a.resellerExpiry
    ? (a.resellerExpiry.toDate ? a.resellerExpiry.toDate() : new Date(a.resellerExpiry))
    : null;
  // Perpanjang DI ATAS sisa aktif (telat 1-2 hari tidak hanguskan sisa)
  const base = (cur && cur > new Date()) ? cur : new Date();
  const exp = new Date(base.getTime() + m * 30 * 86400000);

  await d.ref.update({ resellerExpiry: exp, active: true });
  await logAudit(byName, 'RESELLER_EXTEND', username, { months: m, until: exp.toISOString() });
  await notifyOps(
    `🏪 <b>Reseller diperpanjang</b>: ${username} +${m} bln (s/d ${exp.toLocaleDateString('id-ID')}) oleh ${byName}`,
    { safe: `🏪 Reseller ${username} +${m} bln oleh ${byName}`, type: 'critical' }
  );
  return { ok: true, resellerExpiry: exp };
}

// ===== STATISTIK MEMBER RESELLER (dashboard scoped) =====
async function getResellerStats(db, username) {
  const cnt = async (st) =>
    (await db.collection('users').where('createdBy', '==', username).where('status', '==', st).count().get()).data().count;
  const [active, expired, banned, pending] = await Promise.all([
    cnt('ACTIVE'), cnt('EXPIRED'), cnt('BANNED'), cnt('PENDING')
  ]);
  return { active, expired, banned, pending, total: active + expired + banned + pending };
}

// ===== LIST MEMBER RESELLER (scoped, single-field query, sort in-memory) =====
async function listResellerMembers(db, username, { status = null, q = null, limit = 500 } = {}) {
  const snap = await db.collection('users').where('createdBy', '==', username).limit(limit).get();
  let rows = snap.docs.map(x => ({ id: x.id, u: x.data() }));
  if (q) {
    const qq = String(q).trim().toLowerCase().replace(/^@/, '');
    rows = rows.filter(r => r.id === qq || (r.u.username || '').toLowerCase() === qq);
  }
  if (status) rows = rows.filter(r => (r.u.status || null) === status);
  rows.sort((a, b) => String(b.u.createdAt || '').localeCompare(String(a.u.createdAt || '')));
  return rows;
}

module.exports = {
  getResellerAccount, isResellerActive, canManageUser,
  extendReseller, getResellerStats, listResellerMembers
};
