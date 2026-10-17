import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = dirname(fileURLToPath(import.meta.url)).replace(/[\\/]dist[\\/]scripts$/, '').replace(/[\\/]scripts$/, '');
const projectRoot = resolve(serverRoot, '..');
const workDir = resolve(projectRoot, 'work', 'stage1');
await mkdir(workDir, { recursive: true });
const testDatabase = resolve(workDir, `seed-regression-${Date.now()}.db`);
await writeFile(testDatabase, '');
process.env.DATABASE_URL = `file:${testDatabase.replace(/\\/g, '/')}`;
process.env.NODE_ENV = 'test';
process.env.DEMO_ENABLED = 'true';
// 阶段1复验也使用一次性隔离库，绝不重建正在运营的数据。
execFileSync(process.execPath, [resolve(serverRoot, 'node_modules/prisma/build/index.js'), 'db', 'push', '--schema', resolve(serverRoot, 'prisma/schema.prisma'), '--skip-generate'], { cwd: serverRoot, env: process.env, stdio: 'pipe' });
execFileSync(process.execPath, [resolve(serverRoot, 'node_modules/tsx/dist/cli.mjs'), resolve(serverRoot, 'prisma/seed.ts')], { cwd: serverRoot, env: process.env, stdio: 'pipe' });
const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/db.js');
const { businessDate, fromCents } = await import('../src/utils.js');
const { nextDemoPrice } = await import('../src/collectors/demo.js');
const app = await createApp({ startScheduler: false });
try {
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin123' } });
  assert.equal(login.statusCode, 200);
  const dashboard = await app.inject({ method: 'GET', url: '/api/dashboard', headers: { authorization: `Bearer ${login.json().token}` } });
  assert.equal(dashboard.statusCode, 200);
  const body = dashboard.json();
  const products = await prisma.product.findMany({ include: { collections: { orderBy: [{ collectedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] } }, orderBy: { id: 'asc' } });
  assert.equal(products.length, 12);
  assert.equal(body.monitoredProductCount, 12);
  assert.equal(await prisma.collectionRecord.count(), 372);
  const platforms = Object.fromEntries(['jd', 'tmall', 'pdd'].map((platform) => [platform, products.filter((product) => product.platform === platform).length]));
  assert.deepEqual(platforms, { jd: 4, tmall: 4, pdd: 4 });
  assert.ok(await prisma.alert.count() >= 2);
  assert.ok(await prisma.alertRuleState.count({ where: { active: true, rule: 'target' } }) >= 2);
  assert.equal(body.activeAlertCount, await prisma.alertRuleState.count({ where: { active: true } }));
  assert.ok(body.priceTrends.some((trend: { statistics: { maxDrawdownPercent: number } }) => trend.statistics.maxDrawdownPercent > 10));
  let replayedPoints = 0;
  let maximumMovement = 0;
  for (const product of products) {
    assert.equal(product.collections.length, 31);
    let previous = product.basePriceCents;
    for (const record of product.collections) {
      assert.equal(record.sourceLabel, '演示模拟');
      const snapshot = JSON.parse(record.collectorSnapshot) as Parameters<typeof nextDemoPrice>[0];
      const replayed = nextDemoPrice(snapshot.productId ? snapshot : { productId: product.id, date: businessDate(record.collectedAt), basePriceCents: product.basePriceCents, previousPriceCents: previous, volatilityPercent: 2.5, sequence: record.demoSequence ?? 0 });
      assert.equal(replayed, record.priceCents);
      const movement = Math.abs((replayed - previous) / previous * 100);
      maximumMovement = Math.max(maximumMovement, movement);
      assert.ok(movement <= 2.5);
      assert.ok(replayed >= Math.ceil(product.basePriceCents * 0.6) && replayed <= Math.floor(product.basePriceCents * 1.3));
      previous = replayed;
      replayedPoints++;
    }
    const api = body.products.find((item: { id: string }) => item.id === product.id);
    assert.equal(api.currentPrice, fromCents(product.collections.at(-1)!.priceCents));
  }
  const product = products.find((item) => item.id.startsWith('jd-iphone16-'))!;
  const prices = product.collections.map((record) => record.priceCents!);
  const historical = prices.slice(0, 30);
  // 独立使用原始数组计算，再与 HTTP 返回值逐项比较。
  const independentlyComputed = { minPrice: fromCents(Math.min(...prices)), maxPrice: fromCents(Math.max(...prices)), avgPrice: Math.round(prices.reduce((sum, price) => sum + price, 0) / prices.length) / 100, currentPrice: fromCents(prices.at(-1)), pointCount: prices.length };
  // 仪表盘候选商品采用轻摘要；所选曲线仍提供从流水计算的完整统计。
  const apiProduct = body.priceTrends.find((item: { productId: string }) => item.productId === product.id).statistics;
  for (const [key, value] of Object.entries(independentlyComputed)) assert.equal(apiProduct[key], value, `${key} 必须来自采集记录`);
  const report = {
    passed: true, products: 12, platforms, collections: 372, alerts: await prisma.alert.count(), activeRules: body.activeAlertCount, replayedPoints, testDatabase, operatingDatabaseUntouched: true,
    maximumMovementPercent: Number(maximumMovement.toFixed(6)), currentPriceMatchCount: products.length,
    sample: { id: product.id, name: product.name, platform: product.platform, basePrice: fromCents(product.basePriceCents), targetPrice: fromCents(product.targetPriceCents),
      history30: product.collections.slice(0, 30).map((record) => ({ time: record.collectedAt.toISOString(), price: fromCents(record.priceCents), sourceLabel: record.sourceLabel })),
      historical30Statistics: { minPrice: fromCents(Math.min(...historical)), maxPrice: fromCents(Math.max(...historical)), latestPrice: fromCents(historical.at(-1)) },
      todayPoint: { time: product.collections[30]!.collectedAt.toISOString(), price: fromCents(product.collections[30]!.priceCents) }, independentlyComputedAll31: independentlyComputed,
      dashboardAll31: Object.fromEntries(Object.keys(independentlyComputed).map((key) => [key, apiProduct[key]])), maxDrawdownPercent: apiProduct.maxDrawdownPercent },
  };
  await mkdir(resolve(projectRoot, 'outputs'), { recursive: true });
  await writeFile(process.env.VERIFICATION_OUTPUT_PATH ?? resolve(projectRoot, 'outputs/stage1-current-verification.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report, null, 2));
} finally { await app.close(); await prisma.$disconnect(); }
