import { Prisma } from '@prisma/client';
import { prisma } from './db.js';
import { ApiError } from './utils.js';

export interface CollectionRunContext {
  runId: string;
  runItemId: string;
  shouldStop?: () => boolean;
}

export class CollectionInterruptedError extends ApiError {
  constructor(message = '服务正在停止，该采集任务尚未开始，已中断') {
    super(503, 'COLLECTION_INTERRUPTED', message);
  }
}

/** 项目开始、流水落库、计数都以持久化任务为准，进程退出不再丢失内存计数。 */
export async function startRunItem(context: CollectionRunContext) {
  const result = await prisma.collectionRunItem.updateMany({
    where: { id: context.runItemId, runId: context.runId, status: 'pending' },
    data: { status: 'running', startedAt: new Date() },
  });
  if (result.count !== 1) throw new CollectionInterruptedError('采集任务已完成或已中断，不能重复执行');
}

export async function assertRunItemCanCommit(tx: Prisma.TransactionClient, context: CollectionRunContext, productId: string) {
  const item = await tx.collectionRunItem.findUnique({ where: { id: context.runItemId } });
  if (!item || item.runId !== context.runId || item.productId !== productId || item.status !== 'running') {
    throw new CollectionInterruptedError('采集任务已完成或已中断，禁止重复写入采集流水');
  }
}

/** 与采集记录使用同一事务：即使在提交后立即被强杀，轮次计数也与已保存流水一致。 */
export async function finishRunItem(
  tx: Prisma.TransactionClient,
  context: CollectionRunContext,
  status: 'success' | 'failure' | 'interrupted',
  details: { collectionRecordId?: string; error?: string | null } = {},
) {
  const updated = await tx.collectionRunItem.updateMany({
    where: { id: context.runItemId, runId: context.runId, status: { in: ['pending', 'running'] } },
    data: { status, finishedAt: new Date(), collectionRecordId: details.collectionRecordId, error: details.error ?? null },
  });
  // 调用方的 DTO 组装报错或重复收尾不能把已经成功提交的任务改成失败、再次增加计数。
  if (updated.count !== 1) return false;
  const counter = status === 'success' ? 'successCount' : status === 'failure' ? 'failureCount' : 'interruptedCount';
  await tx.collectionRun.update({ where: { id: context.runId }, data: { [counter]: { increment: 1 } } });
  return true;
}

export function finishRunItemOutsideCollection(context: CollectionRunContext, status: 'success' | 'failure' | 'interrupted', error?: string | null) {
  return prisma.$transaction(tx => finishRunItem(tx, context, status, { error }));
}

export async function finalizeCollectionRun(runId: string, options: { interruptedReason?: string; fatalError?: string } = {}) {
  return prisma.$transaction(async tx => {
    const now = new Date();
    // 停止派发后剩余任务明确记录为中断；这些任务没有采集结果，不能伪造失败价格流水。
    await tx.collectionRunItem.updateMany({
      where: { runId, status: { in: ['pending', 'running'] } },
      data: { status: 'interrupted', finishedAt: now, error: options.interruptedReason ?? options.fatalError ?? '轮次结束时任务尚未完成' },
    });
    const counts = await tx.collectionRunItem.groupBy({ by: ['status'], where: { runId }, _count: { _all: true } });
    const count = (status: string) => counts.find(item => item.status === status)?._count._all ?? 0;
    const successCount = count('success'), failureCount = count('failure'), interruptedCount = count('interrupted');
    const errors = await tx.collectionRunItem.findMany({ where: { runId, error: { not: null } }, orderBy: { id: 'asc' }, take: 10, select: { productId: true, error: true } });
    const status = options.fatalError ? 'failed' : interruptedCount ? 'interrupted' : failureCount ? 'completed_with_errors' : 'completed';
    return tx.collectionRun.update({ where: { id: runId }, data: {
      successCount, failureCount, interruptedCount, status, finishedAt: now,
      error: [options.fatalError, ...errors.map(item => `${item.productId}: ${item.error}`)].filter(Boolean).join('\n') || null,
    } });
  });
}

/** 必须在启用 cron 之前恢复上个进程遗留轮次；只修复运行状态，绝不重写已有价格。 */
export async function recoverInterruptedRuns(now = new Date()) {
  const runs = await prisma.collectionRun.findMany({ where: { status: 'running' }, orderBy: { startedAt: 'asc' } });
  for (const run of runs) {
    await prisma.$transaction(async tx => {
      const items = await tx.collectionRunItem.findMany({ where: { runId: run.id }, include: { collectionRecord: { select: { status: true, failureReason: true } } } });
      if (!items.length) {
        // 老版本没有任务与流水关联，无法从时间范围可靠推断轮次归属，保留已知计数并说明限制。
        await tx.collectionRun.update({ where: { id: run.id }, data: { status: 'interrupted', finishedAt: now, error: [run.error, '启动恢复：上次进程中断；该轮次没有任务账本，保留原有计数，未完成数量无法可靠还原。可手动或下一轮重新采集。'].filter(Boolean).join('\n') } });
        return;
      }
      for (const item of items) {
        if (!['pending', 'running'].includes(item.status) || !item.collectionRecord) continue;
        const recordedStatus = item.collectionRecord?.status;
        await tx.collectionRunItem.update({ where: { id: item.id }, data: {
          status: recordedStatus === 'success' ? 'success' : recordedStatus === 'failure' ? 'failure' : 'interrupted',
          finishedAt: now,
          error: recordedStatus === 'failure' ? item.collectionRecord?.failureReason ?? '采集失败' : recordedStatus === 'success' ? null : '启动恢复：上次进程中断，任务未完成；未生成价格，可手动或下一轮重新采集。',
        } });
      }
      // 未关联流水的任务统一更新，避免大量待执行商品在启动恢复时逐条往返数据库。
      await tx.collectionRunItem.updateMany({ where: { runId: run.id, status: { in: ['pending', 'running'] } }, data: {
        status: 'interrupted', finishedAt: now, error: '启动恢复：上次进程中断，任务未完成；未生成价格，可手动或下一轮重新采集。',
      } });
      const refreshed = await tx.collectionRunItem.groupBy({ by: ['status'], where: { runId: run.id }, _count: { _all: true } });
      const count = (status: string) => refreshed.find(item => item.status === status)?._count._all ?? 0;
      await tx.collectionRun.update({ where: { id: run.id }, data: {
        status: 'interrupted', finishedAt: now,
        successCount: count('success'), failureCount: count('failure'), interruptedCount: count('interrupted'),
        error: '启动恢复：上次进程中断；已从任务账本恢复计数，已保存采集流水保持原样。未完成商品可手动或下一轮重新采集。',
      } });
    });
  }
  return runs.length;
}
