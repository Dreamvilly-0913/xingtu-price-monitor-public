import bcrypt from 'bcrypt';
import { prisma } from '../src/db.js';
import { DemoCollector } from '../src/collectors/demo.js';
import type { CollectorResult } from '../src/collectors/types.js';
import { calculateStats } from '../src/stats.js';
import { businessDayStart, fromCents } from '../src/utils.js';
import { initializeAlertStates } from '../src/alerts.js';

const catalog = [
  { slug: 'jd-iphone16', name: 'iPhone 16 128G', platform: 'jd', sku: '100128110216', base: 5999, category: '手机', groupId: 'group-iphone16', requireShape: true },
  { slug: 'jd-airpods', name: 'AirPods Pro 2', platform: 'jd', sku: '100038004359', base: 1899, category: '耳机', groupId: 'group-airpods', requireShape: true },
  { slug: 'jd-xiaomi15', name: '小米 15', platform: 'jd', sku: '100139262749', base: 4499, category: '手机' },
  { slug: 'jd-switch', name: 'Switch OLED', platform: 'jd', sku: '100028990592', base: 2599, category: '游戏机' },
  { slug: 'tmall-iphone16', name: 'iPhone 16 128G', platform: 'tmall', sku: 'iphone16-128', base: 5999, category: '手机', groupId: 'group-iphone16' },
  { slug: 'tmall-sony', name: '索尼 WH-1000XM5', platform: 'tmall', sku: 'sony-wh1000xm5', base: 2299, category: '耳机' },
  { slug: 'tmall-dyson', name: '戴森 V12', platform: 'tmall', sku: 'dyson-v12', base: 4290, category: '清洁家电' },
  { slug: 'tmall-matepad', name: '华为 MatePad 11.5', platform: 'tmall', sku: 'matepad-115', base: 1899, category: '平板' },
  { slug: 'pdd-iphone16', name: 'iPhone 16 128G', platform: 'pdd', sku: 'iphone16-128-pdd', base: 5399, category: '手机', groupId: 'group-iphone16' },
  { slug: 'pdd-airpods', name: 'AirPods Pro 2', platform: 'pdd', sku: 'airpods-pro2-pdd', base: 1549, category: '耳机', groupId: 'group-airpods' },
  { slug: 'pdd-haier', name: '海尔冰箱 BCD-216', platform: 'pdd', sku: 'haier-bcd216', base: 1499, category: '冰箱' },
  { slug: 'pdd-midea', name: '美的空调 1.5 匹', platform: 'pdd', sku: 'midea-ac15', base: 2299, category: '空调' },
];

const collector = new DemoCollector();
const now = new Date();
const todayStart = businessDayStart(now);
const historyDates = Array.from({ length: 31 }, (_, index) => index === 30 ? now : new Date(todayStart.getTime() - (30 - index) * 86_400_000 + 12 * 3_600_000));

async function makeRecords(id: string, item: (typeof catalog)[number]): Promise<CollectorResult[]> {
  let previousPriceCents = item.base * 100;
  const records: CollectorResult[] = [];
  for (const date of historyDates) {
    const record = await collector.collect({ product: { id, platform: item.platform, url: '', sku: item.sku, basePriceCents: item.base * 100, collectorConfig: '{}' }, collectedAt: date, previousPriceCents, demoSequence: 0, volatilityPercent: 2.5 });
    records.push(record);
    previousPriceCents = record.priceCents!;
  }
  return records;
}

export async function seed() {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_RESET !== 'true') throw new Error('生产环境禁止重建演示数据；首次演示初始化必须显式设置 ALLOW_DEMO_RESET=true');
  const initialPasswordHash = await bcrypt.hash('admin123', 10);
  return prisma.$transaction(async (db) => {
  // 事务仅重建约定前缀的演示商品，保留自建商品、采集轮次、设置与已修改密码。
  await db.product.deleteMany({ where: { OR: catalog.map((item) => ({ id: { startsWith: `${item.slug}-` } })) } });
  await db.setting.upsert({ where: { id: 'global' }, create: { id: 'global' }, update: {} });
  await db.user.upsert({ where: { username: 'admin' }, create: { username: 'admin', displayName: '星图运营管理员', passwordHash: initialPasswordHash, mustChangePassword: true }, update: {} });
  const iphoneGroup = await db.productGroup.upsert({ where: { name: 'iPhone 16 128G' }, create: { id: 'group-iphone16', name: 'iPhone 16 128G' }, update: {} });
  const airpodsGroup = await db.productGroup.upsert({ where: { name: 'AirPods Pro 2' }, create: { id: 'group-airpods', name: 'AirPods Pro 2' }, update: {} });
  const groupIds: Record<string, string> = { 'group-iphone16': iphoneGroup.id, 'group-airpods': airpodsGroup.id };

  const summary: unknown[] = [];
  for (const item of catalog) {
    const targetPriceCents = Math.round(item.base * 100 * 0.95);
    let id = `${item.slug}-0`;
    let records = await makeRecords(id, item);
    let attempt = 0;
    // 选择可复算的商品 ID，使验收形态自然来自游走函数；不修改采集价格。
    if (item.requireShape) {
      while (records.at(-1)!.priceCents! > targetPriceCents || calculateStats(records).maxDrawdownPercent <= 10) {
        attempt++;
        if (attempt > 10_000) throw new Error(`无法找到满足演示形态的确定性种子：${item.slug}`);
        id = `${item.slug}-${attempt}`;
        records = await makeRecords(id, item);
      }
    }
    const url = item.platform === 'jd' ? `https://item.jd.com/${item.sku}.html` : item.platform === 'tmall' ? `https://list.tmall.com/search_product.htm?q=${encodeURIComponent(item.name)}` : `https://mobile.yangkeduo.com/search_result.html?search_key=${encodeURIComponent(item.name)}`;
    await db.product.create({ data: { id, name: item.name, platform: item.platform, url, sku: item.sku, category: item.category, basePriceCents: item.base * 100, targetPriceCents, groupId: item.groupId ? groupIds[item.groupId] : null, sourceType: 'demo', collectorConfig: '{}' } });
    await db.collectionRecord.createMany({ data: records.map((record) => ({ productId: id, sourceType: record.sourceType, sourceLabel: record.sourceLabel, status: record.status, priceCents: record.priceCents, failureReason: record.failureReason, collectedAt: record.collectedAt, demoSequence: record.demoSequence, collectorSnapshot: record.collectorSnapshot ?? '{}', trigger: 'seed' })) });
    const currentPriceCents = records.at(-1)!.priceCents!;
    if (currentPriceCents <= targetPriceCents) {
      await db.alert.create({ data: { productId: id, rule: 'target', priceCents: currentPriceCents, threshold: targetPriceCents / 100, message: `演示模拟：当前价 ¥${fromCents(currentPriceCents)!.toFixed(2)} 已达到目标价 ¥${fromCents(targetPriceCents)!.toFixed(2)}`, sourceType: 'demo', sourceLabel: '演示模拟', triggeredAt: now } });
    }
    summary.push({ id, name: item.name, platform: item.platform, seedSearchAttempts: attempt, targetPrice: fromCents(targetPriceCents), ...calculateStats(records), sourceLabel: '演示模拟' });
  }
  const result = { seedDate: now.toISOString(), products: await db.product.count(), collections: await db.collectionRecord.count(), alerts: await db.alert.count(), summary };
  console.log(JSON.stringify(result, null, 2));
  return result;
  }, { timeout: 60_000 });
}

try { await seed(); await initializeAlertStates(now); }
finally { await prisma.$disconnect(); }
