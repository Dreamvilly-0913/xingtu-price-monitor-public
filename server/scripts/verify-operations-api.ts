import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
await mkdir(resolve(root, 'work/operations'), { recursive: true });
const database = resolve(root, `work/operations/auth-api-${Date.now()}.db`);
await writeFile(database, '');
process.env.DATABASE_URL = `file:${database.replaceAll('\\', '/')}`;
process.env.NODE_ENV = 'test';
process.env.DEMO_ENABLED = 'false';
process.env.BOOTSTRAP_TOKEN = 'isolated-test-token-not-a-deployment-secret';
execFileSync(process.execPath, [resolve(root, 'server/node_modules/prisma/build/index.js'), 'db', 'push', '--schema', resolve(root, 'server/prisma/schema.prisma'), '--skip-generate'], { stdio: 'pipe', env: process.env });
const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/db.js');
const { config } = await import('../src/config.js');
const { verifyBootstrapToken, securePassword } = await import('../src/auth-service.js');
const { collectProduct } = await import('../src/collection-service.js');
const bcrypt = (await import('bcrypt')).default;
let assertions = 0, requests = 0, token = '';
const check = (condition: unknown, message: string) => { assert.ok(condition, message); assertions++; };
const app = await createApp();
let fixturePrice = 100;
const fixture = createServer((_request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ price: fixturePrice })); });
await new Promise<void>(resolveListen => fixture.listen(0, '127.0.0.1', resolveListen));
const priceUrl = `http://127.0.0.1:${(fixture.address() as { port: number }).port}/price`;
process.env.HTTP_ALLOWED_HOSTS = new URL(priceUrl).host;
async function api(method: 'GET'|'POST'|'PUT'|'PATCH'|'DELETE', url: string, payload?: Record<string, unknown>, expected = 200, bearer = token) {
  const response = await app.inject({ method, url, payload, headers: bearer ? { authorization: `Bearer ${bearer}` } : {} });
  requests++;
  check(response.statusCode === expected, `${method} ${url}: ${response.statusCode} ${response.body}`);
  return { data: response.json(), response };
}
try {
  check((await api('GET', '/api/auth/status')).data.bootstrapRequired, '空库需要初始化');
  await api('POST', '/api/auth/bootstrap', { username: 'opsadmin', displayName: '隔离运营验收', password: 'short' }, 400);
  const session = (await api('POST', '/api/auth/bootstrap', { username: 'opsadmin', displayName: '隔离运营验收', password: 'Operations-Safe-2026!' }, 201)).data;
  token = session.token;
  check(!session.user.mustChangePassword, '新管理员无需修改默认密码');
  await api('POST', '/api/auth/bootstrap', { username: 'otheradmin', displayName: '隔离', password: 'Operations-Safe-2026!' }, 409);
  check(!(await api('GET', '/api/auth/status')).data.bootstrapRequired, '初始化后入口关闭');
  const initialToken = token;
  const renewed = (await api('POST', '/api/auth/change-password', { oldPassword: 'Operations-Safe-2026!', newPassword: 'Operations-Renewed-2026!' })).data;
  token = renewed.token;
  check(token !== initialToken && Boolean(token), '改密签发新会话');
  await api('GET', '/api/products', undefined, 401, initialToken);
  check((await api('GET', '/api/auth/me')).data.username === 'opsadmin', '新token继续使用');
  await api('POST', '/api/auth/login', { username: 'opsadmin', password: 'Operations-Safe-2026!' }, 401, '');
  await api('POST', '/api/auth/login', { username: 'opsadmin', password: 'Operations-Renewed-2026!' }, 200, '');
  await prisma.user.create({ data: { username: 'legacy', displayName: '旧管理员', passwordHash: await bcrypt.hash('admin123', 10) } });
  const legacy = (await api('POST', '/api/auth/login', { username: 'legacy', password: 'admin123' }, 200, '')).data;
  check(legacy.user.mustChangePassword, '运营模式默认密码强制改密');
  await api('GET', '/api/products', undefined, 403, legacy.token);
  await api('GET', '/api/settings', undefined, 200, legacy.token);
  const legacyRenewed = (await api('POST', '/api/auth/change-password', { oldPassword: 'admin123', newPassword: 'Legacy-Replaced-2026!' }, 200, legacy.token)).data;
  check(!legacyRenewed.user.mustChangePassword, '改密解除限制');
  await api('GET', '/api/products', undefined, 200, legacyRenewed.token);
  for (let count = 0; count < 5; count++) await api('POST', '/api/auth/login', { username: 'nonexistent', password: 'wrong' }, 401, '');
  const limited = await api('POST', '/api/auth/login', { username: 'nonexistent', password: 'wrong' }, 429, '');
  check(limited.response.headers['retry-after'] === '900', '限流明确返回Retry-After');
  const previousMode = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  assert.throws(() => verifyBootstrapToken('wrong'), '生产初始化凭证检查');
  assertions++;
  verifyBootstrapToken(process.env.BOOTSTRAP_TOKEN);
  assertions++;
  const previousBootstrap = config.bootstrapToken;
  config.bootstrapToken = 'replace-with-another-random-secret-at-least-32-characters';
  assert.throws(() => verifyBootstrapToken(config.bootstrapToken), /禁止示例占位值/);
  assertions++;
  config.bootstrapToken = previousBootstrap;
  process.env.NODE_ENV = previousMode;
  // 模块已导入时启动检查不会重跑，因此用独立进程验证真正的生产启动路径。
  const productionSecrets = [
    { name: '示例JWT密钥', jwt: 'replace-with-a-random-secret-at-least-32-characters', bootstrap: '', expected: 1 },
    { name: '旧演示默认JWT', jwt: 'xingtu-local-demo-secret-change-before-deploy-2026', bootstrap: '', expected: 1 },
    { name: '重复字符JWT', jwt: 'a'.repeat(48), bootstrap: '', expected: 1 },
    { name: '示例初始化凭证', jwt: randomBytes(32).toString('hex'), bootstrap: 'replace-with-another-random-secret-at-least-32-characters', expected: 1 },
    { name: '随机JWT与初始化凭证', jwt: randomBytes(32).toString('hex'), bootstrap: randomBytes(32).toString('hex'), expected: 0 },
    { name: '已初始化部署不提供初始化凭证', jwt: randomBytes(32).toString('hex'), bootstrap: '', expected: 0 },
  ];
  const secretCaseResults: { name: string; exitCode: number | null; expectedExitCode: number }[] = [];
  const configModule = pathToFileURL(resolve(root, 'server/src/config.ts')).href;
  for (const item of productionSecrets) {
    const child = spawnSync(process.execPath, [resolve(root, 'server/node_modules/tsx/dist/cli.mjs'), '--eval', `import(${JSON.stringify(configModule)})`], { cwd: resolve(root, 'server'), env: { ...process.env, NODE_ENV: 'production', JWT_SECRET: item.jwt, BOOTSTRAP_TOKEN: item.bootstrap }, encoding: 'utf8', timeout: 15_000 });
    check(child.status === item.expected, `${item.name}生产启动返回${child.status}，应为${item.expected}`);
    secretCaseResults.push({ name: item.name, exitCode: child.status, expectedExitCode: item.expected });
  }
  check(!securePassword.safeParse('中文'.repeat(18)).success, 'bcrypt超72字节密码拒绝');
  const body = { name: '隔离价格接口商品', platform: 'jd', url: priceUrl, sku: 'operations-test', category: '隔离验收', basePrice: 100, targetPrice: 90, sourceType: 'http', collectorConfig: { mode: 'json', priceUrl, jsonPath: 'price' }, enabled: true };
  const beforeRecords = await prisma.collectionRecord.count();
  const preview = (await api('POST', '/api/collectors/preview', body)).data;
  check(preview.status === 'success' && preview.price === 100 && preview.persisted === false, '真实配置试采结果');
  check(await prisma.collectionRecord.count() === beforeRecords, '试采未写价格流水');
  const product = (await api('POST', '/api/products', body, 201)).data;
  check(product.currentPrice === null, '新商品无第二套价格');
  await api('POST', `/api/products/${product.id}/collect`);
  fixturePrice = 80;
  const collected = (await api('POST', `/api/products/${product.id}/collect`)).data;
  check(collected.product.currentPrice === 80 && collected.product.currentPriceCollectedAt === collected.collection.collectedAt, '当前价格时间取成功流水');
  check((await api('GET', `/api/alerts?productId=${product.id}&status=active`)).data.total === 1, '目标预警已触发');
  const recordsBeforeEdit = await prisma.collectionRecord.count();
  await api('PUT', `/api/products/${product.id}`, { ...body, targetPrice: 70 });
  check((await api('GET', `/api/alerts?productId=${product.id}&status=active`)).data.total === 0, '改目标立即解除失效预警');
  check(await prisma.collectionRecord.count() === recordsBeforeEdit, '重评不新增价格');
  await api('POST', '/api/products', { ...body, sourceType: 'demo' }, 403);
  const summary = (await api('GET', '/api/dashboard?summaryOnly=true')).data;
  check(summary.priceTrends.length === 0, '仪表盘摘要不加载曲线');
  const dashboard = (await api('GET', `/api/dashboard?productIds=${product.id}`)).data;
  check(dashboard.priceTrends[0].statistics.currentPrice === 80, '选定曲线实时统计正确');
  for (let index = 0; index < 106; index++) await prisma.productGroup.create({ data: { name: `隔离商品组-${String(index).padStart(3,'0')}` } });
  const search = (await api('GET', '/api/groups?search=105&pageSize=10')).data;
  check(search.total === 1 && search.items[0].name.endsWith('105'), '第106组可远程查找');
  await prisma.product.createMany({ data: Array.from({ length: 105 }, (_, index) => ({ name: `分页-${index}`, platform: 'jd', url: priceUrl, sku: `page-${index}`, category: `分类-${index}`, basePriceCents: 10000, targetPriceCents: 9000, sourceType: 'http', enabled: false })) });
  const categories = (await api('GET', '/api/categories')).data.items;
  check(categories.includes('分类-104') && categories.length === 106, '分类不受前100商品截断');
  const page = (await api('GET', '/api/products?pageSize=2&page=2')).data;
  check(page.items.length === 2 && page.total === 106, '数据库分页');

  // 所有价格来自隔离HTTP夹具或DemoCollector；旧价只回填采集时间，不修改采集金额。
  const comparisonGroup = (await api('POST', '/api/groups', { name: '隔离运营比价验收' }, 201)).data;
  const staleBody = { ...body, name: '三天前最低报价', sku: 'comparison-stale', groupId: comparisonGroup.id };
  const freshBody = { ...body, name: '有效平台报价', platform: 'tmall', sku: 'comparison-fresh', groupId: comparisonGroup.id };
  const staleProduct = (await api('POST', '/api/products', staleBody, 201)).data;
  const freshProduct = (await api('POST', '/api/products', freshBody, 201)).data;
  fixturePrice = 10;
  const staleCollection = await collectProduct(staleProduct.id, 'isolated-http-time-fixture', new Date(Date.now() - 3 * 86400000));
  check(staleCollection.collection.price === 10, '旧10元确实来自HTTP采集结果');
  fixturePrice = 20;
  const freshCollection = (await api('POST', `/api/products/${freshProduct.id}/collect`)).data;
  check(freshCollection.collection.price === 20, '新20元确实来自HTTP采集结果');
  const comparison = (await api('GET', '/api/comparison')).data.groups.find((group: { id: string }) => group.id === comparisonGroup.id);
  check(comparison.cheapestProductId === freshProduct.id && comparison.cheapestPrice === 20 && comparison.cheapestPlatform === 'tmall', '常规最低字段排除三天前10元，返回有效20元');
  check(comparison.freshCheapestPrice === 20 && comparison.lastKnownCheapestPrice === 10 && comparison.lastKnownCheapestPlatform === 'jd', '有效报价与历史最后已知低价分别明确');
  check(comparison.cheapestProductIds.length === 1 && comparison.cheapestProductIds[0] === freshProduct.id, '最低价候选ID仅包含有效报价');
  check(comparison.products.find((item: { id: string }) => item.id === staleProduct.id).isPriceStale, '三天前价格显示陈旧标记');
  await api('PUT', `/api/products/${freshProduct.id}`, { ...freshBody, enabled: false });
  const disabledComparison = (await api('GET', '/api/comparison')).data.groups.find((group: { id: string }) => group.id === comparisonGroup.id);
  check(disabledComparison.cheapestPrice === null && disabledComparison.freshCheapestPrice === null, '停用20元后没有有效最低报价');
  await api('PUT', `/api/products/${freshProduct.id}`, { ...freshBody, sku: 'comparison-configuration-changed' });
  const incompatibleComparison = (await api('GET', '/api/comparison')).data.groups.find((group: { id: string }) => group.id === comparisonGroup.id);
  check(incompatibleComparison.cheapestPrice === null && !incompatibleComparison.products.find((item: { id: string }) => item.id === freshProduct.id).currentPriceMatchesConfiguration, '配置改变后的旧价不可参加有效比价');
  const recordsBeforeReadiness = await prisma.collectionRecord.count();
  await api('PUT', `/api/products/${product.id}`, { ...body, targetPrice: 70, enabled: false });
  const unready = (await api('GET', '/api/settings')).data.productionReadiness;
  check(unready.enabledRealProductCount === 2 && unready.validRealProductCount === 0, '两个启用真实商品均无有效报价');
  check(unready.blockers.some((message: string) => message.includes('无有效报价')), '系统设置准确阻止无有效报价的运营准备状态');
  await api('PUT', `/api/products/${product.id}`, { ...body, targetPrice: 70, enabled: true });
  const ready = (await api('GET', '/api/settings')).data.productionReadiness;
  check(ready.validRealProductCount === 1 && !ready.blockers.some((message: string) => message.includes('无有效报价')), '恢复一条有效真实报价后解除该阻碍');
  check(await prisma.collectionRecord.count() === recordsBeforeReadiness, '切换规则/配置/启用状态只重评，不造价格');
  const demoProduct = await prisma.product.create({ data: { name: '遗留演示预警夹具', platform: 'pdd', sku: 'demo-only-fixture', url: priceUrl, category: '隔离验收', basePriceCents: 10000, targetPriceCents: 11000, sourceType: 'demo', collectorConfig: '{}', enabled: true } });
  config.demoEnabled = true;
  try { await collectProduct(demoProduct.id, 'isolated-demo-visibility-fixture'); }
  finally { config.demoEnabled = false; }
  check(await prisma.alert.count({ where: { productId: demoProduct.id, sourceType: 'demo', resolvedAt: null } }) === 1, '隔离DemoCollector产生明确标注的演示预警');
  const visibleAlerts = (await api('GET', '/api/alerts?pageSize=100')).data;
  const visibleActiveAlerts = (await api('GET', '/api/alerts?status=active&pageSize=100')).data;
  check(visibleAlerts.items.every((item: { sourceType: string }) => item.sourceType === 'http') && visibleActiveAlerts.items.every((item: { sourceType: string }) => item.sourceType === 'http'), '运营预警列表及活动筛选只返回真实来源');
  check(!visibleAlerts.items.some((item: { productId: string }) => item.productId === demoProduct.id), '遗留演示预警不混入运营预警中心');
  check((await api('GET', '/api/audit-logs?pageSize=100')).data.items.some((item: { action: string }) => item.action.includes('change-password')), '改密与CRUD操作留审计');
  await prisma.user.delete({ where: { id: session.user.id } });
  await api('GET', '/api/products', undefined, 401);
  check(config.demoEnabled === false, '全程运营模式');
  const report = { passed: true, verifiedAt: new Date().toISOString(), requests, assertions, isolatedDatabase: database, oldTokenStatus: 401, defaultPasswordBusinessStatus: 403, rateLimitStatus: 429, previewAddedRecords: 0, actualCollectionCurrentPrice: 80, ruleEditAddedRecords: 0, laterGroupSearchFound: true, categories: categories.length, productionSecretCases: secretCaseResults, comparison: { staleLastKnownPrice: 10, validCheapestPrice: 20, validCheapestPlatform: 'tmall', staleAgeDays: 3, disabledCheapestPrice: null, incompatibleCheapestPrice: null }, readiness: { enabledWithoutValidPrice: unready.enabledRealProductCount, validBeforeRestore: 0, blockerPresent: true, validAfterRestore: ready.validRealProductCount, ruleChangesAddedPrices: 0 }, alertsVisibility: { visibleOnlyHttp: true, hiddenDemoActiveAlerts: 1, visibleAlerts: visibleAlerts.total, visibleActiveAlerts: visibleActiveAlerts.total }, fixtureExplanation: '真实HTTP采集器请求本地随机端口夹具，演示预警来自DemoCollector；全程只操作一次性SQLite，不代表电商市场报价', productionDataTouched: false };
  await writeFile(resolve(root, 'outputs/operations-api.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} catch (error) {
  await writeFile(resolve(root, 'outputs/operations-api.json'), `${JSON.stringify({ passed: false, requests, assertions, isolatedDatabase: database, error: error instanceof Error ? error.stack : String(error), productionDataTouched: false }, null, 2)}\n`);
  throw error;
} finally { await app.close(); await prisma.$disconnect(); await new Promise<void>(done => fixture.close(() => done())); }
