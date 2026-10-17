import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

// 运营验收只运行在专用隔离服务；初始化与改密不会触碰正式运营数据库。
const fixturePath = process.env.OPERATIONS_FIXTURE_PATH || fileURLToPath(new URL('../work/operations-browser-fixture.json', import.meta.url));
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const webBase = (process.env.WEB_BASE_URL || fixture.webBase || 'http://127.0.0.1:4399').replace(/\/$/, '');
const apiBase = (process.env.API_BASE_URL || `${webBase}/api`).replace(/\/$/, '');
for (const base of [webBase, apiBase]) {
  const location = new URL(base);
  assert.ok(['127.0.0.1', 'localhost'].includes(location.hostname) && location.port === '4399', '运营浏览器验收仅允许本机4399隔离服务');
}
const username = process.env.OPERATIONS_USERNAME || 'ops-admin';
const initialPassword = process.env.OPERATIONS_PASSWORD || 'Ops-browser-acceptance-2026';
const newPassword = process.env.OPERATIONS_NEW_PASSWORD || `${initialPassword}-updated`;
const bootstrapToken = process.env.BOOTSTRAP_TOKEN || fixture.bootstrapToken;
const outputDir = fileURLToPath(new URL('../outputs/', import.meta.url));
await mkdir(outputDir, { recursive: true });
const summary = { startedAt: new Date().toISOString(), webBase, apiBase, passed: false, steps: [], screenshots: [], errors: [] };
let browser, page, context, token;
let executablePath = process.env.BROWSER_EXECUTABLE_PATH;
for (const path of ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe']) {
  if (executablePath) break;
  try { await access(path); executablePath = path; } catch { /* 尝试另一个本机浏览器。 */ }
}
const money = value => Number(value).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
async function checkpoint(name, details) { summary.steps.push({ name, passed: true, ...details }); }
async function capture(name) {
  const path = `${outputDir}/operations-browser-${name}.png`;
  await page.screenshot({ path, fullPage: true });
  summary.screenshots.push({ name, file: path });
}
async function api(path, method = 'GET', body) {
  const response = await context.request.fetch(`${apiBase}${path}`, { method, headers: token ? { Authorization: `Bearer ${token}` } : {}, ...(body ? { data: body } : {}) });
  const result = await response.json();
  assert.ok(response.ok(), `${method} ${path}: HTTP${response.status()} ${JSON.stringify(result)}`);
  return result;
}
async function chart(testId) {
  const locator = page.getByTestId(testId);
  await locator.waitFor({ state: 'visible' });
  await expect(locator.locator('canvas')).toHaveCount(1);
  const bounds = await locator.boundingBox();
  assert.ok(bounds && bounds.width > 200 && bounds.height > 200);
  return { renderedPointCount: Number(await locator.getAttribute('data-point-count')), rawPointCount: Number(await locator.getAttribute('data-raw-point-count')), sampled: await locator.getAttribute('data-sampled') === 'true', seriesCount: Number(await locator.getAttribute('data-series-count')) };
}
async function navigate(route) { await page.goto(`${webBase}${route}`, { waitUntil: 'networkidle' }); await expect(page.getByTestId('header-unread-count')).toBeVisible(); }
async function clickForResponse(locator, path, method = 'POST') {
  // 立即处理等待Promise的异常，保证点击失败时仍能保存浏览器原始诊断。
  let responseFailure;
  const pending = page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === method).catch(error => { responseFailure = error; return null; });
  await locator.click();
  const response = await pending;
  if (!response) throw responseFailure;
  return response;
}

