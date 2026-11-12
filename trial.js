const { FieldValue } = require('firebase-admin/firestore');
const { createPendingLicense } = require('./licenses');
const { logAudit, notifyOps } = require('./ops');

const DEFAULT_TRIAL = {
  enabled: false,
  days: 7,
  dailyCap: 20,
  package: 'com.deimos.phantom',  // legacy fallback
  pushNotify: false,
  requirePublicMember: true
};

// ===== BACA SETTING TRIAL (dari doc settings/app) =====
async function getTrialSettings(db) {
  try {
    const doc = await db.collection('settings').doc('app').get();
    if (!doc.exists) return { ...DEFAULT_TRIAL };
    const d = doc.data();
    return {
      enabled: d.trialEnabled === true,
      days: parseInt(d.trialDays) || DEFAULT_TRIAL.days,
      dailyCap: parseInt(d.trialDailyCap) || DEFAULT_TRIAL.dailyCap,
      package: d.trialPackage || DEFAULT_TRIAL.package,
      pushNotify: d.trialPushNotify === true,
      requirePublicMember: d.trialRequirePublic !== false
    };
  } catch (e) {
    return { ...DEFAULT_TRIAL };
  }
}

function todayKey() { return new Date().toISOString().slice(0, 10); }

// ===== REGISTRI DEVICE GLOBAL (anti-farm lintas akun TG) =====
async function checkTrialDevice(db, deviceId) {
  if (!deviceId) return false;
  try {
    const snap = await db.collection('trial_devices').doc(deviceId).get();
    return snap.exists;
  } catch (e) { return false; }
}

async function markTrialActivated(db, uid, deviceId) {
  const now = new Date().toISOString();
  if (deviceId) {
    await db.collection('trial_devices').doc(deviceId).set({
      uid, activatedAt: now
    });
  }
  await db.collection('trial_claims').doc(uid).set({
    deviceId, status: 'ACTIVE', activatedAt: now
  }, { merge: true });
}

// ===== COUNTER HARIAN + BURST =====
async function incrementClaimCounter(db) {
  const key = todayKey();
  const ref = db.collection('trial_counters').doc(key);
  await ref.set({ count: FieldValue.increment(1), date: key }, { merge: true });
  const snap = await ref.get();
  return snap.exists ? (snap.data().count || 1) : 1;
}

async function checkBurst(db, windowMinutes = 10, threshold = 5) {
  try {
    const cutoff = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();
    const snap = await db.collection('trial_claims')
      .where('claimedAt', '>=', cutoff)
      .count().get();
    return (snap.data().count || 0) >= threshold;
  } catch (e) { return false; }
}

async function checkUserEverClaimed(db, uid) {
  try {
    const snap = await db.collection('trial_claims').doc(uid).get();
    return snap.exists;
  } catch (e) { return false; }
}

async function isMemberOfPublicGroup(telegramApi, uid, publicGroupId) {
  if (!publicGroupId) return true;
  try {
    const axios = require('axios');
    const r = await axios.post(`${telegramApi}/getChatMember`, {
      chat_id: publicGroupId, user_id: uid
    });
    const status = r.data?.result?.status;
    return ['member', 'administrator', 'creator'].includes(status);
  } catch (e) { return false; }
}

