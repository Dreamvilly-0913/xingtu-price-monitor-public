import { useDeferredValue, useState } from 'react';
import { Link } from 'react-router-dom';
import Alert from 'antd/es/alert';
import Button from 'antd/es/button';
import Card from 'antd/es/card';
import Empty from 'antd/es/empty';
import Select from 'antd/es/select';
import Space from 'antd/es/space';
import Table from 'antd/es/table';
import Tag from 'antd/es/tag';
import Typography from 'antd/es/typography';
import ReloadOutlined from '@ant-design/icons/es/icons/ReloadOutlined';
import type { HTMLAttributes } from 'react';
import type { TableProps } from 'antd';
import { query, useRemote } from '../api';
import type { Collection, ListResponse, Product } from '../types';
import { PageHeading, PlatformTag, Price, SourceTag, SOURCE_OPTIONS, formatTime, platformName } from '../components/Ui';

const triggerNames: Record<string, string> = { manual: '手动采集', scheduled: '定时采集', seed: '历史回填' };
const hasSnapshot = (record: Collection) => typeof record.collectorSnapshot === 'object' && record.collectorSnapshot !== null && Object.keys(record.collectorSnapshot).length > 0;

export default function CollectionsPage() {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [productId, setProductId] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [sourceType, setSourceType] = useState<string>();
  const [productSearch, setProductSearch] = useState('');
  const deferredSearch = useDeferredValue(productSearch);
  const records = useRemote<ListResponse<Collection>>(`/collections${query({ page, pageSize, productId, status, sourceType })}`);
  const products = useRemote<ListResponse<Product>>(`/products${query({ page: 1, pageSize: 100, search: deferredSearch || undefined })}`);

  const resetFilters = () => {
    setProductId(undefined);
    setStatus(undefined);
    setSourceType(undefined);
    setProductSearch('');
    setPage(1);
  };

  const columns: TableProps<Collection>['columns'] = [
    { title: '监控商品', dataIndex: 'productName', key: 'product', width: 230, fixed: 'left', render: (name, record) => <Link to={`/products/${record.productId}`}>{name}</Link> },
    { title: '平台', dataIndex: 'platform', width: 95, render: (value) => <PlatformTag platform={value} /> },
    { title: '数据来源', dataIndex: 'sourceLabel', width: 120, render: (value) => <SourceTag label={value} /> },
    { title: '采集状态', dataIndex: 'status', width: 100, render: (value) => <Tag color={value === 'success' ? 'success' : 'error'}>{value === 'success' ? '成功' : '失败'}</Tag> },
    { title: '采集价格', dataIndex: 'price', width: 135, align: 'right', render: (value, record) => <Price value={record.status === 'success' ? value : null} /> },
    { title: '失败原因', dataIndex: 'failureReason', width: 340, render: (value) => value ? <span style={{ color: '#bc3d49', overflowWrap: 'anywhere' }}>{value}</span> : <Typography.Text type="secondary">—</Typography.Text> },
    { title: '采集时间（上海）', dataIndex: 'collectedAt', width: 195, render: formatTime },
    { title: '触发方式', dataIndex: 'trigger', width: 110, render: (value: string) => triggerNames[value] ?? value },
  ];

  return <div className="page-stack">
    <PageHeading title="采集记录" description="每一笔价格的来处可追溯；采集失败保留原因，价格仅来自成功流水。" extra={<Button icon={<ReloadOutlined />} onClick={records.reload} loading={records.loading}>刷新记录</Button>} />
    <Alert type="info" showIcon message="演示模拟与真实采集均明确标注来源" description="金额为本次采集结果。失败流水没有价格，也不会覆盖商品最后一次成功采集的价格。展开记录可查看采集输入快照。" />
    {(records.error || products.error) && <Alert type="error" showIcon message={records.error || products.error} action={<Button size="small" onClick={() => { records.reload(); products.reload(); }}>重新加载</Button>} />}
    <Card className="panel-card" title="全部采集流水" extra={<Typography.Text type="secondary">共 {records.data?.total ?? '—'} 条</Typography.Text>}>
      <div className="filter-toolbar">
        <Select aria-label="采集记录商品筛选" placeholder="全部商品 · 可搜索名称 / SKU" allowClear showSearch filterOption={false} searchValue={productSearch} onSearch={setProductSearch} value={productId} onChange={(value) => { setProductId(value); setPage(1); }} loading={products.loading} options={(products.data?.items ?? []).map((product) => ({ value: product.id, label: `${product.name} · ${platformName(product.platform)}` }))} style={{ minWidth: 280, flex: '1 1 280px', maxWidth: 430 }} notFoundContent={products.loading ? '正在查找商品…' : '没有匹配商品，请更换关键词'} />
        <Select aria-label="采集状态筛选" placeholder="全部采集状态" allowClear value={status} options={[{ value: 'success', label: '采集成功' }, { value: 'failure', label: '采集失败' }]} onChange={(value) => { setStatus(value); setPage(1); }} style={{ width: 165 }} />
        <Select aria-label="采集来源筛选" placeholder="全部数据来源" allowClear value={sourceType} options={SOURCE_OPTIONS} onChange={(value) => { setSourceType(value); setPage(1); }} style={{ width: 165 }} />
        <Button onClick={resetFilters}>重置筛选</Button>
      </div>
      <Table<Collection> rowKey="id" dataSource={records.data?.items ?? []} columns={columns} loading={records.loading} scroll={{ x: 1325 }} size="middle" locale={{ emptyText: <Empty description={records.error ? '采集记录加载失败，请重试' : '当前筛选条件下没有采集记录'} /> }} onRow={(record) => ({ 'data-testid': `collection-${record.id}` } as HTMLAttributes<HTMLTableRowElement>)} pagination={{ current: page, pageSize, total: records.data?.total ?? 0, showSizeChanger: true, pageSizeOptions: [10, 20, 50, 100], showTotal: (total, range) => `${range[0]}–${range[1]} / 共 ${total} 条`, onChange: (nextPage, nextSize) => { setPage(nextSize === pageSize ? nextPage : 1); setPageSize(nextSize); } }} expandable={{ rowExpandable: hasSnapshot, expandedRowRender: (record) => <Space direction="vertical" style={{ width: '100%' }}><Typography.Text strong>采集输入快照 · {record.sourceLabel}</Typography.Text><Typography.Text type="secondary">保存本次采集的配置及输入，可用于追溯或复算历史结果。</Typography.Text><pre style={{ margin: 0, padding: 16, background: '#f4f6fa', borderRadius: 8, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12 }}>{JSON.stringify(record.collectorSnapshot, null, 2)}</pre></Space> }} />
    </Card>
  </div>;
}
