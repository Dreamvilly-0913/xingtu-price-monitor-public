import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(root, 'server/.env');
mkdirSync(resolve(root, 'server'), { recursive: true });
// 首次启动生成本地环境，不覆盖用户已配置的数据库或密钥。
if (!existsSync(target)) {
  writeFileSync(target, `DATABASE_URL="file:./dev.db"\nJWT_SECRET="${randomBytes(48).toString('hex')}"\nBOOTSTRAP_TOKEN="${randomBytes(32).toString('hex')}"\nDEMO_ENABLED=true\nPORT=4010\nHOST=127.0.0.1\nCORS_ORIGIN="http://localhost:4173"\nAPP_TIMEZONE="Asia/Shanghai"\nNODE_ENV=development\n`);
  console.log('已生成 server/.env（JWT 密钥随机生成）。');
}
