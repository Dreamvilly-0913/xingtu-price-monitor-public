import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import Alert from 'antd/es/alert';
import AntdApp from 'antd/es/app';
import Button from 'antd/es/button';
import Card from 'antd/es/card';
import Descriptions from 'antd/es/descriptions';
import Empty from 'antd/es/empty';
import Segmented from 'antd/es/segmented';
import Skeleton from 'antd/es/skeleton';
import Table from 'antd/es/table';
import Tabs from 'antd/es/tabs';
import Tag from 'antd/es/tag';
import ArrowLeftOutlined from '@ant-design/icons/es/icons/ArrowLeftOutlined';
import SyncOutlined from '@ant-design/icons/es/icons/SyncOutlined';
import ExportOutlined from '@ant-design/icons/es/icons/ExportOutlined';
import { api, useRemote } from '../api';
import type { Collection, PriceAlert, ProductDetail } from '../types';
import Chart from '../components/Chart';
import { ChangePercent, PageHeading, PlatformTag, Price, PriceFreshness, SourceTag, alertColumns, collectionColumns, formatMoney, formatTime, platformName, priceTooltip, ruleName, shortDate } from '../components/Ui';

export default function DetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { message } = AntdApp.useApp();
  const [days, setDays] = useState(30);
  const [collecting, setCollecting] = useState(false);
  const detail = useRemote<ProductDetail>(id ? `/products/${id}?days=${days}` : null);
  const product = detail.data?.product;
  const stats = detail.data?.statistics;
  const history = detail.data?.history || [];
  const historyPointCount = detail.data?.historyPointCount ?? history.length;
  const historySampled = detail.data?.historySampled === true;
  const chartOption = useMemo(() => ({
    color: ['#2d6be9'], grid: { top: 34, right: 72, bottom: 74, left: 85 },
    tooltip: { trigger: 'axis', renderMode: 'richText', formatter: priceTooltip },
    xAxis: { type: 'time', boundaryGap: false, axisLine: { lineStyle: { color: '#e3e9f2' } }, splitLine: { show: false }, axisLabel: { color: '#8994a7', formatter: (value: number) => shortDate(new Date(value).toISOString()) } },
    yAxis: { type: 'value', scale: true, axisLabel: { color: '#8994a7', formatter: formatMoney }, splitLine: { lineStyle: { color: '#eef1f6', type: 'dashed' } } },
    dataZoom: [{ type: 'inside', filterMode: 'none' }, { type: 'slider', bottom: 10, height: 22, borderColor: '#e8edf5', fillerColor: 'rgba(45,107,233,.09)', handleStyle: { color: '#2d6be9' }, textStyle: { color: '#8994a7' } }],
    series: [{ name: product ? `${platformName(product.platform)} · ${product.name}` : '价格', type: 'line', smooth: false, symbolSize: 5, showSymbol: history.length < 40, lineStyle: { width: 2.5 }, areaStyle: { color: 'rgba(45,107,233,.08)' }, data: history.map(point => ({ value: [point.time, point.price], sourceLabel: point.sourceLabel })), markLine: product ? { silent: true, symbol: 'none', label: { position: 'end', fontSize: 10, formatter: '{b}' }, data: [{ yAxis: product.targetPrice, name: '目标价（配置）', lineStyle: { color: '#17a398', type: 'dashed' }, label: { color: '#17a398' } }, { yAxis: product.basePrice, name: '基准价（配置）', lineStyle: { color: '#a0aabc', type: 'dashed' }, label: { color: '#8a95a8' } }] } : undefined }],
  }), [detail.data]);
  async function collect() {
    if (!id) return;
    setCollecting(true);
    try {
      const result = await api<{ collection: Collection }>(`/products/${id}/collect`, { method: 'POST' });
      if (result.collection.status === 'success') message.success(`采集成功 · ${result.collection.sourceLabel} · ${formatMoney(result.collection.price)}`);
      else message.error(`采集失败：${result.collection.failureReason}`);
      detail.reload();
    } catch (failure) { message.error(failure instanceof Error ? failure.message : '采集失败'); }
    finally { setCollecting(false); }
  }
  async function readAlert(alert: PriceAlert) {
    try { await api(`/alerts/${alert.id}/read`, { method: 'PATCH' }); message.success('已标记为已读'); detail.reload(); }
    catch (failure) { message.error(failure instanceof Error ? failure.message : '处理失败'); }
  }
  const metrics = [
    { title: '当前价格', value: <Price value={stats?.currentPrice} testId="detail-current-price" />, note: product?.currentPrice == null ? '暂无成功采集' : <SourceTag label={product?.currentPriceSourceLabel || product?.sourceLabel} /> },
    { title: '历史最低价', value: <Price value={stats?.minPrice} />, note: '全部成功采集记录' },
    { title: '历史最高价', value: <Price value={stats?.maxPrice} />, note: '全部成功采集记录' },
    { title: '历史均价', value: <Price value={stats?.avgPrice} />, note: '全部成功采集记录' },
    { title: '最大回撤跌幅', value: stats?.maxDrawdownPercent == null ? '—' : `${stats.maxDrawdownPercent.toFixed(2)}%`, note: '此前最高价到随后低点' },
  ];
  return <div className="page-stack"><div className="detail-back"><Button type="text" icon={<ArrowLeftOutlined />} onClick={() => navigate('/products')}>返回商品列表</Button></div><PageHeading title={product?.name || '商品详情'} description={<>{product && <><PlatformTag platform={product.platform} /><span>{product.category} · SKU {product.sku}</span><Tag color={product.enabled ? 'success' : 'default'} style={{ marginLeft: 10 }}>{product.enabled ? '监控开启' : '监控关闭'}</Tag></>}</>} extra={<><Button onClick={detail.reload} loading={detail.loading}>刷新数据</Button><Button type="primary" icon={<SyncOutlined />} onClick={collect} loading={collecting}>立即采集</Button></>} />
    {detail.error && <Alert type="error" showIcon message={detail.error} action={<Button onClick={detail.reload}>重试</Button>} />}
    {product && <PriceFreshness product={product} />}
    {Boolean(detail.data?.currentRules?.length) && <Alert type="warning" showIcon message="当前触发中的规则" description={<div data-testid="detail-current-rules">{detail.data!.currentRules!.map(rule => <div key={rule.id}>{ruleName(rule.rule)} · 最新成功采集价 {formatMoney(rule.price)} · {rule.sourceLabel} · 复核于 {formatTime(rule.evaluatedAt)}</div>)}<div>当前规则独立于提醒冷却和已读状态；下方流水保留原触发价格。</div></div>} />}
    {product?.lastCollectionStatus === 'failure' && <Alert type="warning" showIcon message={`该商品连续采集失败 ${product.consecutiveFailures} 次`} description={<>{product.lastFailureReason}<br />当前价格继续取最新成功流水，数据来源保持该条流水的来源。</>} />}
    <div className="detail-metric-grid">{metrics.map(metric => <Card key={metric.title} className="metric-card detail-metric-card" loading={detail.loading && !detail.data}><div className="metric-card-top">{metric.title}</div><div className="detail-metric-value">{metric.value}</div><div className="metric-note">{metric.note}</div></Card>)}</div><div className="statistics-sources">全历史统计来源：{stats?.sourceLabels?.length ? stats.sourceLabels.map(label => <SourceTag key={label} label={label} />) : <span className="muted">暂无成功价格</span>}<span className="muted">最低、最高、均价与最大回撤使用全部成功流水。</span></div>
    <Card className="panel-card" title={<div className="panel-title"><strong>价格历史</strong><small>近 {days} 天及今日 · {historyPointCount.toLocaleString('zh-CN')} 条成功流水{historySampled ? ` · 曲线展示 ${history.length.toLocaleString('zh-CN')} 个采样点` : ''}</small></div>} extra={<Segmented value={days} onChange={value => setDays(Number(value))} options={[{ label: '7天', value: 7 }, { label: '30天', value: 30 }, { label: '90天', value: 90 }]} />}>
      {detail.loading && !detail.data ? <Skeleton active /> : history.length ? <Chart option={chartOption} height={380} testId="detail-price-chart" pointCount={history.length} rawPointCount={historyPointCount} sampled={historySampled} latestPrice={history.at(-1)?.price} /> : <div className="chart-empty"><Empty description="该时间范围暂无成功采集价格，可立即采集获取第一条记录。" /></div>}
      <div className="chart-footnote" data-testid="detail-history-note">{Array.from(new Set(history.map(point => point.sourceLabel))).map(label => <SourceTag key={label} label={label} />)}统计卡覆盖全部 {stats?.pointCount ?? '—'} 条成功流水；曲线按所选时间范围展示。{historySampled && '记录较多，曲线已经采样；全部原始流水仍保留，统计卡使用全部成功记录计算。'}悬停可查看每个价格点的来源。</div>
    </Card>
    {product && <Card className="panel-card" title="监控配置"><Descriptions column={{ xs: 1, sm: 2, lg: 3 }} items={[{ key: 'base', label: '基准价', children: <Price value={product.basePrice} /> }, { key: 'target', label: '目标价', children: <><Price value={product.targetPrice} />{product.currentPrice != null && product.currentPrice <= product.targetPrice && <Tag color="success" style={{ marginLeft: 8 }}>已达到</Tag>}</> }, { key: 'group', label: '商品组', children: product.group?.name ? <Link to="/comparison">{product.group.name}</Link> : '未归组' }, { key: 'source', label: '配置数据源', children: <SourceTag label={product.configuredSourceLabel} /> }, { key: 'yesterday', label: '较昨日', children: <ChangePercent value={product.changeFromYesterdayPercent} /> }, { key: 'reference', label: '较基准价', children: <ChangePercent value={product.changeFromBasePercent} /> }, { key: 'collected', label: '最近采集时间', children: formatTime(product.lastCollectedAt) }, { key: 'rule', label: '24 小时跌幅阈值', children: product.collectorConfig.dropThresholdPercent ? `${product.collectorConfig.dropThresholdPercent.toFixed(2)}%` : '使用系统默认' }, { key: 'url', label: '平台商品链接', children: <a href={product.url} target="_blank" rel="noopener noreferrer">查看平台商品 <ExportOutlined /></a> }]} />{product.sourceType === 'http' && <div className="config-detail"><strong>真实采集配置</strong><span>方式：{product.collectorConfig.mode === 'html' ? '网页 CSS 选择器' : 'JSON 价格接口'}</span><span>请求地址：{product.collectorConfig.priceUrl || (product.collectorConfig.mode === 'html' ? product.url : '京东公开价格接口（默认）')}</span><span>解析规则：{product.collectorConfig.mode === 'html' ? product.collectorConfig.cssSelector : product.collectorConfig.jsonPath || '$[0].p'}</span></div>}</Card>}
    <Card className="panel-card detail-records"><Tabs items={[{ key: 'collections', label: `采集记录（${detail.data?.collections.length ?? 0}）`, children: <><div className="records-heading"><span>最近 50 条采集记录 · 时间按上海时区</span><Link to="/collections">查看全部流水</Link></div><Table<Collection> rowKey="id" columns={collectionColumns} dataSource={detail.data?.collections || []} loading={detail.loading} scroll={{ x: 1150 }} pagination={{ pageSize: 10, showSizeChanger: false }} /></> }, { key: 'alerts', label: `预警记录（${detail.data?.alerts.length ?? 0}）`, children: <><div className="records-heading"><span>最近 50 条预警记录</span><Link to="/alerts">前往预警中心</Link></div><Table<PriceAlert> rowKey="id" columns={[...alertColumns, { title: '操作', key: 'action', width: 100, render: (_, alert) => alert.readAt ? <span className="muted">已读</span> : <Button type="link" size="small" onClick={() => readAlert(alert)}>标记已读</Button> }]} dataSource={detail.data?.alerts || []} loading={detail.loading} scroll={{ x: 1350 }} pagination={{ pageSize: 10, showSizeChanger: false }} /></> }]} /></Card>
  </div>;
}
