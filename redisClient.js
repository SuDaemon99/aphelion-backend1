// redisClient.js — SATU instance Redis dengan operasi lengkap (queue + set + counter)
const createSafeRedis = () => {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return null;

  let blockedUntil = 0;
  const isQuotaError = (err) => /max requests limit exceeded/i.test(err && err.message || '');
  const guard = async (fn, fallback) => {
    if (Date.now() < blockedUntil) return fallback;
    try { return await fn(); }
    catch (err) {
      if (isQuotaError(err)) { blockedUntil = Date.now() + 3600000; console.error('🔴 Redis quota, cooldown 1 jam'); }
      else console.error('Redis op error:', err.message);
      return fallback;
    }
  };

  try {
    const { Redis } = require('@upstash/redis');
    const r = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });

    return {
      get:   (k)       => guard(() => r.get(k), null),
      set:   (k, v, o) => guard(() => r.set(k, v, o), undefined),
      del:   (k)       => guard(() => r.del(k), 0),
      keys:  (p)       => guard(() => r.keys(p), []),
      mget:  (...ks)   => guard(() => r.mget(...ks), []),
      // --- operasi QUEUE & SET (untuk fallback) ---
      lpush: (k, v)    => guard(() => r.lpush(k, v), 0),
      rpop:  (k)       => guard(() => r.rpop(k), null),
      llen:  (k)       => guard(() => r.llen(k), 0),
      sadd:  (k, v)    => guard(() => r.sadd(k, v), 0),
      sismember: (k,v) => guard(() => r.sismember(k, v), false),
      scard: (k)       => guard(() => r.scard(k), 0),
      incr:  (k)       => guard(() => r.incr(k), 0),
      expire:(k, s)    => guard(() => r.expire(k, s), 0),
    };
  } catch (e) { console.error('Redis init error:', e.message); return null; }
};

module.exports = { createSafeRedis };
