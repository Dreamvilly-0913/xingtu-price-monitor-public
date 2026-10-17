import type { Alert, AlertRuleState, CollectionRecord } from '@prisma/client';
import { fromCents } from './utils.js';

interface ProductLabel { name: string; platform: string }
export function serializeCollection(record: CollectionRecord & { product?: ProductLabel }) {
  return { id: record.id, productId: record.productId, productName: record.product?.name, platform: record.product?.platform, sourceType: record.sourceType, sourceLabel: record.sourceLabel, status: record.status, price: fromCents(record.priceCents), failureReason: record.failureReason, collectedAt: record.collectedAt.toISOString(), createdAt: record.createdAt.toISOString(), trigger: record.trigger, runId: record.runId, collectorSnapshot: JSON.parse(record.collectorSnapshot) as Record<string, unknown> };
}
export function serializeAlert(alert: Alert & { product?: ProductLabel; currentRuleState?: AlertRuleState | null }) {
  return { id: alert.id, productId: alert.productId, productName: alert.product?.name, platform: alert.product?.platform, rule: alert.rule, price: fromCents(alert.priceCents), threshold: alert.threshold, message: alert.message, sourceType: alert.sourceType, sourceLabel: alert.sourceLabel, triggeredAt: alert.triggeredAt.toISOString(), readAt: alert.readAt?.toISOString() ?? null, resolvedAt: alert.resolvedAt?.toISOString() ?? null,
    // 保存触发时采用的 24 小时基线，后续有新价格仍能逐条对账。
    baselineRecordId: alert.baselineRecordId, baselinePrice: fromCents(alert.baselinePriceCents), baselineCollectedAt: alert.baselineCollectedAt?.toISOString() ?? null, baselineSourceType: alert.baselineSourceType,
    // resolvedAt 保留原提醒解除时间；当前是否触发由规则状态决定，冷却重入不修改历史。
    isActive: Boolean(alert.currentRuleState?.active && alert.currentRuleState.lastAlertId === alert.id),
    activePrice: alert.currentRuleState?.active ? fromCents(alert.currentRuleState.priceCents) : null,
    activeThreshold: alert.currentRuleState?.active ? alert.currentRuleState.threshold : null,
    activeMessage: alert.currentRuleState?.active ? alert.currentRuleState.message : null,
    activeSince: alert.currentRuleState?.activeSince?.toISOString() ?? null,
    stateEvaluatedAt: alert.currentRuleState?.evaluatedAt.toISOString() ?? null };
}

export function serializeAlertRuleState(state: AlertRuleState & { product?: ProductLabel }) {
  return { id: state.id, productId: state.productId, productName: state.product?.name, platform: state.product?.platform, rule: state.rule, active: state.active,
    price: fromCents(state.priceCents), threshold: state.threshold, message: state.message, sourceType: state.sourceType, sourceLabel: state.sourceLabel,
    activeSince: state.activeSince?.toISOString() ?? null, evaluatedAt: state.evaluatedAt.toISOString(), lastAlertId: state.lastAlertId,
    baselineRecordId: state.baselineRecordId, baselinePrice: fromCents(state.baselinePriceCents), baselineCollectedAt: state.baselineCollectedAt?.toISOString() ?? null, baselineSourceType: state.baselineSourceType };
}
