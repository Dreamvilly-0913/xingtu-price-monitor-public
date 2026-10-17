import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const outputDir = fileURLToPath(new URL('../outputs/', import.meta.url));
await mkdir(outputDir, { recursive: true });
const tag = process.argv[2] ?? 'sandbox';
const protocol = process.argv[3] === 'http' ? 'http' : 'https';
const skus = ['100014348672', '100151490054'];

// 探针仅记录真实 HTTP 返回；连接失败时保留完整错误链，不替换成价格。
function errorDetails(error) {
  if (!(error instanceof Error)) return String(error);
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    code: error.code ?? null,
    cause: error.cause ? errorDetails(error.cause) : null,
    errors: Array.isArray(error.errors) ? error.errors.map(errorDetails) : undefined,
  };
}

const results = [];
for (const sku of skus) {
  const url = `${protocol}://p.3.cn/prices/mgets?skuIds=J_${sku}`;
  const startedAt = new Date().toISOString();
  const start = performance.now();
  let outcome;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        accept: 'application/json,text/plain,*/*',
        referer: `https://item.jd.com/${sku}.html`,
      },
    });
    const body = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { /* 非 JSON 返回仍原样记录。 */ }
    outcome = {
      sku, url, startedAt, completedAt: new Date().toISOString(),
      elapsedMs: Math.round(performance.now() - start),
      receivedHttpResponse: true, status: response.status, statusText: response.statusText,
      contentType: response.headers.get('content-type'), body, parsed,
      structure: Array.isArray(parsed)
        ? { type: 'array', length: parsed.length, firstItemKeys: Object.keys(parsed[0] ?? {}) }
        : { type: parsed === null ? 'non-json' : typeof parsed },
      validPositivePrice: Array.isArray(parsed) && Number(parsed[0]?.p) > 0,
      error: null,
    };
  } catch (error) {
    outcome = {
      sku, url, startedAt, completedAt: new Date().toISOString(),
      elapsedMs: Math.round(performance.now() - start),
      receivedHttpResponse: false, status: null, body: null, structure: null,
      validPositivePrice: false, error: errorDetails(error),
    };
  }
  results.push(outcome);
  console.log(JSON.stringify(outcome));
}
const report = {
  tag,
  verifiedSku: { sku: '100151490054', name: '小米15 12GB+512GB 丁香紫', source: 'https://item.jd.com/100151490054.html', verification: '京东官方商品页的搜索索引标题核验；原 SKU 无法核验商品身份。' },
  results,
};
await writeFile(`${outputDir}/stage0-jd-${tag}.json`, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
