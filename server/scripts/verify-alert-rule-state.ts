import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CollectionRecord, Prisma, Product } from '@prisma/client';

const serverRoot = dirname(fileURLToPath(import.meta.url)).replace(/[\\/]dist[\\/]scripts$/, '').replace(/[\\/]scripts$/, '');
const projectRoot = resolve(serverRoot, '..');
const workDir = resolve(projectRoot, 'work', 'alert-rule-state');
await mkdir(workDir, { recursive: true });
const database = resolve(workDir, `rule-state-${Date.now()}.db`);
await writeFile(database, '');
process.env.DATABASE_URL = `file:${database.replace(/\\/g, '/')}`;
process.env.NODE_ENV = 'test';
process.env.DEMO_ENABLED = 'true';
execFileSync(process.execPath, [resolve(serverRoot, 'node_modules/prisma/build/index.js'), 'db', 'push', '--schema', resolve(serverRoot, 'prisma/schema.prisma'), '--skip-generate'], { cwd: serverRoot, env: process.env, stdio: 'pipe' });

const { prisma } = await import('../src/db.js');
const { evaluateAlerts, initializeAlertStates, reconcileProductAlerts, expireInvalidActiveAlerts } = await import('../src/alerts.js');
const { collectionIdentity } = await import('../src/collection-identity.js');
const { serializeAlert } = await import('../src/serializers.js');
const { loadProductDto } = await import('../src/stats.js');
const { getDashboard } = await import('../src/dashboard.js');
const { config } = await import('../src/config.js');
const { createApp } = await import('../src/app.js');
const { tokenPayload } = await import('../src/auth-service.js');
const base = new Date(Date.now() - 30 * 60_000);
let assertions = 0, requests = 0, productSequence = 0, recordSequence = 0;
const results: Record<string, unknown> = {};
const equal = (actual: unknown, expected: unknown, description: string) => { assert.deepEqual(actual, expected, description); assertions++; };
const check = (condition: unknown, description: string) => { assert.ok(condition, description); assertions++; };
const at = (minutes: number) => new Date(base.getTime() + minutes * 60_000);

async function product(overrides: Partial<Prisma.ProductCreateInput> = {}) {
  return prisma.product.create({ data: { id: `rule-product-${++productSequence}`, name: `规则状态隔离夹具 ${productSequence}`, platform: 'jd', sku: `rule-${productSequence}`, url: 'https://example.com/item', category: '隔离回归夹具', basePriceCents: 10000, targetPriceCents: 9000, sourceType: 'http', collectorConfig: JSON.stringify({ priceUrl: 'https://example.com/price', jsonPath: 'price' }), enabled: true, ...overrides } });
}
async function price(item: Product, cents: number, collectedAt: Date) {
  // 人工价格仅写一次性验证库，快照和触发方式明确标注夹具；不伪装真实市场报价。
  return prisma.collectionRecord.create({ data: { id: `rule-record-${String(++recordSequence).padStart(6, '0')}`, productId: item.id, sourceType: item.sourceType, sourceLabel: item.sourceType === 'demo' ? '演示模拟' : '真实采集', status: 'success', priceCents: cents, collectedAt, collectorSnapshot: JSON.stringify({ collectionIdentity: collectionIdentity(item), isolatedVerificationFixture: true }), trigger: 'isolated-verification-fixture' } });
}
async function evaluate(item: Product, record: CollectionRecord, evaluatedAt = record.collectedAt) {
  return prisma.$transaction(tx => evaluateAlerts(tx, item, record, 5, 30, evaluatedAt));
}
const state = (productId: string, rule = 'target') => prisma.alertRuleState.findUniqueOrThrow({ where: { productId_rule: { productId, rule } } });

const app = await createApp({ startScheduler: false, serveStatic: false });
const user = await prisma.user.create({ data: { username: 'rule-state-verifier', displayName: '隔离验证账户', passwordHash: 'not-used-for-login', mustChangePassword: false } });
const headers = { authorization: `Bearer ${app.jwt.sign(tokenPayload(user))}` };
async function api(url: string, method: 'GET' | 'PATCH' = 'GET') {
  const response = await app.inject({ method, url, headers });
  requests++;
  equal(response.statusCode, 200, `${method} ${url} HTTP 200`);
  return response.json();
}

