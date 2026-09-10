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
const createPendingLicense = async (db, { packageName, durationDays, createdBy, source }) => {
  const code = genLicenseCode();
  const ref = await db.collection('users').add({
    uid: null,
    username: null,
    email: null,
    token: code,
    tokenMasked: maskToken(code),
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
  return { id: ref.id, code, masked: maskToken(code) };
};

module.exports = { genLicenseCode, maskToken, createPendingLicense };