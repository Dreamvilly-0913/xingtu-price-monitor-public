import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Product } from '@prisma/client';

const serverRoot = dirname(fileURLToPath(import.meta.url)).replace(/[\\/]dist[\\/]scripts$/, '').replace(/[\\/]scripts$/, '');
const root = resolve(serverRoot, '..');
const workDir = resolve(root, 'work/operations-race');
await mkdir(workDir, { recursive: true });
const database = resolve(workDir, `race-${Date.now()}.db`);
await writeFile(database, '');
process.env.DATABASE_URL = `file:${database.replaceAll('\\', '/')}`;
process.env.NODE_ENV = 'test';
process.env.DEMO_ENABLED = 'false';
execFileSync(process.execPath, [resolve(serverRoot, 'node_modules/prisma/build/index.js'), 'db', 'push', '--schema', resolve(serverRoot, 'prisma/schema.prisma'), '--skip-generate'], { cwd: serverRoot, env: process.env, stdio: 'pipe' });
const { prisma } = await import('../src/db.js');
const { collectProduct, waitForCollectionQueues } = await import('../src/collection-service.js');
const { collectionIdentity } = await import('../src/collection-identity.js');
const { ApiError } = await import('../src/utils.js');

type Gate = { started: () => void; released: Promise<void>; price: number };
const gates = new Map<string, Gate>();
const fixture = createServer((request, response) => {
  const gate = gates.get(request.url ?? '');
  if (!gate) { response.writeHead(404); response.end('fixture not configured'); return; }
  gate.started();
  void gate.released.then(() => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ price: gate.price })); });
});
await new Promise<void>(done => fixture.listen(0, '127.0.0.1', done));
const baseUrl = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
process.env.HTTP_ALLOWED_HOSTS = new URL(baseUrl).host;
let assertions = 0;
const check = (value: unknown, message: string) => { assert.ok(value, message); assertions++; };
const results: Record<string, unknown> = {};
async function product(name: string, targetPriceCents = 9000) {
  return prisma.product.create({ data: { name: `并发隔离 ${name}`, platform: 'jd', sku: `race-${name}`, category: '并发隔离夹具', url: `${baseUrl}/${name}`, basePriceCents: 10000, targetPriceCents, sourceType: 'http', enabled: true, collectorConfig: JSON.stringify({ mode: 'json', priceUrl: `${baseUrl}/${name}`, jsonPath: 'price', timeoutMs: 10000 }) } });
}

async function duringRequest(item: Product, mutation: () => Promise<unknown>, shouldDelete = false) {
  let started!: () => void, release!: () => void, settled = false;
  const requestStarted = new Promise<void>(done => { started = done; });
  const released = new Promise<void>(done => { release = done; });
  gates.set(new URL((JSON.parse(item.collectorConfig) as { priceUrl: string }).priceUrl).pathname, { started, released, price: 80 });
  // 拦住真实HTTP响应直至数据库修改完成，确定性复现请求期间的业务状态变化。
  const pending = collectProduct(item.id, 'isolated-race-http-fixture', undefined, false).then(result => { settled = true; return { result, error: null }; }, error => { settled = true; return { result: null, error }; });
  try {
    await Promise.race([requestStarted, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('慢HTTP夹具未收到请求')), 5000); timer.unref(); })]);
    check(!settled, '状态修改发生在HTTP仍未完成时');
    await mutation();
    await new Promise<void>(done => setTimeout(done, 80));
    release();
    const completion = await pending;
    const records = await prisma.collectionRecord.findMany({ where: { productId: item.id } });
    const alerts = await prisma.alert.count({ where: { productId: item.id } });
    check(alerts === 0, '并发状态变更未触发失效预警');
    if (shouldDelete) {
      check(completion.error instanceof ApiError && completion.error.statusCode === 404, '采集中删除商品明确返回404');
      check(records.length === 0, '删除商品后没有采集或孤立价格流水');
      return { status: 404, savedRecords: 0, alertsCreated: 0 };
    }
    assert.ifError(completion.error);
    check(completion.result?.collection.status === 'success' && completion.result.collection.price === 80, '已开始的HTTP结果仍正常记录80元');
    const record = records.find(record => record.trigger === 'isolated-race-http-fixture')!;
    check(Boolean(record), '真实请求结果落库');
    const snapshot = JSON.parse(record.collectorSnapshot) as { collectionIdentity: string; requestUrl: string };
    check(snapshot.collectionIdentity === collectionIdentity(item), '快照身份始终保留实际请求的旧配置');
    check(snapshot.requestUrl === (JSON.parse(item.collectorConfig) as { priceUrl: string }).priceUrl, '审计URL仍是实际请求URL');
    const latest = await prisma.product.findUniqueOrThrow({ where: { id: item.id } });
    check(completion.result?.product.targetPrice === latest.targetPriceCents / 100 && completion.result.product.enabled === latest.enabled, '采集响应使用当前商品状态');
    return { status: 'success', price: 80, savedRecords: records.length, alertsCreated: 0, snapshotIdentityPreserved: true, currentIdentityMatchesSnapshot: collectionIdentity(latest) === snapshot.collectionIdentity, returnedEnabled: completion.result?.product.enabled, returnedTargetPrice: completion.result?.product.targetPrice, returnedPriceConfigurationCompatible: completion.result?.product.currentPriceMatchesConfiguration };
  } finally { release(); await pending; }
}

