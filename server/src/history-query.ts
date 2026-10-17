import type { CollectionRecord, Prisma } from '@prisma/client';
import { prisma } from './db.js';
import { businessDayStart, fromCents } from './utils.js';

const order: Prisma.CollectionRecordOrderByWithRelationInput[] = [{ collectedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }];
type HistorySample = Pick<CollectionRecord, 'id' | 'collectedAt' | 'createdAt' | 'priceCents' | 'sourceLabel' | 'sourceType'>;

/** 窗口记录逐批读取，密集曲线按时间桶保留首尾和最高/最低点；全部原始记录仍可查采集流水。 */
export async function loadPriceHistory(productId: string, days = 30, now = new Date(), maxPoints = 1000) {
  const start = new Date(businessDayStart(now).getTime() - days * 86_400_000);
  const where: Prisma.CollectionRecordWhereInput = { productId, status: 'success', priceCents: { gt: 0 }, collectedAt: { gte: start, lte: now } };
  const aggregate = await prisma.collectionRecord.aggregate({ where, _count: { _all: true }, _min: { collectedAt: true }, _max: { collectedAt: true } });
  const pointCount = aggregate._count._all;
  const cap = Math.max(8, Math.min(2000, Math.floor(maxPoints)));
  const bucketCount = Math.max(1, Math.floor((cap - 2) / 4));
  // 按实际有价格的时间跨度分桶，避免30天窗口仅有几小时数据时被压成寥寥几个点。
  const sampleStart = aggregate._min.collectedAt?.getTime() ?? start.getTime();
  const sampleEnd = aggregate._max.collectedAt?.getTime() ?? now.getTime();
  const width = Math.max(1, (sampleEnd - sampleStart + 1) / bucketCount);
  const buckets = new Map<number, { first: HistorySample; last: HistorySample; min: HistorySample; max: HistorySample }>();
  const exact: HistorySample[] = [];
  let cursor: string | undefined;
  for (;;) {
    const batch: HistorySample[] = await prisma.collectionRecord.findMany({ where, select: { id: true, collectedAt: true, createdAt: true, priceCents: true, sourceLabel: true, sourceType: true }, orderBy: order, take: 1000, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
    for (const sample of batch) {
      if (pointCount <= cap) { exact.push(sample); continue; }
      const key = Math.min(bucketCount - 1, Math.floor((sample.collectedAt.getTime() - sampleStart) / width));
      const bucket = buckets.get(key);
      if (!bucket) buckets.set(key, { first: sample, last: sample, min: sample, max: sample });
      else { bucket.last = sample; if (sample.priceCents! < bucket.min.priceCents!) bucket.min = sample; if (sample.priceCents! > bucket.max.priceCents!) bucket.max = sample; }
    }
    if (batch.length < 1000) break;
    cursor = batch.at(-1)!.id;
  }
  const points = pointCount <= cap ? exact : [...new Map([...buckets.values()].flatMap(bucket => [bucket.first, bucket.min, bucket.max, bucket.last]).map(sample => [sample.id, sample])).values()].sort((a, b) => a.collectedAt.getTime() - b.collectedAt.getTime() || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  return { pointCount, sampled: pointCount > cap, points: points.map(sample => ({ id: sample.id, time: sample.collectedAt.toISOString(), price: fromCents(sample.priceCents), sourceLabel: sample.sourceLabel, sourceType: sample.sourceType })), start: start.toISOString(), end: now.toISOString() };
}
