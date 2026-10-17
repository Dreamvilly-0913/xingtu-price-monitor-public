import { prisma } from './db.js';
import { DemoCollector } from './collectors/demo.js';
import { HttpCollector } from './collectors/http.js';
import { ApiError, businessDayStart } from './utils.js';
import { loadProductDto, loadProductSummaries } from './stats.js';
import { serializeCollection, serializeAlert } from './serializers.js';
import { evaluateAlerts } from './alerts.js';
import { collectionIdentity } from './collection-identity.js';
import { config } from './config.js';
import { assertRunItemCanCommit, CollectionInterruptedError, finishRunItem, startRunItem, type CollectionRunContext } from './run-progress.js';

const demo = new DemoCollector();
const http = new HttpCollector();
const queues = new Map<string, Promise<unknown>>();
let shuttingDown = false;

/** Fastify preClose 阶段立即拒绝尚未开始的队列；已在网络中的请求仍按原超时完成落库。 */
export function beginCollectionShutdown() { shuttingDown = true; }
export function resumeCollectionQueues() { shuttingDown = false; }

/** 同商品采集串行化，避免同日抽样序号、当前价和预警冷却的并发竞争。 */
export async function collectProduct(productId: string, trigger = 'manual', collectedAt?: Date, includeStatistics = true, runContext?: CollectionRunContext) {
  if (shuttingDown || runContext?.shouldStop?.()) throw new CollectionInterruptedError();
  const previousJob = queues.get(productId) ?? Promise.resolve();
  // 默认采集时间在商品队列真正开始执行时确定，不能把排队申请时间当作报价时间。
  const job = previousJob.catch(() => undefined).then(async () => {
    if (shuttingDown || runContext?.shouldStop?.()) throw new CollectionInterruptedError();
    if (runContext) await startRunItem(runContext);
    return performCollection(productId, trigger, collectedAt ?? new Date(), includeStatistics, runContext);
  });
  queues.set(productId, job);
  try { return await job; } finally { if (queues.get(productId) === job) queues.delete(productId); }
}

async function performCollection(productId: string, trigger: string, collectedAt: Date, includeStatistics: boolean, runContext?: CollectionRunContext) {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) throw new ApiError(404, 'PRODUCT_NOT_FOUND', '监控商品不存在');
  if (product.sourceType === 'demo' && !config.demoEnabled) throw new ApiError(400, 'DEMO_DISABLED', '当前部署已关闭演示采集，请配置真实数据源');
  const settings = await prisma.setting.upsert({ where: { id: 'global' }, update: {}, create: { id: 'global' } });
  const latest = await prisma.collectionRecord.findFirst({ where: { productId, status: 'success' }, orderBy: [{ collectedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }] });
  const dayStart = businessDayStart(collectedAt);
  const sequence = await prisma.collectionRecord.count({ where: { productId, sourceType: 'demo', collectedAt: { gte: dayStart, lt: new Date(dayStart.getTime() + 86_400_000) } } });
  const collector = product.sourceType === 'demo' ? demo : http;
  if (shuttingDown || runContext?.shouldStop?.()) throw new CollectionInterruptedError();
  const result = await collector.collect({ product, collectedAt, previousPriceCents: latest?.priceCents ?? null, demoSequence: sequence, volatilityPercent: settings.demoVolatilityPercent });
  const { record, alerts, currentProduct, currentSettings } = await prisma.$transaction(async (tx) => {
    if (runContext) await assertRunItemCanCommit(tx, runContext, productId);
    // 网络请求期间商品可能被删除；明确返回404，事务不留下孤立采集记录。
    if (!await tx.product.findUnique({ where: { id: productId }, select: { id: true } })) throw new ApiError(404, 'PRODUCT_NOT_FOUND', '监控商品已在采集期间被删除');
    const snapshot = { ...(JSON.parse(result.collectorSnapshot ?? '{}') as Record<string, unknown>), collectionIdentity: collectionIdentity(product) };
    const record = await tx.collectionRecord.create({ data: { productId: result.productId, runId: runContext?.runId, sourceType: result.sourceType, sourceLabel: result.sourceLabel, collectedAt: result.collectedAt, status: result.status, priceCents: result.priceCents, failureReason: result.failureReason, demoSequence: result.demoSequence ?? null, collectorSnapshot: JSON.stringify(snapshot), trigger } });
    // 采集快照忠实保存旧请求；预警必须用落库时的新目标、启用状态、来源配置与全局规则。
    const currentProduct = await tx.product.findUnique({ where: { id: productId } });
    if (!currentProduct) throw new ApiError(404, 'PRODUCT_NOT_FOUND', '监控商品已在采集期间被删除');
    const currentSettings = await tx.setting.upsert({ where: { id: 'global' }, update: {}, create: { id: 'global' } });
    if (runContext) await finishRunItem(tx, runContext, result.status, { collectionRecordId: record.id, error: result.failureReason });
    return { record, currentProduct, currentSettings, alerts: await evaluateAlerts(tx, currentProduct, record, currentSettings.dropThresholdPercent, currentSettings.collectionIntervalMinutes) };
  });
  const productDto = includeStatistics ? await loadProductDto(productId) : (await loadProductSummaries([currentProduct], new Date(), currentSettings.collectionIntervalMinutes))[0]!;
  return { collection: serializeCollection({ ...record, product: currentProduct }), product: productDto, alertsCreated: alerts.map((alert) => serializeAlert({ ...alert, product: currentProduct })) };
}

/** 优雅退出需要等手动采集以及调度商品队列全部落库。 */
export async function waitForCollectionQueues() { await Promise.allSettled([...queues.values()]); }
