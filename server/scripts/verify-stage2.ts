import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const directory = fileURLToPath(new URL('.', import.meta.url));
const serverRoot = directory.replace(/[\\/]dist[\\/]scripts[\\/]?$/, '').replace(/[\\/]scripts[\\/]?$/, '');
const projectRoot = resolve(serverRoot, '..');
const workDir = resolve(projectRoot, 'work', 'stage2');
await mkdir(workDir, { recursive: true });
const testDatabase = resolve(workDir, `api-${Date.now()}.db`);
// 隔离验收库：业务交付的 seed 数据不参与测试，也不会被测试写入。
await writeFile(testDatabase, '');
process.env.DATABASE_URL = `file:${testDatabase.replace(/\\/g, '/')}`;
process.env.NODE_ENV = 'test';
process.env.DEMO_ENABLED = 'true';
execFileSync(process.execPath, [resolve(serverRoot, 'node_modules/prisma/build/index.js'), 'db', 'push', '--schema', resolve(serverRoot, 'prisma/schema.prisma'), '--skip-generate'], { cwd: serverRoot, env: process.env, stdio: 'pipe' });

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/db.js');
const { collectProduct } = await import('../src/collection-service.js');
const { HttpCollector, getJsonPath } = await import('../src/collectors/http.js');
const { CollectionScheduler } = await import('../src/scheduler.js');
const { nextDemoPrice } = await import('../src/collectors/demo.js');
const { calculateStats, serializeProduct } = await import('../src/stats.js');
const bcrypt = (await import('bcrypt')).default;
await prisma.user.create({ data: { username: 'admin', displayName: '接口验收管理员', passwordHash: await bcrypt.hash('admin123', 10) } });

let fixturePrice: number | string = 100;
const fixtureServer = createServer((request, response) => {
  const path = request.url?.split('?')[0];
  if (path === '/timeout') { setTimeout(() => { if (!response.destroyed) response.end('{"price":100}'); }, 400); return; }
  if (path === '/missing') { response.writeHead(404); response.end('not found'); return; }
  if (path === '/bad-json') { response.end('<html>访问被拦截</html>'); return; }
  response.setHeader('content-type', path === '/html' ? 'text/html' : 'application/json');
  if (path === '/html') response.end('<html><span class="price">￥1,234.56</span></html>');
  else if (path === '/array') response.end(JSON.stringify([{ p: '5999.00' }]));
  else if (path === '/zero') response.end('{"price":0}');
  else if (path === '/negative') response.end('{"price":-99}');
  else if (path === '/tiny') response.end('{"price":1e-7}');
  else if (path === '/huge') response.end('{"price":1e21}');
  else if (path === '/scientific') response.end('{"price":"1e3"}');
  else if (path === '/decimal') response.end('{"price":".99"}');
  else response.end(JSON.stringify({ data: { price: fixturePrice }, price: fixturePrice }));
});
await new Promise<void>((done) => fixtureServer.listen(0, '127.0.0.1', done));
const address = fixtureServer.address();
assert.ok(address && typeof address !== 'string');
const fixtureUrl = `http://127.0.0.1:${address.port}`;
// 仅明确允许本次随机端口的本地夹具，不关闭实际采集的内网保护。
process.env.HTTP_ALLOWED_HOSTS = `127.0.0.1:${address.port}`;
const app = await createApp({ startScheduler: false });
let assertionCount = 0;
const check = (value: unknown, message: string) => { assert.ok(value, message); assertionCount++; };
let token = '';
let apiRequests = 0;
async function api(method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH', url: string, body?: unknown, expected = 200, authenticated = true) {
  const response = await app.inject({ method, url, ...(body != null ? { payload: JSON.stringify(body) } : {}), headers: { ...(authenticated && token ? { authorization: `Bearer ${token}` } : {}), ...(body != null ? { 'content-type': 'application/json' } : {}) } });
  apiRequests++;
  assert.equal(response.statusCode, expected, `${method} ${url}: ${response.body}`);
  assertionCount++;
  return response.json();
}
const productBody = (name: string, platform = 'jd', extra: Record<string, unknown> = {}) => ({ name, platform, url: `${fixtureUrl}/json`, sku: `test-${name}`, category: '接口验收', basePrice: 100, targetPrice: 90, sourceType: 'demo', collectorConfig: {}, enabled: true, ...extra });

