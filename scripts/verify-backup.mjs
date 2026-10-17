import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { backupSqlite } from './backup-sqlite.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { PrismaClient } = createRequire(resolve(root, 'server/package.json'))('@prisma/client');
const id = randomUUID();
const fixtureDirectory = resolve(root, 'work', `backup-fixture-${id}`);
const snapshotDirectory = resolve(root, 'work/backups', `fixture-${id}`, "quote'in-path");
await mkdir(fixtureDirectory, { recursive: true });
const sourceFile = resolve(fixtureDirectory, 'source.db');
await writeFile(sourceFile, '', { flag: 'wx' });
const databaseUrl = `file:${sourceFile.replaceAll('\\', '/')}`;
const source = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
let assertions = 0;
const equal = (a, b, name) => { assertions++; assert.deepEqual(a, b, name); };
const check = (a, name) => { assertions++; assert.ok(a, name); };
const began = performance.now();
let snapshot, restored, writer;
try {
  await source.$executeRawUnsafe('CREATE TABLE "Balances" (id INTEGER PRIMARY KEY, amount INTEGER NOT NULL)');
  await source.$executeRawUnsafe('INSERT INTO "Balances" VALUES (1, 500000), (2, 500000)');
  await source.$executeRawUnsafe('CREATE TABLE "Ledger" (id INTEGER PRIMARY KEY, delta INTEGER NOT NULL)');
  await source.$executeRawUnsafe('WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM sequence WHERE n < 10000) INSERT INTO "Ledger" SELECT n, 0 FROM sequence');
  let entered;
  const firstWrite = new Promise(yes => { entered = yes; });
  let writing = true;
  writer = (async () => {
    for (let iteration = 0; iteration < 20; iteration++) {
      await source.$transaction(async tx => {
        await tx.$executeRawUnsafe('UPDATE "Balances" SET amount = amount - 25 WHERE id = 1');
        if (iteration === 0) entered();
        await new Promise(yes => setTimeout(yes, 2));
        await tx.$executeRawUnsafe('UPDATE "Balances" SET amount = amount + 25 WHERE id = 2');
        await tx.$executeRawUnsafe('INSERT INTO "Ledger" VALUES (?, 25)', 10001 + iteration);
      });
      await new Promise(yes => setTimeout(yes, 1));
    }
    writing = false;
  })();
  await firstWrite;
  check(writing, '备份开始时另一连接的事务写入正在进行');
  const report = await backupSqlite({ databaseUrl, outputDirectory: snapshotDirectory });
  snapshot = new PrismaClient({ datasources: { db: { url: `file:${resolve(root, report.backupFile).replaceAll('\\', '/')}` } } });
  const balances = await snapshot.$queryRawUnsafe('SELECT amount FROM "Balances" ORDER BY id');
  const [{ total }] = await snapshot.$queryRawUnsafe('SELECT COUNT(*) AS total FROM "Ledger"');
  const capturedWrites = Number(total) - 10000;
  equal(Number(balances[0].amount) + Number(balances[1].amount), 1_000_000, '快照没有捕获转账中间状态');
  equal(Number(balances[0].amount), 500000 - capturedWrites * 25, '余额与流水为同一一致性时刻');
  check(capturedWrites >= 0 && capturedWrites <= 20, '快照写入数处于实际范围');
  equal(report.tables.find(table => table.tableName === 'Ledger').rows, Number(total), '清单行数与快照一致');
  equal(report.integrityCheck, 'ok', '快照quick_check正常');
  check(/^[a-f0-9]{64}$/.test(report.sha256), '快照SHA256完整');
  const stored = JSON.parse(await readFile(`${resolve(root, report.backupFile)}.json`, 'utf8'));
  equal(stored.sha256, report.sha256, '快照清单保存相同哈希');
  await writer;
  const [{ total: sourceRows }] = await source.$queryRawUnsafe('SELECT COUNT(*) AS total FROM "Ledger"');
  equal(Number(sourceRows), 10020, '原库在线写入20次全部完成');
  const second = await backupSqlite({ databaseUrl, outputDirectory: snapshotDirectory });
  check(second.backupFile !== report.backupFile, '再次备份不覆盖原快照');
  equal(second.tables.find(table => table.tableName === 'Ledger').rows, 10020, '第二份快照包含全部写入');
  equal((await stat(resolve(root, report.backupFile))).size, report.bytes, '第一份快照未被后续备份改写');
  const restoredFile = resolve(fixtureDirectory, 'restored.db');
  await copyFile(resolve(root, report.backupFile), restoredFile);
  restored = new PrismaClient({ datasources: { db: { url: `file:${restoredFile.replaceAll('\\', '/')}` } } });
  equal(await restored.$queryRawUnsafe('SELECT amount FROM "Balances" ORDER BY id'), balances, '恢复文件余额与快照一致');
  equal(createHash('sha256').update(await readFile(restoredFile)).digest('hex'), report.sha256, '恢复前后文件哈希一致');
  equal((await restored.$queryRawUnsafe('PRAGMA quick_check'))[0].quick_check, 'ok', '恢复数据库完整性正常');
  assertions++; await assert.rejects(() => backupSqlite({ databaseUrl: 'postgresql://private:never-print@localhost/db' }), /只支持 SQLite/);
  assertions++; await assert.rejects(() => backupSqlite({ databaseUrl: `file:${resolve(fixtureDirectory, 'missing.db')}` }));
  assertions++; await assert.rejects(() => stat(resolve(fixtureDirectory, 'missing.db')), /ENOENT/);
  assertions++; await assert.rejects(() => backupSqlite({ databaseUrl, outputDirectory: fixtureDirectory }), /work\/backups/);
  equal((await readdir(snapshotDirectory)).filter(name => name.endsWith('.db')).length, 2, '只有两份预期快照，没有覆盖或其它目标写入');
  const verification = { status: 'passed', generatedAt: new Date().toISOString(), assertions, noBusinessDatabaseMutation: true, initialLedgerRows: 10000, concurrentCommittedWrites: 20, capturedWrites, backupLedgerRows: Number(total), completedBackupLedgerRows: 10020, backupCount: 2, balanceSum: 1_000_000, snapshotBytes: report.bytes, snapshotSha256: report.sha256, restoreIntegrity: 'ok', durationMs: Math.round(performance.now() - began) };
  await mkdir(resolve(root, 'outputs'), { recursive: true });
  await writeFile(resolve(root, 'outputs/operations-backup.json'), `${JSON.stringify(verification, null, 2)}\n`);
  console.log(JSON.stringify(verification));
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', assertions, error: error instanceof Error ? error.stack : String(error) }));
  process.exitCode = 1;
} finally {
  await writer?.catch(() => undefined);
  await Promise.allSettled([source.$disconnect(), snapshot?.$disconnect(), restored?.$disconnect()]);
}
