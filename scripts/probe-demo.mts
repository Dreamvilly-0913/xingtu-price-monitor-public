import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { nextDemoPrice } from '../server/src/collectors/demo.js';

const outputDir = fileURLToPath(new URL('../outputs/', import.meta.url));
await mkdir(outputDir, { recursive: true });

/** 复用正式 DemoCollector 函数，金额全部按整数分运算。 */
function sequence(productId: string, basePriceCents: number, startDate: string, days: number) {
  let previousPriceCents = basePriceCents;
  return Array.from({ length: days }, (_, day) => {
    const date = new Date(new Date(`${startDate}T00:00:00.000Z`).getTime() + day * 86_400_000).toISOString().slice(0, 10);
    const priceCents = nextDemoPrice({ productId, date, basePriceCents, previousPriceCents, volatilityPercent: 2.5 });
    const changePercent = (priceCents - previousPriceCents) / previousPriceCents * 100;
    const point = { date, source: '演示模拟', previousPriceCents, priceCents, price: (priceCents / 100).toFixed(2), changePercent };
    previousPriceCents = priceCents;
    return point;
  });
}

const input = { productId: 'stage0-jd-iphone16', basePriceCents: 599_900, startDate: '2026-09-03', days: 30 };
const points = sequence(input.productId, input.basePriceCents, input.startDate, input.days);
const rerun = sequence(input.productId, input.basePriceCents, input.startDate, input.days);
const maxAbsoluteDailyChangePercent = Math.max(...points.map(point => Math.abs(point.changePercent)));
const minPriceCents = Math.min(...points.map(point => point.priceCents));
const maxPriceCents = Math.max(...points.map(point => point.priceCents));
const deterministic = JSON.stringify(points) === JSON.stringify(rerun);
const allChangesWithin2_5Percent = points.every(point => Math.abs(point.changePercent) <= 2.5 + 1e-10);
const allPricesWithin60To130Percent = points.every(point => point.priceCents >= input.basePriceCents * 0.6 && point.priceCents <= input.basePriceCents * 1.3);

// 同时覆盖小金额的取整边界，避免用价格舍入掩盖超过限幅的变化。
const smallAmountChecks = [1, 2, 3, 7, 10, 99, 100, 101, 199].map(base => {
  const small = sequence(`edge-${base}`, base, input.startDate, 30);
  return { basePriceCents: base, valid: small.every(point => point.priceCents > 0 && point.priceCents >= Math.ceil(base * 0.6) && point.priceCents <= Math.floor(base * 1.3) && Math.abs(point.changePercent) <= 2.5 + 1e-10) };
});
const passed = deterministic && allChangesWithin2_5Percent && allPricesWithin60To130Percent && smallAmountChecks.every(check => check.valid);
const report = {
  input, source: '演示模拟', pointCount: points.length, checkedSteps: points.length,
  minPriceCents, maxPriceCents, latestPriceCents: points.at(-1)?.priceCents,
  maxAbsoluteDailyChangePercent, deterministic, allChangesWithin2_5Percent,
  allPricesWithin60To130Percent, smallAmountChecks, passed, points,
};
const csv = ['date,source,previousPriceCents,priceCents,price,changePercent', ...points.map(point => `${point.date},${point.source},${point.previousPriceCents},${point.priceCents},${point.price},${point.changePercent.toFixed(8)}`)].join('\n');
await writeFile(`${outputDir}/stage0-demo.json`, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
await writeFile(`${outputDir}/stage0-demo.csv`, `${csv}\n`, 'utf8');
console.table(points.map(point => ({ date: point.date, price: point.price, changePercent: point.changePercent.toFixed(6), source: point.source })));
console.log(JSON.stringify({ ...report, points: undefined }, null, 2));
if (!passed) process.exitCode = 1;
