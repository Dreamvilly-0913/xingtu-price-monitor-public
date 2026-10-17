import { prisma } from './db.js';
import { loadProductDtos, loadProductSummaries } from './stats.js';
import { loadPriceHistory } from './history-query.js';
import { businessDayStart, fromCents, percent } from './utils.js';
import { config } from './config.js';

export interface DashboardOptions { productIds?: string[]; days?: number; summaryOnly?: boolean }

export async function getDashboard(now = new Date(), options: DashboardOptions = {}) {
  const dayStart = businessDayStart(now);
  const productVisibility = config.demoEnabled ? {} : { sourceType: 'http' };
  const recordVisibility = config.demoEnabled ? {} : { sourceType: 'http', product: { sourceType: 'http' } };
  const [products, todayCount, successCount, activeAlerts, setting] = await Promise.all([
    prisma.product.findMany({ where: productVisibility, include: { group: true }, orderBy: { createdAt: 'asc' } }),
    prisma.collectionRecord.count({ where: { collectedAt: { gte: dayStart, lte: now }, ...recordVisibility } }),
    prisma.collectionRecord.count({ where: { collectedAt: { gte: dayStart, lte: now }, status: 'success', ...recordVisibility } }),
    prisma.alertRuleState.count({ where: { active: true, ...recordVisibility } }),
    prisma.setting.findUnique({ where: { id: 'global' } }),
  ]);
  const summaries = await loadProductSummaries(products, now, setting?.collectionIntervalMinutes ?? 30);
  const byId = new Map(summaries.map(product => [product.id, product]));
  const topDrops = summaries.filter(product => product.currentPrice != null && product.changeFromYesterdayPercent != null && product.currentPriceCollectedAt && new Date(product.currentPriceCollectedAt) >= dayStart && product.changeFromYesterdayPercent < 0 && !product.isPriceStale);
  const dropRows = await Promise.all(topDrops.map(async product => {
    const previous = await prisma.collectionRecord.findFirst({ where: { productId: product.id, status: 'success', priceCents: { gt: 0 }, collectedAt: { gte: new Date(dayStart.getTime() - 86_400_000), lt: dayStart } }, orderBy: [{ collectedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }] });
    if (!previous) return null;
    return { productId: product.id, name: product.name, platform: product.platform, currentPrice: product.currentPrice, previousPrice: fromCents(previous.priceCents), previousPriceSourceLabel: previous.sourceLabel, dropPercent: -percent(Math.round(product.currentPrice! * 100), previous.priceCents!), sourceLabel: product.currentPriceSourceLabel ?? product.sourceLabel };
  }));
  const selectedIds = options.summaryOnly ? [] : (options.productIds ?? products.slice(0, 3).map(product => product.id));
  const selected = products.filter(product => selectedIds.includes(product.id)).slice(0, 10);
  const statistics = await loadProductDtos(selected, now, setting?.collectionIntervalMinutes ?? 30);
  const trends = await Promise.all(selected.map(async (product, index) => {
    const history = await loadPriceHistory(product.id, options.days ?? 30, now);
    return { productId: product.id, name: product.name, platform: product.platform, sourceLabel: byId.get(product.id)?.sourceLabel ?? (product.sourceType === 'demo' ? '演示模拟' : '真实采集'), statistics: statistics[index]!, points: history.points, pointCount: history.pointCount, sampled: history.sampled };
  }));
  return {
    monitoredProductCount: products.length, enabledProductCount: products.filter(product => product.enabled).length,
    todayCollectionCount: todayCount, todaySuccessCount: successCount, todaySuccessRate: todayCount ? Number((successCount / todayCount * 100).toFixed(2)) : 0,
    activeAlertCount: activeAlerts, todayTopDrops: dropRows.filter((row): row is NonNullable<typeof row> => row != null).sort((a, b) => b.dropPercent - a.dropPercent).slice(0, 5),
    platformDistribution: ['jd', 'tmall', 'pdd'].map(platform => ({ platform, count: products.filter(product => product.platform === platform).length })),
    products: summaries, priceTrends: trends,
  };
}
