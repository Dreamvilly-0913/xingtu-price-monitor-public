import { chmod, mkdir, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import dotenv from 'dotenv';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serverRoot = resolve(projectRoot, 'server');
const require = createRequire(resolve(serverRoot, 'package.json'));

/** 使用 SQLite 在线一致性快照，不能直接复制仍在写入的 db/wal 文件。 */
export async function backupSqlite({ databaseUrl, outputDirectory = resolve(projectRoot, 'work/backups') } = {}) {
  dotenv.config({ path: resolve(serverRoot, '.env'), quiet: true });
  const sourceUrl = databaseUrl ?? process.env.DATABASE_URL ?? 'file:./dev.db';
  if (!sourceUrl.startsWith('file:')) throw new Error('db:backup 只支持 SQLite；PostgreSQL 请使用 pg_dump，不会复制或修改数据库');
  const databasePart = sourceUrl.slice(5).split('?')[0];
  if (!databasePart || databasePart === ':memory:') throw new Error('备份需要一个已存在的 SQLite 文件');
  const source = resolve(serverRoot, 'prisma', databasePart);
  if (!(await stat(source)).isFile()) throw new Error('SQLite 数据库路径不是文件');
  const destinationDirectory = resolve(outputDirectory);
  const requiredDirectory = resolve(projectRoot, 'work/backups');
  const relativeDirectory = relative(requiredDirectory, destinationDirectory);
  if (relativeDirectory.startsWith('..') || relativeDirectory.startsWith('/') || /^[A-Za-z]:/.test(relativeDirectory)) throw new Error('备份必须保存在本项目 work/backups 目录内');
  await mkdir(destinationDirectory, { recursive: true, mode: 0o700 });
  const createdAt = new Date().toISOString();
  const name = `xingtu-${createdAt.replace(/[-:.]/g, '')}-${randomUUID()}.db`;
  const destination = resolve(destinationDirectory, name);
  const { PrismaClient } = require('@prisma/client');
  const sourceClient = new PrismaClient({ datasources: { db: { url: `file:${source.replaceAll('\\', '/')}` } } });
  let snapshotClient;
  try {
    await sourceClient.$queryRawUnsafe('PRAGMA busy_timeout = 10000');
    // wx 先独占创建空文件，任何同名旧快照都不能被覆盖；VACUUM INTO 允许空目标。
    await writeFile(destination, '', { flag: 'wx', mode: 0o600 });
    // 参数绑定防止路径形成 SQL，不拼接包含引号的文件路径。
    await sourceClient.$executeRawUnsafe('VACUUM INTO ?', destination);
    await chmod(destination, 0o600);
    snapshotClient = new PrismaClient({ datasources: { db: { url: `file:${destination.replaceAll('\\', '/')}` } } });
    const integrity = await snapshotClient.$queryRawUnsafe('PRAGMA quick_check');
    if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok') throw new Error('生成的 SQLite 快照未通过 quick_check；请保留文件排查，不用于恢复');
    const tableNames = await snapshotClient.$queryRawUnsafe("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    const tables = [];
    for (const { name: tableName } of tableNames) {
      const quoted = tableName.replaceAll('"', '""');
      const [{ total }] = await snapshotClient.$queryRawUnsafe(`SELECT COUNT(*) AS total FROM "${quoted}"`);
      tables.push({ tableName, rows: Number(total) });
    }
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(destination)) hash.update(chunk);
    const report = { status: 'passed', createdAt, method: 'SQLite VACUUM INTO', backupFile: relative(projectRoot, destination).replaceAll('\\', '/'), bytes: (await stat(destination)).size, sha256: hash.digest('hex'), integrityCheck: 'ok', tables };
    await writeFile(`${destination}.json`, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return report;
  } finally {
    await Promise.allSettled([sourceClient.$disconnect(), snapshotClient?.$disconnect()]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const report = await backupSqlite();
    console.log(JSON.stringify(report));
  } catch (error) {
    // 不输出 Prisma 原始错误，避免连接串或用户名/密码进入运维日志。
    console.error(JSON.stringify({ status: 'failed', error: error instanceof Error && !error.name.startsWith('Prisma') ? error.message : 'SQLite 一致性备份失败，请检查数据库文件、写权限和连接状态；原库不会被重建' }));
    process.exitCode = 1;
  }
}
