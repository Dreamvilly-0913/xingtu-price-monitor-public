export type Platform = 'jd' | 'tmall' | 'pdd';
export type SourceType = 'demo' | 'http';
export interface User { id: string; username: string; displayName: string; mustChangePassword?: boolean }
export interface PriceStatistics { currentPrice: number | null; minPrice: number | null; maxPrice: number | null; avgPrice: number | null; maxDrawdownPercent: number | null; pointCount: number; sourceLabels: string[] }
export interface CollectorConfig { mode?: 'json' | 'html'; priceUrl?: string; jsonPath?: string; cssSelector?: string; priceRegex?: string; timeoutMs?: number; dropThresholdPercent?: number }
export interface Product extends PriceStatistics {
  id: string; name: string; platform: Platform; url: string; sku: string; category: string; basePrice: number; targetPrice: number;
  sourceType: SourceType; sourceLabel: string; configuredSourceLabel: string; currentPriceSourceType: SourceType | null; currentPriceSourceLabel: string | null;
  collectorConfig: CollectorConfig; enabled: boolean; groupId: string | null; group: { id: string; name: string } | null;
  changeFromYesterdayPercent: number | null; changeFromBasePercent: number | null; lastCollectionStatus: 'success' | 'failure' | 'never';
  lastCollectedAt: string | null; lastFailureReason: string | null; consecutiveFailures: number; createdAt: string; updatedAt: string;
  currentPriceCollectedAt?: string | null; priceAgeMinutes?: number | null; isPriceStale?: boolean; currentPriceMatchesConfiguration?: boolean;
}
export interface Group { id: string; name: string; productCount: number }
export interface Collection { id: string; productId: string; productName: string; platform: Platform; sourceType: SourceType; sourceLabel: string; status: 'success' | 'failure'; price: number | null; failureReason: string | null; collectedAt: string; trigger: string; runId?: string | null; collectorSnapshot?: unknown }
export interface PriceAlert { id: string; productId: string; productName: string; platform: Platform; rule: 'target' | 'drop24h'; price: number; threshold: number; message: string; sourceType: SourceType; sourceLabel: string; triggeredAt: string; readAt: string | null; resolvedAt: string | null; isActive: boolean; activePrice: number | null; activeThreshold: number | null; activeMessage: string | null; activeSince: string | null; stateEvaluatedAt: string | null }
export interface AlertRuleState { id: string; productId: string; productName: string; platform: Platform; rule: PriceAlert['rule']; active: boolean; price: number | null; threshold: number; message: string; sourceType: SourceType; sourceLabel: string; activeSince: string | null; evaluatedAt: string; lastAlertId: string | null }
export interface AlertListResponse extends ListResponse<PriceAlert> { currentRules: AlertRuleState[]; activeRuleCount: number }
export interface ListResponse<T> { items: T[]; total: number; page: number; pageSize: number }
export interface PricePoint { id?: string; time: string; price: number; sourceLabel: string; sourceType?: SourceType }
export interface ProductDetail { product: Product; statistics: PriceStatistics; history: PricePoint[]; historyPointCount?: number; historySampled?: boolean; collections: Collection[]; alerts: PriceAlert[]; currentRules?: AlertRuleState[] }
export interface Dashboard {
  monitoredProductCount: number; enabledProductCount: number; todayCollectionCount: number; todaySuccessCount: number; todaySuccessRate: number; activeAlertCount: number;
  todayTopDrops: { productId: string; name: string; platform: Platform; currentPrice: number; previousPrice: number; previousPriceSourceLabel: string; dropPercent: number; sourceLabel: string }[];
  platformDistribution: { platform: Platform; count: number }[]; products: Product[];
  priceTrends: { productId: string; name: string; platform: Platform; sourceLabel: string; statistics: PriceStatistics; pointCount?: number; sampled?: boolean; points: PricePoint[] }[];
}
export interface ComparisonGroup { id: string; name: string; cheapestPlatform: Platform | null; cheapestProductId: string | null; cheapestProductIds: string[]; cheapestPrice: number | null; products: Product[]; freshCheapestProductIds?: string[]; freshCheapestPrice?: number | null; freshCheapestPlatform?: Platform | null }
export interface Settings {
  collectionIntervalMinutes: number; demoVolatilityPercent: number; dropThresholdPercent: number;
  scheduler: { enabled: boolean; running: boolean; lastRunAt: string | null; nextRunAt: string | null };
  dataSources: { type: SourceType; label: string; description: string }[];
  productionReadiness?: { demoEnabled: boolean; defaultPasswordDetected?: boolean; blockers?: string[]; warnings?: string[] };
}
export interface CollectorPreview { status: 'success' | 'failure'; price: number | null; collectedAt: string; sourceLabel: string; failureReason: string | null; requestUrl?: string }
export interface AuthStatus { bootstrapRequired: boolean; bootstrapTokenRequired?: boolean; demoEnabled: boolean }
export interface SchedulerRun { id: string; startedAt: string; finishedAt: string | null; status: string; total: number; successCount: number; failureCount: number; interruptedCount: number; error: string | null; trigger: string }