try {
  assert.ok(executablePath, '未找到本机Edge/Chrome');
  browser = await chromium.launch({ executablePath, headless: true, args: ['--disable-gpu'] });
  context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  page = await context.newPage();
  page.setDefaultTimeout(25_000);
  page.on('pageerror', error => summary.errors.push({ type: 'pageerror', message: error.message }));
  page.on('console', message => { if (message.type() === 'error') summary.errors.push({ type: 'console.error', message: message.text() }); });

  await page.goto(`${webBase}/login`, { waitUntil: 'networkidle' });
  const initialStatus = await api('/auth/status');
  assert.equal(initialStatus.bootstrapRequired, true, '此验收需专用空用户数据库');
  assert.equal(initialStatus.demoEnabled, false);
  await expect(page.getByRole('heading', { name: '初始化运营管理员' })).toBeVisible();
  await expect(page.getByTestId('demo-account')).toHaveCount(0);
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('管理员姓名', { exact: true }).fill('隔离验收运营管理员');
  if (initialStatus.bootstrapTokenRequired) await page.getByLabel('初始化令牌', { exact: true }).fill(bootstrapToken);
  await page.getByLabel('管理员密码', { exact: true }).fill(initialPassword);
  await page.getByLabel('确认管理员密码', { exact: true }).fill(initialPassword);
  const initialSessionResponse = await clickForResponse(page.getByRole('button', { name: '创建管理员并进入' }), '/api/auth/bootstrap');
  assert.equal(initialSessionResponse.status(), 201);
  const initialSession = await initialSessionResponse.json();
  token = initialSession.token;
  await page.waitForURL(url => url.pathname === '/dashboard');
  await expect(page.getByTestId('header-unread-count')).toBeVisible();
  assert.equal((await api('/auth/status')).bootstrapRequired, false);
  await checkpoint('生产空库初始化', { initializationStatus: 201, demoEnabled: false, bootstrapTokenRequired: initialStatus.bootstrapTokenRequired, defaultAccountHintVisible: false, createdUsername: initialSession.user.username });
  await capture('01-bootstrap-dashboard');

  await navigate('/settings');
  await page.getByLabel('当前密码', { exact: true }).fill(initialPassword);
  await page.getByLabel('新密码', { exact: true }).fill(newPassword);
  await page.getByLabel('确认新密码', { exact: true }).fill(newPassword);
  const changed = await clickForResponse(page.getByRole('button', { name: /修改密码/ }), '/api/auth/change-password');
  assert.equal(changed.status(), 200);
  token = (await changed.json()).token;
  const oldSessionResponse = await context.request.get(`${apiBase}/auth/me`, { headers: { Authorization: `Bearer ${initialSession.token}` } });
  assert.equal(oldSessionResponse.status(), 401);
  assert.equal((await api('/auth/me')).username, username);
  // 清除会话并使用登录表单重新登录，确认新密码和会话恢复都可用。
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${webBase}/login`, { waitUntil: 'networkidle' });
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(newPassword);
  const loggedIn = await clickForResponse(page.getByRole('button', { name: /^登\s*录$/ }), '/api/auth/login');
  assert.equal(loggedIn.status(), 200);
  token = (await loggedIn.json()).token;
  await page.waitForURL(url => url.pathname === '/dashboard');
  await checkpoint('改密与真实页面重新登录', { oldTokenStatus: oldSessionResponse.status(), newSessionStatus: 200, loginStatus: 200 });

  const liveId = fixture.liveProductId;
  const staleId = fixture.staleProductId;
  assert.ok(liveId && staleId && fixture.comparisonGroupId && fixture.farGroupName && fixture.farCategory);
  const liveDetail = await api(`/products/${liveId}?days=30`);
  const staleDetail = await api(`/products/${staleId}?days=30`);
  assert.equal(liveDetail.product.isPriceStale, false);
  assert.equal(staleDetail.product.isPriceStale, true);
  assert.ok(staleDetail.product.currentPrice < liveDetail.product.currentPrice);
  await navigate('/comparison');
  const comparison = (await api('/comparison')).groups.find(group => group.id === fixture.comparisonGroupId);
  assert.ok(comparison);
  assert.equal(comparison.freshCheapestPrice, liveDetail.product.currentPrice);
  await expect(page.getByTestId(`price-freshness-${staleId}`)).toHaveAttribute('data-stale', 'true');
  await expect(page.getByTestId(`cheapest-${fixture.comparisonGroupId}`)).toContainText(money(liveDetail.product.currentPrice));
  await expect(page.getByTestId(`comparison-product-${staleId}`)).not.toHaveClass(/is-cheapest/);
  await checkpoint('过期报价保留但排除有效最低', { oldPrice: staleDetail.product.currentPrice, oldPriceAgeMinutes: staleDetail.product.priceAgeMinutes, livePrice: liveDetail.product.currentPrice, freshCheapestPrice: comparison.freshCheapestPrice, freshCheapestIds: comparison.freshCheapestProductIds });
  await capture('02-fresh-comparison');

  await navigate('/products');
  const search = page.getByPlaceholder('搜索商品名称或 SKU');
  await search.fill(liveDetail.product.name);
  await search.press('Enter');
  const liveRow = page.getByTestId(`product-${liveId}`);
  await expect(liveRow).toBeVisible();
  await liveRow.getByRole('button', { name: '编辑', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '编辑监控商品' });
  const recordCountBefore = (await api('/collections?pageSize=1')).total;
  const previewHttp = await clickForResponse(editor.getByTestId('collector-preview'), '/api/collectors/preview');
  assert.equal(previewHttp.status(), 200);
  const preview = await previewHttp.json();
  assert.equal(preview.status, 'success');
  assert.equal(preview.sourceLabel, '真实采集');
  assert.ok(preview.price > 0);
  await expect(editor.getByTestId('collector-preview-result')).toContainText(money(preview.price));
  const recordsAfterPreview = (await api('/collections?pageSize=1')).total;
  assert.equal(recordsAfterPreview, recordCountBefore);
  const farSearch = editor.getByLabel('商品组', { exact: true });
  await farSearch.fill(fixture.farGroupName);
  await page.locator('.ant-select-dropdown:visible').getByTitle(fixture.farGroupName, { exact: true }).click();
  const farGroups = await api(`/groups?page=1&pageSize=20&search=${encodeURIComponent(fixture.farGroupName)}`);
  assert.ok(farGroups.items.some(group => group.id === fixture.farGroupId));
  await checkpoint('真实配置预览与第100组之后远程搜索', { previewPrice: preview.price, sourceLabel: preview.sourceLabel, collectionCountBefore: recordCountBefore, collectionCountAfter: recordsAfterPreview, farGroupId: fixture.farGroupId, totalGroups: (await api('/groups?pageSize=1')).total });
  await capture('03-preview-and-far-group');
  await editor.getByRole('button', { name: /取\s*消/ }).click();
  await expect(editor).not.toBeVisible();
  await search.fill('');
  await search.press('Enter');
  const categoryFilter = page.locator('.filter-toolbar').getByRole('combobox', { name: '分类', exact: true });
  await categoryFilter.fill(fixture.farCategory);
  await page.locator('.ant-select-dropdown:visible').getByTitle(fixture.farCategory, { exact: true }).click();
  const farProducts = await api(`/products?category=${encodeURIComponent(fixture.farCategory)}&pageSize=100`);
  assert.ok(farProducts.total > 0);
  for (const product of farProducts.items) await expect(page.getByTestId(`product-${product.id}`)).toBeVisible();
  await checkpoint('第100类之后分类可筛选', { farCategory: fixture.farCategory, matchingProducts: farProducts.total, totalCategories: (await api('/categories')).items.length });

  await navigate('/alerts');
  const unread = await api('/alerts?status=unread&pageSize=100');
  assert.ok(unread.total > 0);
  await expect(page.getByTestId('header-unread-count')).toHaveAttribute('data-count', String(unread.total));
  const unreadAlert = unread.items.find(alert => alert.productId === liveId) || unread.items[0];
  await page.getByTestId(`alert-${unreadAlert.id}`).getByRole('button', { name: /标记已读/ }).click();
  await expect(page.getByTestId('header-unread-count')).toHaveAttribute('data-count', String(unread.total - 1));
  const unreadAfter = await api('/alerts?status=unread&pageSize=1');
  assert.equal(unreadAfter.total, unread.total - 1);
  await checkpoint('标记已读后铃铛立即同步', { unreadBefore: unread.total, unreadAfter: unreadAfter.total, readAlertId: unreadAlert.id });

  await navigate(`/products/${liveId}`);
  const detailChart = await chart('detail-price-chart');
  assert.equal(detailChart.renderedPointCount, liveDetail.history.length);
  assert.equal(detailChart.rawPointCount, liveDetail.historyPointCount ?? liveDetail.history.length);
  assert.equal(detailChart.sampled, liveDetail.historySampled === true);
  await expect(page.getByTestId('detail-current-price')).toContainText(money(liveDetail.product.currentPrice));
  if (detailChart.sampled) await expect(page.getByTestId('detail-history-note')).toContainText('已经采样');
  await checkpoint('真实历史曲线与统计元信息', { detailChart, latestSuccessfulPrice: liveDetail.product.currentPrice, historySourceLabels: [...new Set(liveDetail.history.map(point => point.sourceLabel))] });

  await navigate('/dashboard');
  const selector = page.getByTestId('dashboard-product-selector');
  const liveCheckbox = selector.locator(`input[value="${liveId}"]`);
  await expect(liveCheckbox).toBeVisible();
  let unchecked = 0;
  while (await selector.locator('input:checked').count()) {
    assert.ok(unchecked < 10, '仪表盘勾选项取消应在10次内结束');
    await selector.locator('input:checked').first().uncheck();
    unchecked += 1;
  }
  await liveCheckbox.check();
  await expect(page.getByTestId('dashboard-trend-chart')).toHaveAttribute('data-series-count', '1');
  const chartBefore = await chart('dashboard-trend-chart');
  const selectedDashboard = await api(`/dashboard?days=30&productIds=${encodeURIComponent(liveId)}`);
  const trend = selectedDashboard.priceTrends.find(item => item.productId === liveId);
  assert.ok(trend);
  assert.equal(chartBefore.renderedPointCount, trend.points.length);
  assert.equal(chartBefore.rawPointCount, trend.pointCount ?? trend.points.length);
  // 从另一API调用模拟后台调度写入，页面依靠正常30秒轮询更新，不调用DOM刷新事件。
  const collectResult = await api(`/products/${liveId}/collect`, 'POST');
  assert.equal(collectResult.collection.status, 'success');
  assert.equal(collectResult.collection.sourceLabel, '真实采集');
  await expect(page.getByTestId('dashboard-trend-chart')).toHaveAttribute('data-raw-point-count', String(chartBefore.rawPointCount + 1), { timeout: 45_000 });
  const chartAfter = await chart('dashboard-trend-chart');
  const afterDetail = await api(`/products/${liveId}?days=30`);
  assert.equal(afterDetail.product.currentPrice, collectResult.collection.price);
  assert.equal(afterDetail.history.at(-1).price, collectResult.collection.price);
  await checkpoint('常驻仪表盘自动显示后台新采集', { before: chartBefore, after: chartAfter, collectionPrice: collectResult.collection.price, latestHistoryPrice: afterDetail.history.at(-1).price, pollingWithoutNavigationOrRefresh: true });
  await capture('04-live-dashboard');

  await navigate('/collections');
  await expect(page.getByTestId(`collection-${collectResult.collection.id}`)).toBeVisible();
  await navigate('/settings');
  await expect(page.getByTestId('production-readiness')).toContainText('真实运营模式');
  await expect(page.getByLabel('采集间隔（分钟）', { exact: true })).toBeVisible();
  await checkpoint('运营设置和真实采集流水', { manualCollectionIdVisible: collectResult.collection.id, productionReadinessVisible: true, javascriptErrorCount: summary.errors.length });
  assert.equal(summary.errors.length, 0, JSON.stringify(summary.errors));
  summary.passed = true;
} catch (error) {
  summary.failure = { name: error.name, message: error.message, stack: error.stack, url: page?.url() };
  if (page) { await page.screenshot({ path: `${outputDir}/operations-browser-failure.png`, fullPage: true }).catch(() => undefined); summary.failure.pageText = (await page.locator('body').innerText().catch(() => '')).slice(0, 6000); }
  process.exitCode = 1;
} finally {
  summary.completedAt = new Date().toISOString();
  summary.durationMs = new Date(summary.completedAt).getTime() - new Date(summary.startedAt).getTime();
  await writeFile(`${outputDir}/operations-browser-verification.json`, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  await browser?.close();
  console.log(JSON.stringify({ passed: summary.passed, stepCount: summary.steps.length, screenshotCount: summary.screenshots.length, javascriptErrors: summary.errors.length, durationMs: summary.durationMs, failure: summary.failure?.message, output: 'outputs/operations-browser-verification.json' }));
}
