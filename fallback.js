// fallback.js — Primary Firestore, Fallback Redis Queue (idempotent)
const QUEUE_KEY = 'fb:queue';

// Push item ke antrean Redis (dipanggil SAAT Firestore gagal karena quota)
const pushFallback = async (redis, item) => {
  if (!redis) return false;
  try {
    await redis.lpush(QUEUE_KEY, JSON.stringify({ ...item, ts: Date.now() }));
    return true;
  } catch (e) { console.error('fallback push gagal:', e.message); return false; }
};

// Tulis dengan fallback: coba Firestore, kalau RESOURCE_EXHAUSTED → masuk queue
const safeWriteWithFallback = async (redis, writeFn, fallbackItem) => {
  try {
    return { ok: true, result: await writeFn() };
  } catch (err) {
    if (/RESOURCE_EXHAUSTED|Quota exceeded/i.test(err.message || '')) {
      const queued = await pushFallback(redis, fallbackItem);
      return { ok: false, deferred: queued, reason: 'quota_exhausted' };
    }
    throw err; // error non-quota (network dll) tetap dilempar
  }
};

// Drain saat kuota pulih (dipanggil cron / endpoint manual jam 15:00+ WIB)
const drainFallback = async (redis, db, replayFn) => {
  let moved = 0, failed = 0;
  while (true) {
    const raw = await redis.rpop(QUEUE_KEY);
    if (!raw) break;
    try {
      const item = JSON.parse(raw);
      await replayFn(db, item);   // replayFn WAJIB idempotent (pakai dedupeId/pre-gen id)
      moved++;
    } catch (e) { failed++; if (redis) await redis.lpush(QUEUE_KEY, raw); } // requeue
  }
  return { moved, failed };
};

module.exports = { pushFallback, safeWriteWithFallback, drainFallback };
