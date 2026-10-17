import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { prisma } from './db.js';
import { loadProductDto, loadProductDtos, loadProductSummaries } from './stats.js';
import { serializeAlert, serializeAlertRuleState, serializeCollection } from './serializers.js';
import { ApiError, businessDayStart, fromCents, toCents } from './utils.js';
import { collectProduct } from './collection-service.js';
import { CollectionScheduler } from './scheduler.js';
import { groupSchema, idSchema, paginationSchema, productSchema, settingsSchema } from './validation.js';
import { getDashboard } from './dashboard.js';
import { loadPriceHistory } from './history-query.js';
import { reconcileProductAlerts } from './alerts.js';
import { config } from './config.js';
import { publicUser, securePassword, tokenPayload } from './auth-service.js';
import { probeHttpPrice } from './collectors/http.js';

const includeLabel = { product: { select: { name: true, platform: true } } };
const includeAlertState = { ...includeLabel, currentRuleState: true };
const collectionOrder: Prisma.CollectionRecordOrderByWithRelationInput[] = [{ collectedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }];

async function requireProduct(id: string) {
  const product = await prisma.product.findUnique({ where: { id }, include: { group: true } });
  if (!product) throw new ApiError(404, 'PRODUCT_NOT_FOUND', '监控商品不存在');
  return product;
}
async function checkGroup(id: string | null | undefined) {
  if (id && !(await prisma.productGroup.findUnique({ where: { id } }))) throw new ApiError(400, 'INVALID_GROUP', '商品组不存在');
}
function productData(body: z.infer<typeof productSchema>) {
  return { name: body.name, platform: body.platform, url: body.url, sku: body.sku, category: body.category, basePriceCents: toCents(body.basePrice), targetPriceCents: toCents(body.targetPrice), sourceType: body.sourceType, collectorConfig: JSON.stringify(body.collectorConfig), enabled: body.enabled, groupId: body.groupId ?? null };
}
function requireAllowedSource(sourceType: string) {
  if (!config.demoEnabled && sourceType === 'demo') throw new ApiError(403, 'DEMO_DISABLED', '运营模式已关闭演示采集，请配置真实采集');
}

