import { Redis } from '@upstash/redis';
import crypto from 'crypto';

// Upstash (REST) クライアント
export const redis = (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
  ? new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN })
  : null;

// token 生成（7文字前後 / base64url）
export function genToken(len = 7) {
  const bytes = Math.ceil((len * 6) / 8);
  return crypto.randomBytes(bytes).toString('base64url').slice(0, len);
}

// Stripe へのオープンリダイレクト防止
export function isAllowedTarget(url) {
  return /^https:\/\/(checkout|buy|pay)\.stripe\.com\/.+/i.test(url);
}

// 短縮作成：token -> URL を TTL付きで保存（上書き禁止）
export async function createShort(url, ttlSec) {
  if (!redis) return null;
  if (!isAllowedTarget(url)) throw new Error('UNSAFE_TARGET_URL');
  for (let i = 0; i < 5; i++) {
    const token = genToken(7);
    const ok = await redis.set(`s:${token}`, url, { ex: ttlSec, nx: true });
    if (ok === 'OK' || ok === true) return token;
  }
  throw new Error('SHORTENER_TOKEN_COLLISION');
}

export async function resolveShort(token) {
  if (!redis) return null;
  return await redis.get(`s:${token}`); // 見つからなければ null
}
