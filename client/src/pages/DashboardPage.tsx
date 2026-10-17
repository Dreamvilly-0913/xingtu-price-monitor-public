import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import Alert from 'antd/es/alert';
import Button from 'antd/es/button';
import Card from 'antd/es/card';
import Checkbox from 'antd/es/checkbox';
import Empty from 'antd/es/empty';
import Skeleton from 'antd/es/skeleton';
import Segmented from 'antd/es/segmented';
import Tag from 'antd/es/tag';
import Tooltip from 'antd/es/tooltip';
import ArrowRightOutlined from '@ant-design/icons/es/icons/ArrowRightOutlined';
import ShoppingOutlined from '@ant-design/icons/es/icons/ShoppingOutlined';
import SyncOutlined from '@ant-design/icons/es/icons/SyncOutlined';
import CheckCircleOutlined from '@ant-design/icons/es/icons/CheckCircleOutlined';
import BellOutlined from '@ant-design/icons/es/icons/BellOutlined';
import { query, useRemote } from '../api';
import type { Dashboard } from '../types';
import Chart from '../components/Chart';
import { PageHeading, PlatformTag, Price, RefreshButton, SourceTag, platformName, shortDate, formatMoney, priceTooltip } from '../components/Ui';

const colors = ['#2d6be9', '#11a6a4', '#9259da', '#e79430', '#ea6684', '#54a055', '#507196', '#bd8dd8', '#f5ab65', '#569cbc', '#c25466', '#748856'];
export default function DashboardPage() {
  const [selected, setSelected] = useState<string[]>([]);
  const [days, setDays] = useState(30);
  const { data, loading, error, reload } = useRemote<Dashboard>(`/dashboard${query({ days, ...(selected.length ? { productIds: selected.join(',') } : { summaryOnly: true }) })}`);
  const [initialized, setInitialized] = useState(false);
  useEffect(() => {
    if (data && !initialized) {
      const iphones = data.products.filter(product => product.name.includes('iPhone'));
      setSelected((iphones.length ? iphones : data.products).slice(0, 3).map(product => product.id));
      setInitialized(true);
    }
  }, [data, initialized]);
  const series = useMemo(() => data?.priceTrends.filter(item => selected.includes(item.productId)) || [], [data, selected]);
  const renderedPointCount = series.reduce((sum, item) => sum + item.points.length, 0);
  const originalPointCount = series.reduce((sum, item) => sum + (item.pointCount ?? item.points.length), 0);
  const sampled = series.some(item => item.sampled === true);
  const trendOption = useMemo(() => ({
    color: colors, grid: { left: 85, right: 20, top: 25, bottom: 65 },
    tooltip: { trigger: 'axis', renderMode: 'richText', formatter: priceTooltip },
    xAxis: { type: 'time', boundaryGap: false, axisLine: { lineStyle: { color: '#e3e9f2' } }, axisLabel: { color: '#8994a7', formatter: (value: number) => shortDate(new Date(value).toISOString()) }, splitLine: { show: false } },
    yAxis: { type: 'value', scale: true, axisLabel: { color: '#8994a7', formatter: formatMoney }, splitLine: { lineStyle: { color: '#eef1f6', type: 'dashed' } } },
    legend: { bottom: 0, type: 'scroll', icon: 'roundRect', itemWidth: 13, itemHeight: 4, textStyle: { color: '#67768d', fontSize: 11 } },
    series: series.map(item => ({ name: `${platformName(item.platform)} · ${item.name}`, type: 'line', smooth: false, showSymbol: false, symbolSize: 5, lineStyle: { width: 2.4 }, data: item.points.map(point => ({ value: [point.time, point.price], sourceLabel: point.sourceLabel })) })),
  }), [series]);
  const distributionOption = useMemo(() => ({ color: ['#2d6be9', '#11a6a4', '#a087e8'], tooltip: { trigger: 'item', formatter: '{b}：{c} 件（{d}%）' }, series: [{ type: 'pie', radius: ['57%', '78%'], center: ['50%', '49%'], label: { show: false }, emphasis: { scale: false }, itemStyle: { borderColor: '#fff', borderWidth: 5, borderRadius: 5 }, data: data?.platformDistribution.map(item => ({ name: platformName(item.platform), value: item.count })) || [] }] }), [data]);
  const metrics = [
    { label: '监控商品', value: data?.monitoredProductCount, suffix: '件', icon: <ShoppingOutlined />, tone: 'blue', note: `${data?.enabledProductCount ?? '—'} 件正在监控` },
    { label: '今日采集次数', value: data?.todayCollectionCount, suffix: '次', icon: <SyncOutlined />, tone: 'teal', note: `成功 ${data?.todaySuccessCount ?? '—'} 次 · 上海业务日期` },
    { label: '今日采集成功率', value: data ? data.todaySuccessRate.toFixed(1) : undefined, suffix: '%', icon: <CheckCircleOutlined />, tone: 'purple', note: '按今日全部采集流水计算' },
    { label: '当前触发预警', value: data?.activeAlertCount, suffix: '条', icon: <BellOutlined />, tone: 'orange', note: '价格恢复后自动解除' },
  ];
  return <div className="page-stack">
    <PageHeading title="运营仪表盘" description="集中查看数码家电价格动态，让每一次运营决策都有据可查。" extra={<><Tag className="live-tag"><span className="live-dot" /> 可见页面每 30 秒更新</Tag><RefreshButton loading={loading} onClick={reload} /></>} />
    {error && <Alert type="error" showIcon message={error} action={<Button onClick={reload}>重试</Button>} />}
    <div className="metric-grid">{metrics.map(metric => <Card key={metric.label} className="metric-card" loading={loading && !data}><div className="metric-card-top"><span>{metric.label}</span><span className={`metric-icon ${metric.tone}`}>{metric.icon}</span></div><div className="metric-value">{metric.value ?? '—'}<small>{metric.suffix}</small></div><div className="metric-note">{metric.note}</div></Card>)}</div>
    <div className="dashboard-grid"><Card className="panel-card trend-card" title={<div className="panel-title"><strong>商品价格趋势</strong><small>近 {days} 天及今日 · 单位：元</small></div>} extra={<Segmented value={days} options={[{ label: '7天', value: 7 }, { label: '30天', value: 30 }, { label: '90天', value: 90 }]} onChange={value => setDays(Number(value))} />}>
      <div className="trend-selector" data-testid="dashboard-product-selector"><span className="muted">勾选商品对比 · 最多 10 件</span><Checkbox.Group value={selected} onChange={values => setSelected((values as string[]).slice(0, 10))} options={data?.products.map(item => ({ label: `${platformName(item.platform)} · ${item.name}`, value: item.id, disabled: selected.length >= 10 && !selected.includes(item.id) })) || []} /></div>
      {loading && !data ? <Skeleton active /> : series.length ? <Chart option={trendOption} testId="dashboard-trend-chart" pointCount={renderedPointCount} rawPointCount={originalPointCount} sampled={sampled} seriesCount={series.length} height={330} /> : <div className="chart-empty"><Empty description="勾选商品后查看采集价格曲线" /></div>}
      <div className="chart-footnote" data-testid="dashboard-history-note">{Array.from(new Set(series.flatMap(item => item.points.map(point => point.sourceLabel)))).map(label => <SourceTag key={label} label={label} />)}曲线只使用成功采集记录，失败不会产生价格点。{sampled && `原始流水共 ${originalPointCount.toLocaleString('zh-CN')} 条，曲线展示 ${renderedPointCount.toLocaleString('zh-CN')} 个采样点；完整记录保留并参与统计。`}</div>
    </Card><Card className="panel-card distribution-card" title={<div className="panel-title"><strong>平台商品分布</strong><small>全部监控商品</small></div>}>
      <div className="distribution-chart-wrap"><Chart option={distributionOption} height={240} pointCount={data?.platformDistribution.reduce((sum, item) => sum + item.count, 0) || 0} /><div className="donut-center"><strong>{data?.monitoredProductCount ?? '—'}</strong><span>监控商品</span></div></div>
      <div className="platform-legend">{data?.platformDistribution.map((item, index) => <div key={item.platform}><span className="legend-label"><i style={{ background: ['#2d6be9', '#11a6a4', '#a087e8'][index] }} />{platformName(item.platform)}</span><strong>{item.count} <small>件</small></strong></div>)}</div>
      <div className="source-explanation"><span className="source-explanation-icon">i</span><p>演示数据用于复算与验收。切换真实采集时，请先配置接口或网页解析规则。</p></div>
    </Card></div>
    <div className="dashboard-bottom-grid"><Card className="panel-card" title={<div className="panel-title"><strong>今日最大降幅 Top 5</strong><small>今日最新价相对昨日最后成功价</small></div>} extra={<Link to="/products">查看全部 <ArrowRightOutlined /></Link>}>
      {data?.todayTopDrops.length ? <div className="drop-list">{data.todayTopDrops.map((item, index) => <div className="drop-row" key={item.productId}><span className={`rank-number rank-${index}`}>{String(index + 1).padStart(2, '0')}</span><div className="drop-product"><Link to={`/products/${item.productId}`}>{item.name}</Link><div><PlatformTag platform={item.platform} /><SourceTag label={item.sourceLabel} /></div></div><div className="drop-price"><Price value={item.currentPrice} /><small>昨日 {formatMoney(item.previousPrice)}</small><small>{item.previousPriceSourceLabel}</small></div><Tooltip title="今日最新价相对昨日最后成功采集价"><span className="drop-percent">↓ {item.dropPercent.toFixed(2)}%</span></Tooltip></div>)}</div> : <Empty description="今日尚无降价商品" />}
    </Card><Card className="panel-card workflow-card" title="让监控形成完整闭环"><div className="workflow-step"><span>01</span><div><strong>配置监控商品</strong><p>设置平台、SKU、数据源与目标价格。</p></div></div><div className="workflow-step"><span>02</span><div><strong>持续采集与复核</strong><p>定时采集，保留每次成功与失败的完整流水。</p></div></div><div className="workflow-step"><span>03</span><div><strong>跟进降价预警</strong><p>目标价与 24 小时跌幅双规则，处理提醒。</p></div></div><Link to="/alerts"><Button block icon={<BellOutlined />}>查看预警中心</Button></Link></Card></div>
  </div>;
}
