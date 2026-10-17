import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Agent } from 'undici';
import { buildCollectionIdentity } from '../collection-identity.js';
import { createPinnedAgent, readLimitedText, redactUrl, validateHttpTarget } from '../http-safety.js';
import { parseHtmlPrice, parseJsonPrice } from '../pricing-parser.js';
import type { Collector, CollectorConfig, CollectorInput, CollectorResult } from './types.js';

const browserUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 仅支持对象路径和数组下标，禁止执行配置中的表达式。 */
export function getJsonPath(value: unknown, path: string): unknown {
  const normalized = path.replace(/^\$\.?/, '').replace(/\[(\d+)\]/g, '.$1').replace(/^\./, '');
  if (!normalized) return value;
  if (!/^[\w-]+(?:\.[\w-]+)*$/.test(normalized)) throw new Error(`不支持的 JSON 路径：${path}`);
  return normalized.split('.').reduce<unknown>((current, key) => current != null && typeof current === 'object' && Object.hasOwn(current, key) ? (current as Record<string, unknown>)[key] : undefined, value);
}

interface HttpAudit {
  algorithmVersion: 'http-validated-v2';
  collectionIdentity: string;
  requestUrl: string | null;
  finalUrl: string | null;
  requestRule: { mode: string; jsonPath?: string; cssSelector?: string; priceRegex?: string } | null;
  httpStatus: number | null;
  durationMs: number;
  responseBytes: number | null;
  bodySha256: string | null;
  bodySummary: string | null;
  redirects: { url: string; httpStatus: number; verifiedAddress: string; explicitAllowedHost: boolean }[];
}