try {
  await prisma.setting.upsert({ where: { id: 'global' }, create: { id: 'global', collectionIntervalMinutes: 30 }, update: {} });
  const target = await product();
  const trigger = await price(target, 8000, at(0));
  const first = await evaluate(target, trigger);
  equal(first.length, 1, '80 达到 90 目标价创建一个提醒');
  equal(serializeAlert(first[0]!).isActive, true, '立即采集返回的提醒携带当前规则状态');
  equal((await state(target.id)).active, true, '第一次达标当前规则 active=true');
  equal((await getDashboard(at(0), { summaryOnly: true })).activeAlertCount, 1, '仪表盘首次达标规则计数 1');
  const original = first[0]!;
  const recovery = await price(target, 9500, at(1));
  equal((await evaluate(target, recovery)).length, 0, '95 恢复价格不创建提醒');
  equal((await state(target.id)).active, false, '恢复后当前规则 active=false');
  equal((await getDashboard(at(1), { summaryOnly: true })).activeAlertCount, 0, '仪表盘恢复后计数 0');
  const resolvedAt = (await prisma.alert.findUniqueOrThrow({ where: { id: original.id } })).resolvedAt!.toISOString();
  const reentry = await price(target, 8000, at(2));
  equal((await evaluate(target, reentry)).length, 0, '80 冷却期间重入不新增提醒');
  const reentryState = await state(target.id);
  equal(reentryState.active, true, '冷却重入当前规则 active=true');
  equal(reentryState.activeSince?.toISOString(), at(2).toISOString(), '重入时间为本次达标时间');
  equal(reentryState.collectionRecordId, reentry.id, '规则引用真实最新成功流水');
  equal(await prisma.alert.count({ where: { productId: target.id } }), 1, '80→95→80 保持一个历史提醒');
  equal((await getDashboard(at(2), { summaryOnly: true })).activeAlertCount, 1, '仪表盘冷却重入计数恢复 1');
  const stored = await prisma.alert.findUniqueOrThrow({ where: { id: original.id }, include: { currentRuleState: true } });
  equal(stored.resolvedAt?.toISOString(), resolvedAt, '原提醒解除时间未改写');
  equal(stored.triggeredAt.toISOString(), at(0).toISOString(), '原提醒触发时间未改写');
  equal(stored.priceCents, 8000, '原提醒触发价未改写');
  equal(serializeAlert(stored).isActive, true, '已解除历史提醒可关联当前冷却重入状态');
  const activeBeforeRead = await api(`/api/alerts?status=active&productId=${target.id}`);
  equal(activeBeforeRead.total, 1, '触发中筛选返回原真实提醒');
  equal(activeBeforeRead.activeRuleCount, 1, '触发中筛选返回当前规则数');
  equal(activeBeforeRead.items[0].id, original.id, '触发中筛选没有伪造提醒 ID');
  equal(activeBeforeRead.items[0].isActive, true, '触发中筛选 DTO isActive=true');
  check(Boolean(activeBeforeRead.items[0].resolvedAt), '触发中提醒仍保留原解除时间');
  const read = await api(`/api/alerts/${original.id}/read`, 'PATCH');
  equal(read.isActive, true, '标记已读返回当前仍触发');
  check(Boolean(read.readAt), '已读时间落库');
  equal((await state(target.id)).active, true, '标记已读不改变当前规则');
  const ongoing = await price(target, 8500, at(3));
  equal((await evaluate(target, ongoing)).length, 0, '已读但在冷却中不创建新提醒');
  const currentDto = await api(`/api/alerts?status=active&productId=${target.id}`);
  equal(currentDto.items[0].price, 80, '提醒原触发价保持 80');
  equal(currentDto.items[0].activePrice, 85, '提醒当前规则价为最新成功采集的 85');
  equal(currentDto.currentRules[0].price, 85, '当前规则表价为 85');
  equal((await loadProductDto(target.id, at(3))).currentPrice, 85, '商品 currentPrice 与规则当前价一致');
  const detail = await api(`/api/products/${target.id}`);
  equal(detail.currentRules[0].price, 85, '详情当前规则价与流水一致');
  equal(detail.alerts[0].price, 80, '详情保留原触发价');
  equal(detail.alerts[0].isActive, true, '详情当前触发状态来自 State');
  const later = await price(target, 8000, at(1441));
  const laterAlerts = await evaluate(target, later);
  const laterTarget = laterAlerts.filter(alert => alert.rule === 'target');
  equal(laterTarget.length, 1, '已读提醒超过 24 小时后允许新目标提醒');
  equal(await prisma.alert.count({ where: { productId: target.id, rule: 'target' } }), 2, '冷却期结束后历史目标提醒数 2');
  equal((await state(target.id)).lastAlertId, laterTarget[0]!.id, '当前规则关联新的真实目标提醒');
  equal((await prisma.alert.findUniqueOrThrow({ where: { id: original.id } })).resolvedAt?.toISOString(), resolvedAt, '新提醒不覆盖原解除时间');
  results.targetReentry = { prices: [80, 95, 80], activeCounts: [1, 0, 1], alertsDuringCooldown: 1, originalPrice: 80, laterCurrentPrice: 85, readKeepsActive: true, notificationsAfter24Hours: 2 };

  const drop = await product({ targetPriceCents: 1000 });
  await price(drop, 10000, at(-1440));
  const drop80 = await price(drop, 8000, at(0));
  equal((await evaluate(drop, drop80)).length, 1, '24 小时跌幅 20% 创建提醒');
  equal((await state(drop.id, 'drop24h')).active, true, '跌幅规则首次触发');
  const dropAlert = await prisma.alert.findFirstOrThrow({ where: { productId: drop.id, rule: 'drop24h' } });
  const drop99 = await price(drop, 9900, at(1));
  equal((await evaluate(drop, drop99)).length, 0, '跌幅恢复不创建提醒');
  equal((await state(drop.id, 'drop24h')).active, false, '跌幅恢复解除当前规则');
  const dropAgain = await price(drop, 8000, at(2));
  equal((await evaluate(drop, dropAgain)).length, 0, '跌幅冷却重入无新提醒');
  equal((await state(drop.id, 'drop24h')).active, true, '跌幅冷却重入当前规则恢复');
  equal(await prisma.alert.count({ where: { productId: drop.id } }), 1, '跌幅重入历史提醒不重复');
  const dropState = await state(drop.id, 'drop24h');
  equal(dropState.baselinePriceCents, 10000, '跌幅当前状态保留真实 24 小时基线');
  const dropResult = await api(`/api/alerts?status=active&productId=${drop.id}`);
  equal(dropResult.items[0].id, dropAlert.id, '跌幅重入关联原提醒');
  equal(dropResult.items[0].isActive, true, '跌幅重入 DTO 当前触发');
  results.dropReentry = { baseline: 100, prices: [80, 99, 80], active: [true, false, true], notifications: 1 };

  const refresh = await product();
  const old80 = await price(refresh, 8000, at(0));
  await evaluate(refresh, old80);
  await expireInvalidActiveAlerts(at(91));
  equal((await state(refresh.id)).active, false, '陈旧报价使规则过期');
  const samePriceNew = await price(refresh, 8000, new Date(at(91).getTime() - 1000));
  equal((await evaluate(refresh, samePriceNew)).length, 0, '同价新点在冷却中不新增提醒');
  equal((await state(refresh.id)).active, true, '同价新点即使早于最近重评 1 秒仍恢复当前规则');
  equal((await state(refresh.id)).collectionRecordId, samePriceNew.id, '同价恢复引用新的成功记录 ID');
  equal((await loadProductDto(refresh.id, at(91))).currentPrice, 80, '同价恢复与商品最新成功价一致');
  await evaluate(refresh, old80);
  equal((await state(refresh.id)).collectionRecordId, samePriceNew.id, '迟到旧点不会覆盖最新规则');
  equal((await state(refresh.id)).active, true, '迟到旧点不会解除已恢复规则');
  results.quoteRefresh = { expiredAtMinutes: 91, samePrice: 80, newRecordRestored: true, oldRecordIgnored: true };

  const switcher = await product({ sourceType: 'demo', collectorConfig: '{}' });
  await evaluate(switcher, await price(switcher, 8000, at(0)));
  const switched = await prisma.product.update({ where: { id: switcher.id }, data: { sourceType: 'http', collectorConfig: JSON.stringify({ priceUrl: 'https://example.com/price', jsonPath: 'price' }) } });
  const switchedAlerts = await evaluate(switched, await price(switched, 8000, at(1)));
  equal(switchedAlerts.length, 1, '旧演示提醒不阻止真实源首次提醒');
  equal(switchedAlerts[0]!.sourceType, 'http', '切换后提醒来源明确为真实采集');
  equal(await prisma.alert.count({ where: { productId: switcher.id, sourceType: 'demo', resolvedAt: null } }), 0, '来源切换归档旧演示提醒');
  const changed = await prisma.product.update({ where: { id: switcher.id }, data: { sku: 'changed-sku' } });
  const countBeforeReconcile = await prisma.collectionRecord.count();
  await reconcileProductAlerts(changed.id, at(2));
  equal((await state(changed.id)).active, false, '配置变更后旧口径报价不触发当前规则');
  equal(await prisma.collectionRecord.count(), countBeforeReconcile, '配置重评不产生价格');
  const changedAlerts = await evaluate(changed, await price(changed, 8000, at(3)));
  equal(changedAlerts.length, 1, '新 SKU 口径不受旧 SKU 冷却阻止');
  equal((await state(changed.id)).collectionIdentity, collectionIdentity(changed), '当前规则采用新采集身份');
  results.sourceIsolation = { demoToHttpNewNotifications: 1, newSkuNotifications: 1, mismatchedQuoteActive: false, reconcileAddedRecords: 0 };

  const legacy = await product();
  await price(legacy, 8000, at(4));
  await price(legacy, 9500, at(5));
  await price(legacy, 8000, at(6));
  const legacyAlert = await prisma.alert.create({ data: { productId: legacy.id, rule: 'target', priceCents: 8000, threshold: 90, message: '真实采集：隔离旧版本提醒夹具', sourceType: 'http', sourceLabel: '真实采集', triggeredAt: at(4), resolvedAt: at(5) } });
  const noNotification = await product();
  await price(noNotification, 8000, at(6));
  const beforeInitialize = { prices: await prisma.collectionRecord.count(), alerts: await prisma.alert.count() };
  const initialized = await initializeAlertStates(at(7));
  equal(await prisma.collectionRecord.count(), beforeInitialize.prices, '旧库回填不产生价格记录');
  equal(await prisma.alert.count(), beforeInitialize.alerts, '旧库回填不产生历史提醒');
  equal((await state(legacy.id)).active, true, '旧库已解除提醒在冷却重入时回填当前触发');
  equal((await state(legacy.id)).lastAlertId, legacyAlert.id, '旧库回填关联真实旧提醒');
  equal((await prisma.alert.findUniqueOrThrow({ where: { id: legacyAlert.id } })).collectionIdentity, collectionIdentity(legacy), '可核对的旧提醒回填采集身份');
  equal((await prisma.alert.findUniqueOrThrow({ where: { id: legacyAlert.id } })).resolvedAt?.toISOString(), at(5).toISOString(), '回填保留旧提醒解除时间');
  equal((await state(noNotification.id)).active, true, '无历史提醒但满足条件的旧库仍展示当前规则');
  equal((await state(noNotification.id)).lastAlertId, null, '无历史提醒的规则不伪造提醒 ID');
  const noNotificationApi = await api(`/api/alerts?status=active&productId=${noNotification.id}`);
  equal(noNotificationApi.total, 0, '无历史提醒的 active 筛选真实流水数为 0');
  equal(noNotificationApi.activeRuleCount, 1, '无历史提醒的 active 当前规则数为 1');
  equal(noNotificationApi.currentRules[0].price, 80, '无提醒当前规则仍使用已有真实成功价');
  await initializeAlertStates(at(7));
  equal(await prisma.alert.count(), beforeInitialize.alerts, '重复初始化幂等且不增加提醒');
  equal(await prisma.collectionRecord.count(), beforeInitialize.prices, '重复初始化不增加价格');
  results.legacyInitialization = { ...initialized, addedPrices: 0, addedNotifications: 0, activeWithoutNotification: true, repeatedInitializationIdempotent: true };

  const disabledDemo = await product({ sourceType: 'demo', collectorConfig: '{}' });
  await evaluate(disabledDemo, await price(disabledDemo, 8000, at(8)));
  config.demoEnabled = false;
  await expireInvalidActiveAlerts(at(8));
  equal((await state(disabledDemo.id)).active, false, '运营模式解除演示规则');
  equal((await getDashboard(at(8), { summaryOnly: true })).activeAlertCount, await prisma.alertRuleState.count({ where: { active: true, sourceType: 'http', product: { sourceType: 'http' } } }), '运营模式仪表盘仅计真实规则');
  config.demoEnabled = true;
  const beforeDisable = await prisma.collectionRecord.count();
  await prisma.product.update({ where: { id: noNotification.id }, data: { enabled: false } });
  await reconcileProductAlerts(noNotification.id, at(8));
  equal((await state(noNotification.id)).active, false, '关闭监控解除当前规则');
  equal(await prisma.collectionRecord.count(), beforeDisable, '关闭监控重评不生成价格');
  results.invalidSourceAndDisabled = { demoRulesDisabledInOperations: true, disabledProductActive: false, generatedPrices: 0 };

  const report = { status: 'passed', generatedAt: new Date().toISOString(), assertions, requests, isolation: '一次性 SQLite；所有人工点标注隔离验证夹具，未访问真实价格接口，未写正式实例', database, results };
  await mkdir(resolve(projectRoot, 'outputs'), { recursive: true });
  await writeFile(process.env.VERIFICATION_OUTPUT_PATH ?? resolve(projectRoot, 'outputs/alert-rule-state-verification.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report, null, 2));
} finally { config.demoEnabled = true; await app.close(); await prisma.$disconnect(); }
