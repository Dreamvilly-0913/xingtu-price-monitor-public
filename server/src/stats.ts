import type { CollectionRecord, Prisma, Product } from '@prisma/client';
import { businessDayStart, fromCents, percent, round } from './utils.js';
import { prisma } from './db.js';
import { collectionIdentity, recordCollectionIdentity } from './collection-identity.js';

export interface PriceStatistics { currentPrice: number | null; minPrice: number | null; maxPrice: number | null; avgPrice: number | null; maxDrawdownPercent: number; pointCount: number; sourceLabels: string[] }

type ChronologicalRecord = Pick<CollectionRecord, 'collectedAt'> & Partial<Pick<CollectionRecord, 'createdAt' | 'id'>>;

/** 所有页面使用同一排序；种子结果尚未入库时保持原采集顺序。 */
export function compareCollections(a: ChronologicalRecord, b: ChronologicalRecord): number {
  const timeOrder = a.collectedAt.getTime() - b.collectedAt.getTime() || (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0);
  if (timeOrder) return timeOrder;
  const leftId = a.id ?? '', rightId = b.id ?? '';
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

/** 涨跌比较的两个报价必须来自同一可核对的采集口径。 */
export function comparablePrices(left: CollectionRecord | null | undefined, right: CollectionRecord | null | undefined): boolean {
  if (!left || !right || left.sourceType !== right.sourceType) return false;
  const identity = recordCollectionIdentity(left);
  return identity != null && identity === recordCollectionIdentity(right);
}

/** 全部统计只读取成功采集记录，失败记录从不进入价格统计。 */
export function calculateStats(records: (Pick<CollectionRecord, 'status' | 'priceCents' | 'sourceLabel'> & ChronologicalRecord)[]): PriceStatistics {
  const prices = records.filter((record) => record.status === 'success' && record.priceCents != null && record.priceCents > 0).sort(compareCollections).map((record) => record.priceCents!);
  if (!prices.length) return { currentPrice: null, minPrice: null, maxPrice: null, avgPrice: null, maxDrawdownPercent: 0, pointCount: 0, sourceLabels: [] };
  // 汇总统计注明全部来源，切换真实源后仍能识别参与统计的旧演示价格。
  const sourceLabels = [...new Set(records.filter(record => record.status === 'success' && record.priceCents != null && record.priceCents > 0).map(record => record.sourceLabel))];
  let peak = prices[0]!, minimum = prices[0]!, maximum = prices[0]!, total = 0;
  let maximumDrop = 0;
  // 禁止把全部历史传给 Math.min/max，长期运行十几万点时会超过调用参数上限。
  for (const price of prices) { total += price; minimum = Math.min(minimum, price); maximum = Math.max(maximum, price); peak = Math.max(peak, price); maximumDrop = Math.max(maximumDrop, (peak - price) / peak * 100); }
  return { currentPrice: fromCents(prices.at(-1)), minPrice: fromCents(minimum), maxPrice: fromCents(maximum), avgPrice: Math.round(total / prices.length) / 100, maxDrawdownPercent: round(maximumDrop, 4), pointCount: prices.length, sourceLabels };
}

export function priceFreshness(product: Product, current: CollectionRecord | undefined | null, now = new Date(), intervalMinutes = 30) {
  const priceAgeMinutes = current ? round(Math.max(0, now.getTime() - current.collectedAt.getTime()) / 60_000, 2) : null;
  const maxPriceAgeMinutes = intervalMinutes * 2 + Math.max(5, Math.min(intervalMinutes, 60));
  const sameIdentity = current ? recordCollectionIdentity(current) === collectionIdentity(product) : false;
  const isCurrentPriceCompatible = Boolean(current && current.sourceType === product.sourceType && sameIdentity);
  return { currentPriceCollectedAt: current?.collectedAt.toISOString() ?? null, priceAgeMinutes, maxPriceAgeMinutes, isCurrentPriceCompatible, currentPriceMatchesConfiguration: isCurrentPriceCompatible, isPriceStale: !current || !isCurrentPriceCompatible || priceAgeMinutes! > maxPriceAgeMinutes };
}

export function serializeProduct(product: Product & { collections: CollectionRecord[]; group?: { id: string; name: string } | null }, now = new Date(), intervalMinutes = 30) {
  const chronological = [...product.collections].sort(compareCollections);
  const successful = chronological.filter((record) => record.status === 'success' && record.priceCents != null && record.priceCents > 0);
  const current = successful.at(-1);
  const todayStart = businessDayStart(now).getTime();
  const yesterday = successful.filter((record) => record.collectedAt.getTime() >= todayStart - 86_400_000 && record.collectedAt.getTime() < todayStart).at(-1);
  let consecutiveFailures = 0;
  for (let i = chronological.length - 1; i >= 0; i--) { if (chronological[i]!.status !== 'failure') break; consecutiveFailures++; }
  const latest = chronological.at(-1);
  return {
    id: product.id, name: product.name, platform: product.platform, url: product.url, sku: product.sku, category: product.category,
    basePrice: fromCents(product.basePriceCents), targetPrice: fromCents(product.targetPriceCents), sourceType: product.sourceType,
    sourceLabel: current?.sourceLabel ?? (product.sourceType === 'demo' ? '演示模拟' : '真实采集'), configuredSourceLabel: product.sourceType === 'demo' ? '演示模拟' : '真实采集',
    currentPriceSourceType: current?.sourceType ?? null, currentPriceSourceLabel: current?.sourceLabel ?? null, collectorConfig: JSON.parse(product.collectorConfig) as Record<string, unknown>,
    enabled: product.enabled, groupId: product.groupId, group: product.group ?? null, ...calculateStats(chronological), ...priceFreshness(product, current, now, intervalMinutes),
    changeFromYesterdayPercent: comparablePrices(current, yesterday) ? percent(current!.priceCents!, yesterday!.priceCents!) : null,
    changeFromBasePercent: current ? percent(current.priceCents!, product.basePriceCents) : null,
    lastCollectionStatus: latest?.status ?? 'never', lastCollectedAt: latest?.collectedAt.toISOString() ?? null,
    lastFailureReason: latest?.failureReason ?? null, consecutiveFailures,
    createdAt: product.createdAt.toISOString(), updatedAt: product.updatedAt.toISOString(),
  };
}

const ascending: Prisma.CollectionRecordOrderByWithRelationInput[] = [{ productId: 'asc' }, { collectedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }];
const descending: Prisma.CollectionRecordOrderByWithRelationInput[] = [{ collectedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }];
type ProductWithGroup = Product & { group?: { id: string; name: string } | null };

/** 分页的商品在数据库汇总价格，最大回撤逐批扫描；不会加载完整历史到内存。 */
export async function loadProductDtos(products: ProductWithGroup[], now = new Date(), intervalMinutes?: number, historyStatistics = true) {
  if (!products.length) return [];
  const productIds = products.map(product => product.id);
  const successWhere: Prisma.CollectionRecordWhereInput = { productId: { in: productIds }, status: 'success', priceCents: { gt: 0 } };
  const [aggregates, sources, setting] = await Promise.all([
    historyStatistics ? prisma.collectionRecord.groupBy({ by: ['productId'], where: successWhere, _min: { priceCents: true }, _max: { priceCents: true }, _avg: { priceCents: true }, _count: { _all: true } }) : Promise.resolve([]),
    prisma.collectionRecord.groupBy({ by: ['productId', 'sourceLabel'], where: successWhere }),
    intervalMinutes === undefined ? prisma.setting.findUnique({ where: { id: 'global' } }) : Promise.resolve(null),
  ]);
  const statsById = new Map(aggregates.map(row => [row.productId, row]));
  const drawdowns = new Map<string, { peak: number; drop: number }>();
  let cursor: string | undefined;
  for (; historyStatistics;) {
    const batch = await prisma.collectionRecord.findMany({ where: successWhere, select: { id: true, productId: true, priceCents: true }, orderBy: ascending, take: 1000, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
    for (const record of batch) {
      const state = drawdowns.get(record.productId) ?? { peak: record.priceCents!, drop: 0 };
      state.peak = Math.max(state.peak, record.priceCents!);
      state.drop = Math.max(state.drop, (state.peak - record.priceCents!) / state.peak * 100);
      drawdowns.set(record.productId, state);
    }
    if (batch.length < 1000) break;
    cursor = batch.at(-1)!.id;
  }
  const effectiveInterval = intervalMinutes ?? setting?.collectionIntervalMinutes ?? 30;
  const dayStart = businessDayStart(now);
  const result: ReturnType<typeof serializeProduct>[] = [];
  // 每次最多 6 商品并发，避免分页 100 商品产生数百个同时排队的数据库请求。
  for (let offset = 0; offset < products.length; offset += 6) {
    result.push(...await Promise.all(products.slice(offset, offset + 6).map(async product => {
      const [current, latest, yesterday] = await Promise.all([
        prisma.collectionRecord.findFirst({ where: { productId: product.id, status: 'success', priceCents: { gt: 0 } }, orderBy: descending }),
        prisma.collectionRecord.findFirst({ where: { productId: product.id }, orderBy: descending }),
        prisma.collectionRecord.findFirst({ where: { productId: product.id, status: 'success', priceCents: { gt: 0 }, collectedAt: { gte: new Date(dayStart.getTime() - 86_400_000), lt: dayStart } }, orderBy: descending }),
      ]);
      const lastSuccessfulAttempt = await prisma.collectionRecord.findFirst({ where: { productId: product.id, status: 'success' }, orderBy: descending });
      const afterLastSuccess: Prisma.CollectionRecordWhereInput = lastSuccessfulAttempt ? { OR: [
        { collectedAt: { gt: lastSuccessfulAttempt.collectedAt } },
        { collectedAt: lastSuccessfulAttempt.collectedAt, createdAt: { gt: lastSuccessfulAttempt.createdAt } },
        { collectedAt: lastSuccessfulAttempt.collectedAt, createdAt: lastSuccessfulAttempt.createdAt, id: { gt: lastSuccessfulAttempt.id } },
      ] } : {};
      const consecutiveFailures = latest?.status === 'failure' ? await prisma.collectionRecord.count({ where: { productId: product.id, status: 'failure', ...afterLastSuccess } }) : 0;
      const dto = serializeProduct({ ...product, collections: current ? [current] : [] }, now, effectiveInterval);
      const aggregate = statsById.get(product.id);
      return { ...dto, minPrice: fromCents(aggregate?._min.priceCents), maxPrice: fromCents(aggregate?._max.priceCents), avgPrice: aggregate?._avg.priceCents == null ? null : Math.round(aggregate._avg.priceCents) / 100, pointCount: aggregate?._count._all ?? 0, maxDrawdownPercent: round(drawdowns.get(product.id)?.drop ?? 0, 4), sourceLabels: sources.filter(row => row.productId === product.id).map(row => row.sourceLabel), changeFromYesterdayPercent: comparablePrices(current, yesterday) ? percent(current!.priceCents!, yesterday!.priceCents!) : null, lastCollectionStatus: latest?.status ?? 'never', lastCollectedAt: latest?.collectedAt.toISOString() ?? null, lastFailureReason: latest?.failureReason ?? null, consecutiveFailures };
    })));
  }
  return result;
}

export async function loadProductDto(productId: string, now = new Date()) {
  const product = await prisma.product.findUniqueOrThrow({ where: { id: productId }, include: { group: true } });
  return (await loadProductDtos([product], now))[0]!;
}

/** 仪表盘候选商品只需要最新报价；不为了勾选框扫描其全部历史。 */
export async function loadProductSummaries(products: ProductWithGroup[], now = new Date(), intervalMinutes?: number) {
  return (await loadProductDtos(products, now, intervalMinutes, false)).map(dto => {
    const { minPrice: _min, maxPrice: _max, avgPrice: _avg, maxDrawdownPercent: _drop, pointCount: _count, ...summary } = dto;
    return summary;
  });
}
