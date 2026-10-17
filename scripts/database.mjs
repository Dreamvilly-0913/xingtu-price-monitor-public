import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import dotenv from 'dotenv';
import './setup-env.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = resolve(root, 'server');
dotenv.config({ path: resolve(server, '.env'), quiet: true });
const action = process.argv[2] || 'generate';
const isPostgres = action === 'validate-postgres' || /^postgres(ql)?:/.test(process.env.DATABASE_URL || '');
const canonical = resolve(server, 'prisma/schema.prisma');
const schema = isPostgres ? resolve(server, 'prisma/schema.postgresql.prisma') : canonical;
// Prisma provider 不能由环境变量插值；从同一模型生成 provider 副本，避免模型漂移。
if (isPostgres) writeFileSync(schema, readFileSync(canonical, 'utf8').replace(/provider\s*=\s*"sqlite"/, 'provider = "postgresql"'));
// 某些 Windows 环境的 schema engine 不能创建首个 SQLite 文件，只补空文件，绝不截断旧数据库。
if (!isPostgres && process.env.DATABASE_URL?.startsWith('file:')) {
  const databaseFile = resolve(dirname(schema), process.env.DATABASE_URL.slice(5).split('?')[0]);
  mkdirSync(dirname(databaseFile), { recursive: true });
  if (!existsSync(databaseFile)) closeSync(openSync(databaseFile, 'wx'));
}
// Windows 会锁住已加载的查询引擎，模型完全一致时复用客户端，构建可与本地服务并存。
if (action === 'generate') {
  try {
    const require = createRequire(resolve(server, 'package.json'));
    const generated = resolve(dirname(require.resolve('@prisma/client')), '../../.prisma/client/schema.prisma');
    const normalize = (text) => (text.match(/"(?:\\.|[^"\\])*"|[^\s]+/g) || []).join('');
    if (existsSync(generated) && normalize(readFileSync(generated, 'utf8')) === normalize(readFileSync(schema, 'utf8')) && require('@prisma/client').Prisma.prismaVersion.client === require('@prisma/client/package.json').version) {
      console.log('Prisma Client 与模型、版本一致，复用已生成客户端。');
      process.exit(0);
    }
  } catch { /* 首次生成时没有客户端，继续运行 generate。 */ }
}
const command = action === 'validate-postgres' ? 'validate' : action === 'push' ? 'db push' : 'generate';
const bin = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const result = spawnSync(bin, ['exec', 'prisma', ...command.split(' '), '--schema', schema], {
  cwd: server, stdio: 'inherit', shell: process.platform === 'win32',
  env: { ...process.env, ...(action === 'validate-postgres' ? { DATABASE_URL: 'postgresql://schema:only@localhost:5432/xingtu' } : {}) },
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
