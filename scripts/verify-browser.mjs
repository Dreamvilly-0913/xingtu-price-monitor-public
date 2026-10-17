import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const webBase = (process.env.WEB_BASE_URL ?? 'http://127.0.0.1:4173').replace(/\/$/, '');
const apiBase = (process.env.API_BASE_URL ?? `${webBase}/api`).replace(/\/$/, '');
const outputDir = fileURLToPath(new URL('../outputs/', import.meta.url));
await mkdir(outputDir, { recursive: true });
const startedAt = new Date().toISOString();
const errors = [];
const steps = [];
const screenshots = [];
let browser;
let page;
let context;
let cleanupProductId;
let token;
let executablePath = process.env.BROWSER_EXECUTABLE_PATH;
if (!executablePath) {
  for (const candidate of [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ]) {
    try { await access(candidate); executablePath = candidate; break; } catch { /* 尝试已安装的下一个浏览器。 */ }
  }
}
const summary = { webBase, apiBase, startedAt, executablePath, passed: false, steps, screenshots, errors };

// 验收通过实际页面点击完成；API 仅用于和页面、曲线最后一点交叉对账。
async function checkpoint(name, details) { steps.push({ name, passed: true, verifiedAt: new Date().toISOString(), ...details }); }
function money(value) { return Number(value).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

try {
  assert.ok(executablePath, '没有发现本机 Edge/Chrome；可设置 BROWSER_EXECUTABLE_PATH');
  browser = await chromium.launch({ executablePath, headless: true, args: ['--disable-gpu'] });
  context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  page = await context.newPage();
  page.setDefaultTimeout(25_000);
  page.on('pageerror', error => errors.push({ type: 'pageerror', message: error.message }));
  page.on('console', message => { if (message.type() === 'error') errors.push({ type: 'console.error', message: message.text() }); });

  async function api(path) {
    const response = await context.request.get(`${apiBase}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status(), 200, `${path} HTTP 必须为 200：${await response.text()}`);
    return response.json();
  }
  async function capture(name) {
    const file = `stage3-${name}.png`;
    await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' }));
    await page.mouse.move(20, 20);
    const notice = page.locator('.ant-message-notice-content').last();
    if (await notice.count()) await notice.waitFor({ state: 'hidden', timeout: 5000 });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${outputDir}/${file}`, fullPage: true });
    screenshots.push(file);
  }
  async function menu(name, pathname) {
    await page.getByRole('menuitem', { name: new RegExp(name) }).click();
    await page.waitForURL(url => url.pathname === pathname);
    await page.waitForLoadState('networkidle');
  }
  async function actualChart(testId) {
    const chart = page.getByTestId(testId);
    await chart.waitFor({ state: 'visible' });
    await page.waitForFunction(id => Number(document.querySelector(`[data-testid="${id}"]`)?.getAttribute('data-point-count')) > 0, testId);
    const dimensions = await chart.boundingBox();
    assert.ok(dimensions && dimensions.width > 100 && dimensions.height > 100, `${testId} 实际图表尺寸不可为空`);
    const canvasCount = await chart.locator('canvas').count();
    assert.ok(canvasCount >= 1, `${testId} 必须实际渲染 ECharts canvas`);
    return { pointCount: Number(await chart.getAttribute('data-point-count')), seriesCount: Number(await chart.getAttribute('data-series-count') ?? 1), canvasCount, width: dimensions.width, height: dimensions.height };
  }
  async function priceText(locator, price) {
    await locator.waitFor({ state: 'visible' });
    await expect(locator).toContainText(money(price), { timeout: 25_000 });
  }

  await page.goto(`${webBase}/login`, { waitUntil: 'networkidle' });
  await page.getByLabel('用户名', { exact: true }).fill('admin');
  await page.getByLabel('密码', { exact: true }).fill('admin123');
  const loginResponsePromise = page.waitForResponse(response => response.url().includes('/api/auth/login') && response.request().method() === 'POST');
  await page.getByRole('button', { name: /登\s*录/ }).click();
  const loginResponse = await loginResponsePromise;
  assert.equal(loginResponse.status(), 200);
  token = (await loginResponse.json()).token;
  assert.ok(token);
  await page.waitForURL(url => url.pathname === '/dashboard');
  const dashboard = await api('/dashboard');
  assert.equal(dashboard.monitoredProductCount, 12);
  const dashboardChart = await actualChart('dashboard-trend-chart');
  assert.ok(dashboard.priceTrends.length >= 1 && dashboard.priceTrends.every(series => series.points.length > 0));
  assert.ok((await page.locator('body').innerText()).includes('演示模拟'));
  const selector = page.getByTestId('dashboard-product-selector');
  const addedProductId = await selector.locator('input[type="checkbox"]:not(:checked)').first().inputValue();
  const addedCheckbox = selector.locator(`input[value="${addedProductId}"]`);
  await addedCheckbox.check();
  await expect(page.getByTestId('dashboard-trend-chart')).toHaveAttribute('data-series-count', String(dashboardChart.seriesCount + 1));
  const chartWithExtraProduct = await actualChart('dashboard-trend-chart');
  const addedSeries = dashboard.priceTrends.find(series => series.productId === addedProductId);
  assert.ok(addedSeries);
  assert.equal(chartWithExtraProduct.pointCount, dashboardChart.pointCount + addedSeries.points.length);
  await addedCheckbox.uncheck();
  await expect(page.getByTestId('dashboard-trend-chart')).toHaveAttribute('data-series-count', String(dashboardChart.seriesCount));
  const chartBounds = await page.getByTestId('dashboard-trend-chart').boundingBox();
  await page.mouse.move(chartBounds.x + chartBounds.width * 0.65, chartBounds.y + chartBounds.height * 0.5);
  await page.waitForTimeout(500);
  assert.ok(!(await page.locator('body').innerText()).includes('NaN'), '真实图表提示不能出现无效金额 NaN');
  await page.mouse.move(20, 20);
  await checkpoint('登录与仪表盘图表', { productCount: dashboard.monitoredProductCount, todayCollectionCount: dashboard.todayCollectionCount, activeAlertCount: dashboard.activeAlertCount, chart: dashboardChart, checkedComparisonProductId: addedProductId, changedSeriesCount: chartWithExtraProduct.seriesCount, changedPointCount: chartWithExtraProduct.pointCount, originalSelectionRestored: true });
  await capture('01-dashboard');

  await menu('监控商品', '/products');
  await page.getByTestId('platform-filter').click();
  await page.locator('.ant-select-dropdown:visible').getByText('京东', { exact: true }).click();
  await page.waitForLoadState('networkidle');
  const jdProducts = await api('/products?platform=jd&pageSize=100');
  assert.equal(jdProducts.total, 4);
  await page.waitForFunction(count => document.querySelectorAll('tr[data-testid^="product-"]').length === count, 4);
  const visibleIds = await page.locator('tr[data-testid^="product-"]').evaluateAll(rows => rows.map(row => row.getAttribute('data-testid').replace('product-', '')));
  assert.deepEqual([...visibleIds].sort(), jdProducts.items.map(product => product.id).sort());
  await checkpoint('商品列表平台筛选', { selectedPlatform: 'jd', displayedCount: visibleIds.length, expectedCount: jdProducts.total, displayedProductIds: visibleIds });
  await capture('02-products-filtered');

  const product = jdProducts.items.find(item => item.id.startsWith('jd-iphone16-'));
  assert.ok(product);
  const row = page.getByTestId(`product-${product.id}`);
  await priceText(page.getByTestId(`product-price-${product.id}`), product.currentPrice);
  await row.getByRole('button', { name: /查看详情/ }).click();
  await page.waitForURL(url => url.pathname === `/products/${product.id}`);
  await page.getByText('30天', { exact: true }).click();
  const detailBefore = await api(`/products/${product.id}?days=30`);
  const detailChartBefore = await actualChart('detail-price-chart');
  assert.equal(detailChartBefore.pointCount, detailBefore.history.length);
  await priceText(page.getByTestId('detail-current-price'), detailBefore.product.currentPrice);
  assert.ok(detailBefore.history.length >= 30);
  await checkpoint('商品详情30天曲线', { productId: product.id, pointCount: detailBefore.history.length, chart: detailChartBefore, currentPrice: detailBefore.product.currentPrice, latestHistoryPrice: detailBefore.history.at(-1).price });

  await menu('监控商品', '/products');
  const rowBeforeCollect = page.getByTestId(`product-${product.id}`);
  await rowBeforeCollect.waitFor({ state: 'visible' });
  const collectResponsePromise = page.waitForResponse(response => response.url().includes(`/api/products/${product.id}/collect`) && response.request().method() === 'POST');
  await rowBeforeCollect.getByRole('button', { name: /立即采集/ }).click();
  const collectResponse = await collectResponsePromise;
  assert.equal(collectResponse.status(), 200);
  const collectionResult = await collectResponse.json();
  assert.equal(collectionResult.collection.status, 'success');
  assert.equal(collectionResult.collection.sourceLabel, '演示模拟');
  assert.notEqual(collectionResult.product.currentPrice, detailBefore.product.currentPrice, '立即采集应产生可见价格变化');
  const movementPercent = Math.abs((collectionResult.product.currentPrice - detailBefore.product.currentPrice) / detailBefore.product.currentPrice * 100);
  assert.ok(movementPercent <= 3);
  await priceText(page.getByTestId(`product-price-${product.id}`), collectionResult.product.currentPrice);
  const displayedListPrice = await page.getByTestId(`product-price-${product.id}`).innerText();
  await page.getByTestId(`product-${product.id}`).getByRole('button', { name: /查看详情/ }).click();
  await page.waitForURL(url => url.pathname === `/products/${product.id}`);
  const detailAfter = await api(`/products/${product.id}?days=30`);
  assert.equal(detailAfter.product.currentPrice, collectionResult.product.currentPrice);
  assert.equal(detailAfter.history.at(-1).price, collectionResult.product.currentPrice);
  assert.equal(detailAfter.history.length, detailBefore.history.length + 1);
  await priceText(page.getByTestId('detail-current-price'), detailAfter.product.currentPrice);
  const detailChartAfter = await actualChart('detail-price-chart');
  assert.equal(detailChartAfter.pointCount, detailAfter.history.length);
  assert.equal(Number(await page.getByTestId('detail-price-chart').getAttribute('data-latest-price')), detailAfter.product.currentPrice);
  await checkpoint('立即采集后列表与详情同步', { productId: product.id, beforePrice: detailBefore.product.currentPrice, afterPrice: detailAfter.product.currentPrice, movementPercent, displayedListPrice, collectionPrice: collectionResult.collection.price, detailCurrentPrice: detailAfter.product.currentPrice, latestHistoryPrice: detailAfter.history.at(-1).price, historyPointCountBefore: detailBefore.history.length, historyPointCountAfter: detailAfter.history.length, chart: detailChartAfter });
  await capture('03-detail-collected');

  await menu('预警中心', '/alerts');
  const alertResult = await api('/alerts?pageSize=100');
  const seedTargets = alertResult.items.filter(alert => alert.rule === 'target' && alert.sourceLabel === '演示模拟' && (alert.productId.startsWith('jd-iphone16-') || alert.productId.startsWith('jd-airpods-')));
  assert.ok(seedTargets.length >= 2, '种子安排的两个已触发预警必须存在');
  for (const alert of seedTargets) await page.getByTestId(`alert-${alert.id}`).waitFor({ state: 'visible' });
  await checkpoint('预警中心种子预警', { totalAlerts: alertResult.total, seedTargetCount: seedTargets.length, seedAlertIds: seedTargets.map(alert => alert.id) });
  await capture('04-alerts');

  await menu('同款比价', '/comparison');
  const comparison = await api('/comparison');
  assert.ok(comparison.groups.length >= 2);
  const verifiedGroups = [];
  for (const group of comparison.groups) {
    const priced = group.products.filter(product => product.currentPrice != null).sort((left, right) => left.currentPrice - right.currentPrice);
    assert.ok(priced.length >= 2);
    assert.equal(group.cheapestPrice, priced[0].currentPrice);
    assert.equal(group.cheapestPlatform, priced[0].platform);
    const cheapestTag = page.getByTestId(`cheapest-${group.id}`);
    await cheapestTag.waitFor({ state: 'visible' });
    const platformName = { jd: '京东', tmall: '天猫', pdd: '拼多多' }[group.cheapestPlatform];
    assert.ok((await cheapestTag.innerText()).includes(platformName));
    await priceText(cheapestTag, group.cheapestPrice);
    verifiedGroups.push({ id: group.id, productCount: group.products.length, cheapestPlatform: group.cheapestPlatform, cheapestPrice: group.cheapestPrice, independentMinimumPrice: priced[0].currentPrice });
  }
  await checkpoint('同款比价最低平台标记', { groupCount: verifiedGroups.length, groups: verifiedGroups });
  await capture('05-comparison');

  // 用临时自建商品真实点击 CRUD；验收结束删除，保持交付目录的12件种子商品。
  await menu('监控商品', '/products');
  await page.getByTestId('product-create').click();
  const createDialog = page.getByRole('dialog', { name: '新增监控商品' });
  const temporaryName = `浏览器验收商品-${Date.now()}`;
  await createDialog.getByLabel('商品名称', { exact: true }).fill(temporaryName);
  await createDialog.getByLabel('分类', { exact: true }).fill('浏览器验收');
  await createDialog.getByLabel('SKU', { exact: true }).fill(`browser-${Date.now()}`);
  await createDialog.getByLabel('商品链接', { exact: true }).fill('https://example.com/browser-acceptance');
  await createDialog.getByLabel('基准价（元）', { exact: true }).fill('100');
  await createDialog.getByLabel('目标价（元）', { exact: true }).fill('90');
  const createPromise = page.waitForResponse(response => new URL(response.url()).pathname === '/api/products' && response.request().method() === 'POST');
  await createDialog.getByRole('button', { name: /创建商品/ }).click();
  const createResponse = await createPromise;
  assert.equal(createResponse.status(), 201);
  const createdProduct = await createResponse.json();
  cleanupProductId = createdProduct.id;
  assert.equal(createdProduct.currentPrice, null);
  await expect(createDialog).not.toBeVisible();
  const temporaryRow = page.getByTestId(`product-${createdProduct.id}`);
  await temporaryRow.waitFor({ state: 'visible' });
  assert.equal((await api('/products?pageSize=100')).total, 13);
  await temporaryRow.getByRole('button', { name: /编辑/ }).click();
  const editDialog = page.getByRole('dialog', { name: '编辑监控商品' });
  await editDialog.getByLabel('目标价（元）', { exact: true }).fill('88');
  const editPromise = page.waitForResponse(response => new URL(response.url()).pathname === `/api/products/${createdProduct.id}` && response.request().method() === 'PUT');
  await editDialog.getByRole('button', { name: /保存修改/ }).click();
  const editResponse = await editPromise;
  assert.equal(editResponse.status(), 200);
  assert.equal((await editResponse.json()).targetPrice, 88);
  await expect(editDialog).not.toBeVisible();
  const disablePromise = page.waitForResponse(response => new URL(response.url()).pathname === `/api/products/${createdProduct.id}` && response.request().method() === 'PUT');
  await page.getByTestId(`product-enabled-${createdProduct.id}`).click();
  const disableResponse = await disablePromise;
  assert.equal(disableResponse.status(), 200);
  assert.equal((await disableResponse.json()).enabled, false);
  await expect(page.getByTestId(`product-enabled-${createdProduct.id}`)).toHaveAttribute('aria-checked', 'false');
  const temporaryCollectPromise = page.waitForResponse(response => new URL(response.url()).pathname === `/api/products/${createdProduct.id}/collect` && response.request().method() === 'POST');
  await temporaryRow.getByRole('button', { name: /立即采集/ }).click();
  const temporaryCollectResponse = await temporaryCollectPromise;
  assert.equal(temporaryCollectResponse.status(), 200);
  const temporaryCollect = await temporaryCollectResponse.json();
  assert.equal(temporaryCollect.collection.status, 'success');
  assert.equal(temporaryCollect.collection.sourceLabel, '演示模拟');
  assert.equal(temporaryCollect.product.enabled, false);
  assert.equal(temporaryCollect.product.currentPrice, temporaryCollect.collection.price);
  await priceText(page.getByTestId(`product-price-${createdProduct.id}`), temporaryCollect.collection.price);
  await temporaryRow.getByRole('button', { name: /^删\s*除$/ }).click();
  const deletePromise = page.waitForResponse(response => new URL(response.url()).pathname === `/api/products/${createdProduct.id}` && response.request().method() === 'DELETE');
  await page.getByRole('button', { name: /确认删除/ }).click();
  const deleteResponse = await deletePromise;
  assert.equal(deleteResponse.status(), 200);
  await expect(temporaryRow).not.toBeVisible();
  cleanupProductId = undefined;
  const restoredProducts = await api('/products?pageSize=100');
  assert.equal(restoredProducts.total, 12);
  await checkpoint('真实页面商品CRUD与关闭监控', { productId: createdProduct.id, createdPrice: null, initialTargetPrice: 90, editedTargetPrice: 88, disabled: true, manualCollectionAfterDisabled: 'success', collectionPrice: temporaryCollect.collection.price, deleted: true, productCountRestored: restoredProducts.total });

  await menu('采集记录', '/collections');
  const records = await api('/collections?pageSize=20');
  await page.getByTestId(`collection-${collectionResult.collection.id}`).waitFor({ state: 'visible' });
  assert.ok(records.items.some(record => record.id === collectionResult.collection.id && record.price === detailAfter.product.currentPrice));
  await menu('系统设置', '/settings');
  const settings = await api('/settings');
  await expect(page.getByLabel('采集间隔（分钟）', { exact: true })).toHaveValue(String(settings.collectionIntervalMinutes));
  for (const source of settings.dataSources) await expect(page.locator('body')).toContainText(source.description);
  await checkpoint('采集记录与系统设置真实数据', { collectionCount: records.total, manualCollectionIdVisible: collectionResult.collection.id, collectionIntervalMinutes: settings.collectionIntervalMinutes, demoVolatilityPercent: settings.demoVolatilityPercent, dropThresholdPercent: settings.dropThresholdPercent, dataSourceCount: settings.dataSources.length });

  // 窄屏只检查可用性和真实页面，避免对布局细节写镜像测试。
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${webBase}/dashboard`, { waitUntil: 'networkidle' });
  const mobileChart = await actualChart('dashboard-trend-chart');
  const pageWidth = await page.evaluate(() => ({ viewportWidth: window.innerWidth, documentWidth: document.documentElement.scrollWidth }));
  assert.ok(pageWidth.documentWidth <= pageWidth.viewportWidth + 2, `窄屏页面不应整体横向溢出：${JSON.stringify(pageWidth)}`);
  await checkpoint('窄屏与浏览器错误', { viewport: { width: 390, height: 844 }, ...pageWidth, chart: mobileChart, javascriptErrorCount: errors.length });
  await capture('06-mobile-dashboard');
  assert.equal(errors.length, 0, `浏览器 JS/console 错误：${JSON.stringify(errors)}`);
  summary.passed = true;
} catch (error) {
  summary.failure = { name: error.name, message: error.message, stack: error.stack };
  if (page) {
    summary.failure.url = page.url();
    await page.screenshot({ path: `${outputDir}/stage3-failure.png`, fullPage: true }).catch(() => undefined);
    summary.failure.pageText = (await page.locator('body').innerText().catch(() => '')).slice(0, 5000);
  }
  process.exitCode = 1;
} finally {
  if (cleanupProductId && context && token) {
    const cleanup = await context.request.delete(`${apiBase}/products/${cleanupProductId}`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
    summary.temporaryProductCleanup = { productId: cleanupProductId, status: cleanup?.status() ?? null, reason: '仅清理本脚本自建商品；原验收失败仍保留并报告' };
  }
  summary.completedAt = new Date().toISOString();
  summary.durationMs = new Date(summary.completedAt).getTime() - new Date(startedAt).getTime();
  await writeFile(`${outputDir}/stage3-browser-verification.json`, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  await browser?.close();
  console.log(JSON.stringify({ passed: summary.passed, stepCount: steps.length, screenshots: screenshots.length, javascriptErrors: errors.length, durationMs: summary.durationMs, failure: summary.failure?.message, output: 'outputs/stage3-browser-verification.json' }));
}