try {
  await prisma.setting.create({ data: { id: 'global', dropThresholdPercent: 5, collectionIntervalMinutes: 30 } });
  const target = await product('target');
  results.targetChanged = await duringRequest(target, () => prisma.product.update({ where: { id: target.id }, data: { targetPriceCents: 7000 } }));
  const disabled = await product('disabled');
  results.disabled = await duringRequest(disabled, () => prisma.product.update({ where: { id: disabled.id }, data: { enabled: false } }));
  const changed = await product('configuration');
  results.configurationChanged = await duringRequest(changed, () => prisma.product.update({ where: { id: changed.id }, data: { sku: 'updated-during-fetch', collectorConfig: JSON.stringify({ mode: 'json', priceUrl: `${baseUrl}/changed-not-requested`, jsonPath: 'price' }) } }));
  const global = await product('global-rule', 7000);
  // 24小时前的100元也由同一真实HTTP夹具采集，不直接改写价格数值。
  const globalPath = new URL((JSON.parse(global.collectorConfig) as { priceUrl: string }).priceUrl).pathname;
  gates.set(globalPath, { started: () => undefined, released: Promise.resolve(), price: 100 });
  const baseline = await collectProduct(global.id, 'isolated-race-baseline-fixture', new Date(Date.now() - 86400000), false);
  check(baseline.collection.price === 100, '全局阈值场景的24小时基线100元由HTTP采集产生');
  results.globalRuleChanged = await duringRequest(global, () => prisma.setting.update({ where: { id: 'global' }, data: { dropThresholdPercent: 25, collectionIntervalMinutes: 1 } }));
  const deleted = await product('deleted');
  results.deleted = await duringRequest(deleted, () => prisma.product.delete({ where: { id: deleted.id } }), true);
  check(await prisma.alert.count() === 0, '所有5项边界均无错误预警');
  const report = { passed: true, verifiedAt: new Date().toISOString(), assertions, scenarios: 5, savedCollections: await prisma.collectionRecord.count(), wrongAlerts: 0, isolatedDatabase: database, actualHttpFixture: true, productionDatabaseTouched: false, fixtureExplanation: '随机本地HTTP端口通过精确允许名单访问，响应门控真实fetch；价格仅用于隔离并发验证，不代表电商报价', results };
  await writeFile(resolve(root, 'outputs/operations-race.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await writeFile(resolve(root, 'outputs/operations-race.json'), `${JSON.stringify({ passed: false, assertions, results, isolatedDatabase: database, error: error instanceof Error ? error.stack : String(error), productionDatabaseTouched: false }, null, 2)}\n`);
  throw error;
} finally { await waitForCollectionQueues(); await prisma.$disconnect(); await new Promise<void>(done => fixture.close(() => done())); }
