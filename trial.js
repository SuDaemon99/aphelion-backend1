const { FieldValue } = require('firebase-admin/firestore');
const { createPendingLicense, genLicenseCode, maskToken } = require('./licenses');
const { logAudit, notifyOps } = require('./ops');
const { enqueue } = require('./fallback');

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

// ===== 🔥 CORE: CLAIM TRIAL (dengan fallback Redis queue untuk kuota Firestore habis) =====
async function claimTrial(db, { uid, telegramUsername, telegramApi, publicGroupId, source = 'bot' }, redis) {
  const settings = await getTrialSettings(db);

  // 1. Saklar OFF
  if (!settings.enabled) return { ok: false, code: 'DISABLED' };

  // 2. Gerbang: wajib member grup publik (READ-only, aman dari quota)
  if (settings.requirePublicMember) {
    const ok = await isMemberOfPublicGroup(telegramApi, uid, publicGroupId);
    if (!ok) return { ok: false, code: 'NOT_MEMBER' };
  }

  // 3. Pernah claim (1 UID seumur hidup) — READ-only
  if (await checkUserEverClaimed(db, uid)) return { ok: false, code: 'USED' };

  // 4. Burst detection (5 claim dalam 10 menit = gelombang farming) — READ-only
  const burst = await checkBurst(db, 10, 5);
  if (burst) {
    await notifyOps(`🚨 <b>BURST TRIAL</b>\n≥5 claim dalam 10 menit — kemungkinan farming. Cek audit.`, { critical: true, safe: '🚨 Burst trial terdeteksi' });
  }

  // 5. Kuota harian — cap pakai MAX(Redis, Firestore) biar akurat saat fallback aktif
  const key = todayKey();
  const redisCount = redis ? (parseInt(await redis.get(`trial:count:${key}`)) || 0) : 0;
  let fsCount = 0;
  try {
    const counterDoc = await db.collection('trial_counters').doc(key).get();
    fsCount = counterDoc.exists ? (counterDoc.data().count || 0) : 0;
  } catch (e) { /* Firestore mungkin penuh, andalkan Redis */ }
  const todayCount = Math.max(redisCount, fsCount);
  if (todayCount >= settings.dailyCap) return { ok: false, code: 'QUOTA_FULL' };

  // 6. Ambil package aktif — READ-only
  const pkgSnap = await db.collection('packages').where('active', '==', true).get();
  if (pkgSnap.empty) return { ok: false, code: 'PACKAGE_INVALID' };
  const activePackages = pkgSnap.docs.map(d => d.data().packageName);

  // 🔥 7. PRE-GEN ID + CODE DI MEMORI (TANPA Firestore!)
  // Ini yang bikin user TETAP dapat token meskipun Firestore kuota habis
  const planned = activePackages.map(pkg => ({
    pkg,
    id: db.collection('users').doc().id,   // pre-gen ID Firestore (idempoten)
    code: genLicenseCode()                   // code lahir di memori (crypto.randomBytes)
  }));

  const now = new Date().toISOString();

  // Siapkan data untuk fallback queue (payload idempoten)
  const trialClaimData = {
    uid,
    telegramUsername: telegramUsername || null,
    tokenRef: planned[0].id,
    packageName: activePackages.join(','),
    durationDays: settings.days,
    claimedAt: now,
    activatedAt: null,
    deviceId: null,
    status: 'CLAIMED',
    tokenCount: planned.length,
    allPackages: activePackages
  };

  const trialUserData = {
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
    tokenCount: planned.length,
    allPackages: activePackages
  };

  // 🔥 8. Coba persist SEMUA ke Firestore. Kalau RESOURCE_EXHAUSTED → enqueue Redis, user tetap dapat token.
  let deferred = false;
  try {
    // 8a. Buat 1 token per package (pakai docId pre-gen)
    for (const p of planned) {
      await createPendingLicense(db, {
        packageName: p.pkg,
        durationDays: settings.days,
        createdBy: `trial:${source}`,
        source: 'trial',
        docId: p.id,
        code: p.code,
        username: telegramUsername || null
      });
    }

    // 8b. Catat claim per UID
    await db.collection('trial_claims').doc(uid).set(trialClaimData);

    // 8c. Update user doc utama
    await db.collection('users').doc(uid).set(trialUserData, { merge: true });

    // 8d. Increment counter
    await db.collection('trial_counters').doc(key).set({ count: FieldValue.increment(1), date: key }, { merge: true });
    if (redis) await redis.incr(`trial:count:${key}`);

  } catch (err) {
    if (/RESOURCE_EXHAUSTED|Quota exceeded/i.test(err.message || '')) {
      // 🔥 FIRESTORE KUOTA HABIS → push payload ke Redis queue, user TETAP dapat token
      deferred = true;
      if (redis) {
        for (const p of planned) {
          await enqueue(redis, {
            op: 'license',
            dedupeId: p.id,
            docId: p.id,
            code: p.code,
            packageName: p.pkg,
            durationDays: settings.days,
            createdBy: `trial:${source}`,
            source: 'trial',
            username: telegramUsername || null
          });
        }
        await enqueue(redis, { op: 'trial_claim', dedupeId: `claim:${uid}`, uid, data: trialClaimData });
        await enqueue(redis, { op: 'trial_user',  dedupeId: `user:${uid}`,  uid, data: trialUserData });
        await enqueue(redis, { op: 'counter',     dedupeId: `cnt:${uid}`,   key });
        await redis.incr(`trial:count:${key}`);   // Redis = otoritas cap (anti dobel claim)
      }
      console.warn(`🟡 Trial claim ${uid} DEFERRED ke Redis queue (Firestore quota)`);
    } else {
      // Error non-quota (network, dll) — tetap dilempar
      throw err;
    }
  }

  // 9. Audit + feed (best-effort, non-kritis)
  try {
    const pkgSummary = activePackages.map(p => p.split('.').pop()).join(' + ');
    await logAudit('system', 'TRIAL_CLAIM', uid, {
      username: telegramUsername,
      packages: activePackages,
      tokenCount: planned.length,
      days: settings.days,
      source,
      deferred
    });
    await notifyOps(
      `🎁 <b>TRIAL CLAIM</b>${deferred ? ' (PENDING SYNC)' : ''}\n@${telegramUsername || uid} • ${planned.length} token (${pkgSummary}) • ${settings.days}d`,
      { safe: `🎁 Trial: @${telegramUsername || uid}${deferred ? ' [DEFERRED]' : ''}`, type: 'system' }
    );
  } catch (e) { /* abaikan */ }

  // 10. Return multi-token + backward compat
  const tokens = planned.map(p => ({
    code: p.code,
    masked: maskToken(p.code),
    packageName: p.pkg,
    id: p.id
  }));

  return {
    ok: true,
    deferred,                           // 🔥 flag: true = data masih di queue Redis, belum di Firestore
    tokens,
    token: tokens[0].code,              // backward compat
    code: tokens[0].code,               // backward compat
    id: tokens[0].id,                   // backward compat
    masked: tokens[0].masked,           // backward compat
    days: settings.days,
    package: activePackages[0],         // backward compat
    packages: activePackages,
    tokenCount: tokens.length
  };
}

module.exports = {
  DEFAULT_TRIAL, getTrialSettings, checkTrialDevice, markTrialActivated,
  claimTrial, checkUserEverClaimed
};
