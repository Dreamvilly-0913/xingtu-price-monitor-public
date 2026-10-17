import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const webBase = (process.env.WEB_BASE_URL ?? 'http://127.0.0.1:4010').replace(/\/$/, '');
const outputDir = fileURLToPath(new URL('../outputs/', import.meta.url));
await mkdir(outputDir, { recursive: true });
const summary = { webBase, startedAt: new Date().toISOString(), passed: false, readOnly: true, browserApiGetRequests: 0, mutatingBusinessRequests: [], steps: [], errors: [], screenshots: [] };
let browser;
let page;
let executablePath = process.env.BROWSER_EXECUTABLE_PATH;

// 生产复验只登录及读取页面，防止重复验收改变已对账的采集流水和预警。
try {
  if (!executablePath) {
    for (const candidate of ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe']) {
      try { await access(candidate); executablePath = candidate; break; } catch { /* 查找下一个已安装浏览器。 */ }
    }
  }
  assert.ok(executablePath, '没有发现 Edge/Chrome，可设置 BROWSER_EXECUTABLE_PATH');
  summary.executablePath = executablePath;
  browser = await chromium.launch({ executablePath, headless: true, args: ['--disable-gpu'] });
  summary.browserVersion = browser.version();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  page = await context.newPage();
  page.setDefaultTimeout(25_000);
  page.on('pageerror', error => summary.errors.push({ type: 'pageerror', message: error.message }));
  page.on('console', message => { if (message.type() === 'error') summary.errors.push({ type: 'console.error', message: message.text() }); });
  page.on('request', request => {
    const pathname = new URL(request.url()).pathname;
    if (!pathname.startsWith('/api/')) return;
    if (request.method() === 'GET') summary.browserApiGetRequests += 1;
    else if (pathname !== '/api/auth/login') summary.mutatingBusinessRequests.push({ method: request.method(), pathname });
  });
  const assetFailures = [];
  page.on('response', response => { if (new URL(response.url()).pathname.startsWith('/assets/') && response.status() >= 400) assetFailures.push({ url: response.url(), status: response.status() }); });
  const checkpoint = (name, details) => summary.steps.push({ name, passed: true, ...details });
  const money = value => Number(value).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  async function chart(testId) {
    const target = page.getByTestId(testId);
    await target.waitFor({ state: 'visible' });
    await expect.poll(async () => Number(await target.getAttribute('data-point-count'))).toBeGreaterThan(0);
    const bounds = await target.boundingBox();
    const canvasCount = await target.locator('canvas').count();
    assert.ok(bounds && bounds.width > 100 && bounds.height > 100 && canvasCount > 0, `${testId} 必须真实渲染`);
    return { pointCount: Number(await target.getAttribute('data-point-count')), seriesCount: Number(await target.getAttribute('data-series-count') ?? 1), canvasCount, width: bounds.width, height: bounds.height };
  }
  async function route(pathname, title) {
    const response = await page.goto(`${webBase}${pathname}`, { waitUntil: 'networkidle' });
    assert.equal(response.status(), 200, `${pathname} 的 SPA 路由必须返回 HTTP 200`);
    await expect(page.locator('.page-heading h1')).toHaveText(title);
    assert.ok(!(await page.locator('body').innerText()).includes('正在加载工作台'));
  }
  async function screenshot(name) {
    const filename = `operations-${name}.png`;
    await page.evaluate(() => document.fonts.ready);
    // 等待 ECharts 默认入场动画完成，截图应包含完整扇区与曲线。
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${outputDir}/${filename}`, fullPage: true });
    summary.screenshots.push(filename);
  }
  const loginPageResponse = await page.goto(`${webBase}/login`, { waitUntil: 'networkidle' });
  assert.equal(loginPageResponse.status(), 200);
  await expect(page.getByRole('heading', { name: '欢迎登录' })).toBeVisible();
  await page.getByLabel('用户名', { exact: true }).fill(process.env.ADMIN_USERNAME ?? 'admin');
  await page.getByLabel('密码', { exact: true }).fill(process.env.ADMIN_PASSWORD ?? 'admin123');
  const loginPromise = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/login' && response.request().method() === 'POST');
  await page.getByRole('button', { name: /登\s*录/ }).click();
  const login = await loginPromise;
  assert.equal(login.status(), 200);
  const token = (await login.json()).token;
  assert.ok(token);
  checkpoint('生产静态登录页与 JWT 登录', { pageStatus: 200, loginStatus: login.status() });
  async function api(path) {
    const response = await context.request.get(`${webBase}/api${path}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status(), 200, path);
    return response.json();
  }
  await page.waitForURL(url => url.pathname === '/dashboard');
  const dashboard = await api('/dashboard');
  const trend = await chart('dashboard-trend-chart');
  assert.equal(dashboard.monitoredProductCount, 12);
  const expectedPoints = (await api(`/dashboard?productIds=${dashboard.products.filter(item => item.name.includes('iPhone')).map(item => item.id).join(',')}`)).priceTrends.reduce((total, series) => total + series.points.length, 0);
  assert.equal(trend.pointCount, expectedPoints);
  await expect(page.locator('body')).toContainText('演示模拟');
  await screenshot('01-production-dashboard');
  checkpoint('生产仪表盘真实图表', { productCount: dashboard.monitoredProductCount, todayCollectionCount: dashboard.todayCollectionCount, activeAlertCount: dashboard.activeAlertCount, chart: trend });
  await route('/products', '监控商品');
  const products = await api('/products?pageSize=100');
  assert.equal(products.total, 12);
  const product = products.items.find(item => item.id.startsWith('jd-iphone16-'));
  assert.ok(product);
  await page.getByTestId('platform-filter').click();
  await page.locator('.ant-select-dropdown:visible').getByText('京东', { exact: true }).click();
  await page.waitForLoadState('networkidle');
  await expect(page.getByTestId(`product-price-${product.id}`)).toContainText(money(product.currentPrice));
  checkpoint('生产商品列表价格对账', { productId: product.id, currentPrice: product.currentPrice, productCount: products.total });
  await route(`/products/${product.id}`, product.name);
  const detail = await api(`/products/${product.id}?days=30`);
  const detailChart = await chart('detail-price-chart');
  assert.equal(detailChart.pointCount, detail.history.length);
  assert.equal(detail.history.at(-1).price, product.currentPrice);
  await expect(page.getByTestId('detail-current-price')).toContainText(money(product.currentPrice));
  await screenshot('02-production-detail');
  checkpoint('生产详情曲线与列表同价', { productId: product.id, currentPrice: product.currentPrice, latestPointPrice: detail.history.at(-1).price, chart: detailChart });
  await route('/comparison', '同款比价');
  const comparison = await api('/comparison');
  const groups = [];
  for (const group of comparison.groups) {
    const valid = group.products.filter(item => item.enabled && !item.isPriceStale && item.currentPrice != null);
    if (!valid.length) { assert.equal(group.cheapestPrice, null); await expect(page.getByTestId(`cheapest-${group.id}`)).toHaveCount(0); continue; }
    const minimumPrice = Math.min(...valid.map(item => item.currentPrice));
    assert.equal(group.cheapestPrice, minimumPrice);
    const expectedPlatformName = { jd: '京东', tmall: '天猫', pdd: '拼多多' }[group.cheapestPlatform];
    const tag = page.getByTestId(`cheapest-${group.id}`);
    await expect(tag).toContainText(expectedPlatformName);
    await expect(tag).toContainText(money(group.cheapestPrice));
    groups.push({ groupId: group.id, cheapestPlatform: group.cheapestPlatform, cheapestPrice: group.cheapestPrice, independentlyCalculatedMinimum: minimumPrice });
  }
  checkpoint('生产比价最便宜平台', { groupCount: groups.length, groups });
  await route('/collections', '采集记录');
  const collections = await api('/collections?pageSize=20');
  await expect(page.getByTestId(`collection-${collections.items[0].id}`)).toBeVisible();
  await expect(page.locator('body')).toContainText('演示模拟');
  checkpoint('生产采集流水', { collectionCount: collections.total, latestCollectionIdVisible: collections.items[0].id });
  await route('/alerts', '预警中心');
  const alerts = await api('/alerts?pageSize=100');
  const targets = alerts.items.filter(alert => alert.rule === 'target' && alert.isActive);
  assert.equal(targets.length, dashboard.activeAlertCount);
  for (const target of targets) await expect(page.getByTestId(`alert-${target.id}`)).toBeVisible();
  checkpoint('生产预警已落库', { totalAlerts: alerts.total, activeTargetAlertCount: targets.length });
  await route('/settings', '系统设置');
  const settings = await api('/settings');
  await expect(page.getByLabel('采集间隔（分钟）', { exact: true })).toHaveValue(String(settings.collectionIntervalMinutes));
  for (const source of settings.dataSources) await expect(page.locator('body')).toContainText(source.description);
  checkpoint('生产设置与双轨源说明', { intervalMinutes: settings.collectionIntervalMinutes, dataSourceCount: settings.dataSources.length });
  await page.setViewportSize({ width: 390, height: 844 });
  await route('/dashboard', '运营仪表盘');
  await chart('dashboard-trend-chart');
  await page.getByRole('button', { name: '打开导航' }).click();
  const drawer = page.locator('.ant-drawer-body');
  await expect(drawer).toBeVisible();
  await drawer.getByRole('menuitem', { name: /系统设置/ }).click();
  await page.waitForURL(url => url.pathname === '/settings');
  await expect(drawer).not.toBeVisible();
  await expect(page.getByLabel('采集间隔（分钟）', { exact: true })).toHaveValue(String(settings.collectionIntervalMinutes));
  const dimensions = await page.evaluate(() => ({ viewportWidth: window.innerWidth, documentWidth: document.documentElement.scrollWidth }));
  assert.ok(dimensions.documentWidth <= dimensions.viewportWidth + 2);
  await screenshot('03-production-mobile-settings');
  assert.equal(summary.errors.length, 0, JSON.stringify(summary.errors));
  assert.equal(assetFailures.length, 0, JSON.stringify(assetFailures));
  assert.equal(summary.mutatingBusinessRequests.length, 0, JSON.stringify(summary.mutatingBusinessRequests));
  checkpoint('生产移动导航和懒加载资源', { ...dimensions, javascriptErrorCount: summary.errors.length, assetHttpFailureCount: assetFailures.length, mutatingBusinessRequestCount: summary.mutatingBusinessRequests.length });
  summary.passed = true;
} catch (error) {
  summary.failure = { name: error.name, message: error.message, stack: error.stack, url: page?.url() };
  if (page) await page.screenshot({ path: `${outputDir}/operations-production-browser-failure.png`, fullPage: true }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  summary.completedAt = new Date().toISOString();
  summary.durationMs = new Date(summary.completedAt).getTime() - new Date(summary.startedAt).getTime();
  await writeFile(`${outputDir}/operations-production-browser-verification.json`, `${JSON.stringify(summary, null, 2)}\n`);
  await browser?.close();
  console.log(JSON.stringify({ passed: summary.passed, readOnly: summary.readOnly, steps: summary.steps.length, errors: summary.errors.length, durationMs: summary.durationMs, failure: summary.failure?.message, output: 'outputs/operations-production-browser-verification.json' }));
}
