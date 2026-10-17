import 'dotenv/config';

process.env.DATABASE_URL ??= 'file:./dev.db';
export const config = {
  port: Number(process.env.PORT ?? 4010),
  host: process.env.HOST ?? '127.0.0.1',
  jwtSecret: process.env.JWT_SECRET ?? 'xingtu-local-demo-secret-change-before-deploy-2026',
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:4173',
  timezone: process.env.APP_TIMEZONE ?? 'Asia/Shanghai',
  demoEnabled: process.env.DEMO_ENABLED === 'true' || (process.env.NODE_ENV !== 'production' && process.env.DEMO_ENABLED !== 'false'),
  bootstrapToken: process.env.BOOTSTRAP_TOKEN ?? '',
  trustProxy: process.env.TRUST_PROXY === 'true',
};

/** 示例文件与本地演示密钥不能成为生产凭证；长度满足也不能放过已知占位值。 */
export function isDeploymentSecret(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 32 && value === value.trim()
    && !/(?:replace[-_ ]?with|change[-_ ]?(?:me|before|this)|placeholder|example[-_ ]?(?:secret|token)|demo[-_ ]?secret)/i.test(value)
    && !/^(.)\1+$/.test(value);
}

if (process.env.NODE_ENV === 'production') {
  if (!isDeploymentSecret(process.env.JWT_SECRET)) throw new Error('生产环境必须设置至少32字符的随机JWT_SECRET，禁止示例占位值和演示默认密钥');
  if (config.bootstrapToken && !isDeploymentSecret(config.bootstrapToken)) throw new Error('生产BOOTSTRAP_TOKEN必须为至少32字符的随机凭证，禁止示例占位值');
}
