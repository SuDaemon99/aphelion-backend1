const crypto = require('crypto');

// Alphabet tanpa I, O, 0, 1 biar gak salah baca saat dijapri manual
const ALPH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const block = (n) => Array.from(crypto.randomBytes(n)).map(b => ALPH[b % ALPH.length]).join('');
const genLicenseCode = () => `APH-${block(4)}-${block(4)}-${block(4)}`;

const maskToken = (t) => {
  if (!t) return null;
  const parts = String(t).split('-');
  if (parts.length >= 3) return parts.map((p, i) => (i > 0 && i < parts.length - 1 ? '****' : p)).join('-');
  return String(t).slice(0, 4) + '****' + String(t).slice(-4);
};

// 1 request = 1 token. Durasi BELUM jalan (expiredAt null) sampai login pertama.
// ✅ DUKUNG PRE-GEN ID + CODE (buat fallback idempoten). Kalau tidak dikirim, auto-generate (backward compat).
const createPendingLicense = async (db, { packageName, durationDays, createdBy, source, docId, code, username, ownerTgUid }) => {
  const finalCode = code || genLicenseCode();
  const ref = docId ? db.collection('users').doc(docId) : db.collection('users').doc();
  await ref.set({
    uid: null,
    username: username || null,
    ownerTgUid: ownerTgUid || null,
    email: null,
    token: finalCode,
    tokenMasked: maskToken(finalCode),
    packageName: packageName || null,
    durationDays: parseInt(durationDays) || 30,
    status: 'PENDING',
    deviceId: null,
    deviceInfo: null,
    createdBy: createdBy || 'system',
    source: source || 'manual',
    activatedAt: null,
    expiredAt: null,
    lastLoginAt: null,
    lastLoginIp: null,
    remindedH3: false,
    remindedH1: false,
    createdAt: new Date().toISOString()
  });
  return { id: ref.id, code: finalCode, masked: maskToken(finalCode) };
};

module.exports = { genLicenseCode, maskToken, createPendingLicense };