try {
  await api('GET', '/api/health', undefined, 200, false);
  await api('GET', '/api/products', undefined, 401, false);
  await api('POST', '/api/auth/login', { username: 'admin', password: 'incorrect' }, 401, false);
  token = (await api('POST', '/api/auth/login', { username: 'admin', password: 'admin123' }, 200, false)).token;
  check((await api('GET', '/api/auth/me')).username === 'admin', 'JWT 身份查询正确');
  const group = await api('POST', '/api/groups', { name: '验收同款组' }, 201);
  await api('PUT', `/api/groups/${group.id}`, { name: '验收同款组（更新）' });
  await api('POST', '/api/groups', { name: '验收同款组（更新）' }, 409);
  const demoBody = productBody('演示验收商品', 'jd', { groupId: group.id });
  const demoProduct = await api('POST', '/api/products', demoBody, 201);
  check(demoProduct.currentPrice === null, '新商品无采集记录时当前价为空');
  const first = await api('POST', `/api/products/${demoProduct.id}/collect`);
  const second = await api('POST', `/api/products/${demoProduct.id}/collect`);
  const movement = (second.product.currentPrice - first.product.currentPrice) / first.product.currentPrice * 100;
  check(first.collection.status === 'success' && second.collection.status === 'success', '演示采集成功');
  check(first.product.currentPrice !== second.product.currentPrice && Math.abs(movement) <= 3, '两次演示采集价格改变且幅度≤3%');
  check(second.product.currentPrice === second.collection.price && second.collection.sourceLabel === '演示模拟', '演示来源和最新价一致');
  await api('PUT', `/api/products/${demoProduct.id}`, { ...demoBody, basePrice: 1 }, 400);
  await api('POST', '/api/products', { ...demoBody, basePrice: 0 }, 400);
  await api('GET', '/api/products?page=0', undefined, 400);
  await api('GET', '/api/products?platform=invalid', undefined, 400);
  await api('GET', '/api/products/not-found', undefined, 404);
  const detail = await api('GET', `/api/products/${demoProduct.id}?days=30`);
  check(detail.history.length === 2 && detail.history.at(-1).price === second.product.currentPrice && detail.statistics.currentPrice === second.product.currentPrice, '详情曲线最新点、列表当前价、统计同步');
  await api('GET', `/api/products/${demoProduct.id}?days=7`);
  await api('GET', `/api/products/${demoProduct.id}?days=90`);
  await api('GET', `/api/products/${demoProduct.id}?days=14`, undefined, 400);

  const httpBody = productBody('真实接口测试商品', 'tmall', { groupId: group.id, sourceType: 'http', collectorConfig: { mode: 'json', priceUrl: `${fixtureUrl}/json`, jsonPath: 'data.price' } });
  const httpProduct = await api('POST', '/api/products', httpBody, 201);
  fixturePrice = 100;
  const baseline = await collectProduct(httpProduct.id, 'verification-fixture', new Date(Date.now() - 24 * 3_600_000));
  check(baseline.collection.price === 100, '24 小时前基线价格通过隔离本地 HTTP 采集器写入');
  fixturePrice = 80;
  const alertCollection = await api('POST', `/api/products/${httpProduct.id}/collect`);
  check(alertCollection.alertsCreated.length === 2, '目标价与24小时跌幅规则均触发');
  check(alertCollection.alertsCreated.some((alert: { rule: string }) => alert.rule === 'target') && alertCollection.alertsCreated.some((alert: { rule: string }) => alert.rule === 'drop24h'), '两种预警规则完整');
  const duplicate = await api('POST', `/api/products/${httpProduct.id}/collect`);
  check(duplicate.alertsCreated.length === 0, '未处理期间重复预警被阻止');
  const unread = await api('GET', `/api/alerts?productId=${httpProduct.id}&status=unread`);
  check(unread.total === 2, '预警列表返回两条未读记录');
  await api('PATCH', `/api/alerts/${unread.items[0].id}/read`);
  const allRead = await api('POST', '/api/alerts/read-all');
  check(allRead.updatedCount === 1, '批量已读处理剩余一条');
  fixturePrice = 100;
  await api('POST', `/api/products/${httpProduct.id}/collect`);
  check((await api('GET', `/api/alerts?productId=${httpProduct.id}&status=active`)).total === 0, '价格恢复后预警自动解除');
  fixturePrice = 80;
  const cooled = await api('POST', `/api/products/${httpProduct.id}/collect`);
  check(cooled.alertsCreated.length === 0, '已读并恢复后24小时冷却仍拦截重复预警');
  const comparison = await api('GET', '/api/comparison');
  const comparisonGroup = comparison.groups.find((item: { id: string }) => item.id === group.id);
  check(comparisonGroup.cheapestProductId === httpProduct.id && comparisonGroup.cheapestPlatform === 'tmall' && comparisonGroup.cheapestPrice === 80, '同组最低价平台是天猫且价格80');

  const collector = new HttpCollector();
  const collectorTestCases = [
    { path: '/array', jsonPath: '$[0].p', expected: 5999 }, { path: '/html', mode: 'html', selector: '.price', expected: 1234.56 },
    { path: '/scientific', expected: 1000 }, { path: '/decimal', expected: 0.99 },
    { path: '/zero', failure: true }, { path: '/negative', failure: true }, { path: '/tiny', failure: true }, { path: '/huge', failure: true },
    { path: '/bad-json', failure: true }, { path: '/missing', failure: true }, { path: '/timeout', failure: true, timeoutMs: 100 },
    { path: '/json', jsonPath: 'missing.path', failure: true }, { path: '/html', mode: 'html', selector: '.absent', failure: true },
  ];
  const collectorReports = [];
  check(getJsonPath([{ p: '5999.00' }], '$[0].p') === '5999.00', '京东默认JSON路径可解析');
  for (const test of collectorTestCases) {
    const result = await collector.collect({ product: { id: 'fixture-only', platform: 'jd', url: `${fixtureUrl}/json`, sku: 'fixture', basePriceCents: 10000, collectorConfig: JSON.stringify({ mode: test.mode ?? 'json', priceUrl: `${fixtureUrl}${test.path}`, jsonPath: test.jsonPath ?? 'price', cssSelector: test.selector, timeoutMs: test.timeoutMs }) }, collectedAt: new Date(), previousPriceCents: null, demoSequence: 0, volatilityPercent: 2.5 });
    if (test.failure) check(result.status === 'failure' && result.priceCents === null && Boolean(result.failureReason), `${test.path} 如实失败且无价格`);
    else check(result.status === 'success' && result.priceCents! / 100 === test.expected, `${test.path} 正确解析金额`);
    collectorReports.push({ path: test.path, status: result.status, price: result.priceCents == null ? null : result.priceCents / 100, failureReason: result.failureReason });
  }
  // 价格取自已经落库的本地 HTTP 采集结果，仅重组元数据验证同一时刻的排序，不改动数据库。
  const samples = await prisma.collectionRecord.findMany({ where: { productId: httpProduct.id, status: 'success' } });
  const sampledHigh = samples.find(record => record.priceCents === 10000)!;
  const sampledLow = samples.find(record => record.priceCents === 8000)!;
  const sharedTime = new Date('2026-10-01T04:00:00.000Z');
  const tiedByWriteTime = [
    { ...sampledLow, id: 'a-low', collectedAt: sharedTime, createdAt: new Date(sharedTime.getTime() + 1) },
    { ...sampledHigh, id: 'z-high', collectedAt: sharedTime, createdAt: sharedTime },
  ];
  const tiedById = [
    { ...sampledLow, id: 'z-low', collectedAt: sharedTime, createdAt: sharedTime },
    { ...sampledHigh, id: 'a-high', collectedAt: sharedTime, createdAt: sharedTime },
  ];
  const sampledProduct = await prisma.product.findUniqueOrThrow({ where: { id: httpProduct.id } });
  for (const records of [tiedByWriteTime, tiedById]) {
    const statistics = calculateStats(records);
    check(statistics.currentPrice === 80, '同一采集时刻按写入时间及ID确定最新价');
    check(statistics.maxDrawdownPercent === 20, '同一采集时刻的最大回撤按统一顺序计算');
    check(serializeProduct({ ...sampledProduct, collections: records }).currentPrice === statistics.currentPrice, '商品序列化与同刻统计使用相同顺序');
  }
  const pendingCollectorRecords = [sampledHigh, sampledLow].map(record => ({ status: record.status, priceCents: record.priceCents, collectedAt: sharedTime, sourceLabel: record.sourceLabel }));
  check(calculateStats(pendingCollectorRecords).currentPrice === 80, '尚未入库的采集结果缺省写入元数据时保留稳定顺序');
  check(calculateStats(pendingCollectorRecords).maxDrawdownPercent === 20, '缺省元数据时仍能复算种子顺序的最大回撤');
  const failBody = { ...demoBody, sourceType: 'http', collectorConfig: { mode: 'json', priceUrl: 'http://127.0.0.1:1/always-fail', jsonPath: 'price', timeoutMs: 1000 } };
  await api('PUT', `/api/products/${demoProduct.id}`, failBody);
  const failure1 = await api('POST', `/api/products/${demoProduct.id}/collect`);
  const failure2 = await api('POST', `/api/products/${demoProduct.id}/collect`);
  check(failure1.collection.status === 'failure' && failure2.collection.status === 'failure' && Boolean(failure2.collection.failureReason), '必败地址两次失败，原因落库');
  check(failure2.product.consecutiveFailures === 2 && failure2.product.currentPrice === second.product.currentPrice, '连续失败2次且保留最后成功价');
  check(failure2.product.sourceLabel === '演示模拟' && failure2.product.configuredSourceLabel === '真实采集' && failure2.collection.sourceLabel === '真实采集', '切换数据源后旧价来源与失败记录来源分别正确');
  const failingList = await api('GET', '/api/products?status=failing');
  check(failingList.total === 1 && failingList.items[0].id === demoProduct.id, '失败状态筛选正确');
  const failedRecords = await api('GET', `/api/collections?productId=${demoProduct.id}&status=failure`);
  check(failedRecords.total === 2 && failedRecords.items.every((item: { price: unknown; failureReason: string }) => item.price === null && item.failureReason), '失败流水没有编造价格');
  const disabled = await api('POST', '/api/products', productBody('停用验收商品', 'pdd', { enabled: false }), 201);
  const healthy = await api('POST', '/api/products', productBody('继续调度验收商品', 'pdd'), 201);
  const run = await api('POST', '/api/scheduler/run');
  check(run.total === 3 && run.successCount === 2 && run.failureCount === 1, '调度失败不中断，3启用品中2成功1失败');
  check((await prisma.collectionRecord.count({ where: { productId: disabled.id } })) === 0, '停用商品未参加调度');
  check((await api('GET', `/api/products/${healthy.id}`)).product.currentPrice != null, '失败商品之后的演示商品仍采集成功');
  check((await api('GET', '/api/scheduler/runs')).total === 1, '采集轮次已保存');
  const list = await api('GET', '/api/products?page=1&pageSize=2');
  check(list.items.length === 2 && list.total === 4, '商品分页2/4正确');
  check((await api('GET', '/api/products?platform=pdd&category=接口验收&status=disabled')).total === 1, '平台分类状态组合筛选正确');
  const settings = await api('GET', '/api/settings');
  check(settings.collectionIntervalMinutes === 30 && settings.dropThresholdPercent === 5 && settings.demoVolatilityPercent === 2.5 && settings.dataSources.length === 2, '默认设置与双轨说明正确');
  await api('PUT', '/api/settings', { collectionIntervalMinutes: 7, demoVolatilityPercent: 3, dropThresholdPercent: 8 });
  check((await api('GET', '/api/settings')).collectionIntervalMinutes === 7, '任意7分钟采集间隔保存成功');
  const priorDemoRecords = await prisma.collectionRecord.findMany({ where: { sourceType: 'demo', status: 'success' } });
  for (const record of priorDemoRecords) {
    const snapshot = JSON.parse(record.collectorSnapshot) as Parameters<typeof nextDemoPrice>[0];
    check(nextDemoPrice(snapshot) === record.priceCents, '变更波动率后历史点仍可按快照复算');
  }
  await api('PUT', '/api/settings', { collectionIntervalMinutes: 0, demoVolatilityPercent: 4, dropThresholdPercent: 5 }, 400);
  const scheduler = new CollectionScheduler();
  const anchor = new Date(Date.now() - 8 * 60_000);
  await prisma.setting.update({ where: { id: 'global' }, data: { lastScheduledAt: anchor } });
  const dueRun = await scheduler.tick();
  check(dueRun?.total === 3 && dueRun.failureCount === 1 && dueRun.successCount === 2, '持久化到期时间触发7分钟调度');
  check(await scheduler.tick() === null, '同一周期不重复调度');
  const savedAnchor = (await prisma.setting.findUniqueOrThrow({ where: { id: 'global' } })).lastScheduledAt;
  const restarted = new CollectionScheduler();
  await restarted.start();
  check((await prisma.setting.findUniqueOrThrow({ where: { id: 'global' } })).lastScheduledAt?.getTime() === savedAnchor?.getTime(), '调度器重启保留上次调度时间');
  await restarted.stop();
  const dashboard = await api('GET', '/api/dashboard');
  check(dashboard.monitoredProductCount === 4 && dashboard.enabledProductCount === 3, '仪表盘监控/启用数量正确');
  for (const product of dashboard.products) {
    const latest = await prisma.collectionRecord.findFirst({ where: { productId: product.id, status: 'success' }, orderBy: [{ collectedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }] });
    check(product.currentPrice === (latest?.priceCents == null ? null : latest.priceCents / 100), '所有仪表盘当前价等于最新成功采集记录');
  }
  await api('POST', '/api/auth/change-password', { oldPassword: 'incorrect', newPassword: 'new-admin-123' }, 400);
  const changedPassword = await api('POST', '/api/auth/change-password', { oldPassword: 'admin123', newPassword: 'new-admin-123' });
  await api('GET', '/api/auth/me', undefined, 401);
  token = changedPassword.token;
  await api('POST', '/api/auth/login', { username: 'admin', password: 'admin123' }, 401, false);
  token = (await api('POST', '/api/auth/login', { username: 'admin', password: 'new-admin-123' }, 200, false)).token;
  check(Boolean(token), '管理员新密码登录成功且旧会话撤销');
  const currentGroups = await api('GET', '/api/groups');
  check(currentGroups.items[0].productCount === 2, '商品组数量正确');
  await api('DELETE', `/api/groups/${group.id}`);
  check((await api('GET', `/api/products/${httpProduct.id}`)).product.groupId === null, '删除商品组后商品保留并清空分组');
  await api('DELETE', `/api/products/${disabled.id}`);
  await api('DELETE', `/api/products/${disabled.id}`, undefined, 404);
  const report = { passed: true, apiRequests, assertionCount, testDatabase, fixtureExplanation: '真实采集器通过本地 HTTP 测试夹具验证 JSON/网页/异常；这些价格不代表电商市场价格，交付演示库未受影响。', demo: { firstPrice: first.product.currentPrice, secondPrice: second.product.currentPrice, movementPercent: Number(movement.toFixed(6)), limitPercent: 3 }, alerts: { baselinePrice: 100, compressedPrice: 80, dropPercent24h: 20, createdCount: 2, duplicateCreatedCount: duplicate.alertsCreated.length, cooldownCreatedCount: cooled.alertsCreated.length, remainingActiveAfterRecovery: 0 }, collectorCases: collectorReports, failure: { reason: failure2.collection.failureReason, consecutiveFailures: 2, unchangedCurrentPrice: failure2.product.currentPrice, oldPriceSource: failure2.product.sourceLabel, configuredSource: failure2.product.configuredSourceLabel }, scheduler: { manualRun: run, dueRun, nonRepeat: true, restartAnchorPreserved: true }, comparison: { cheapestPlatform: comparisonGroup.cheapestPlatform, cheapestPrice: comparisonGroup.cheapestPrice }, pagination: { pageSize: 2, returned: list.items.length, total: list.total }, seedDatabaseUntouched: true };
  await mkdir(resolve(projectRoot, 'outputs'), { recursive: true });
  await writeFile(process.env.VERIFICATION_OUTPUT_PATH ?? resolve(projectRoot, 'outputs/stage2-current-verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await app.close(); await prisma.$disconnect(); await new Promise<void>((done) => fixtureServer.close(() => done())); }
