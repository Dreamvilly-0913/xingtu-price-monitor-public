/** 不从营销文案中的第一个数字猜价格。金额必须完整匹配，最终以整数分保存。 */
const numericPattern = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const groupedPattern = /^[1-9]\d{0,2}(?:,\d{3})+(?:\.\d+)?$/;
const absentPricePattern = /暂(?:无|未)(?:报价|价格|售价)|无报价|价格待定|询价|面议|已售罄|售罄|缺货|无货|暂无货|暂不销售|已下架/i;
const ambiguousHtmlPattern = /立减|满减|优惠|优惠券|补贴|返现|分期|每期|期数|月供|首付|定金|订金|尾款|运费|邮费|配送费|服务费|起售|起价|低至|起$|原价|划线价|市场价|库存|销量|已售|评价|件|折/i;
const captureTemplates = ['(\\d+(?:\\.\\d{1,2})?)', '([0-9]+(?:\\.[0-9]{1,2})?)', '(\\d+(?:\\.\\d+)?)', '([0-9]+(?:\\.[0-9]+)?)', '(\\d[\\d,]*(?:\\.\\d{1,2})?)'];

function amountToCents(text: string): number {
  const normalized = text.replace(/，/g, ',');
  if (!numericPattern.test(normalized) && !groupedPattern.test(normalized)) throw new Error('价格格式不明确：需要一个完整的数字或金额字符串');
  const price = Number(normalized.replace(/,/g, ''));
  if (!Number.isFinite(price) || price <= 0) throw new Error('价格必须为大于 0 的有限金额');
  const cents = Math.round(price * 100);
  if (cents <= 0 || cents > 2_147_483_647) throw new Error('价格超出可存储的有效金额范围');
  return cents;
}

/** JSON 价格字段只能是数值，或完整金额；库存、折扣、价格区间均不视为价格。 */
export function parseJsonPrice(value: unknown): number {
  if (typeof value === 'number') return amountToCents(String(value));
  if (typeof value !== 'string' || !value.trim() || value.length > 256) throw new Error('价格字段为空、过长或不是数字/金额文本');
  const text = value.trim();
  if (absentPricePattern.test(text)) throw new Error('页面明确表示暂无可用报价');
  const bare = text.replace(/^(?:[¥￥]|CNY\s*|RMB\s*)\s*/i, '').replace(/\s*元$/, '').trim();
  return amountToCents(bare);
}

function decodeLiteral(text: string): string {
  // 禁止用户配置可产生回溯的任意正则。常用的标点转义可直接还原为字面量。
  let literal = '';
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === '\\') {
      const next = text[++index];
      if (!next || !/[\\^$.*+?()[\]{}|/]/.test(next)) throw new Error('价格提取规则只允许字面量前后缀和一个标准金额捕获组');
      literal += next;
    } else {
      if (/[\\^$.*+?()[\]{}|]/.test(char)) throw new Error('价格提取规则禁止额外分组、通配符、断言和量词');
      literal += char;
    }
  }
  return literal;
}

export function compilePriceExtraction(pattern: string): { prefix: string; suffix: string; startsAtBeginning: boolean; endsAtEnd: boolean; amountPattern: string } {
  if (!pattern || pattern.length > 200) throw new Error('价格提取规则长度必须为 1–200');
  const template = captureTemplates.find((candidate) => pattern.includes(candidate));
  if (!template || pattern.indexOf(template) !== pattern.lastIndexOf(template)) throw new Error('价格提取规则必须且只能包含一个标准金额捕获组，例如 (\\d+(?:\\.\\d{1,2})?)');
  const split = pattern.indexOf(template);
  let prefix = pattern.slice(0, split);
  let suffix = pattern.slice(split + template.length);
  const startsAtBeginning = prefix.startsWith('^');
  const endsAtEnd = suffix.endsWith('$') && !suffix.endsWith('\\$');
  if (startsAtBeginning) prefix = prefix.slice(1);
  if (endsAtEnd) suffix = suffix.slice(0, -1);
  return { prefix: decodeLiteral(prefix), suffix: decodeLiteral(suffix), startsAtBeginning, endsAtEnd, amountPattern: template };
}

/** 有意识地配置提取规则后，可以从含促销文字的元素中抽取唯一售价。 */
function extractConfiguredPrice(text: string, pattern: string): number {
  const config = compilePriceExtraction(pattern);
  const candidates: string[] = [];
  const amount = /\d[\d,，]*(?:\.\d+)?/g;
  const exactAmount = new RegExp(`^${config.amountPattern}$`);
  for (const match of text.matchAll(amount)) {
    const index = match.index!;
    const end = index + match[0].length;
    if (!exactAmount.test(match[0].replace(/，/g, ','))) continue;
    if (index > 0 && /[\d.]/.test(text[index - 1]!)) continue;
    if (end < text.length && /[\d.]/.test(text[end]!)) continue;
    const prefixStart = index - config.prefix.length;
    if (prefixStart < 0 || text.slice(prefixStart, index) !== config.prefix || text.slice(end, end + config.suffix.length) !== config.suffix) continue;
    if (config.startsAtBeginning && prefixStart !== 0) continue;
    if (config.endsAtEnd && end + config.suffix.length !== text.length) continue;
    candidates.push(match[0]);
  }
  if (candidates.length !== 1) throw new Error(`价格提取规则需唯一匹配，实际匹配 ${candidates.length} 个金额`);
  return amountToCents(candidates[0]!);
}

/** 网页文本只接受单一且有明确含义的价格；复杂元素应缩小选择器或显式提取。 */
export function parseHtmlPrice(value: string, priceRegex?: string): number {
  const text = value.replace(/\u00a0/g, ' ').trim();
  if (!text || text.length > 1_000) throw new Error('价格元素为空或超过 1000 字符，请缩小 CSS 选择器');
  if (absentPricePattern.test(text)) throw new Error('页面明确表示暂无可用报价');
  if (priceRegex) return extractConfiguredPrice(text, priceRegex);
  try { return parseJsonPrice(text); } catch { /* 有金额标记的简单文案在下一步判断。 */ }
  if (ambiguousHtmlPattern.test(text)) throw new Error('价格文本包含优惠、分期或多种售价，请缩小选择器或配置唯一价格提取规则');
  const tokens = [...text.matchAll(/(?:\d[\d,，]*(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/g)];
  if (tokens.length !== 1) throw new Error(`价格文本包含 ${tokens.length} 个数字，无法唯一确定售价`);
  const token = tokens[0]!;
  const before = text.slice(0, token.index).trimEnd();
  const after = text.slice(token.index! + token[0].length).trimStart();
  if (/(?:-|−|–|~|～|至)\s*$/.test(before) || /^(?:-|−|–|~|～|至)/.test(after)) throw new Error('价格区间或负数不能作为确定售价');
  if (!/(?:[¥￥]|CNY|RMB)\s*$/i.test(before) && !/^元(?:\s|$|[，。；,.;])/.test(after)) throw new Error('价格文本没有明确的货币标记，请缩小选择器');
  return amountToCents(token[0]);
}
