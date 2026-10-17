import type { Collector, CollectorInput, CollectorResult } from './types.js';
import { businessDate } from '../utils.js';

export function hashSeed(text: string): number {
  let hash = 0x811c9dc5;
  for (const char of text) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash || 1;
}

/** 同日多次采集取同一个种子序列的不同位置，重放顺序即可完全复算。 */
export function seededRandom(productId: string, date: string, sequence = 0): number {
  let value = hashSeed(`${productId}:${date}`);
  for (let i = 0; i <= sequence; i++) {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    value >>>= 0;
  }
  return value / 0x1_0000_0000;
}

export function nextDemoPrice(input: { productId: string; date: string; basePriceCents: number; previousPriceCents: number; volatilityPercent: number; sequence?: number }): number {
  const maxRate = Math.min(Math.abs(input.volatilityPercent), 3) / 100;
  const movement = (seededRandom(input.productId, input.date, input.sequence) * 2 - 1) * maxRate;
  const previous = input.previousPriceCents;
  const candidate = Math.round(previous * (1 + movement));
  // 边界向内取整，保证金额舍入后仍满足基准区间与单次 ±3%。
  const lower = Math.max(Math.ceil(input.basePriceCents * 0.6), Math.ceil(previous * (1 - maxRate)));
  const upper = Math.min(Math.floor(input.basePriceCents * 1.3), Math.floor(previous * (1 + maxRate)));
  if (lower > upper) throw new Error('基准价区间与单次变动区间没有交集，请恢复基准价或新建监控商品');
  return Math.min(upper, Math.max(lower, candidate));
}

export class DemoCollector implements Collector {
  async collect(input: CollectorInput): Promise<CollectorResult> {
    const snapshot = { algorithmVersion: 'fnv1a-xorshift32-v1', productId: input.product.id, date: businessDate(input.collectedAt), basePriceCents: input.product.basePriceCents, previousPriceCents: input.previousPriceCents ?? input.product.basePriceCents, volatilityPercent: input.volatilityPercent, sequence: input.demoSequence };
    const collectorSnapshot = JSON.stringify(snapshot);
    try {
      const priceCents = nextDemoPrice(snapshot);
      if (priceCents <= 0) throw new Error('采集价格必须大于 0');
      return { productId: input.product.id, sourceType: 'demo', sourceLabel: '演示模拟', collectedAt: input.collectedAt, status: 'success', priceCents, failureReason: null, demoSequence: input.demoSequence, collectorSnapshot };
    } catch (error) {
      return { productId: input.product.id, sourceType: 'demo', sourceLabel: '演示模拟', collectedAt: input.collectedAt, status: 'failure', priceCents: null, failureReason: error instanceof Error ? error.message : String(error), demoSequence: input.demoSequence, collectorSnapshot };
    }
  }
}
