import type { Alert, AlertRuleState, CollectionRecord, Prisma, Product } from '@prisma/client';
import { prisma } from './db.js';
import type { CollectorConfig } from './collectors/types.js';
import { collectionIdentity, recordCollectionIdentity } from './collection-identity.js';
import { fromCents, round } from './utils.js';
import { priceFreshness } from './stats.js';
import { config } from './config.js';

const order: Prisma.CollectionRecordOrderByWithRelationInput[] = [{ collectedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }];
const cooldownMs = 86_400_000;

/** 当前规则状态与提醒流水各自保存；冷却只限制新提醒，不阻止规则恢复为触发中。 */
export async function evaluateAlerts(tx: Prisma.TransactionClient, product: Product, record: CollectionRecord, defaultDropThreshold: number, intervalMinutes = 30, evaluationAt = record.collectedAt, options: { emitNotifications?: boolean } = {}) {
  if (record.status !== 'success' || record.priceCents == null || record.priceCents <= 0) return [];
  // 与采集事务共用最新成功点；迟到的历史重评不能覆盖当前报价或当前规则状态。
  const latest = await tx.collectionRecord.findFirst({ where: { productId: product.id, status: 'success', priceCents: { gt: 0 } }, orderBy: order });
  if (!latest || latest.id !== record.id) return [];
  const previousStates = await tx.alertRuleState.findMany({ where: { productId: product.id } });
  // 同一点的重评时间单调递增，仍读取当前目标价；不同 ID 的同价新点可以恢复过期状态。
  evaluationAt = new Date(Math.max(evaluationAt.getTime(), record.collectedAt.getTime(), ...previousStates.filter(state => state.collectionRecordId === record.id).map(state => state.evaluatedAt.getTime())));
  const settings = JSON.parse(product.collectorConfig) as CollectorConfig;
  const identity = recordCollectionIdentity(record);
  const compatible = record.sourceType === product.sourceType && identity === collectionIdentity(product);
  const fresh = !priceFreshness(product, record, evaluationAt, intervalMinutes).isPriceStale;
  const baselineAt = new Date(record.collectedAt.getTime() - cooldownMs);
  const toleranceMs = Math.min(Math.max(1, intervalMinutes), 60) * 60_000;
  // 只接受接近 24 小时前且采集身份一致的价格，陈旧点、演示点不能充当真实报价基线。
  let baseline: CollectionRecord | undefined, candidateCursor: string | undefined;
  for (; compatible;) {
    const candidates = await tx.collectionRecord.findMany({ where: { productId: product.id, sourceType: record.sourceType, status: 'success', priceCents: { gt: 0 }, collectedAt: { gte: new Date(baselineAt.getTime() - toleranceMs), lte: new Date(baselineAt.getTime() + toleranceMs) } }, orderBy: order, take: 500, ...(candidateCursor ? { cursor: { id: candidateCursor }, skip: 1 } : {}) });
    for (const candidate of candidates) {
      if (recordCollectionIdentity(candidate) !== identity) continue;
      const distance = Math.abs(candidate.collectedAt.getTime() - baselineAt.getTime());
      if (!baseline || distance < Math.abs(baseline.collectedAt.getTime() - baselineAt.getTime())) baseline = candidate;
    }
    if (candidates.length < 500 || baseline?.collectedAt.getTime() === baselineAt.getTime()) break;
    candidateCursor = candidates.at(-1)!.id;
  }
  const threshold = settings.dropThresholdPercent ?? defaultDropThreshold;
  const dropPercent = baseline?.priceCents ? (baseline.priceCents - record.priceCents) / baseline.priceCents * 100 : 0;
  const enabled = product.enabled && compatible && fresh && (record.sourceType !== 'demo' || config.demoEnabled);
  const conditions = [
    { rule: 'target', active: enabled && record.priceCents <= product.targetPriceCents, threshold: product.targetPriceCents / 100, message: `当前价 ¥${fromCents(record.priceCents)!.toFixed(2)} 已达到目标价 ¥${fromCents(product.targetPriceCents)!.toFixed(2)}` },
    { rule: 'drop24h', active: enabled && Boolean(baseline) && dropPercent >= threshold, threshold, message: `24 小时跌幅 ${round(dropPercent, 2)}%，达到阈值 ${threshold}%；基线 ¥${fromCents(baseline?.priceCents)?.toFixed(2) ?? '—'}，${baseline?.collectedAt.toISOString() ?? '数据不足'}` },
  ];
  const created: (Alert & { currentRuleState?: AlertRuleState })[] = [];
  for (const condition of conditions) {
    const previous = previousStates.find(state => state.rule === condition.rule);
    const notificationWhere = { productId: product.id, rule: condition.rule, sourceType: record.sourceType, collectionIdentity: identity ?? '' };
    const lastAlert = await tx.alert.findFirst({ where: notificationWhere, orderBy: [{ triggeredAt: 'desc' }, { id: 'desc' }] });
    let lastAlertId = lastAlert?.id ?? null;
    if (!condition.active) {
      await tx.alert.updateMany({ where: { productId: product.id, rule: condition.rule, resolvedAt: null }, data: { resolvedAt: evaluationAt } });
    } else {
      // 来源或配置变化后，旧提醒不占用新口径的未读去重位置。
      await tx.alert.updateMany({ where: { productId: product.id, rule: condition.rule, resolvedAt: null, OR: [{ sourceType: { not: record.sourceType } }, { collectionIdentity: { not: identity ?? '' } }] }, data: { resolvedAt: evaluationAt } });
      const unhandled = await tx.alert.findFirst({ where: { ...notificationWhere, resolvedAt: null, readAt: null } });
      const coolingDown = Boolean(lastAlert && evaluationAt.getTime() - lastAlert.triggeredAt.getTime() < cooldownMs);
      if (options.emitNotifications !== false && !unhandled && !coolingDown) {
        await tx.alert.updateMany({ where: { productId: product.id, rule: condition.rule, resolvedAt: null }, data: { resolvedAt: evaluationAt } });
        const alert = await tx.alert.create({ data: { ...notificationWhere, priceCents: record.priceCents, threshold: condition.threshold, message: `${record.sourceLabel}：${condition.message}`, sourceLabel: record.sourceLabel, triggeredAt: evaluationAt, baselineRecordId: condition.rule === 'drop24h' ? baseline?.id ?? null : null, baselinePriceCents: condition.rule === 'drop24h' ? baseline?.priceCents ?? null : null, baselineCollectedAt: condition.rule === 'drop24h' ? baseline?.collectedAt ?? null : null, baselineSourceType: condition.rule === 'drop24h' ? baseline?.sourceType ?? null : null } });
        created.push(alert);
        lastAlertId = alert.id;
      }
    }
    const state = {
      active: condition.active, sourceType: record.sourceType, sourceLabel: record.sourceLabel, collectionIdentity: identity ?? '', collectionRecordId: record.id, priceCents: record.priceCents,
      threshold: condition.threshold, message: `${record.sourceLabel}：${condition.message}`, evaluatedAt: evaluationAt,
      activeSince: condition.active ? (previous?.active && previous.collectionIdentity === identity ? previous.activeSince ?? evaluationAt : evaluationAt) : null,
      lastAlertId, baselineRecordId: condition.rule === 'drop24h' ? baseline?.id ?? null : null, baselinePriceCents: condition.rule === 'drop24h' ? baseline?.priceCents ?? null : null,
      baselineCollectedAt: condition.rule === 'drop24h' ? baseline?.collectedAt ?? null : null, baselineSourceType: condition.rule === 'drop24h' ? baseline?.sourceType ?? null : null,
    };
    const persistedState = await tx.alertRuleState.upsert({ where: { productId_rule: { productId: product.id, rule: condition.rule } }, create: { productId: product.id, rule: condition.rule, ...state }, update: state });
    const newAlert = created.find(alert => alert.id === lastAlertId);
    if (newAlert) newAlert.currentRuleState = persistedState;
  }
  return created;
}

