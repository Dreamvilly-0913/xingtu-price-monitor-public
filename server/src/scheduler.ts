import cron, { type ScheduledTask } from 'node-cron';
import { prisma } from './db.js';
import { collectProduct, waitForCollectionQueues } from './collection-service.js';
import { ApiError } from './utils.js';
import { config } from './config.js';
import { expireInvalidActiveAlerts } from './alerts.js';
import { setTimeout as delay } from 'node:timers/promises';
import { CollectionInterruptedError, finalizeCollectionRun, finishRunItemOutsideCollection, recoverInterruptedRuns, startRunItem, type CollectionRunContext } from './run-progress.js';

type CollectionRunner = (productId: string, trigger: string, runContext?: CollectionRunContext) => Promise<{ collection: { status: string } }>;

export class CollectionScheduler {
  private task: ScheduledTask | null = null;
  private activeRun = false;
  private lastRunAt: string | null = null;
  private stopping = false;
  private pendingRun: Promise<unknown> | null = null;
  private pendingTick: Promise<unknown> | null = null;
  private pendingStop: Promise<void> | null = null;
  private stopController = new AbortController();
  private hostQueues = new Map<string, Promise<unknown>>();
  private hostLastFinished = new Map<string, number>();
  private readonly collect: CollectionRunner;
  private readonly concurrency: number;
  private readonly hostDelayMs: number;
  private readonly injectedCollector: boolean;

  constructor(options: { collect?: CollectionRunner; concurrency?: number; hostDelayMs?: number } = {}) {
    this.injectedCollector = options.collect != null;
    this.collect = options.collect ?? ((id, trigger, context) => collectProduct(id, trigger, undefined, false, context));
    this.concurrency = Math.max(1, Math.min(6, options.concurrency ?? 3));
    this.hostDelayMs = Math.max(0, options.hostDelayMs ?? 250);
  }

  async start() {
    if (this.task) return;
    this.stopping = false;
    this.pendingStop = null;
    this.stopController = new AbortController();
    if (!this.activeRun) await recoverInterruptedRuns();
    const setting = await this.getSetting();
    if (!setting.lastScheduledAt) await prisma.setting.update({ where: { id: 'global' }, data: { lastScheduledAt: new Date() } });
    this.task = cron.schedule('* * * * *', () => { void this.tick().catch(error => console.error('调度检查失败：', error)); }, { noOverlap: true });
  }

  stop() {
    if (this.pendingStop) return this.pendingStop;
    this.stopping = true;
    this.stopController.abort();
    this.pendingStop = this.executeStop();
    return this.pendingStop;
  }

  private async executeStop() {
    if (this.task) { await this.task.stop(); await this.task.destroy(); this.task = null; }
    // 不再派发后续任务，只等已经开始的请求按超时落库；未执行任务在轮次结束时记为中断。
    await this.pendingTick?.catch(() => undefined);
    await this.pendingRun?.catch(() => undefined);
    await waitForCollectionQueues();
  }

  private getSetting() { return prisma.setting.upsert({ where: { id: 'global' }, create: { id: 'global' }, update: {} }); }

  async snapshot() {
    const setting = await this.getSetting();
    return { running: this.activeRun, enabled: this.task != null, lastRunAt: this.lastRunAt ?? setting.lastScheduledAt?.toISOString() ?? null, nextRunAt: setting.lastScheduledAt ? new Date(setting.lastScheduledAt.getTime() + setting.collectionIntervalMinutes * 60_000).toISOString() : null, concurrency: this.concurrency, perHostDelayMs: this.hostDelayMs };
  }

  tick(now = new Date()) {
    if (this.stopping || this.pendingTick) return Promise.resolve(null);
    const job = this.executeTick(now).finally(() => { if (this.pendingTick === job) this.pendingTick = null; });
    this.pendingTick = job;
    return job;
  }

  private async executeTick(now: Date) {
    if (this.stopping) return null;
    await expireInvalidActiveAlerts(now);
    const setting = await this.getSetting();
    if (this.stopping || this.activeRun || !setting.lastScheduledAt || now.getTime() < setting.lastScheduledAt.getTime() + setting.collectionIntervalMinutes * 60_000) return null;
    return this.run('scheduled', now);
  }

