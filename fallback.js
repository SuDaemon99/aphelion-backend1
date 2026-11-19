// fallback.js — Primary Firestore, Fallback Redis Queue (idempotent via dedupe)
const QUEUE_KEY = 'fb:queue';
const DONE_KEY  = 'fb:done';   // set dedupe: item yang sudah berhasil di-replay

// Push payload ke antrean Redis (dipanggil saat Firestore RESOURCE_EXHAUSTED)
const enqueue = async (redis, item) => {
  if (!redis) return false;
  return await redis.lpush(QUEUE_KEY, JSON.stringify(item)) > 0;
};

// Drain: pop semua item, replay via handler, skip yang sudah pernah sukses (dedupe)
const drain = async (redis, db, handlers) => {
  if (!redis) return { moved: 0, skipped: 0, failed: 0, remaining: 0 };
  let moved = 0, skipped = 0, failed = 0;

  while (true) {
    const raw = await redis.rpop(QUEUE_KEY);
    if (!raw) break;
    let item;
    try { item = JSON.parse(raw); } catch (e) { continue; }

    // dedupe: kalau sudah pernah di-apply, lewati (anti dobel saat drain crash-restart)
    if (item.dedupeId && await redis.sismember(DONE_KEY, item.dedupeId)) { skipped++; continue; }

    const fn = handlers[item.op];
    if (!fn) { console.error('fallback handler tidak dikenal:', item.op); failed++; continue; }

    try {
      await fn(db, item);
      if (item.dedupeId) await redis.sadd(DONE_KEY, item.dedupeId);
      moved++;
    } catch (err) {
      // kalau gagal karena kuota lagi → requeue di depan, stop drain (hemat write)
      if (/RESOURCE_EXHAUSTED|Quota exceeded/i.test(err.message || '')) {
        await redis.lpush(QUEUE_KEY, raw);
        break;
      }
      console.error('fallback replay error:', item.op, err.message);
      failed++;
    }
  }
  const remaining = await redis.llen(QUEUE_KEY);
  return { moved, skipped, failed, remaining };
};

module.exports = { enqueue, drain, QUEUE_KEY };
