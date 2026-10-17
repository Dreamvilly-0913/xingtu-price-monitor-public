import { createServer, type Server } from 'node:http';
import { gzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { HttpCollector, getJsonPath } from '../src/collectors/http.js';
import type { CollectorConfig, CollectorInput } from '../src/collectors/types.js';
import { compilePriceExtraction, parseHtmlPrice, parseJsonPrice } from '../src/pricing-parser.js';
import { createPinnedAgent, isPublicIp, MAX_HTTP_BODY_BYTES, redactUrl, validateHttpTarget } from '../src/http-safety.js';
import { collectorConfigSchema } from '../src/validation.js';

let assertionCount = 0;
const cases: { name: string; durationMs: number; status: 'passed' }[] = [];
const httpEvidence: { path: string; status: string; priceCents: number | null; failureReason: string | null; httpStatus: number | null; durationMs: number }[] = [];
const began = performance.now();
function check(condition: unknown, message: string) { assertionCount++; assert.ok(condition, message); }
function equal(actual: unknown, expected: unknown, message: string) { assertionCount++; assert.deepEqual(actual, expected, message); }
function throws(fn: () => unknown, message: string) { assertionCount++; assert.throws(fn, message); }
async function test(name: string, fn: () => void | Promise<void>) { const started = performance.now(); await fn(); cases.push({ name, durationMs: Math.round(performance.now() - started), status: 'passed' }); }
async function listen(server: Server): Promise<number> { return new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', () => { const address = server.address(); if (!address || typeof address === 'string') no(new Error('fixture无端口')); else yes(address.port); }); }); }
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>((yes) => server.close(() => yes())); }

let forbiddenHits = 0;
const forbidden = createServer((_req, res) => { forbiddenHits++; res.setHeader('Content-Type', 'application/json'); res.end('{"price":1}'); });
const fixture = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://fixture.invalid').pathname;
  res.setHeader('Content-Type', 'application/json');
  if (path === '/json') res.end('{"price":"5999.00","sensitiveToken":"response-secret"}');
  else if (path === '/numeric') res.end('{"price":1000}');
  else if (path === '/scientific') res.end('{"price":"1e3"}');
  else if (path === '/fraction') res.end('{"price":".99"}');
  else if (path === '/zero') res.end('{"price":0}');
  else if (path === '/inventory') res.end('{"price":"暂无报价，库存3件"}');
  else if (path === '/html') { res.setHeader('Content-Type', 'text/html'); res.end('<span class="price">售价 ¥1,234.56</span>'); }
  else if (path === '/promo') { res.setHeader('Content-Type', 'text/html'); res.end('<span class="price">立减100元，到手价¥5999.00</span>'); }
  else if (path === '/multi-selector') { res.setHeader('Content-Type', 'text/html'); res.end('<span class="price">¥99</span><span class="price">¥199</span>'); }
  else if (path === '/no-price') { res.setHeader('Content-Type', 'text/html'); res.end('<span class="price">暂无报价，库存3件</span>'); }
  else if (path === '/range') { res.setHeader('Content-Type', 'text/html'); res.end('<span class="price">¥99–¥199</span>'); }
  else if (path === '/redirect-ok') { res.statusCode = 302; res.setHeader('Location', '/json?token=redirect-secret'); res.end(); }
  else if (path === '/redirect-private') { const address = forbidden.address(); res.statusCode = 302; res.setHeader('Location', `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 1}/private`); res.end(); }
  else if (path === '/redirect-loop') { res.statusCode = 302; res.setHeader('Location', '/redirect-loop'); res.end(); }
  else if (path === '/slow') { setTimeout(() => { if (!res.destroyed) res.end('{"price":9}'); }, 250); }
  else if (path === '/slow-body') { res.write('{"price":'); setTimeout(() => { if (!res.destroyed) res.end('9}'); }, 250); }
  else if (path === '/large') { res.setHeader('Content-Length', MAX_HTTP_BODY_BYTES + 1); res.end('x'.repeat(MAX_HTTP_BODY_BYTES + 1)); }
  else if (path === '/large-stream') { res.write('x'.repeat(600_000)); res.end('x'.repeat(600_000)); }
  else if (path === '/large-gzip') { res.setHeader('Content-Encoding', 'gzip'); res.end(gzipSync(Buffer.alloc(MAX_HTTP_BODY_BYTES + 1, 'x'))); }
  else if (path === '/invalid-json') { res.setHeader('Content-Type', 'text/html'); res.end('<html>denied response-secret</html>'); }
  else if (path === '/http-error') { res.statusCode = 429; res.end('{"private":"response-secret"}'); }
  else { res.statusCode = 404; res.end('not found'); }
});

