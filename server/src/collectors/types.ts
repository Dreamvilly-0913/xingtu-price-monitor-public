export type SourceType = 'demo' | 'http';
export interface CollectorConfig {
  mode?: 'json' | 'html';
  priceUrl?: string;
  jsonPath?: string;
  cssSelector?: string;
  /** 显式提取售价；仅允许一个标准金额捕获组和字面量前后缀。 */
  priceRegex?: string;
  timeoutMs?: number;
  dropThresholdPercent?: number;
}
export interface CollectorInput {
  product: { id: string; platform: string; url: string; sku: string; basePriceCents: number; collectorConfig: string };
  collectedAt: Date;
  previousPriceCents: number | null;
  demoSequence: number;
  volatilityPercent: number;
}
export interface CollectorResult {
  productId: string;
  sourceType: SourceType;
  sourceLabel: '演示模拟' | '真实采集';
  collectedAt: Date;
  status: 'success' | 'failure';
  priceCents: number | null;
  failureReason: string | null;
  demoSequence?: number;
  collectorSnapshot?: string;
}
export interface Collector { collect(input: CollectorInput): Promise<CollectorResult> }