export async function registerPrivateRoutes(app: FastifyInstance, scheduler: CollectionScheduler) {
  app.get('/api/auth/me', async (request) => {
    const payload = request.user as { sub: string };
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) throw new ApiError(401, 'UNAUTHORIZED', '用户不存在，请重新登录');
    return publicUser(user);
  });
  app.post('/api/auth/change-password', async (request) => {
    const body = z.object({ oldPassword: z.string().min(1).max(100), newPassword: securePassword }).strict().parse(request.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: (request.user as { sub: string }).sub } });
    if (!(await bcrypt.compare(body.oldPassword, user.passwordHash))) throw new ApiError(400, 'INVALID_PASSWORD', '原密码不正确');
    if (body.oldPassword === body.newPassword) throw new ApiError(400, 'PASSWORD_UNCHANGED', '新密码必须与原密码不同');
    const updated = await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(body.newPassword, 10), tokenVersion: { increment: 1 }, mustChangePassword: false } });
    return { success: true, token: app.jwt.sign(tokenPayload(updated)), user: publicUser(updated) };
  });
  app.get('/api/dashboard', async request => {
    const query = z.object({ days: z.coerce.number().refine(value => [7, 30, 90].includes(value)).default(30), summaryOnly: z.enum(['true','false']).optional(), productIds: z.string().max(1200).optional() }).parse(request.query);
    const ids = query.productIds?.split(',').filter(Boolean);
    if (ids && (ids.length > 10 || ids.some(id => id.length > 100))) throw new ApiError(400, 'TOO_MANY_PRODUCTS', '曲线每次最多对比10件商品');
    return getDashboard(new Date(), { days: query.days, summaryOnly: query.summaryOnly === 'true', productIds: ids });
  });
  app.get('/api/categories', async () => {
    const categories = await prisma.product.findMany({ select: { category: true }, distinct: ['category'], where: config.demoEnabled ? {} : { sourceType: 'http' }, orderBy: { category: 'asc' } });
    return { items: categories.map(item => item.category) };
  });

  app.get('/api/products', async (request) => {
    const query = paginationSchema.extend({ search: z.string().max(100).optional(), platform: z.enum(['jd', 'tmall', 'pdd']).optional(), category: z.string().max(50).optional(), status: z.enum(['enabled', 'disabled', 'failing']).optional(), sourceType: z.enum(['demo', 'http']).optional(), groupId: z.string().max(100).optional() }).parse(request.query);
    const where: Prisma.ProductWhereInput = { ...(query.search ? { OR: [{ name: { contains: query.search } }, { sku: { contains: query.search } }] } : {}), ...(query.platform ? { platform: query.platform } : {}), ...(query.category ? { category: query.category } : {}), ...(query.sourceType ? { sourceType: query.sourceType } : {}), ...(query.groupId ? { groupId: query.groupId } : {}), ...(query.status === 'enabled' ? { enabled: true } : query.status === 'disabled' ? { enabled: false } : {}) };
    if (!config.demoEnabled) where.sourceType = 'http';
    if (query.status === 'failing') {
      // 只查每件商品最后尝试的状态，价格历史不进入分页筛选内存。
      const failures = await prisma.$queryRaw<{ productId: string }[]>`SELECT "productId" FROM (SELECT "productId", "status", ROW_NUMBER() OVER (PARTITION BY "productId" ORDER BY "collectedAt" DESC, "createdAt" DESC, "id" DESC) AS position FROM "CollectionRecord") AS latest WHERE position = 1 AND "status" = 'failure'`;
      where.id = { in: failures.map(item => item.productId) };
    }
    const [products, total] = await Promise.all([prisma.product.findMany({ where, include: { group: true }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }), prisma.product.count({ where })]);
    return { items: await loadProductDtos(products), total, page: query.page, pageSize: query.pageSize };
  });
  app.post('/api/products', async (request, reply) => {
    const body = productSchema.parse(request.body);
    requireAllowedSource(body.sourceType);
    await checkGroup(body.groupId);
    const product = await prisma.product.create({ data: productData(body) });
    return reply.code(201).send(await loadProductDto(product.id));
  });
  app.put('/api/products/:id', async (request) => {
    const { id } = idSchema.parse(request.params);
    const body = productSchema.parse(request.body);
    requireAllowedSource(body.sourceType);
    await requireProduct(id);
    await checkGroup(body.groupId);
    // 编辑基准价若造成演示游走约束无解，拒绝保存，保留可连续复算的历史。
    const latest = (await prisma.collectionRecord.findFirst({ where: { productId: id, status: 'success' }, orderBy: collectionOrder }))?.priceCents;
    const nextBase = toCents(body.basePrice);
    if (body.sourceType === 'demo' && latest != null && (latest < Math.ceil(nextBase * 0.6) || latest > Math.floor(nextBase * 1.3))) throw new ApiError(400, 'DEMO_BASE_PRICE_CONFLICT', '已有最新价格超出新基准价的 60%–130%，请调整基准价或新建商品');
    await prisma.product.update({ where: { id }, data: productData(body) });
    await reconcileProductAlerts(id);
    return loadProductDto(id);
  });
  app.delete('/api/products/:id', async (request) => {
    const { id } = idSchema.parse(request.params);
    await requireProduct(id);
    await prisma.product.delete({ where: { id } });
    return { success: true };
  });
  app.get('/api/products/:id', async (request) => {
    const { id } = idSchema.parse(request.params);
    const { days } = z.object({ days: z.coerce.number().refine((value) => [7, 30, 90].includes(value)).default(30) }).parse(request.query);
    await requireProduct(id);
    const [product, history, collections, alerts, currentRules] = await Promise.all([loadProductDto(id), loadPriceHistory(id, days), prisma.collectionRecord.findMany({ where: { productId: id }, orderBy: collectionOrder, take: 50, include: includeLabel }), prisma.alert.findMany({ where: { productId: id }, orderBy: [{ triggeredAt: 'desc' }, { id: 'desc' }], take: 50, include: includeAlertState }), prisma.alertRuleState.findMany({ where: { productId: id, active: true }, include: includeLabel, orderBy: { rule: 'asc' } })]);
    const { currentPrice, minPrice, maxPrice, avgPrice, maxDrawdownPercent, pointCount, sourceLabels } = product;
    return { product, statistics: { currentPrice, minPrice, maxPrice, avgPrice, maxDrawdownPercent, pointCount, sourceLabels }, history: history.points, historyPointCount: history.pointCount, historySampled: history.sampled, collections: collections.map(serializeCollection), alerts: alerts.map(serializeAlert), currentRules: currentRules.map(serializeAlertRuleState) };
  });
  app.post('/api/products/:id/collect', async (request) => { const { id } = idSchema.parse(request.params); return collectProduct(id); });

  app.get('/api/groups', async (request) => {
    const { page, pageSize, search } = paginationSchema.extend({ search: z.string().max(100).optional() }).parse(request.query);
    const where = search ? { name: { contains: search } } : {};
    const [groups, total] = await Promise.all([prisma.productGroup.findMany({ where, include: { _count: { select: { products: true } } }, orderBy: [{ name: 'asc' }, { id: 'asc' }], skip: (page - 1) * pageSize, take: pageSize }), prisma.productGroup.count({ where })]);
    return { items: groups.map((group) => ({ id: group.id, name: group.name, productCount: group._count.products })), total, page, pageSize };
  });
  app.post('/api/groups', async (request, reply) => { const body = groupSchema.parse(request.body); const group = await prisma.productGroup.create({ data: body }); return reply.code(201).send({ id: group.id, name: group.name }); });
  app.put('/api/groups/:id', async (request) => { const { id } = idSchema.parse(request.params); const group = await prisma.productGroup.update({ where: { id }, data: groupSchema.parse(request.body) }); return { id: group.id, name: group.name }; });
  app.delete('/api/groups/:id', async (request) => { const { id } = idSchema.parse(request.params); await prisma.productGroup.delete({ where: { id } }); return { success: true }; });
  app.get('/api/comparison', async () => {
    const groups = await prisma.productGroup.findMany({ include: { products: { where: config.demoEnabled ? {} : { sourceType: 'http' }, include: { group: true }, orderBy: { platform: 'asc' } } }, orderBy: { name: 'asc' } });
    const dtos = await loadProductDtos(groups.flatMap(group => group.products));
    const byId = new Map(dtos.map(product => [product.id, product]));
    return { groups: groups.map((group) => {
      const products = group.products.map(product => byId.get(product.id)!);
      const cheapest = products.filter((product) => product.currentPrice != null).sort((a, b) => a.currentPrice! - b.currentPrice! || a.id.localeCompare(b.id))[0];
      const fresh = products.filter(product => product.currentPrice != null && !product.isPriceStale && product.enabled).sort((a,b) => a.currentPrice! - b.currentPrice! || a.id.localeCompare(b.id))[0];
      // 常规比价字段也只采用有效报价，防止接口消费者误把三天前低价当作现价。
      const validIds = fresh ? products.filter(product => !product.isPriceStale && product.enabled && product.currentPrice === fresh.currentPrice).map(product => product.id) : [];
      return { id: group.id, name: group.name, cheapestPlatform: fresh?.platform ?? null, cheapestProductId: fresh?.id ?? null, cheapestPrice: fresh?.currentPrice ?? null, cheapestProductIds: validIds, freshCheapestProductId: fresh?.id ?? null, freshCheapestPlatform: fresh?.platform ?? null, freshCheapestPrice: fresh?.currentPrice ?? null, freshCheapestProductIds: validIds, lastKnownCheapestPrice: cheapest?.currentPrice ?? null, lastKnownCheapestPlatform: cheapest?.platform ?? null, mixedSources: new Set(products.filter(product => product.currentPrice != null).map(product => product.currentPriceSourceType)).size > 1, products };
    }) };
  });

  app.get('/api/collections', async (request) => {
    const query = paginationSchema.extend({ productId: z.string().max(100).optional(), runId: z.string().max(100).optional(), status: z.enum(['success', 'failure']).optional(), sourceType: z.enum(['demo', 'http']).optional() }).parse(request.query);
    const where: Prisma.CollectionRecordWhereInput = { ...(query.productId ? { productId: query.productId } : {}), ...(query.runId ? { runId: query.runId } : {}), ...(query.status ? { status: query.status } : {}), ...(query.sourceType ? { sourceType: query.sourceType } : {}) };
    const [records, total] = await Promise.all([prisma.collectionRecord.findMany({ where, include: includeLabel, orderBy: [{ collectedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }), prisma.collectionRecord.count({ where })]);
    return { items: records.map(serializeCollection), total, page: query.page, pageSize: query.pageSize };
  });
  app.get('/api/alerts', async (request) => {
    const query = paginationSchema.extend({ productId: z.string().max(100).optional(), rule: z.enum(['target', 'drop24h']).optional(), status: z.enum(['unread', 'read', 'active']).optional() }).parse(request.query);
    const where: Prisma.AlertWhereInput = { ...(query.productId ? { productId: query.productId } : {}), ...(query.rule ? { rule: query.rule } : {}), ...(query.status === 'unread' ? { readAt: null } : query.status === 'read' ? { readAt: { not: null } } : query.status === 'active' ? { currentRuleState: { is: { active: true } } } : {}) };
    const stateWhere: Prisma.AlertRuleStateWhereInput = { active: true, ...(query.productId ? { productId: query.productId } : {}), ...(query.rule ? { rule: query.rule } : {}) };
    if (!config.demoEnabled) { where.sourceType = 'http'; where.product = { sourceType: 'http' }; }
    if (!config.demoEnabled) { stateWhere.sourceType = 'http'; stateWhere.product = { sourceType: 'http' }; }
    const [alerts, total, currentRules, activeRuleCount] = await Promise.all([prisma.alert.findMany({ where, include: includeAlertState, orderBy: [{ triggeredAt: 'desc' }, { id: 'desc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }), prisma.alert.count({ where }), prisma.alertRuleState.findMany({ where: stateWhere, include: includeLabel, orderBy: [{ activeSince: 'desc' }, { id: 'desc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }), prisma.alertRuleState.count({ where: stateWhere })]);
    // items/total 只描述真实提醒流水；没有历史提醒的升级状态也能在 currentRules 中如实展示。
    return { items: alerts.map(serializeAlert), total, currentRules: currentRules.map(serializeAlertRuleState), activeRuleCount, page: query.page, pageSize: query.pageSize };
  });
  app.patch('/api/alerts/:id/read', async (request) => { const { id } = idSchema.parse(request.params); const alert = await prisma.alert.update({ where: { id }, data: { readAt: new Date() }, include: includeAlertState }); return serializeAlert(alert); });
  app.post('/api/alerts/read-all', async () => { const result = await prisma.alert.updateMany({ where: { readAt: null }, data: { readAt: new Date() } }); return { updatedCount: result.count }; });

  const getSettings = async () => {
    const settings = await prisma.setting.upsert({ where: { id: 'global' }, create: { id: 'global' }, update: {} });
    const [defaultPasswords, demoProducts, realProducts, failedProducts] = await Promise.all([prisma.user.count({ where: { mustChangePassword: true } }), prisma.product.count({ where: { sourceType: 'demo' } }), prisma.product.count({ where: { sourceType: 'http', enabled: true } }), prisma.collectionRecord.count({ where: { status: 'failure', collectedAt: { gte: new Date(Date.now() - 86_400_000) } } })]);
    const real = await prisma.product.findMany({ where: { sourceType: 'http', enabled: true }, include: { group: true } });
    const summaries = await loadProductSummaries(real, new Date(), settings.collectionIntervalMinutes);
    const validRealProducts = summaries.filter(product => product.currentPrice != null && !product.isPriceStale).length;
    const blockers = [...(defaultPasswords ? ['存在默认密码管理员，请先修改密码'] : []), ...(!realProducts ? ['尚无启用的真实采集商品，请先配置商品并完成试采'] : !validRealProducts ? ['启用的真实商品均无有效报价，请完成成功采集并核对配置'] : [])];
    const warnings = [...(config.demoEnabled ? ['当前允许演示数据；正式运营应设置 DEMO_ENABLED=false'] : []), ...(demoProducts ? [`保留${demoProducts}件演示商品；运营模式不采集、不参与商品列表及比价`] : []), ...(failedProducts ? [`过去24小时有${failedProducts}次采集失败，请检查记录`] : [])];
    return { collectionIntervalMinutes: settings.collectionIntervalMinutes, demoVolatilityPercent: settings.demoVolatilityPercent, dropThresholdPercent: settings.dropThresholdPercent, productionReadiness: { demoEnabled: config.demoEnabled, defaultPasswordDetected: defaultPasswords > 0, enabledRealProductCount: realProducts, validRealProductCount: validRealProducts, blockers, warnings }, scheduler: await scheduler.snapshot(), dataSources: [
      { type: 'demo', label: '演示模拟', description: '按商品 ID 与业务日期生成确定性伪随机游走；仅用于演示与验收。所有价格与日志明确标注演示模拟。' },
      { type: 'http', label: '真实采集', description: '请求配置的 JSON 接口或网页，按 JSON 路径或 CSS 选择器解析实际响应；失败如实记录原因，不生成替代价格。京东默认尝试公开价格接口。' },
    ] };
  };
  app.get('/api/settings', getSettings);
  app.put('/api/settings', async (request) => { const body = settingsSchema.parse(request.body); await prisma.setting.upsert({ where: { id: 'global' }, create: { id: 'global', ...body }, update: body }); const products = await prisma.product.findMany({ select: { id: true } }); for (const product of products) await reconcileProductAlerts(product.id); return getSettings(); });
  app.post('/api/scheduler/run', async () => scheduler.run());
  app.get('/api/scheduler/runs', async (request) => { const { page, pageSize } = paginationSchema.parse(request.query); const [items, total] = await Promise.all([prisma.collectionRun.findMany({ orderBy: { startedAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }), prisma.collectionRun.count()]); return { items, total, page, pageSize }; });
  app.get('/api/audit-logs', async request => { const { page, pageSize } = paginationSchema.parse(request.query); const [items,total] = await Promise.all([prisma.auditLog.findMany({ orderBy: [{ createdAt: 'desc' },{ id: 'desc' }], skip: (page - 1) * pageSize, take: pageSize }), prisma.auditLog.count()]); return { items: items.map(item => ({ ...item, metadata: JSON.parse(item.metadata) })), total, page, pageSize }; });
  app.post('/api/collectors/preview', async request => {
    const body = productSchema.parse(request.body);
    if (body.sourceType !== 'http') throw new ApiError(400, 'HTTP_PREVIEW_REQUIRED', '配置试采仅支持真实采集');
    const result = await probeHttpPrice({ product: { id: 'configuration-preview', ...productData(body) }, collectedAt: new Date(), previousPriceCents: null, demoSequence: 0, volatilityPercent: 0 });
    const snapshot = JSON.parse(result.collectorSnapshot ?? '{}') as Record<string,unknown>;
    return { status: result.status, price: fromCents(result.priceCents), collectedAt: result.collectedAt.toISOString(), sourceLabel: result.sourceLabel, failureReason: result.failureReason, requestUrl: snapshot.finalUrl ?? snapshot.requestUrl, collectorSnapshot: snapshot, persisted: false };
  });
}
