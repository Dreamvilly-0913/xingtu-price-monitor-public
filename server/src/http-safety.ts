import { lookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import { Agent } from 'undici';

export const MAX_HTTP_BODY_BYTES = 1_048_576;
export interface ValidatedHttpTarget { url: URL; address: string; family: 4 | 6; explicitAllowedHost: boolean }
export type DnsResolver = (hostname: string) => Promise<{ address: string; family: number }[]>;

function ipv4Number(address: string): number {
  return address.split('.').reduce((number, octet) => ((number << 8) | Number(octet)) >>> 0, 0);
}

function ipv4IsPublic(address: string): boolean {
  const number = ipv4Number(address);
  const blocked: [string, number][] = [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]];
  return !blocked.some(([network, prefix]) => (number >>> (32 - prefix)) === (ipv4Number(network) >>> (32 - prefix)));
}

function ipv6Words(address: string): number[] {
  let normalized = address.toLowerCase();
  const dottedTail = normalized.match(/(?:\d{1,3}\.){3}\d{1,3}$/)?.[0];
  if (dottedTail) {
    const number = ipv4Number(dottedTail);
    normalized = normalized.slice(0, -dottedTail.length) + `${(number >>> 16).toString(16)}:${(number & 65_535).toString(16)}`;
  }
  const halves = normalized.split('::');
  const left = halves[0] ? halves[0].split(':').map((part) => parseInt(part, 16)) : [];
  const right = halves[1] ? halves[1].split(':').map((part) => parseInt(part, 16)) : [];
  return halves.length > 1 ? [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right] : left;
}

/** 限定可路由公网地址，涵盖 IPv4、IPv6、IPv4-mapped、6to4 和特殊用途段。 */
export function isPublicIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return ipv4IsPublic(address);
  if (family !== 6 || address.includes('%')) return false;
  const words = ipv6Words(address);
  if (words.length !== 8) return false;
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    const value = ((words[6]! << 16) | words[7]!) >>> 0;
    return ipv4IsPublic(`${value >>> 24}.${(value >>> 16) & 255}.${(value >>> 8) & 255}.${value & 255}`);
  }
  const first = words[0]!;
  if ((first & 0xe000) !== 0x2000) return false;
  if (first === 0x2001 && words[1]! < 0x0200) return false;
  if (first === 0x2001 && words[1] === 0x0db8) return false;
  if (first === 0x2002 || (first === 0x3fff && words[1]! < 0x1000)) return false;
  return true;
}

function hostName(url: URL): string { return url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, ''); }
function effectivePort(url: URL): number { return url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80; }

/** 测试/经审核内部网关只能在进程环境中按 hostname[:port] 逐项明确允许。 */
function endpointIsExplicitlyAllowed(url: URL): boolean {
  const name = hostName(url);
  const port = effectivePort(url);
  return (process.env.HTTP_ALLOWED_HOSTS ?? '').split(',').map((item) => item.trim()).filter(Boolean).some((entry) => {
    try {
      if (entry.includes('://') || entry.includes('@') || entry.includes('/') || entry.includes('?') || entry.includes('#') || entry.includes('*')) return false;
      const allowed = new URL(`http://${entry}`);
      if (hostName(allowed) !== name) return false;
      // 未写端口只能放行标准 HTTP / HTTPS；不允许一个主机项放行全部服务端口。
      const hasExplicitPort = entry.startsWith('[') ? /\]:\d+$/.test(entry) : /:\d+$/.test(entry);
      return hasExplicitPort ? effectivePort(allowed) === port : port === 80 || port === 443;
    } catch { return false; }
  });
}

async function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let listener: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    listener = () => reject(signal.reason ?? new DOMException('请求超时', 'AbortError'));
    signal.addEventListener('abort', listener, { once: true });
  });
  try { return await Promise.race([promise, interrupted]); } finally { if (listener) signal.removeEventListener('abort', listener); }
}

export async function validateHttpTarget(requestedUrl: URL, signal: AbortSignal, resolver: DnsResolver = (hostname) => lookup(hostname, { all: true, verbatim: true })): Promise<ValidatedHttpTarget> {
  const url = new URL(requestedUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('采集地址仅支持 http / https');
  if (url.username || url.password) throw new Error('采集地址禁止携带用户名或密码');
  const port = effectivePort(url);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('采集地址端口无效');
  const name = hostName(url);
  if (!name || name.includes('%')) throw new Error('采集地址主机名无效');
  const explicitAllowedHost = endpointIsExplicitlyAllowed(url);
  if (!explicitAllowedHost && port !== 80 && port !== 443) throw new Error('采集端口仅允许 80 / 443；其他端点需通过 HTTP_ALLOWED_HOSTS 明确审核');
  const literalFamily = isIP(name);
  const addresses = literalFamily ? [{ address: name, family: literalFamily }] : await withAbort(resolver(name), signal);
  signal.throwIfAborted();
  if (!addresses.length) throw new Error('采集地址 DNS 未返回任何地址');
  if (addresses.some((answer) => !isIP(answer.address) || ![4, 6].includes(answer.family) || isIP(answer.address) !== answer.family)) throw new Error('采集地址 DNS 返回无效地址');
  if (!explicitAllowedHost && addresses.some((answer) => !isPublicIp(answer.address))) throw new Error('采集地址解析到本机、内网或特殊用途地址，已阻止请求');
  const selected = [...addresses].sort((a, b) => a.family - b.family)[0]!;
  url.hash = '';
  return { url, address: selected.address, family: selected.family as 4 | 6, explicitAllowedHost };
}

/** lookup 固定本轮已验证地址，保持原 Host/SNI，防止校验后的 DNS rebinding。 */
export function createPinnedAgent(target: ValidatedHttpTarget): Agent {
  const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all) callback(null, [{ address: target.address, family: target.family }]);
    else callback(null, target.address, target.family);
  };
  return new Agent({ connect: { lookup: pinnedLookup, timeout: 30_000 }, connections: 1, pipelining: 0 });
}

export function redactUrl(value: string | URL): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.hash = '';
    url.pathname = url.pathname.split('/').map((part) => part.length > 60 ? '[redacted]' : part).join('/');
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, '[redacted]');
    return url.toString().slice(0, 700);
  } catch { return '[invalid-url]'; }
}

/** 按解压后的流累计，Content-Length 缺失/压缩响应同样不能绕过上限。 */
export async function readLimitedText(response: Response, signal: AbortSignal): Promise<{ text: string; bytes: number }> {
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_HTTP_BODY_BYTES) {
    await response.body?.cancel();
    throw new Error('采集响应超过 1 MB 上限');
  }
  const reader = response.body?.getReader();
  if (!reader) return { text: '', bytes: 0 };
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await withAbort(reader.read(), signal);
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_HTTP_BODY_BYTES) throw new Error('采集响应超过 1 MB 上限');
      chunks.push(part.value);
    }
    return { text: Buffer.concat(chunks, bytes).toString('utf8'), bytes };
  } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
  finally { reader.releaseLock(); }
}
