import type { CollectionRecord, Product } from '@prisma/client';
import { createHash } from 'node:crypto';
import type { CollectorConfig } from './collectors/types.js';

/** 采集身份只包含会影响价格口径的配置，改阈值和超时不会中断同源价格比较。 */
export function collectionIdentity(product: Pick<Product, 'id' | 'sourceType' | 'platform' | 'url' | 'sku' | 'basePriceCents' | 'collectorConfig'>): string {
  const options = JSON.parse(product.collectorConfig) as CollectorConfig & { priceRegex?: string };
  if (product.sourceType === 'demo') return JSON.stringify(['demo', product.id, product.basePriceCents]);
  const jdDefault = product.platform === 'jd' && !options.priceUrl && options.mode !== 'html';
  const url = options.priceUrl ?? (jdDefault ? `https://p.3.cn/prices/mgets?skuIds=J_${encodeURIComponent(product.sku)}` : product.url);
  const identity = ['http', product.platform, product.sku, options.mode ?? 'json', url, options.mode === 'html' ? options.cssSelector ?? '' : options.jsonPath ?? (jdDefault ? '$[0].p' : 'price'), options.priceRegex ?? ''];
  return `http-v2:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
}

export const buildCollectionIdentity = collectionIdentity;

export function recordCollectionIdentity(record: Pick<CollectionRecord, 'productId' | 'sourceType' | 'collectorSnapshot'>): string | null {
  try {
    const snapshot = JSON.parse(record.collectorSnapshot) as Record<string, unknown>;
    if (typeof snapshot.collectionIdentity === 'string') return snapshot.collectionIdentity;
    // 旧演示点的快照已经包含商品和基准价，能够可靠还原采集身份。
    if (record.sourceType === 'demo' && snapshot.algorithmVersion === 'fnv1a-xorshift32-v1' && typeof snapshot.basePriceCents === 'number') return JSON.stringify(['demo', record.productId, snapshot.basePriceCents]);
  } catch { /* 旧版本缺失/损坏快照时，不推测真实采集的价格口径。 */ }
  return null;
}