  run(trigger = 'manual', startedAt = new Date()) {
    if (this.stopping) return Promise.reject(new ApiError(503, 'SCHEDULER_STOPPING', '采集服务正在停止'));
    if (this.activeRun) return Promise.reject(new ApiError(409, 'COLLECTION_RUNNING', '上一轮采集尚未完成'));
    this.activeRun = true;
    const job = this.executeRun(trigger, startedAt).finally(() => { this.activeRun = false; if (this.pendingRun === job) this.pendingRun = null; });
    this.pendingRun = job;
    return job;
  }

  private async onHost<T>(host: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.hostQueues.get(host) ?? Promise.resolve();
    const job = previous.catch(() => undefined).then(async () => {
      if (this.stopping) throw new CollectionInterruptedError();
      // 以完整任务结束为冷却锚点，不能在前置数据库写入前记开始时间，导致实际请求间隔被压缩。
      // 单调时钟和循环复查同时避免墙钟调整、定时器提前唤醒使间隔缩短。
      const deadline = (this.hostLastFinished.get(host) ?? Number.NEGATIVE_INFINITY) + this.hostDelayMs;
      while (performance.now() < deadline) {
        try { await delay(Math.ceil(deadline - performance.now()), undefined, { signal: this.stopController.signal }); }
        catch { throw new CollectionInterruptedError(); }
      }
      if (this.stopping) throw new CollectionInterruptedError();
      try { return await operation(); }
      finally { this.hostLastFinished.set(host, performance.now()); }
    });
    this.hostQueues.set(host, job);
    try { return await job; } finally { if (this.hostQueues.get(host) === job) this.hostQueues.delete(host); }
  }

  private async executeRun(trigger: string, startedAt: Date) {
    let runId: string | undefined;
    try {
      const products = await prisma.product.findMany({ where: { enabled: true, ...(!config.demoEnabled ? { sourceType: 'http' } : {}) }, orderBy: { id: 'asc' } });
      // 轮次和任务账本一起创建；不存在 total 已写入却没有任务归属的窗口。
      const run = await prisma.collectionRun.create({ data: {
        trigger, startedAt, status: 'running', total: products.length,
        items: { create: products.map(product => ({ productId: product.id })) },
      }, include: { items: true } });
      runId = run.id;
      const itemIds = new Map(run.items.map(item => [item.productId, item.id]));
      if (trigger === 'scheduled') await prisma.setting.update({ where: { id: 'global' }, data: { lastScheduledAt: startedAt } });
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(this.concurrency, Math.max(1, products.length)) }, async () => {
        for (;;) {
          if (this.stopping) break;
          const product = products[next++];
          if (!product) break;
          const context: CollectionRunContext = { runId: run.id, runItemId: itemIds.get(product.id)!, shouldStop: () => this.stopping };
          try {
            const options = JSON.parse(product.collectorConfig) as { priceUrl?: string; mode?: string };
            const url = options.priceUrl ?? (product.platform === 'jd' && options.mode !== 'html' ? 'https://p.3.cn' : product.url);
            const host = product.sourceType === 'demo' ? `demo:${product.id}` : new URL(url).host;
            const result = await this.onHost(host, async () => {
              // 生产采集器在商品队列真正启动时记录 running；既有测试注入器仍支持原两参数签名。
              if (this.injectedCollector) await startRunItem(context);
              return this.collect(product.id, trigger, context);
            });
            await finishRunItemOutsideCollection(context, result.collection.status === 'success' ? 'success' : 'failure');
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const interrupted = error instanceof CollectionInterruptedError;
            const changed = await finishRunItemOutsideCollection(context, interrupted ? 'interrupted' : 'failure', message);
            // 流水事务成功后的 DTO 报错不能覆盖该任务的成功状态。
            if (changed && !interrupted) console.error(`商品 ${product.id} 采集执行失败：`, message);
          }
        }
      }));
      const finished = await finalizeCollectionRun(runId, this.stopping ? { interruptedReason: '服务停止：尚未开始的采集任务已中断，可手动或下一轮重新采集。' } : {});
      this.lastRunAt = startedAt.toISOString();
      return { runId, total: finished.total, successCount: finished.successCount, failureCount: finished.failureCount, interruptedCount: finished.interruptedCount, status: finished.status };
    } catch (error) {
      if (runId) await finalizeCollectionRun(runId, { fatalError: error instanceof Error ? error.message : String(error) }).catch(updateError => console.error('保存失败轮次失败：', updateError));
      throw error;
    }
  }
}
