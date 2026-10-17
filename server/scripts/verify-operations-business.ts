import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CollectionRecord, Prisma, Product } from '@prisma/client';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const serverRoot = scriptDir.replace(/[\\/]dist[\\/]scripts$/, '').replace(/[\\/]scripts$/, '');
const projectRoot = resolve(serverRoot, '..');
const workDir = resolve(projectRoot, 'work', 'operations-business');
await mkdir(workDir, { recursive: true });
const database = resolve(workDir, `business-${Date.now()}.db`);
await writeFile(database, '');
process.env.DATABASE_URL = `file:${database.replace(/\\/g, '/')}`;
process.env.NODE_ENV = 'test';
process.env.DEMO_ENABLED = 'true';
execFileSync(process.execPath, [resolve(serverRoot, 'node_modules/prisma/build/index.js'), 'db', 'push', '--schema', resolve(serverRoot, 'prisma/schema.prisma'), '--skip-generate'], { cwd: serverRoot, env: process.env, stdio: 'pipe' });

const { prisma } = await import('../src/db.js');
const { calculateStats, loadProductDto, priceFreshness } = await import('../src/stats.js');
const { loadPriceHistory } = await import('../src/history-query.js');
const { collectionIdentity } = await import('../src/collection-identity.js');
const { evaluateAlerts, reconcileProductAlerts, expireInvalidActiveAlerts } = await import('../src/alerts.js');
const { CollectionScheduler } = await import('../src/scheduler.js');
const { collectProduct, waitForCollectionQueues } = await import('../src/collection-service.js');
const { DemoCollector } = await import('../src/collectors/demo.js');
const { config } = await import('../src/config.js');
const { getDashboard } = await import('../src/dashboard.js');
const now = new Date();
let assertions = 0;
const check = (condition: unknown, description: string) => { assert.ok(condition, description); assertions++; };
const equal = (actual: unknown, expected: unknown, description: string) => { assert.deepEqual(actual, expected, description); assertions++; };
const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const results: Record<string, unknown> = {};
let productSequence = 0, recordSequence = 0;

async function product(overrides: Partial<Prisma.ProductCreateInput> = {}) {
  return prisma.product.create({ data: { id: `ops-product-${++productSequence}`, name: `运营隔离验证 ${productSequence}`, platform: 'jd', sku: `fixture-${productSequence}`, url: 'https://example.com/item', category: '隔离验证夹具', basePriceCents: 10000, targetPriceCents: 7000, collectorConfig: JSON.stringify({ priceUrl: 'https://example.com/prices', jsonPath: 'price' }), sourceType: 'http', enabled: false, ...overrides } });
}
async function price(item: Product, cents: number, at: Date, overrides: Partial<Prisma.CollectionRecordUncheckedCreateInput> = {}) {
  return prisma.collectionRecord.create({ data: { id: `ops-record-${String(++recordSequence).padStart(8, '0')}`, productId: item.id, sourceType: item.sourceType, sourceLabel: item.sourceType === 'demo' ? '演示模拟' : '真实采集', status: 'success', priceCents: cents, collectedAt: at, collectorSnapshot: JSON.stringify({ collectionIdentity: collectionIdentity(item), testFixture: true }), trigger: 'isolated-verification-fixture', ...overrides } });
}
async function evaluate(item: Product, record: CollectionRecord, at = record.collectedAt) {
  return prisma.$transaction(tx => evaluateAlerts(tx, item, record, 5, 30, at));
}

