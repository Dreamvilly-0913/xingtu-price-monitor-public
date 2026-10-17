import bcrypt from 'bcrypt';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { User } from '@prisma/client';
import { config, isDeploymentSecret } from './config.js';
import { prisma } from './db.js';
import { ApiError } from './utils.js';

// bcrypt 只处理前72字节；按UTF-8字节校验，避免长密码静默截断。
export const securePassword = z.string().min(12, '密码至少12个字符').max(72).refine(value => Buffer.byteLength(value, 'utf8') <= 72, '密码UTF-8长度不得超过72字节').refine(value => !['admin123', 'password1234', '123456789012', 'admin12345678'].includes(value.toLowerCase()), '请使用非默认密码');
export const bootstrapSchema = z.object({ username: z.string().trim().min(3).max(100), displayName: z.string().trim().min(1).max(100), password: securePassword, bootstrapToken: z.string().max(200).optional() }).strict();
export const publicUser = (user: User) => ({ id: user.id, username: user.username, displayName: user.displayName, mustChangePassword: !config.demoEnabled && user.mustChangePassword });
export const tokenPayload = (user: User) => ({ sub: user.id, username: user.username, ver: user.tokenVersion });
export const dummyPasswordHash = bcrypt.hashSync(randomBytes(24).toString('hex'), 10);
export function verifyBootstrapToken(candidate: string | undefined) {
  if (process.env.NODE_ENV !== 'production') return;
  if (!isDeploymentSecret(config.bootstrapToken)) throw new ApiError(503, 'BOOTSTRAP_UNCONFIGURED', '首次初始化需在服务器设置至少32字符的随机BOOTSTRAP_TOKEN，禁止示例占位值');
  const expected = Buffer.from(config.bootstrapToken);
  const supplied = Buffer.from(candidate ?? '');
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new ApiError(401, 'INVALID_BOOTSTRAP_TOKEN', '初始化凭证不正确');
}

/** 登录频率按服务器识别的IP及账号组合限制，不信任客户端自行提交的转发头。 */
export class LoginLimiter {
  private buckets = new Map<string, { count: number; expiresAt: number }>();
  check(ip: string, username: string, now = Date.now()) {
    for (const [key, bucket] of this.buckets) if (bucket.expiresAt <= now) this.buckets.delete(key);
    const policies = [{ key: `ip:${ip}`, maximum: 30, duration: 15 * 60_000 }, { key: `user:${ip}:${username.toLowerCase()}`, maximum: 5, duration: 15 * 60_000 }];
    for (const policy of policies) {
      const bucket = this.buckets.get(policy.key);
      if (bucket && bucket.count >= policy.maximum) throw new ApiError(429, 'LOGIN_RATE_LIMITED', '登录尝试过于频繁，请15分钟后重试', { retryAfterSeconds: Math.ceil((bucket.expiresAt - now) / 1000) });
    }
    if (this.buckets.size > 10_000) throw new ApiError(429, 'LOGIN_RATE_LIMITED', '登录请求过多，请稍后重试');
    for (const policy of policies) {
      const bucket = this.buckets.get(policy.key) ?? { count: 0, expiresAt: now + policy.duration };
      bucket.count++;
      this.buckets.set(policy.key, bucket);
    }
  }
  success(ip: string, username: string) { this.buckets.delete(`user:${ip}:${username.toLowerCase()}`); }
}

export async function writeAudit(user: { id: string; username: string } | null, action: string, entityType: string, entityId?: string, metadata: Record<string, unknown> = {}) {
  // 调用端只传字段名、计数和非敏感设置；不传表单或接口URL原文。
  await prisma.auditLog.create({ data: { userId: user?.id, username: user?.username ?? 'bootstrap', action, entityType, entityId, metadata: JSON.stringify(metadata) } });
}
