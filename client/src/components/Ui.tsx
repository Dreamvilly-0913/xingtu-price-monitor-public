import type { ReactNode } from 'react';
import Tag from 'antd/es/tag';
import Tooltip from 'antd/es/tooltip';
import Button from 'antd/es/button';
import type { TableColumnsType } from 'antd';
import { Link } from 'react-router-dom';
import type { Collection, Platform, PriceAlert, Product } from '../types';

export const PLATFORM_OPTIONS = [{ value: 'jd', label: '京东' }, { value: 'tmall', label: '天猫' }, { value: 'pdd', label: '拼多多' }];
export const SOURCE_OPTIONS = [{ value: 'demo', label: '演示模拟' }, { value: 'http', label: '真实采集' }];
export const platformName = (platform: Platform) => ({ jd: '京东', tmall: '天猫', pdd: '拼多多' })[platform];
export const ruleName = (rule: PriceAlert['rule']) => rule === 'target' ? '达到目标价' : '24 小时跌幅';
export function formatMoney(value?: number | null) { return value == null ? '—' : `¥${value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
export function formatTime(value?: string | null) { return value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)) : '—'; }
export function shortDate(value: string) { return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit' }).format(new Date(value)); }
// 使用富文本提示而非拼接 HTML；每一个历史点都显示当时采集来源。
export function priceTooltip(parameters: unknown) {
  const items = (Array.isArray(parameters) ? parameters : [parameters]) as { seriesName?: string; data?: { value?: [string, number]; sourceLabel?: string } }[];
  const points = items.filter(item => Array.isArray(item.data?.value));
  if (!points.length) return '';
  return [formatTime(points[0].data!.value![0]), ...points.map(item => `${item.seriesName || '采集价格'}  ${formatMoney(item.data!.value![1])} 〔${item.data!.sourceLabel || '来源未知'}〕`)].join('\n');
}
export function PageHeading({ title, description, extra }: { title: string; description?: ReactNode; extra?: ReactNode }) { return <div className="page-heading"><div><h1>{title}</h1><p>{description}</p></div>{extra && <div className="heading-actions">{extra}</div>}</div>; }
export function SourceTag({ label }: { label?: string | null }) { return label ? <Tag className="source-tag" color={label === '演示模拟' ? 'cyan' : 'blue'}>{label}</Tag> : <Tag>尚无价格</Tag>; }
export function PlatformTag({ platform }: { platform: Platform }) { return <Tag className={`platform-tag platform-${platform}`}>{platformName(platform)}</Tag>; }
export function Price({ value, testId, className = '' }: { value?: number | null; testId?: string; className?: string }) { return <span className={`price-text ${className}`} data-testid={testId}>{formatMoney(value)}</span>; }
export function hasUsablePrice(product: Product) { return product.enabled && product.currentPrice != null && !product.isPriceStale && product.currentPriceMatchesConfiguration !== false; }
export function PriceFreshness({ product, showTime = true }: { product: Product; showTime?: boolean }) {
  if (product.currentPrice == null) return null;
  const incompatible = product.currentPriceMatchesConfiguration === false;
  const stale = Boolean(product.isPriceStale);
  return <div data-testid={`price-freshness-${product.id}`} data-stale={String(stale)} data-compatible={String(!incompatible)}>
    <Tag color={incompatible || stale ? 'warning' : 'success'}>{incompatible ? '配置已变更 · 历史报价' : stale ? '报价已过期' : '有效报价'}</Tag>
    {!product.enabled && <Tag>监控关闭 · 不参与排名</Tag>}
    {showTime && <div className="cell-time">价格采于 {formatTime(product.currentPriceCollectedAt || (product.lastCollectionStatus === 'success' ? product.lastCollectedAt : null))}</div>}
    {product.priceAgeMinutes != null && <div className="cell-time">距今 {product.priceAgeMinutes >= 1440 ? `${(product.priceAgeMinutes / 1440).toFixed(1)} 天` : `${Math.max(0, Math.round(product.priceAgeMinutes))} 分钟`}{incompatible || stale ? ' · 不参与有效最低价排名' : ''}</div>}
  </div>;
}
export function ChangePercent({ value }: { value: number | null | undefined }) { return value == null ? <span className="muted">—</span> : <span className={value > 0 ? 'price-up' : value < 0 ? 'price-down' : 'muted'}>{value > 0 ? '↗ +' : value < 0 ? '↘ ' : ''}{value.toFixed(2)}%</span>; }
export const collectionColumns: TableColumnsType<Collection> = [
  { title: '商品 / 平台', key: 'product', width: 220, render: (_, row) => <div><Link to={`/products/${row.productId}`} className="table-product-name">{row.productName}</Link><div className="cell-meta"><PlatformTag platform={row.platform} /></div></div> },
  { title: '数据来源', key: 'source', width: 120, render: (_, row) => <SourceTag label={row.sourceLabel} /> },
  { title: '采集结果', key: 'result', width: 140, render: (_, row) => row.status === 'success' ? <div><Price value={row.price} /><div><Tag color="success">成功</Tag></div></div> : <Tag color="error">失败</Tag> },
  { title: '失败原因', dataIndex: 'failureReason', width: 280, render: value => value ? <Tooltip title={value}><span className="failure-text">{value}</span></Tooltip> : <span className="muted">—</span> },
  { title: '触发方式', dataIndex: 'trigger', width: 100, render: value => ({ seed: '种子回填', manual: '手动采集', scheduled: '定时采集', scheduler: '定时采集' } as Record<string, string>)[value] || value },
  { title: '采集时间（上海）', dataIndex: 'collectedAt', width: 175, render: formatTime },
];
export const alertColumns: TableColumnsType<PriceAlert> = [
  { title: '商品 / 平台', key: 'product', width: 220, render: (_, row) => <div><Link to={`/products/${row.productId}`} className="table-product-name">{row.productName}</Link><div className="cell-meta"><PlatformTag platform={row.platform} /><SourceTag label={row.sourceLabel} /></div></div> },
  { title: '预警规则', dataIndex: 'rule', width: 130, render: ruleName },
  { title: '触发价格', dataIndex: 'price', width: 130, render: value => <Price value={value} /> },
  { title: '规则阈值', key: 'threshold', width: 130, render: (_, row) => row.rule === 'target' ? formatMoney(row.threshold) : `${row.threshold.toFixed(2)}%` },
  { title: '预警说明', dataIndex: 'message', width: 260 },
  { title: '状态', key: 'status', width: 160, render: (_, row) => <div><Tag color={row.readAt ? 'default' : 'orange'}>{row.readAt ? '已读' : '未读'}</Tag><Tag color={row.isActive ? 'red' : 'default'}>{row.isActive ? '触发中' : '当前未触发'}</Tag>{row.isActive && <div className="cell-time">当前规则价 {formatMoney(row.activePrice)}</div>}</div> },
  { title: '触发时间（上海）', dataIndex: 'triggeredAt', width: 175, render: formatTime },
];
export function RefreshButton({ onClick, loading }: { onClick: () => void; loading?: boolean }) { return <Button onClick={onClick} loading={loading}>刷新数据</Button>; }
