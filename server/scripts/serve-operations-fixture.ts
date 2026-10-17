import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 浏览器验收使用独立库及实际本地 HTTP 响应，绝不注入正式库或伪称平台报价。
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
await mkdir(resolve(root, 'work/operations'), { recursive: true });
const database = resolve(root, `work/operations/browser-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${database.replaceAll('\\', '/')}`;
process.env.NODE_ENV = 'production';
process.env.DEMO_ENABLED = 'false';
process.env.JWT_SECRET = 'isolated-browser-jwt-key-not-for-deployment-2026';
process.env.BOOTSTRAP_TOKEN = 'isolated-browser-bootstrap-token-not-for-deployment';
process.env.HTTP_ALLOWED_HOSTS = '127.0.0.1:4400';
await writeFile(database, '');
execFileSync(process.execPath, [resolve(root, 'server/node_modules/prisma/build/index.js'), 'db', 'push', '--schema', resolve(root, 'server/prisma/schema.prisma'), '--skip-generate'], { stdio: 'pipe', env: process.env });
const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/db.js');
const { HttpCollector } = await import('../src/collectors/http.js');
const { collectProduct } = await import('../src/collection-service.js');
let price = 20, staleFails = false, fixtureRequests = 0;
const prices = createServer((request, response) => {
  fixtureRequests++;
  response.setHeader('content-type', 'application/json');
  if (request.url === '/stale' && staleFails) { response.statusCode = 503; response.end(JSON.stringify({ error: 'isolated failure fixture' })); return; }
  response.end(JSON.stringify({ price: request.url === '/stale' ? 10 : price }));
});
await new Promise<void>(done => prices.listen(4400, '127.0.0.1', done));
const priceUrl = 'http://127.0.0.1:4400/price';
const data = (name: string, category: string, groupId: string, enabled = false, url = priceUrl) => ({ name, category, groupId, platform: 'jd', url, sku: name, basePriceCents: 10000, targetPriceCents: enabled ? 5000 : 500, sourceType: 'http', collectorConfig: JSON.stringify({ mode: 'json', priceUrl: url, jsonPath: 'price' }), enabled });
await prisma.setting.create({ data: { id: 'global', collectionIntervalMinutes: 30 } });
const comparisonGroup = await prisma.productGroup.create({ data: { name: '运营验收同款比价' } });
const live = await prisma.product.create({ data: data('运营验收实时商品', '实时运营验收', comparisonGroup.id, true) });
const stale = await prisma.product.create({ data: { ...data('运营验收陈旧商品', '实时运营验收', comparisonGroup.id, true, 'http://127.0.0.1:4400/stale'), platform: 'tmall', targetPriceCents: 500 } });
const collector = new HttpCollector();
async function persistHttp(product: typeof live, collectedAt: Date) {
  const result = await collector.collect({ product, collectedAt, previousPriceCents: null, demoSequence: 0, volatilityPercent: 2.5 });
  if (result.status !== 'success') throw new Error(result.failureReason ?? '本地验收采集失败');
  return prisma.collectionRecord.create({ data: { productId: product.id, sourceType: result.sourceType, sourceLabel: result.sourceLabel, collectedAt: result.collectedAt, status: result.status, priceCents: result.priceCents, failureReason: result.failureReason, collectorSnapshot: result.collectorSnapshot ?? '{}', trigger: 'isolated-http-history' } });
}
const now = new Date();
for (let day = 30; day >= 1; day--) {
  price = 20 + day / 10;
  await persistHttp(live, new Date(now.getTime() - day * 86_400_000));
}
price = 20;
await collectProduct(live.id, 'isolated-http-current');
await persistHttp(stale, new Date(now.getTime() - 72 * 3_600_000));
staleFails = true;
await collectProduct(stale.id, 'isolated-http-failure');
for (let index = 0; index < 105; index++) {
  const group = await prisma.productGroup.create({ data: { name: `历史分组${String(index).padStart(3, '0')}` } });
  await prisma.product.create({ data: data(`分类覆盖商品${index}`, `历史分类${String(index).padStart(3, '0')}`, group.id) });
}
const farGroupName = '远端第106组可检索';
const farCategory = '远端第106分类可检索';
const farGroup = await prisma.productGroup.create({ data: { name: farGroupName } });
await prisma.product.create({ data: data('远端分类验收商品', farCategory, farGroup.id) });
const app = await createApp({ serveStatic: true, startScheduler: false });
await app.listen({ port: 4399, host: '127.0.0.1' });
const manifest = { webBase: 'http://127.0.0.1:4399', apiBase: 'http://127.0.0.1:4399/api', database, liveProductId: live.id, staleProductId: stale.id, comparisonGroupId: comparisonGroup.id, farGroupId: farGroup.id, farGroupName, farCategory, priceUrl, expectedPrice: price, bootstrapToken: process.env.BOOTSTRAP_TOKEN, historyPoints: 31, fixtureRequests };
await writeFile(resolve(root, 'work/operations-browser-fixture.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log('运营浏览器隔离服务就绪：4399；价格服务4400；历史31点；不使用正式数据库。');
async function stop() { await app.close(); await prisma.$disconnect(); await new Promise<void>(done => prices.close(() => done())); }
process.once('SIGINT', () => { void stop().then(() => process.exit(0)); });
process.once('SIGTERM', () => { void stop().then(() => process.exit(0)); });
