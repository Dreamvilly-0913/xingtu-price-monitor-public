import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { nextDemoPrice } from '../server/dist/src/collectors/demo.js';

const base = (process.env.API_BASE_URL || 'http://127.0.0.1:4010/api').replace(/\/$/, '');
const web = base.replace(/\/api$/, '');
let token = '';
let requests = 0;
let assertions = 0;
const check = (condition, description) => { assert.ok(condition, description); assertions++; };
async function api(path, method = 'GET', payload, status = 200) {
  const response = await fetch(`${base}${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(payload ? { 'Content-Type': 'application/json' } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}) });
  requests++;
  check(response.status === status, `${method} ${path} 状态 ${response.status} 应为 ${status}`);
  return response.json();
}
const output = process.env.VERIFICATION_OUTPUT || fileURLToPath(new URL('../outputs/operations-production-verification.json', import.meta.url));
const round = (value, places = 2) => Number(value.toFixed(places));
const results = [];
let replayedPoints = 0;
try {
  check((await api('/health')).status === 'ok', '健康接口');
  token = (await api('/auth/login', 'POST', { username: process.env.DEMO_USERNAME || 'admin', password: process.env.DEMO_PASSWORD || 'admin123' })).token;
  check(Boolean(token), 'JWT登录');
  const dashboard = await api('/dashboard');
  const listing = await api('/products?pageSize=100');
  check(listing.total === Number(process.env.EXPECTED_PRODUCTS || 12), '监控商品数');
  check(dashboard.monitoredProductCount === listing.total, '仪表盘数量与列表一致');
  const selectedTrends = new Map();
  for (let offset = 0; offset < listing.items.length; offset += 10) {
    const ids = listing.items.slice(offset, offset + 10).map(item => item.id).join(',');
    const selected = await api(`/dashboard?productIds=${encodeURIComponent(ids)}&days=30`);
    for (const trend of selected.priceTrends) selectedTrends.set(trend.productId, trend);
  }
  let totalCollections = 0;
  for (const product of listing.items) {
    const records = [];
    for (let page = 1;; page++) {
      const batch = await api(`/collections?productId=${encodeURIComponent(product.id)}&pageSize=100&page=${page}`);
      records.push(...batch.items);
      if (records.length >= batch.total) break;
    }
    totalCollections += records.length;
    // 与数据库、商品 DTO 和统计函数一致，独立校验同一采集时刻的最终顺序。
    const success = records.filter(item => item.status === 'success').sort((a, b) => a.collectedAt.localeCompare(b.collectedAt) || a.createdAt.localeCompare(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    check(success.length >= 31, `${product.id}至少31条成功记录`);
    const cents = success.map(item => Math.round(item.price * 100));
    let peak = cents[0], drawdown = 0;
    for (const price of cents) { peak = Math.max(peak, price); drawdown = Math.max(drawdown, (peak - price) / peak * 100); }
    const expected = { currentPrice: cents.at(-1) / 100, minPrice: Math.min(...cents) / 100, maxPrice: Math.max(...cents) / 100, avgPrice: Math.round(cents.reduce((sum, item) => sum + item, 0) / cents.length) / 100, maxDrawdownPercent: round(drawdown, 4), pointCount: cents.length };
    const detail = await api(`/products/${product.id}?days=30`);
    const dashboardProduct = dashboard.products.find(item => item.id === product.id);
    const trend = selectedTrends.get(product.id);
    const sourceLabels = [...new Set(success.map(record => record.sourceLabel))].sort();
    for (const item of [product, detail.statistics, dashboardProduct, trend.statistics]) check(JSON.stringify([...item.sourceLabels].sort()) === JSON.stringify(sourceLabels), '统计汇总准确标注全部来源');
    for (const [key, value] of Object.entries(expected)) {
      check(product[key] === value, `${product.id}列表${key}`);
      check(detail.statistics[key] === value, `${product.id}详情${key}`);
      if (key === 'currentPrice') check(dashboardProduct[key] === value, `${product.id}仪表盘${key}`);
      check(trend.statistics[key] === value, `${product.id}走势图统计${key}`);
    }
    check(detail.product.currentPrice === expected.currentPrice && detail.history.at(-1).price === expected.currentPrice && trend.points.at(-1).price === expected.currentPrice, `${product.id}曲线最新点一致`);
    const latestSuccess = success.at(-1);
    check(product.currentPriceSourceType === latestSuccess.sourceType && product.currentPriceSourceLabel === latestSuccess.sourceLabel && product.sourceLabel === latestSuccess.sourceLabel, `${product.id}当前价对应实际采集来源`);
    for (const record of success) {
      check(record.price > 0 && record.sourceLabel === (record.sourceType === 'demo' ? '演示模拟' : '真实采集'), `${product.id}价格及来源`);
      if (record.sourceType === 'demo') {
        const snapshot = record.collectorSnapshot;
        check(snapshot.algorithmVersion === 'fnv1a-xorshift32-v1', '演示快照版本');
        check(nextDemoPrice(snapshot) === Math.round(record.price * 100), '采集输入快照复算');
        replayedPoints++;
      }
    }
    results.push({ productId: product.id, name: product.name, platform: product.platform, ...expected, sourceLabel: product.currentPriceSourceLabel });
  }
  const comparison = await api('/comparison');
  for (const group of comparison.groups) {
    const priced = group.products.filter(item => item.currentPrice != null && item.enabled && !item.isPriceStale);
    if (!priced.length) { check(group.cheapestPrice === null && group.cheapestProductIds.length === 0, '无有效报价不标最便宜'); continue; }
    const minimum = Math.min(...priced.map(item => item.currentPrice));
    check(group.cheapestPrice === minimum, `${group.name}比价最低值`);
    const ids = priced.filter(item => item.currentPrice === minimum).map(item => item.id).sort();
    check(JSON.stringify([...group.cheapestProductIds].sort()) === JSON.stringify(ids), `${group.name}最低平台及并列标记`);
    const representative = priced.find(item => item.id === ids[0]);
    check(group.cheapestProductId === representative.id && group.cheapestPlatform === representative.platform, `${group.name}最低平台稳定代表正确`);
  }
  const alerts = await api('/alerts?pageSize=100');
  check(alerts.items.filter(item => item.rule === 'target').length >= 2, '至少两个目标预警');
  const belowTarget = listing.items.filter(item => item.currentPrice != null && item.currentPrice <= item.targetPrice);
  check(belowTarget.length >= 2, '至少两个商品当前价格已达目标价');
  for (const alert of alerts.items.filter(item => item.isActive && item.rule === 'target')) {
    const product = listing.items.find(item => item.id === alert.productId);
    check(product.enabled && !product.isPriceStale && product.currentPrice <= product.targetPrice, `${alert.productId}活跃目标预警条件仍成立`);
  }
  check(dashboard.activeAlertCount === alerts.activeRuleCount, '仪表盘活跃预警数与当前规则状态一致');
  check(listing.items.some(item => item.maxDrawdownPercent > 10), '至少一个最大跌幅超过10%');
  check((await api('/settings')).dataSources.length === 2, '双轨来源说明');
  check(Boolean((await api('/unknown-route', 'GET', undefined, 404)).error?.code), '未知API统一错误格式');
  for (const path of ['/', '/login', '/dashboard', `/products/${listing.items[0].id}`]) {
    const response = await fetch(`${web}${path}`);
    requests++;
    check(response.status === 200 && (response.headers.get('content-type') || '').includes('text/html'), `生产SPA路由${path}`);
    const html = await response.text();
    const script = html.match(/src="([^"]+\.js)"/);
    check(Boolean(script), 'HTML包含真实构建入口');
    const asset = await fetch(new URL(script[1], web));
    requests++;
    check(asset.ok && (asset.headers.get('content-type') || '').includes('javascript'), '构建资源可访问');
  }
  await mkdir(fileURLToPath(new URL('../outputs', import.meta.url)), { recursive: true });
  const report = { passed: true, verifiedAt: new Date().toISOString(), apiBase: base, requests, assertions, productCount: listing.total, totalCollections, replayedPoints, currentPriceMatchCount: results.length, alertCount: alerts.total, activeAlertCount: dashboard.activeAlertCount, belowTargetCount: belowTarget.length, groups: comparison.groups.map(group => ({ name: group.name, cheapestPlatform: group.cheapestPlatform, cheapestPrice: group.cheapestPrice })), products: results };
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ passed: true, requests, assertions, productCount: listing.total, totalCollections, replayedPoints, currentPriceMatchCount: results.length, alertCount: alerts.total }));
} catch (error) {
  await mkdir(fileURLToPath(new URL('../outputs', import.meta.url)), { recursive: true });
  await writeFile(output, `${JSON.stringify({ passed: false, requests, assertions, error: error.stack || String(error) }, null, 2)}\n`);
  console.error(error.stack || error);
  process.exitCode = 1;
}
