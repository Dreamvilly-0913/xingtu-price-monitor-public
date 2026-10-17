import { z } from 'zod';
import { compilePriceExtraction } from './pricing-parser.js';

const amount = z.number().finite().positive().max(21_474_836.47).refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 0.000001, '金额最多保留两位小数');
const httpUrl = z.string().url().refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), '链接仅支持 http / https');
export const collectorConfigSchema = z.object({
  mode: z.enum(['json', 'html']).optional(), priceUrl: httpUrl.optional(), jsonPath: z.string().max(200).optional(), cssSelector: z.string().max(300).optional(), priceRegex: z.string().min(1).max(200).superRefine((value, context) => { try { compilePriceExtraction(value); } catch (error) { context.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : '价格提取规则无效' }); } }).optional(), timeoutMs: z.number().int().min(100).max(30_000).optional(), dropThresholdPercent: z.number().min(0.1).max(100).optional(),
}).strict();
export const productSchema = z.object({
  name: z.string().trim().min(1).max(150), platform: z.enum(['jd', 'tmall', 'pdd']), url: httpUrl, sku: z.string().trim().min(1).max(100), category: z.string().trim().min(1).max(50), basePrice: amount, targetPrice: amount, sourceType: z.enum(['demo', 'http']), collectorConfig: collectorConfigSchema.default({}), enabled: z.boolean().default(true), groupId: z.string().min(1).max(100).nullable().optional(),
}).strict().superRefine((value, context) => {
  if (value.sourceType === 'http' && value.collectorConfig.mode === 'html' && !value.collectorConfig.cssSelector) context.addIssue({ code: z.ZodIssueCode.custom, path: ['collectorConfig', 'cssSelector'], message: '网页采集必须配置 CSS 选择器' });
  if (value.sourceType === 'http' && value.collectorConfig.mode !== 'html' && value.platform !== 'jd' && !value.collectorConfig.priceUrl) context.addIssue({ code: z.ZodIssueCode.custom, path: ['collectorConfig', 'priceUrl'], message: '非京东 JSON 采集必须配置价格接口地址' });
});
export const paginationSchema = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) });
export const settingsSchema = z.object({ collectionIntervalMinutes: z.number().int().min(1).max(1440), demoVolatilityPercent: z.number().min(0).max(3), dropThresholdPercent: z.number().min(0.1).max(100) }).strict();
export const groupSchema = z.object({ name: z.string().trim().min(1).max(100) }).strict();
export const idSchema = z.object({ id: z.string().min(1).max(100) });