// ===== 🔥 CORE: CLAIM TRIAL — SEKARANG GENERATE 1 TOKEN PER PACKAGE AKTIF =====
async function claimTrial(db, { uid, telegramUsername, telegramApi, publicGroupId, source = 'bot' }) {
  const settings = await getTrialSettings(db);

  // 1. Saklar OFF
  if (!settings.enabled) return { ok: false, code: 'DISABLED' };

  // 2. Gerbang: wajib member grup publik
  if (settings.requirePublicMember) {
    const ok = await isMemberOfPublicGroup(telegramApi, uid, publicGroupId);
    if (!ok) return { ok: false, code: 'NOT_MEMBER' };
  }

  // 3. Pernah claim (1 UID seumur hidup)
  if (await checkUserEverClaimed(db, uid)) return { ok: false, code: 'USED' };

  // 4. Burst detection (5 claim dalam 10 menit = gelombang farming)
  const burst = await checkBurst(db, 10, 5);
  if (burst) {
    await notifyOps(`🚨 <b>BURST TRIAL</b>\n≥5 claim dalam 10 menit — kemungkinan farming. Cek audit.`, { critical: true, safe: '🚨 Burst trial terdeteksi' });
  }

  // 5. Kuota harian
  const key = todayKey();
  const counterDoc = await db.collection('trial_counters').doc(key).get();
  const todayCount = counterDoc.exists ? (counterDoc.data().count || 0) : 0;
  if (todayCount >= settings.dailyCap) return { ok: false, code: 'QUOTA_FULL' };

  // 🔥 6. AMBIL SEMUA PACKAGE AKTIF (Phantom + Grab + lainnya)
  const pkgSnap = await db.collection('packages')
    .where('active', '==', true)
    .get();

  if (pkgSnap.empty) return { ok: false, code: 'PACKAGE_INVALID' };

  const activePackages = pkgSnap.docs.map(d => d.data().packageName);

  // 🔥 7. GENERATE 1 TOKEN PER PACKAGE AKTIF (multi-token)
  const tokens = [];
  for (const pkg of activePackages) {
    const { id, code, masked } = await createPendingLicense(db, {
      packageName: pkg,
      durationDays: settings.days,
      createdBy: `trial:${source}`,
      source: 'trial'
    });

    // Stamp username & source ke doc user per-package
    await db.collection('users').doc(id).update({
      username: telegramUsername || null,
      source: 'trial',
      createdBy: `trial:${source}`
    });

    tokens.push({ code, masked, packageName: pkg, id });
  }

  // 8. Catat claim (per UID) — 1 claim = dapat semua token
  const now = new Date().toISOString();
  await db.collection('trial_claims').doc(uid).set({
    uid,
    telegramUsername: telegramUsername || null,
    tokenRef: tokens[0].id,
    packageName: activePackages.join(','),  // semua package
    durationDays: settings.days,
    claimedAt: now,
    activatedAt: null,
    deviceId: null,
    status: 'CLAIMED',
    tokenCount: tokens.length,
    allPackages: activePackages
  });

  // 9. Update user doc utama (pakai package pertama sebagai primary)
  await db.collection('users').doc(uid).set({
    uid,
    username: telegramUsername || null,
    source: 'trial',
    tier: 'trial',
    packageName: activePackages[0],
    durationDays: settings.days,
    status: 'PENDING',
    deviceId: null,
    createdBy: `trial:${source}`,
    createdAt: now,
    remindedH3: false,
    remindedH1: false,
    tokenCount: tokens.length,
    allPackages: activePackages
  }, { merge: true });

  // 10. Increment counter + alert kuota 80%
  const newCount = await incrementClaimCounter(db);
  if (newCount === Math.floor(settings.dailyCap * 0.8)) {
    await notifyOps(
      `⚠️ <b>Kuota trial 80%</b>: ${newCount}/${settings.dailyCap} terpakai hari ini`,
      { critical: true, safe: `⚠️ Kuota trial ${newCount}/${settings.dailyCap}` }
    );
  }

  // 11. Audit + feed (tampilkan semua package)
  const pkgSummary = activePackages.map(p => p.split('.').pop()).join(' + ');

  await logAudit('system', 'TRIAL_CLAIM', uid, {
    username: telegramUsername,
    packages: activePackages,
    tokenCount: tokens.length,
    days: settings.days,
    source
  });

  await notifyOps(
    `🎁 <b>TRIAL CLAIM</b>\n@${telegramUsername || uid} • ${tokens.length} token (${pkgSummary}) • ${settings.days}d`,
    { safe: `🎁 Trial: @${telegramUsername || uid} (${tokens.length} token)`, type: 'system' }
  );

  // 🔥 Return multi-token + backward compat (field 'code' & 'package' untuk handler lama)
  return {
    ok: true,
    tokens,                          // array semua token
    token: tokens[0].code,           // backward compat (token pertama)
    code: tokens[0].code,            // backward compat
    id: tokens[0].id,                // backward compat
    masked: tokens[0].masked,        // backward compat
    days: settings.days,
    package: activePackages[0],      // backward compat (package pertama)
    packages: activePackages,        // array semua package
    tokenCount: tokens.length
  };
}

module.exports = {
  DEFAULT_TRIAL, getTrialSettings, checkTrialDevice, markTrialActivated,
  claimTrial, checkUserEverClaimed
};