async function deactivateRules(tx: Prisma.TransactionClient, productId: string, now: Date) {
  await tx.alertRuleState.updateMany({ where: { productId, active: true }, data: { active: false, activeSince: null, evaluatedAt: now } });
  return (await tx.alert.updateMany({ where: { productId, resolvedAt: null }, data: { resolvedAt: now } })).count;
}

/** 即使采集持续失败，旧报价的当前规则也会过期；不生成价格或提醒。 */
export async function expireInvalidActiveAlerts(now = new Date()) {
  const [states, legacyAlerts] = await Promise.all([
    prisma.alertRuleState.groupBy({ by: ['productId'], where: { active: true } }),
    prisma.alert.groupBy({ by: ['productId'], where: { resolvedAt: null } }),
  ]);
  const ids = [...new Set([...states, ...legacyAlerts].map(item => item.productId))];
  let resolvedCount = 0;
  for (const productId of ids) {
    resolvedCount += await prisma.$transaction(async tx => {
      const [product, current, setting] = await Promise.all([
        tx.product.findUnique({ where: { id: productId } }),
        tx.collectionRecord.findFirst({ where: { productId, status: 'success', priceCents: { gt: 0 } }, orderBy: order }),
        tx.setting.findUnique({ where: { id: 'global' } }),
      ]);
      const invalid = !product || !product.enabled || !current || (current.sourceType === 'demo' && !config.demoEnabled) || priceFreshness(product, current, now, setting?.collectionIntervalMinutes ?? 30).isPriceStale;
      if (invalid) return deactivateRules(tx, productId, now);
      const before = await tx.alert.count({ where: { productId, resolvedAt: null } });
      await evaluateAlerts(tx, product, current, setting?.dropThresholdPercent ?? 5, setting?.collectionIntervalMinutes ?? 30, now, { emitNotifications: false });
      return before - await tx.alert.count({ where: { productId, resolvedAt: null } });
    });
  }
  return resolvedCount;
}

