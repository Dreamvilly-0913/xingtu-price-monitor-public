import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('.', import.meta.url));
const serverRoot = directory.replace(/[\\/]dist[\\/]scripts[\\/]?$/, '').replace(/[\\/]scripts[\\/]?$/, '');
const projectRoot = resolve(serverRoot, '..');
const stage2Report = JSON.parse(await readFile(resolve(projectRoot, 'outputs/stage2-verification.json'), 'utf8')) as { testDatabase: string };
process.env.DATABASE_URL = `file:${stage2Report.testDatabase.replace(/\\/g, '/')}`;
const { prisma } = await import('../src/db.js');
const bcrypt = (await import('bcrypt')).default;
const seedScript = resolve(serverRoot, 'dist/prisma/seed.js');
try {
  const originalProducts = await prisma.product.findMany({ include: { collections: true } });
  const originalUser = await prisma.user.findUniqueOrThrow({ where: { username: 'admin' } });
  const originalSettings = await prisma.setting.findUniqueOrThrow({ where: { id: 'global' } });
  const originalRecordCount = originalProducts.reduce((count, product) => count + product.collections.length, 0);
  const runSeed = (production = false, allowReset = false) => spawnSync(process.execPath, [seedScript], { cwd: serverRoot, env: { ...process.env, NODE_ENV: production ? 'production' : 'test', JWT_SECRET: 'seed-safety-only-secret-32-characters-not-deploy', ALLOW_DEMO_RESET: allowReset ? 'true' : 'false' }, encoding: 'utf8' });
  const first = runSeed();
  assert.equal(first.status, 0, first.stderr);
  const second = runSeed();
  assert.equal(second.status, 0, second.stderr);
  assert.equal(await prisma.product.count(), originalProducts.length + 12);
  assert.equal(await prisma.collectionRecord.count(), originalRecordCount + 372);
  for (const original of originalProducts) {
    const saved = await prisma.product.findUniqueOrThrow({ where: { id: original.id }, include: { collections: true } });
    assert.equal(saved.name, original.name);
    assert.equal(saved.collections.length, original.collections.length);
  }
  const newUser = await prisma.user.findUniqueOrThrow({ where: { username: 'admin' } });
  assert.equal(newUser.passwordHash, originalUser.passwordHash);
  assert.ok(await bcrypt.compare('new-admin-123', newUser.passwordHash));
  const settings = await prisma.setting.findUniqueOrThrow({ where: { id: 'global' } });
  assert.equal(settings.collectionIntervalMinutes, originalSettings.collectionIntervalMinutes);
  assert.equal(settings.demoVolatilityPercent, originalSettings.demoVolatilityPercent);
  assert.equal(settings.dropThresholdPercent, originalSettings.dropThresholdPercent);
  const productionBlocked = runSeed(true);
  assert.equal(productionBlocked.status, 1);
  assert.ok(productionBlocked.stderr.includes('生产环境禁止重建演示数据'));
  assert.equal(await prisma.product.count(), originalProducts.length + 12);
  const explicitlyAllowed = runSeed(true, true);
  assert.equal(explicitlyAllowed.status, 0, explicitlyAllowed.stderr);
  assert.equal(await prisma.product.count(), originalProducts.length + 12);
  assert.equal(await prisma.collectionRecord.count(), originalRecordCount + 372);
  const snapshotCount = await prisma.collectionRecord.count({ where: { trigger: 'seed', NOT: { collectorSnapshot: '{}' } } });
  assert.equal(snapshotCount, 372);
  const report = { passed: true, isolatedDatabase: stage2Report.testDatabase, repeatSeedRuns: 2, customProductsPreserved: originalProducts.length, customRecordsPreserved: originalRecordCount, changedAdminPasswordPreserved: true, settingsPreserved: { collectionIntervalMinutes: settings.collectionIntervalMinutes, demoVolatilityPercent: settings.demoVolatilityPercent, dropThresholdPercent: settings.dropThresholdPercent }, resultingProducts: await prisma.product.count(), resultingCollections: await prisma.collectionRecord.count(), demoProducts: 12, demoCollections: 372, demoInputSnapshots: snapshotCount, productionWithoutExplicitFlag: { exitCode: productionBlocked.status, rejected: true, reason: '生产环境禁止重建演示数据；首次演示初始化必须显式设置 ALLOW_DEMO_RESET=true' }, productionWithExplicitFlag: { exitCode: explicitlyAllowed.status, passed: true }, deliveryDatabaseUntouched: true };
  await writeFile(resolve(projectRoot, 'outputs/stage2-seed-safety.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await prisma.$disconnect(); }
