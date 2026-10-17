import { config } from './config.js';

export const fromCents = (value: number | null | undefined): number | null => value == null ? null : Number((value / 100).toFixed(2));
export const toCents = (value: number): number => Math.round(value * 100);
export const percent = (current: number, previous: number): number => Number(((current - previous) / previous * 100).toFixed(4));
export const round = (value: number, digits = 2): number => Number(value.toFixed(digits));

/** 业务日期统一采用嘉兴团队时区，不依赖部署主机的本地时区。 */
export function businessDate(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = (name: string) => parts.find((part) => part.type === name)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function businessDayStart(date = new Date()): Date {
  // 部署默认 Asia/Shanghai；利用时区格式反推 UTC 日期边界，也支持其它配置时区。
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const part = (name: string) => Number(parts.find((entry) => entry.type === name)?.value ?? 0);
  const localAsUtc = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
  const offset = localAsUtc - Math.floor(date.getTime() / 1000) * 1000;
  return new Date(Date.UTC(part('year'), part('month') - 1, part('day')) - offset);
}

export class ApiError extends Error {
  constructor(public statusCode: number, public code: string, message: string, public details?: unknown) { super(message); }
}