/** 修改目标价、阈值或启用状态后重评真实流水；读取与状态写入在同一事务中。 */
export async function reconcileProductAlerts(productId: string, now = new Date()) {
  return prisma.$transaction(async tx => {
    const [product, setting, latest] = await Promise.all([
      tx.product.findUnique({ where: { id: productId } }),
      tx.setting.upsert({ where: { id: 'global' }, create: { id: 'global' }, update: {} }),
      tx.collectionRecord.findFirst({ where: { productId, status: 'success', priceCents: { gt: 0 } }, orderBy: order }),
    ]);
    if (!product) return [];
    if (!latest || !product.enabled) { await deactivateRules(tx, productId, now); return []; }
    return evaluateAlerts(tx, product, latest, setting.dropThresholdPercent, setting.collectionIntervalMinutes, now);
  });
}

/** 升级旧数据库时从已有流水回填规则状态，绝不补造提醒或价格。 */
export async function initializeAlertStates(now = new Date()) {
  let restoredAlerts = 0, initializedProducts = 0;
  let cursor: string | undefined;
  for (;;) {
    const alerts = await prisma.alert.findMany({ where: { collectionIdentity: '' }, orderBy: { id: 'asc' }, take: 200, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
    for (const alert of alerts) {
      const atTrigger = await prisma.collectionRecord.findFirst({ where: { productId: alert.productId, sourceType: alert.sourceType, status: 'success', priceCents: { gt: 0 }, collectedAt: { lte: alert.triggeredAt } }, orderBy: order });
      const identity = atTrigger && atTrigger.priceCents === alert.priceCents ? recordCollectionIdentity(atTrigger) : null;
      if (identity) { await prisma.alert.update({ where: { id: alert.id }, data: { collectionIdentity: identity } }); restoredAlerts++; }
    }
    if (alerts.length < 200) break;
    cursor = alerts.at(-1)!.id;
  }
  cursor = undefined;
  for (;;) {
    const products: { id: string }[] = await prisma.product.findMany({ select: { id: true }, orderBy: { id: 'asc' }, take: 200, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
    for (const { id } of products) {
      await prisma.$transaction(async tx => {
        const [product, latest, setting] = await Promise.all([
          tx.product.findUnique({ where: { id } }),
          tx.collectionRecord.findFirst({ where: { productId: id, status: 'success', priceCents: { gt: 0 } }, orderBy: order }),
          tx.setting.findUnique({ where: { id: 'global' } }),
        ]);
        if (product && latest) await evaluateAlerts(tx, product, latest, setting?.dropThresholdPercent ?? 5, setting?.collectionIntervalMinutes ?? 30, now, { emitNotifications: false });
        else await deactivateRules(tx, id, now);
      });
      initializedProducts++;
    }
    if (products.length < 200) break;
    cursor = products.at(-1)!.id;
  }
  return { restoredAlerts, initializedProducts };
}