const originalAllowlist = process.env.HTTP_ALLOWED_HOSTS;
let fixturePort = 0;
let httpRequests = 0;
function input(path: string, config: CollectorConfig = {}): CollectorInput { return { product: { id: 'collector-isolated-test', platform: 'tmall', url: `http://127.0.0.1:${fixturePort}/product?token=referer-secret`, sku: 'test-1', basePriceCents: 600_000, collectorConfig: JSON.stringify({ mode: 'json', priceUrl: `http://127.0.0.1:${fixturePort}${path}`, jsonPath: 'price', timeoutMs: 1_500, ...config }) }, collectedAt: new Date(), previousPriceCents: null, demoSequence: 0, volatilityPercent: 2.5 }; }
const collector = new HttpCollector();
async function collect(path: string, config: CollectorConfig = {}) {
  httpRequests++;
  const result = await collector.collect(input(path, config));
  const audit = JSON.parse(result.collectorSnapshot!);
  httpEvidence.push({ path: path.split('?')[0]!, status: result.status, priceCents: result.priceCents, failureReason: result.failureReason, httpStatus: audit.httpStatus, durationMs: audit.durationMs });
  return result;
}

try {
  await test('JSON严格数值与金额：10种有效格式', () => {
    for (const [value, expected] of [[5999, 599900], ['5999', 599900], ['5999.00', 599900], ['.99', 99], ['1e3', 100000], ['¥ 5,999.00', 599900], ['￥5999.00元', 599900], ['CNY 5999.00', 599900], ['RMB 5999.00', 599900], ['1，234.56', 123456]] as const) equal(parseJsonPrice(value), expected, `有效金额${value}`);
  });
  await test('JSON拒绝15种歧义/无效金额', () => {
    for (const value of ['暂无报价，库存3件', '立减100元，到手价¥5999.00', '99-199', '售价5999', '1,23', '1 234', '', '¥-99', 0, -1, 0.0001, 21_474_836.48, NaN, Infinity, { price: 99 }]) throws(() => parseJsonPrice(value), `应拒绝${String(value)}`);
  });
  await test('HTML保守唯一价格：6种有效/18种拒绝', () => {
    for (const [value, expected] of [['5999.00', 599900], ['¥5999', 599900], ['售价 ¥1,234.56', 123456], ['现价：￥5999.00', 599900], ['价格 5999 元', 599900], ['.99', 99]] as const) equal(parseHtmlPrice(value), expected, `有效网页售价${value}`);
    for (const value of ['暂无报价，库存3件', '库存3元', '立减100元，到手价¥5999.00', '¥99–¥199', '¥99起', '售价 ¥99 原价 ¥199', '月供 ¥99', '3期 每期 ¥99', '折扣9.9', '¥-9', '99件', '价格待定 ¥99', '暂无售价 ¥99', '暂未报价 ¥99', '已下架 ¥99', '运费 ¥9', '配送费 ¥9', '服务费 ¥9']) throws(() => parseHtmlPrice(value), `拒绝网页歧义${value}`);
  });
  await test('安全价格提取：唯一捕获及危险正则拒绝', () => {
    const pattern = '到手价¥(\\d+(?:\\.\\d{1,2})?)';
    equal(parseHtmlPrice('立减100元，到手价¥5999.00', pattern), 599900, '明确规则应提取真实售价');
    equal(parseHtmlPrice('立减100元，到手价¥5999.00', '到手价¥([0-9]+(?:\\.[0-9]{1,2})?)'), 599900, '数字字符组模板');
    for (const value of ['到手价¥99 到手价¥199', '售价¥99', '暂无报价，到手价¥99', '到手价¥99.999']) throws(() => parseHtmlPrice(value, pattern), '不唯一/无报价/精度不匹配');
    for (const unsafe of ['(.*)', '(a+)+$', '(\\d+)\\1', '(?<=¥)(\\d+)', '¥(\\d+)(\\d+)', '.*到手价¥(\\d+(?:\\.\\d{1,2})?)', '到手价¥(\\d+(?:\\.\\d{1,2})?)+']) throws(() => compilePriceExtraction(unsafe), '危险正则必须拒绝');
    check(collectorConfigSchema.safeParse({ mode: 'html', priceRegex: pattern }).success, 'API接受安全模板');
    check(!collectorConfigSchema.safeParse({ priceRegex: '(a+)+$' }).success, 'API校验拒绝危险模板');
  });
  await test('地址分类：27种特殊地址拒绝、4种公网允许', () => {
    for (const address of ['0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1', '192.0.0.1', '192.0.2.1', '198.18.0.1', '198.19.255.255', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::', '::1', 'fe80::1', 'fc00::1', 'ff02::1', '2001:db8::1', '2002:7f00:1::', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:192.168.1.1', '3fff::1']) check(!isPublicIp(address), `阻止${address}`);
    for (const address of ['8.8.8.8', '1.1.1.1', '2001:4860:4860::8888', '2606:4700:4700::1111']) check(isPublicIp(address), `允许公网${address}`);
  });
  await test('逐次DNS校验：私网/混合答案/异常端口/凭据', async () => {
    process.env.HTTP_ALLOWED_HOSTS = '';
    const signal = new AbortController().signal;
    for (const value of ['http://127.0.0.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://127.1/', 'http://2130706433/', 'http://8.8.8.8:8080/', 'http://user:password@8.8.8.8/', 'file:///etc/passwd']) { assertionCount++; await assert.rejects(() => validateHttpTarget(new URL(value), signal)); }
    assertionCount++; await assert.rejects(() => validateHttpTarget(new URL('https://fixture.invalid'), signal, async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]));
    assertionCount++; await assert.rejects(() => validateHttpTarget(new URL('https://fixture.invalid'), signal, async () => [{ address: '8.8.8.8', family: 6 }]));
    const verified = await validateHttpTarget(new URL('https://fixture.invalid'), signal, async () => [{ address: '8.8.8.8', family: 4 }]);
    equal(verified.address, '8.8.8.8', '公网DNS固定地址');
    const aborted = new AbortController(); setTimeout(() => aborted.abort(), 30);
    assertionCount++; await assert.rejects(() => validateHttpTarget(new URL('https://fixture.invalid'), aborted.signal, async () => new Promise((yes) => setTimeout(() => yes([{ address: '8.8.8.8', family: 4 }]), 150))));
  });
  await listen(forbidden);
  fixturePort = await listen(fixture);
  process.env.HTTP_ALLOWED_HOSTS = `127.0.0.1:${fixturePort},fixture.invalid:${fixturePort}`;
  await test('固定已验证地址建立实际连接，原hostname不存在也可连接fixture', async () => {
    let dnsCalls = 0;
    const target = await validateHttpTarget(new URL(`http://fixture.invalid:${fixturePort}/json`), new AbortController().signal, async () => { dnsCalls++; return [{ address: '127.0.0.1', family: 4 }]; });
    const agent = createPinnedAgent(target);
    try {
      const options: RequestInit & { dispatcher: typeof agent } = { dispatcher: agent };
      const response = await fetch(target.url, options);
      equal(response.status, 200, '固定地址实际HTTP成功');
      check((await response.text()).includes('5999.00'), '收到fixture正文');
      equal(dnsCalls, 1, '连接不再次使用系统DNS');
    } finally { await agent.destroy(); }
  });
  await test('HTTP采集：正常JSON/科学计数/小数/HTML与显式促销价', async () => {
    for (const [path, config, price] of [['/json?token=request-secret', {}, 599900], ['/numeric', {}, 100000], ['/scientific', {}, 100000], ['/fraction', {}, 99], ['/html', { mode: 'html', cssSelector: '.price' }, 123456], ['/promo', { mode: 'html', cssSelector: '.price', priceRegex: '到手价¥(\\d+(?:\\.\\d{1,2})?)' }, 599900]] as const) {
      const result = await collect(path, config); equal(result.status, 'success', `${path}成功`); equal(result.priceCents, price, `${path}整数分`); equal(result.sourceLabel, '真实采集', '来源标记');
      const audit = JSON.parse(result.collectorSnapshot!); equal(audit.httpStatus, 200, 'HTTP状态200'); check(/^[a-f0-9]{64}$/.test(audit.bodySha256), '正文哈希'); check(typeof audit.durationMs === 'number', '耗时'); check(typeof audit.collectionIdentity === 'string', '价格口径身份'); check(!result.collectorSnapshot!.includes('request-secret') && !result.collectorSnapshot!.includes('response-secret') && !result.collectorSnapshot!.includes('referer-secret'), '审计未泄露请求/响应秘密');
    }
  });
  await test('HTTP采集：歧义、无报价、多元素、HTTP/JSON错误均失败且无价格', async () => {
    for (const [path, config, reason] of [['/zero', {}, '大于 0'], ['/inventory', {}, '暂无'], ['/promo', { mode: 'html', cssSelector: '.price' }, '优惠'], ['/multi-selector', { mode: 'html', cssSelector: '.price' }, '唯一'], ['/no-price', { mode: 'html', cssSelector: '.price' }, '暂无'], ['/range', { mode: 'html', cssSelector: '.price' }, '数字'], ['/html', { mode: 'html', cssSelector: '.missing' }, '唯一'], ['/invalid-json', {}, 'JSON'], ['/http-error', {}, 'HTTP 429'], ['/json', { jsonPath: 'notFound' }, '未找到']] as const) {
      const result = await collect(path, config); equal(result.status, 'failure', `${path}失败`); equal(result.priceCents, null, '失败不伪造价格'); check(result.failureReason?.includes(reason), `${path}失败原因${reason}实际${result.failureReason}`); equal(result.sourceLabel, '真实采集', '失败仍真实来源'); check(!result.collectorSnapshot!.includes('response-secret'), '失败审计不含正文秘密');
    }
  });
  await test('逐跳校验：同端点跳转成功、私网异端点与跳转环拒绝', async () => {
    const allowed = await collect('/redirect-ok'); equal(allowed.status, 'success', '合法相对跳转'); equal(allowed.priceCents, 599900, '跳转价格'); const audit = JSON.parse(allowed.collectorSnapshot!); equal(audit.redirects.length, 2, '两次实际响应'); check(!allowed.collectorSnapshot!.includes('redirect-secret'), '跳转token脱敏');
    const denied = await collect('/redirect-private'); equal(denied.status, 'failure', '不允许私网端点跳转'); equal(denied.priceCents, null, '私网没有价格'); equal(forbiddenHits, 0, '禁止端点未收到任何请求'); equal(JSON.parse(denied.collectorSnapshot!).httpStatus, 302, '保留最后真实HTTP状态');
    const loop = await collect('/redirect-loop'); equal(loop.status, 'failure', '跳转环失败'); check(loop.failureReason?.includes('超过 3'), '最大3跳');
  });
  await test('响应体上限：Content-Length、chunked、gzip解压均受1MB限制', async () => {
    for (const path of ['/large', '/large-stream', '/large-gzip']) { const result = await collect(path); equal(result.status, 'failure', `${path}失败`); equal(result.priceCents, null, '超限无价格'); check(result.failureReason?.includes('1 MB'), '具体超限原因'); }
  });
  await test('端到端截止时间：响应头与响应体两种超时', async () => {
    for (const path of ['/slow', '/slow-body']) { const started = performance.now(); const result = await collect(path, { timeoutMs: 100 }); equal(result.status, 'failure', '超时失败'); equal(result.priceCents, null, '超时无价格'); check(result.failureReason?.includes('超时'), '超时原因'); check(performance.now() - started < 500, '超时及时结束'); }
  });
  await test('默认拒绝私网、allowlist仅精确端点、地址参数脱敏与JSON自有字段', async () => {
    process.env.HTTP_ALLOWED_HOSTS = '';
    const denied = await collect('/json'); equal(denied.status, 'failure', '默认不能抓本机'); equal(denied.priceCents, null, '默认私网无价格');
    process.env.HTTP_ALLOWED_HOSTS = '127.0.0.1';
    const noPort = await collect('/json'); equal(noPort.status, 'failure', '裸主机不放行任意端口');
    check(!redactUrl('https://user:pw@example.com/price?token=raw-secret&sku=123').includes('raw-secret'), 'URL查询值脱敏');
    check(!redactUrl('https://user:pw@example.com/price?token=raw-secret').includes('pw'), 'URL凭据脱敏');
    equal(getJsonPath([{ p: '5999' }], '$[0].p'), '5999', '京东数组路径'); equal(getJsonPath({ price: 100 }, 'constructor'), undefined, '原型字段不可取价格');
  });
  const report = { status: 'passed', generatedAt: new Date().toISOString(), cases: cases.length, assertions: assertionCount, httpCollectorRequests: httpRequests, forbiddenEndpointRequests: forbiddenHits, durationMs: Math.round(performance.now() - began), noDatabaseMutation: true, results: cases, httpEvidence };
  const output = resolve(process.cwd(), process.cwd().endsWith('server') ? '../outputs' : 'outputs');
  await mkdir(output, { recursive: true });
  for (const name of ['collector-hardening-verification.json', 'operations-collector.json']) await writeFile(resolve(output, name), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, results: undefined, httpEvidence: undefined }));
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', casesPassed: cases.length, assertions: assertionCount, error: error instanceof Error ? error.stack : String(error) }));
  process.exitCode = 1;
} finally {
  if (originalAllowlist === undefined) delete process.env.HTTP_ALLOWED_HOSTS; else process.env.HTTP_ALLOWED_HOSTS = originalAllowlist;
  await Promise.all([close(fixture), close(forbidden)]);
}
