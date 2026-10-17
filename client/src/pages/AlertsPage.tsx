import { useDeferredValue, useState } from 'react';
import { Link } from 'react-router-dom';
import Alert from 'antd/es/alert';
import App from 'antd/es/app';
import Button from 'antd/es/button';
import Card from 'antd/es/card';
import Col from 'antd/es/col';
import Empty from 'antd/es/empty';
import Popconfirm from 'antd/es/popconfirm';
import Row from 'antd/es/row';
import Select from 'antd/es/select';
import Space from 'antd/es/space';
import Statistic from 'antd/es/statistic';
import Table from 'antd/es/table';
import Tag from 'antd/es/tag';
import Typography from 'antd/es/typography';
import CheckOutlined from '@ant-design/icons/es/icons/CheckOutlined';
import ReloadOutlined from '@ant-design/icons/es/icons/ReloadOutlined';
import type { HTMLAttributes } from 'react';
import type { TableProps } from 'antd';
import { api, query, useRemote } from '../api';
import type { AlertListResponse, AlertRuleState, ListResponse, PriceAlert, Product } from '../types';
import { PageHeading, PlatformTag, Price, SourceTag, formatMoney, formatTime, platformName, ruleName } from '../components/Ui';

export default function AlertsPage() {
  const { message } = App.useApp();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [productId, setProductId] = useState<string>();
  const [rule, setRule] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [productSearch, setProductSearch] = useState('');
  const [readingId, setReadingId] = useState<string>();
  const [readingAll, setReadingAll] = useState(false);
  const deferredSearch = useDeferredValue(productSearch);
  const alerts = useRemote<AlertListResponse>(`/alerts${query({ page, pageSize, productId, rule, status })}`);
  const unread = useRemote<AlertListResponse>('/alerts?pageSize=1&status=unread');
  const active = useRemote<AlertListResponse>('/alerts?pageSize=1&status=active');
  const handled = useRemote<AlertListResponse>('/alerts?pageSize=1&status=read');
  const current = useRemote<AlertListResponse>(`/alerts${query({ pageSize: 100, productId, rule, status: 'active' })}`);
  const products = useRemote<ListResponse<Product>>(`/products${query({ page: 1, pageSize: 100, search: deferredSearch || undefined })}`);
  const refresh = () => { alerts.reload(); unread.reload(); active.reload(); handled.reload(); current.reload(); };

  // 已读状态与触发状态各自展示，避免把价格仍触发中的预警误显示为已恢复。
  const markRead = async (id: string) => {
    setReadingId(id);
    try { await api(`/alerts/${encodeURIComponent(id)}/read`, { method: 'PATCH' }); message.success('预警已标记为已读'); refresh(); }
    catch (error) { message.error(error instanceof Error ? error.message : '标记失败，请重试'); }
    finally { setReadingId(undefined); }
  };
  const markAllRead = async () => {
    setReadingAll(true);
    try { const result = await api<{ updatedCount: number }>('/alerts/read-all', { method: 'POST' }); message.success(`已将 ${result.updatedCount} 条预警标记为已读`); refresh(); }
    catch (error) { message.error(error instanceof Error ? error.message : '批量标记失败，请重试'); }
    finally { setReadingAll(false); }
  };
  const columns: TableProps<PriceAlert>['columns'] = [
    { title: '商品 / 平台', key: 'product', width: 250, fixed: 'left', render: (_, record) => <Space direction="vertical" size={5}><Link to={`/products/${record.productId}`}>{record.productName}</Link><PlatformTag platform={record.platform} /></Space> },
    { title: '预警规则', dataIndex: 'rule', width: 150, render: (value, record) => <Space direction="vertical" size={3}><Typography.Text>{ruleName(value)}</Typography.Text><Typography.Text type="secondary" style={{ fontSize: 12 }}>{record.rule === 'target' ? `目标价 ${formatMoney(record.threshold)}` : `24 小时跌幅 ≥ ${record.threshold.toFixed(2)}%`}</Typography.Text></Space> },
    { title: '触发时价格', dataIndex: 'price', align: 'right', width: 145, render: (value) => <Price value={value} /> },
    { title: '数据来源', dataIndex: 'sourceLabel', width: 120, render: (value) => <SourceTag label={value} /> },
    { title: '提醒内容', dataIndex: 'message', width: 280, render: (value) => <span style={{ overflowWrap: 'anywhere' }}>{value}</span> },
    { title: '已读 / 当前触发状态', key: 'status', width: 180, render: (_, record) => <Space direction="vertical" size={4}><Tag color={record.readAt ? 'default' : 'orange'}>{record.readAt ? '已读' : '未读'}</Tag><Tag color={record.isActive ? 'red' : 'default'}>{record.isActive ? '触发中' : '当前未触发'}</Tag>{record.isActive && <Typography.Text type="secondary" style={{ fontSize: 12 }}>当前规则价 {formatMoney(record.activePrice)}</Typography.Text>}</Space> },
    { title: '触发时间（上海）', dataIndex: 'triggeredAt', width: 195, render: formatTime },
    { title: '操作', key: 'actions', width: 120, fixed: 'right', render: (_, record) => record.readAt ? <Typography.Text type="secondary">已读</Typography.Text> : <Button type="link" size="small" icon={<CheckOutlined />} loading={readingId === record.id} disabled={Boolean(readingId && readingId !== record.id) || readingAll} onClick={() => void markRead(record.id)}>标记已读</Button> },
  ];
  const currentColumns: TableProps<AlertRuleState>['columns'] = [
    { title: '商品 / 平台', key: 'product', width: 240, render: (_, record) => <Space direction="vertical" size={4}><Link to={`/products/${record.productId}`}>{record.productName}</Link><PlatformTag platform={record.platform} /></Space> },
    { title: '当前规则', dataIndex: 'rule', width: 130, render: ruleName },
    { title: '最新成功采集价', dataIndex: 'price', width: 155, render: value => <Price value={value} /> },
    { title: '数据来源', dataIndex: 'sourceLabel', width: 120, render: value => <SourceTag label={value} /> },
    { title: '当前条件', dataIndex: 'message', width: 320 },
    { title: '复核时间（上海）', dataIndex: 'evaluatedAt', width: 190, render: formatTime },
  ];
  const loadError = alerts.error || unread.error || active.error || handled.error || current.error || products.error;

  return <div className="page-stack">
    <PageHeading title="预警中心" description="及时发现到价与明显降价，保留触发时的价格和实际数据来源。" extra={<Space wrap><Button icon={<ReloadOutlined />} onClick={refresh} loading={alerts.loading}>刷新</Button><Popconfirm title="将全部未读预警标记为已读？" description="此操作处理全部商品的未读提醒，包括当前筛选之外的记录。" okText="全部标记" cancelText="取消" onConfirm={() => void markAllRead()}><Button icon={<CheckOutlined />} loading={readingAll} disabled={!unread.data?.total || Boolean(readingId)}>全部标记已读</Button></Popconfirm></Space>} />
    <Row gutter={[16, 16]}>
      <Col xs={24} sm={8}><Card className="panel-card"><Statistic title="待处理 · 未读提醒" value={unread.data?.total ?? '—'} valueStyle={{ color: '#d47f1f' }} /></Card></Col>
      <Col xs={24} sm={8}><Card className="panel-card"><Statistic title="当前触发中的规则" value={active.data?.activeRuleCount ?? '—'} valueStyle={{ color: '#c44051' }} /></Card></Col>
      <Col xs={24} sm={8}><Card className="panel-card"><Statistic title="已读提醒" value={handled.data?.total ?? '—'} /></Card></Col>
    </Row>
    <Alert type="info" showIcon message="预警规则与冷却机制" description="价格 ≤ 商品目标价，或 24 小时跌幅 ≥ 设定阈值时触发。未读且持续触发期间不重复提醒；同商品同规则、同采集口径自上次提醒起 24 小时内不新建记录。冷却期间再次达标仍显示触发中；已读不会解除当前规则。提醒流水保留原触发价与解除时间。" />
    {loadError && <Alert type="error" showIcon message={loadError} action={<Button size="small" onClick={() => { refresh(); products.reload(); }}>重新加载</Button>} />}
    <Card className="panel-card" title="当前触发规则" extra={<Typography.Text type="secondary">共 {current.data?.activeRuleCount ?? '—'} 条 · 当前商品和规则筛选</Typography.Text>}>
      <Table<AlertRuleState> rowKey="id" columns={currentColumns} dataSource={current.data?.currentRules ?? []} loading={current.loading} size="small" scroll={{ x: 1150 }} pagination={false} onRow={record => ({ 'data-testid': `current-rule-${record.productId}-${record.rule}` } as HTMLAttributes<HTMLTableRowElement>)} locale={{ emptyText: <Empty description="当前没有触发中的规则" /> }} />
      {(current.data?.activeRuleCount ?? 0) > 100 && <Typography.Text type="secondary">当前展示前 100 条，请按商品或规则筛选查看。</Typography.Text>}
    </Card>
    <Card className="panel-card" title="预警流水" extra={<Typography.Text type="secondary">共 {alerts.data?.total ?? '—'} 条</Typography.Text>}>
      <div className="filter-toolbar">
        <Select aria-label="预警商品筛选" placeholder="全部商品 · 可搜索名称 / SKU" allowClear showSearch filterOption={false} searchValue={productSearch} onSearch={setProductSearch} value={productId} onChange={(value) => { setProductId(value); setPage(1); }} loading={products.loading} options={(products.data?.items ?? []).map((product) => ({ value: product.id, label: `${product.name} · ${platformName(product.platform)}` }))} style={{ minWidth: 280, flex: '1 1 280px', maxWidth: 430 }} notFoundContent={products.loading ? '正在查找商品…' : '没有匹配商品，请更换关键词'} />
        <Select aria-label="预警规则筛选" placeholder="全部预警规则" allowClear value={rule} options={[{ value: 'target', label: '到达目标价' }, { value: 'drop24h', label: '24 小时降幅' }]} onChange={(value) => { setRule(value); setPage(1); }} style={{ width: 170 }} />
        <Select aria-label="预警处理状态筛选" placeholder="全部预警状态" allowClear value={status} options={[{ value: 'unread', label: '未读' }, { value: 'read', label: '已读' }, { value: 'active', label: '触发中' }]} onChange={(value) => { setStatus(value); setPage(1); }} style={{ width: 155 }} />
        <Button onClick={() => { setProductId(undefined); setRule(undefined); setStatus(undefined); setProductSearch(''); setPage(1); }}>重置筛选</Button>
      </div>
      <Table<PriceAlert> rowKey="id" columns={columns} dataSource={alerts.data?.items ?? []} loading={alerts.loading} size="middle" scroll={{ x: 1520 }} onRow={(record) => ({ 'data-testid': `alert-${record.id}` } as HTMLAttributes<HTMLTableRowElement>)} locale={{ emptyText: <Empty description={alerts.error ? '预警记录加载失败，请重试' : '当前筛选条件下没有预警记录'} /> }} pagination={{ current: page, pageSize, total: alerts.data?.total ?? 0, showSizeChanger: true, pageSizeOptions: [10, 20, 50, 100], showTotal: (total, range) => `${range[0]}–${range[1]} / 共 ${total} 条`, onChange: (nextPage, nextSize) => { setPage(nextSize === pageSize ? nextPage : 1); setPageSize(nextSize); } }} expandable={{ expandedRowRender: (record) => <Space wrap size="large"><Typography.Text>已读时间：{formatTime(record.readAt)}</Typography.Text><Typography.Text>原提醒解除时间：{formatTime(record.resolvedAt)}</Typography.Text><Typography.Text>当前规则复核时间：{formatTime(record.stateEvaluatedAt)}</Typography.Text><Typography.Text type="secondary">记录 ID：{record.id}</Typography.Text></Space> }} />
    </Card>
  </div>;
}