/** 真实采集全程不回退到演示源，失败也保留可审计的请求元信息。 */
export class HttpCollector implements Collector {
  async collect(input: CollectorInput): Promise<CollectorResult> {
    const base = { productId: input.product.id, sourceType: 'http' as const, sourceLabel: '真实采集' as const, collectedAt: input.collectedAt };
    const started = performance.now();
    const audit: HttpAudit = { algorithmVersion: 'http-validated-v2', collectionIdentity: buildCollectionIdentity({ ...input.product, sourceType: 'http' }), requestUrl: null, finalUrl: null, requestRule: null, httpStatus: null, durationMs: 0, responseBytes: null, bodySha256: null, bodySummary: null, redirects: [] };
    const agents: Agent[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let requestedUrl = '';
    const snapshot = () => {
      audit.durationMs = Math.round(performance.now() - started);
      return JSON.stringify(audit);
    };
    try {
      const options = JSON.parse(input.product.collectorConfig) as CollectorConfig;
      const useJdDefault = input.product.platform === 'jd' && !options.priceUrl && options.mode !== 'html';
      requestedUrl = options.priceUrl ?? (useJdDefault ? `https://p.3.cn/prices/mgets?skuIds=J_${encodeURIComponent(input.product.sku)}` : input.product.url);
      audit.requestUrl = redactUrl(requestedUrl);
      const jsonPath = options.jsonPath ?? (useJdDefault ? '$[0].p' : 'price');
      audit.requestRule = options.mode === 'html' ? { mode: 'html', cssSelector: options.cssSelector, priceRegex: options.priceRegex } : { mode: 'json', jsonPath };
      const controller = new AbortController();
      const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 10_000, 100), 30_000);
      timer = setTimeout(() => controller.abort(new DOMException('请求超时，采集已取消', 'AbortError')), timeoutMs);
      let nextUrl = new URL(requestedUrl);
      let response: Response | undefined;
      // 手动处理每个跳转：所有实际连接均绑定本轮已校验的 DNS 地址。
      for (let hop = 0; hop <= 3; hop++) {
        const target = await validateHttpTarget(nextUrl, controller.signal);
        audit.finalUrl = redactUrl(target.url);
        const agent = createPinnedAgent(target);
        agents.push(agent);
        const init: RequestInit & { dispatcher: Agent } = { signal: controller.signal, redirect: 'manual', dispatcher: agent, headers: { 'User-Agent': browserUa, Accept: options.mode === 'html' ? 'text/html,application/xhtml+xml' : 'application/json,text/plain,*/*', Referer: new URL(input.product.url).origin } };
        response = await fetch(target.url, init);
        audit.httpStatus = response.status;
        audit.redirects.push({ url: redactUrl(target.url), httpStatus: response.status, verifiedAddress: target.address, explicitAllowedHost: target.explicitAllowedHost });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          await response.body?.cancel();
          if (!location) throw new Error(`HTTP ${response.status} 跳转未提供 Location`);
          if (hop === 3) throw new Error('采集跳转超过 3 次，已终止请求');
          const redirectUrl = new URL(location, target.url);
          if (target.url.protocol === 'https:' && redirectUrl.protocol !== 'https:') throw new Error('采集跳转禁止从 HTTPS 降级到 HTTP');
          nextUrl = redirectUrl;
          continue;
        }
        break;
      }
      if (!response) throw new Error('采集未取得 HTTP 响应');
      if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status} ${response.statusText.replace(/[\r\n]/g, '').slice(0, 60)}`); }
      const body = await readLimitedText(response, controller.signal);
      audit.responseBytes = body.bytes;
      audit.bodySha256 = createHash('sha256').update(body.text).digest('hex');
      controller.signal.throwIfAborted();
      let priceCents: number;
      if (options.mode === 'html') {
        if (!options.cssSelector) throw new Error('网页采集未配置 CSS 选择器');
        const $ = cheerio.load(body.text);
        const elements = $(options.cssSelector);
        audit.bodySummary = `HTML；响应 ${body.bytes} 字节；价格元素匹配 ${elements.length} 个`;
        if (elements.length !== 1) throw new Error(`CSS 选择器必须匹配唯一价格元素，实际匹配 ${elements.length} 个`);
        priceCents = parseHtmlPrice(elements.text(), options.priceRegex);
      } else {
        let data: unknown;
        try { data = JSON.parse(body.text); } catch { audit.bodySummary = `非 JSON 响应；${body.bytes} 字节；可能遭遇拦截`; throw new Error('返回内容不是有效 JSON，可能遭遇拦截'); }
        // 只保存结构摘要与哈希，不落库原文、Cookie、令牌或其它响应值。
        audit.bodySummary = `JSON ${Array.isArray(data) ? `数组(${data.length}项)` : data !== null && typeof data === 'object' ? `对象(${Object.keys(data).length}字段)` : typeof data}；响应 ${body.bytes} 字节`;
        const value = getJsonPath(data, jsonPath);
        if (value == null) throw new Error(`JSON 路径未找到价格：${jsonPath}`);
        priceCents = parseJsonPrice(value);
      }
      // 同步 JSON / HTML 解析也计入截止时间；规则被限制为安全的金额模板。
      if (performance.now() - started >= timeoutMs) throw new DOMException('请求与解析超时，采集已取消', 'AbortError');
      controller.signal.throwIfAborted();
      return { ...base, status: 'success', priceCents, failureReason: null, collectorSnapshot: snapshot() };
    } catch (error) {
      const cause = error instanceof Error && error.cause instanceof Error ? `；${error.cause.message}` : '';
      let reason = error instanceof Error ? error.name === 'AbortError' || error.name === 'TimeoutError' ? '请求与解析超时，采集已取消' : `${error.message}${cause}` : String(error);
      if (requestedUrl) reason = reason.replaceAll(requestedUrl, redactUrl(requestedUrl));
      reason = reason.replace(/[\r\n\t]/g, ' ').slice(0, 400);
      return { ...base, status: 'failure', priceCents: null, failureReason: reason, collectorSnapshot: snapshot() };
    } finally {
      if (timer) clearTimeout(timer);
      // 每轮创建隔离 dispatcher，失败/超时立即销毁，避免遗留连接持有进程。
      await Promise.allSettled(agents.map((agent) => agent.destroy()));
    }
  }
}

/** 配置预览与正式采集复用同一实现；调用者决定是否保存流水。 */
export function probeHttpPrice(input: CollectorInput): Promise<CollectorResult> { return new HttpCollector().collect(input); }
