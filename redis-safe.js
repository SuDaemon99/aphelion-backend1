// redis-safe.js
const { Redis } = require('@upstash/redis');

let redisBlockedUntil = 0;
const isQuotaError = (err) => /max requests limit exceeded/i.test(err.message);

const createSafeRedis = () => {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return null;
  }
  
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });

  const safeGet = async (key) => {
    if (Date.now() < redisBlockedUntil) return null;
    try {
      return await redis.get(key);
    } catch (err) {
      if (isQuotaError(err)) {
        redisBlockedUntil = Date.now() + 3600000; // cooldown 1 jam
        console.error('🔴 Redis quota exceeded, cooldown 1 jam');
      }
      return null;
    }
  };

  const safeSet = async (key, value, opts) => {
    if (Date.now() < redisBlockedUntil) return;
    try {
      await redis.set(key, value, opts);
    } catch (err) {
      if (isQuotaError(err)) {
        redisBlockedUntil = Date.now() + 3600000;
        console.error('🔴 Redis quota exceeded, cooldown 1 jam');
      }
    }
  };

  const safeKeys = async (pattern) => {
    if (Date.now() < redisBlockedUntil) return [];
    try {
      return await redis.keys(pattern);
    } catch (err) {
      if (isQuotaError(err)) {
        redisBlockedUntil = Date.now() + 3600000;
        console.error('🔴 Redis quota exceeded, cooldown 1 jam');
      }
      return [];
    }
  };

  const safeMget = async (...keys) => {
    if (Date.now() < redisBlockedUntil) return [];
    try {
      return await redis.mget(...keys);
    } catch (err) {
      if (isQuotaError(err)) {
        redisBlockedUntil = Date.now() + 3600000;
        console.error('🔴 Redis quota exceeded, cooldown 1 jam');
      }
      return [];
    }
  };

  return { get: safeGet, set: safeSet, keys: safeKeys, mget: safeMget };
};

module.exports = createSafeRedis;