try {
  await prisma.setting.create({ data: { id: 'global', collectionIntervalMinutes: 30, lastScheduledAt: now } });
  // 15万点直接验证 JavaScript 参数上限；隔离生成器不调用真实市场接口。
  const memoryRecords = Array.from({ length: 150000 }, (_, index) => ({ status: 'success', priceCents: 10000 + index % 1000, sourceLabel: '演示模拟', collectedAt: new Date(now.getTime() - (150000 - index) * 1000), id: `memory-${String(index).padStart(7, '0')}` }));
  const started = performance.now();
  const memoryStats = calculateStats(memoryRecords);
  equal(memoryStats.pointCount, 150000, '15万历史点未丢失');
  equal(memoryStats.minPrice, 100, '大样本最低价');
  equal(memoryStats.maxPrice, 109.99, '大样本最高价');
  equal(memoryStats.currentPrice, 109.99, '大样本最新价');
  equal(memoryStats.avgPrice, 105, '大样本整数分均价正确舍入');
  results.largeStatistics = { records: 150000, ...memoryStats, elapsedMs: Math.round(performance.now() - started), stackOverflow: false };

  const historyProduct = await product();
  const rows: Prisma.CollectionRecordCreateManyInput[] = Array.from({ length: 2500 }, (_, index) => ({ id: `history-${String(index).padStart(6, '0')}`, productId: historyProduct.id, sourceType: 'http', sourceLabel: '真实采集', status: 'success', priceCents: index === 877 ? 3000 : index === 1894 ? 15000 : 10000 + index % 200, collectedAt: new Date(now.getTime() - (2500 - index) * 10000), createdAt: now, collectorSnapshot: JSON.stringify({ collectionIdentity: collectionIdentity(historyProduct), testFixture: true }), trigger: 'isolated-verification-fixture' }));
  for (let offset = 0; offset < rows.length; offset += 500) await prisma.collectionRecord.createMany({ data: rows.slice(offset, offset + 500) });
  const allRows = await prisma.collectionRecord.findMany({ where: { productId: historyProduct.id } });
  const expectedStats = calculateStats(allRows);
  const dto = await loadProductDto(historyProduct.id, now);
  for (const key of ['currentPrice', 'minPrice', 'maxPrice', 'avgPrice', 'maxDrawdownPercent', 'pointCount', 'sourceLabels'] as const) equal(dto[key], expectedStats[key], `数据库逐批/聚合统计 ${key} 对账`);
  const history = await loadPriceHistory(historyProduct.id, 30, now);
  equal(history.pointCount, 2500, '曲线标出原始记录数');
  check(history.sampled && history.points.length <= 1000, '2500点曲线压到最多1000点');
  check(history.points.length >= 400, '密集短窗口仍保留足够曲线细节');
  equal(history.points[0]!.id, rows[0]!.id, '下采样保留首点');
  equal(history.points.at(-1)!.id, rows.at(-1)!.id, '下采样保留末点');
  check(history.points.some(point => point.id === 'history-000877' && point.price === 30), '下采样保留全局最低价');
  check(history.points.some(point => point.id === 'history-001894' && point.price === 150), '下采样保留全局最高价');
  check(history.points.every((point, index) => !index || point.time >= history.points[index - 1]!.time), '下采样时间有序');
  results.databaseStatistics = { records: 2500, matchedFields: 7, statistics: expectedStats, sampledPoints: history.points.length, cap: 1000, firstAndLastRetained: true, globalExtremaRetained: true };

  const staleProduct = await product({ enabled: true });
  await price(staleProduct, 10000, new Date(now.getTime() - 72 * 3600000));
  const staleNow = await price(staleProduct, 8000, now);
  equal((await evaluate(staleProduct, staleNow)).length, 0, '72小时前价格不能触发24小时跌幅');
  const crossProduct = await product({ enabled: true });
  await price(crossProduct, 10000, new Date(now.getTime() - 86400000), { sourceType: 'demo', sourceLabel: '演示模拟', collectorSnapshot: JSON.stringify({ collectionIdentity: JSON.stringify(['demo', crossProduct.id, 10000]), testFixture: true }) });
  const crossNow = await price(crossProduct, 8000, now);
  equal((await evaluate(crossProduct, crossNow)).length, 0, '模拟价格不能充当真实24小时基线');
  equal((await loadProductDto(crossProduct.id, now)).changeFromYesterdayPercent, null, '列表昨日涨跌不混用演示和真实价格');
  const mismatchProduct = await product({ enabled: true });
  await price(mismatchProduct, 10000, new Date(now.getTime() - 86400000), { collectorSnapshot: JSON.stringify({ collectionIdentity: 'http-v2:old-configuration', testFixture: true }) });
  const mismatchNow = await price(mismatchProduct, 8000, now);
  equal((await evaluate(mismatchProduct, mismatchNow)).length, 0, '不同采集配置身份不能构成24小时基线');
  equal((await loadProductDto(mismatchProduct.id, now)).changeFromYesterdayPercent, null, '列表昨日涨跌不混用不同采集配置');
  const correctProduct = await product({ enabled: true, targetPriceCents: 9000 });
  const baseline = await price(correctProduct, 10000, new Date(now.getTime() - 86400000));
  await prisma.collectionRecord.createMany({ data: Array.from({ length: 510 }, (_, index) => ({ id: `baseline-noise-${String(index).padStart(6, '0')}`, productId: correctProduct.id, sourceType: 'http', sourceLabel: '真实采集', status: 'success', priceCents: 10000, collectedAt: new Date(baseline.collectedAt.getTime() + 1000 + index), collectorSnapshot: JSON.stringify({ collectionIdentity: 'http-v2:another-configuration', testFixture: true }), trigger: 'isolated-verification-fixture' })) });
  const current = await price(correctProduct, 8000, now);
  const created = await evaluate(correctProduct, current);
  equal(created.length, 2, '真实24小时100到80触发目标价和跌幅两条');
  const dropAlert = created.find(alert => alert.rule === 'drop24h')!;
  equal(dropAlert.baselineRecordId, baseline.id, '预警留存基线记录ID');
  equal(dropAlert.baselinePriceCents, 10000, '预警留存基线金额');
  equal(dropAlert.baselineCollectedAt?.toISOString(), baseline.collectedAt.toISOString(), '预警留存基线时间');
  equal(dropAlert.baselineSourceType, 'http', '预警留存真实来源');
  equal((await evaluate(correctProduct, current)).length, 0, '同规则未读去重');
  await prisma.alert.updateMany({ where: { productId: correctProduct.id }, data: { readAt: now } });
  equal((await evaluate(correctProduct, current, new Date(now.getTime() + 1000))).length, 0, '标已读后仍在24小时冷却中');
  const pointsBeforeEdit = await prisma.collectionRecord.count({ where: { productId: correctProduct.id } });
  await prisma.product.update({ where: { id: correctProduct.id }, data: { targetPriceCents: 7000 } });
  await reconcileProductAlerts(correctProduct.id, now);
  equal(await prisma.alert.count({ where: { productId: correctProduct.id, rule: 'target', resolvedAt: null } }), 0, '改目标价立即解除不再达标提醒');
  equal(await prisma.collectionRecord.count({ where: { productId: correctProduct.id } }), pointsBeforeEdit, '修改目标价不创建价格点');
  results.alerts = { stale72hCreated: 0, crossSourceCreated: 0, mismatchedIdentityCreated: 0, crossSourceYesterdayChange: null, changedConfigurationYesterdayChange: null, skippedMismatchedBaselineRecords: 510, genuine24hDropPercent: 20, alertsCreated: 2, duplicateCreated: 0, cooldownCreated: 0, baselinePrice: 100, triggerPrice: 80, baselineRecordId: baseline.id, editCreatedPricePoints: 0, targetResolvedImmediately: true };

  const quote = priceFreshness(historyProduct, allRows.at(-1), now, 30);
  check(!quote.isPriceStale && quote.isCurrentPriceCompatible, '新近匹配真实报价有效');
  const oldQuote = priceFreshness(historyProduct, { ...allRows.at(-1)!, collectedAt: new Date(now.getTime() - 3 * 86400000) }, now, 30);
  check(oldQuote.isPriceStale && oldQuote.priceAgeMinutes === 4320 && oldQuote.currentPriceCollectedAt !== null, '三天前的报价有准确年龄和陈旧标记');
  const changedProduct = { ...historyProduct, sku: 'new-sku' };
  const mismatchQuote = priceFreshness(changedProduct, allRows.at(-1), now, 30);
  check(mismatchQuote.isPriceStale && !mismatchQuote.currentPriceMatchesConfiguration, '配置变化后旧报价失配');
  const beforeExpiryCount = await prisma.collectionRecord.count();
  const expired = await expireInvalidActiveAlerts(new Date(now.getTime() + (quote.maxPriceAgeMinutes + 1) * 60000));
  check(expired >= 1, '报价超过配置时效后活动预警被解除');
  equal(await prisma.collectionRecord.count(), beforeExpiryCount, '预警过期不制造价格点');
  equal(await prisma.alert.count({ where: { resolvedAt: null } }), 0, '失效报价无活动预警');
  results.quoteFreshness = { freshAgeMinutes: quote.priceAgeMinutes, staleAgeMinutes: oldQuote.priceAgeMinutes, allowedAgeMinutes: quote.maxPriceAgeMinutes, changedConfigurationCompatible: mismatchQuote.isCurrentPriceCompatible, expiredActiveAlerts: expired, expiryCreatedPricePoints: 0 };

  const dashboard = await getDashboard(now);
  const summary = await getDashboard(now, { summaryOnly: true });
  check(dashboard.priceTrends.length <= 3, '仪表盘默认最多3条曲线');
  check(summary.priceTrends.length === 0, '仅摘要请求不取曲线');
  results.dashboard = { defaultTrendCount: dashboard.priceTrends.length, summaryTrendCount: summary.priceTrends.length, products: summary.products.length };

  await prisma.product.updateMany({ data: { enabled: false } });
  const runProducts = await Promise.all(Array.from({ length: 6 }, (_, index) => product({ enabled: true, collectorConfig: JSON.stringify({ priceUrl: `https://host-${index % 2}.example/prices`, jsonPath: 'price' }) })));
  const disabled = await product({ enabled: false });
  let active = 0, maximumActive = 0;
  const hostActive = new Map<string, number>(), hostMaximum = new Map<string, number>(), hostStarts = new Map<string, number[]>();
  const called = new Set<string>();
  const runner = async (id: string) => {
    const item = runProducts.find(item => item.id === id)!;
    const host = new URL((JSON.parse(item.collectorConfig) as { priceUrl: string }).priceUrl).host;
    const hostCount = (hostActive.get(host) ?? 0) + 1;
    hostActive.set(host, hostCount); hostMaximum.set(host, Math.max(hostMaximum.get(host) ?? 0, hostCount));
    hostStarts.set(host, [...(hostStarts.get(host) ?? []), Date.now()]);
    active++; maximumActive = Math.max(maximumActive, active); called.add(id);
    await delay(60);
    active--; hostActive.set(host, hostCount - 1);
    if (id === runProducts[0]!.id) throw new Error('隔离验证：预设采集异常');
    return { collection: { status: id === runProducts[1]!.id ? 'failure' : 'success' } };
  };
  const scheduler = new CollectionScheduler({ collect: runner, concurrency: 3, hostDelayMs: 90 });
  const round = await scheduler.run('isolated-verification');
  equal(round.total, 6, '调度只纳入启用商品');
  equal(round.successCount, 4, '调度成功数');
  equal(round.failureCount, 2, '异常与失败结果均计入失败且后续继续');
  equal(round.status, 'completed_with_errors', '轮次留下带错误完成状态');
  check(called.size === 6 && !called.has(disabled.id), '禁用商品未调度');
  check(maximumActive <= 3 && maximumActive >= 2, '总并发有界且不同站点并发采集');
  check([...hostMaximum.values()].every(maximum => maximum === 1), '同站点串行采集');
  const smallestHostGap = Math.min(...[...hostStarts.values()].flatMap(starts => starts.slice(1).map((start, index) => start - starts[index]!)));
  check(smallestHostGap >= 89, '同站点请求有启动间隔');
  const persistedRun = await prisma.collectionRun.findUniqueOrThrow({ where: { id: round.runId } });
  check(persistedRun.finishedAt && persistedRun.error?.includes('隔离验证：预设采集异常'), '轮次完成时间与异常原文落库');
  results.scheduler = { ...round, maximumActive, hostMaximum: Object.fromEntries(hostMaximum), smallestHostGapMs: smallestHostGap, configuredConcurrency: 3, configuredHostDelayMs: 90, disabledCollected: 0, executionContinuedAfterFailures: true };
  equal(await scheduler.tick(new Date(now.getTime() + 29 * 60000)), null, '未到全局间隔不采集');
  const dueAt = new Date(now.getTime() + 30 * 60000);
  const dueRound = await scheduler.tick(dueAt);
  equal(dueRound?.total, 6, '达到全局间隔开始完整轮次');
  equal((await prisma.setting.findUniqueOrThrow({ where: { id: 'global' } })).lastScheduledAt?.toISOString(), dueAt.toISOString(), '调度时间持久化');
  const restartedScheduler = new CollectionScheduler({ collect: runner });
  equal(await restartedScheduler.tick(new Date(dueAt.getTime() + 60000)), null, '新调度实例使用持久化时间不重复开轮');
  await restartedScheduler.stop();
  results.scheduleTiming = { intervalMinutes: 30, earlyRound: null, dueTotal: dueRound?.total, persistedRunAt: dueAt.toISOString(), restartedDuplicateRound: null };

  let shutdownFinished = false, shutdownCalls = 0, signalStarted!: () => void;
  const firstShutdownTaskStarted = new Promise<void>(done => { signalStarted = done; });
  const shutdownScheduler = new CollectionScheduler({ collect: async () => { shutdownCalls++; signalStarted(); await delay(50); shutdownFinished = true; return { collection: { status: 'success' } }; }, concurrency: 1, hostDelayMs: 0 });
  const running = shutdownScheduler.run('shutdown-verification');
  await firstShutdownTaskStarted;
  const shutdownStarted = performance.now();
  await shutdownScheduler.stop();
  const stoppedRound = await running;
  check(shutdownFinished && (await shutdownScheduler.snapshot()).running === false, '优雅停止等待已开始采集完成');
  equal(shutdownCalls, 1, '优雅停止不再派发后续采集任务');
  equal(stoppedRound.interruptedCount, 5, '剩余5个任务明确记录为中断');
  await assert.rejects(() => shutdownScheduler.run(), /采集服务正在停止/); assertions++;
  results.shutdown = { elapsedMs: Math.round(performance.now() - shutdownStarted), completedBeforeStopReturned: shutdownFinished, stoppedRunRejected: true, startedTasks: shutdownCalls, interruptedTasks: stoppedRound.interruptedCount };

  await prisma.product.updateMany({ data: { enabled: false } });
  const queuedProduct = await product({ sourceType: 'demo', collectorConfig: '{}', enabled: true });
  const originalCollect = DemoCollector.prototype.collect;
  const observedStarts: number[] = [];
  DemoCollector.prototype.collect = async function(input) { observedStarts.push(input.collectedAt.getTime()); await delay(100); return originalCollect.call(this, input); };
  try {
    const queued = await Promise.all([collectProduct(queuedProduct.id, 'queue-verification', undefined, false), collectProduct(queuedProduct.id, 'queue-verification', undefined, false)]);
    await waitForCollectionQueues();
    equal(observedStarts.length, 2, '串行队列执行2次');
    check(observedStarts[1]! - observedStarts[0]! >= 100, '第二个报价时间使用实际开采时间而非请求排队时间');
    equal(queued[1]!.collection.collectorSnapshot.sequence, 1, '队列序号无竞争');
    check(Math.abs((queued[1]!.collection.price! - queued[0]!.collection.price!) / queued[0]!.collection.price! * 100) <= 3, '队列演示价格保持单次3%以内');
    results.productQueue = { executions: 2, actualStartGapMs: observedStarts[1]! - observedStarts[0]!, secondSequence: queued[1]!.collection.collectorSnapshot.sequence, currentPrice: queued[1]!.collection.price, drainedBeforeShutdown: true };
  } finally { DemoCollector.prototype.collect = originalCollect; }

  await prisma.product.update({ where: { id: queuedProduct.id }, data: { targetPriceCents: 11000 } });
  await reconcileProductAlerts(queuedProduct.id, new Date());
  equal(await prisma.alert.count({ where: { productId: queuedProduct.id, resolvedAt: null } }), 1, '演示模式可创建明确标注的演示目标价预警');
  config.demoEnabled = false;
  const operationalDashboard = await getDashboard(new Date(), { summaryOnly: true });
  const realProducts = await prisma.product.count({ where: { sourceType: 'http' } });
  equal(operationalDashboard.monitoredProductCount, realProducts, '真实运营仪表盘商品数排除演示商品');
  check(operationalDashboard.products.every(item => item.sourceType === 'http'), '真实运营仪表盘候选商品不包含演示源');
  equal(operationalDashboard.activeAlertCount, 0, '真实运营仪表盘隐藏旧演示预警');
  const expiredDemoAlerts = await expireInvalidActiveAlerts(new Date());
  equal(expiredDemoAlerts, 1, '真实运营模式及时解除旧演示活动预警');
  const demoCountBefore = await prisma.collectionRecord.count({ where: { productId: queuedProduct.id } });
  await assert.rejects(() => collectProduct(queuedProduct.id), /已关闭演示采集/); assertions++;
  equal(await prisma.collectionRecord.count({ where: { productId: queuedProduct.id } }), demoCountBefore, '禁用演示模式手动采集不会写价格');
  const operationalScheduler = new CollectionScheduler({ collect: async () => { throw new Error('演示源不应被调用'); } });
  const operationalRound = await operationalScheduler.run('real-operations-verification');
  equal(operationalRound.total, 0, '真实运营模式调度排除演示源');
  results.operationsMode = { demoEnabled: false, manualDemoRejected: true, scheduledDemoCount: operationalRound.total, rejectedDemoNewRecords: 0, visibleDashboardProducts: realProducts, visibleDemoProducts: 0, visibleDemoActiveAlerts: 0, expiredDemoAlerts };
  config.demoEnabled = true;
  await operationalScheduler.stop();
  await scheduler.stop();

  const payload = { status: 'passed', generatedAt: new Date().toISOString(), assertions, isolation: '独立 SQLite 验证库；人工价格仅为隔离夹具，不写入运营数据库，不代表真实市场报价', database, results };
  await mkdir(resolve(projectRoot, 'outputs'), { recursive: true });
  await writeFile(resolve(projectRoot, 'outputs', 'operations-business.json'), `${JSON.stringify(payload, null, 2)}\n`);
  console.log(JSON.stringify({ status: payload.status, assertions, groups: Object.keys(results).length, results }, null, 2));
} catch (error) {
  await writeFile(resolve(projectRoot, 'outputs', 'operations-business.json'), `${JSON.stringify({ status: 'failed', assertions, results, error: error instanceof Error ? error.stack : String(error), database }, null, 2)}\n`);
  throw error;
} finally {
  await waitForCollectionQueues();
  await prisma.$disconnect();
}
