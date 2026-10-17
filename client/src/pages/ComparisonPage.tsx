import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Alert from 'antd/es/alert';
import App from 'antd/es/app';
import Button from 'antd/es/button';
import Card from 'antd/es/card';
import Col from 'antd/es/col';
import Empty from 'antd/es/empty';
import Form from 'antd/es/form';
import Input from 'antd/es/input';
import Modal from 'antd/es/modal';
import Popconfirm from 'antd/es/popconfirm';
import Row from 'antd/es/row';
import Skeleton from 'antd/es/skeleton';
import Space from 'antd/es/space';
import Statistic from 'antd/es/statistic';
import Table from 'antd/es/table';
import Tag from 'antd/es/tag';
import Tooltip from 'antd/es/tooltip';
import Typography from 'antd/es/typography';
import AppstoreOutlined from '@ant-design/icons/es/icons/AppstoreOutlined';
import ArrowRightOutlined from '@ant-design/icons/es/icons/ArrowRightOutlined';
import DeleteOutlined from '@ant-design/icons/es/icons/DeleteOutlined';
import EditOutlined from '@ant-design/icons/es/icons/EditOutlined';
import PlusOutlined from '@ant-design/icons/es/icons/PlusOutlined';
import ReloadOutlined from '@ant-design/icons/es/icons/ReloadOutlined';
import TrophyOutlined from '@ant-design/icons/es/icons/TrophyOutlined';
import type { TableProps } from 'antd';
import { api, query, useRemote } from '../api';
import type { ComparisonGroup, Group, ListResponse } from '../types';
import { PageHeading, PlatformTag, Price, PriceFreshness, SourceTag, formatMoney, formatTime, hasUsablePrice, platformName } from '../components/Ui';

interface GroupValues { name: string }

export default function ComparisonPage() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const [managerOpen, setManagerOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<Group | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string>();
  const [groupPage, setGroupPage] = useState(1);
  const [groupPageSize, setGroupPageSize] = useState(10);
  const [groupForm] = Form.useForm<GroupValues>();
  const comparison = useRemote<{ groups: ComparisonGroup[] }>('/comparison');
  const groupList = useRemote<ListResponse<Group>>(managerOpen ? `/groups${query({ page: groupPage, pageSize: groupPageSize })}` : null);
  const allGroups = comparison.data?.groups ?? [];
  const productCount = allGroups.reduce((total, group) => total + group.products.length, 0);
  const pricedProductCount = allGroups.reduce((total, group) => total + group.products.filter(hasUsablePrice).length, 0);

  const refresh = () => { comparison.reload(); groupList.reload(); };
  const openEditor = (group?: Group) => {
    setEditingGroup(group ?? null);
    groupForm.resetFields();
    groupForm.setFieldsValue({ name: group?.name ?? '' });
    setEditorOpen(true);
  };
  const saveGroup = async (values: GroupValues) => {
    setSaving(true);
    try {
      await api(editingGroup ? `/groups/${encodeURIComponent(editingGroup.id)}` : '/groups', { method: editingGroup ? 'PUT' : 'POST', body: JSON.stringify({ name: values.name.trim() }) });
      message.success(editingGroup ? '商品组名称已更新' : '商品组已创建，请在监控商品中将同款商品归入该组');
      setEditorOpen(false);
      if (!editingGroup) setGroupPage(1);
      refresh();
    } catch (error) { message.error(error instanceof Error ? error.message : '商品组保存失败，请重试'); }
    finally { setSaving(false); }
  };
  const deleteGroup = async (group: Group) => {
    setDeletingId(group.id);
    try {
      await api(`/groups/${encodeURIComponent(group.id)}`, { method: 'DELETE' });
      message.success(`商品组「${group.name}」已删除，组内监控商品及采集记录保留`);
      setGroupPage(1);
      refresh();
    } catch (error) { message.error(error instanceof Error ? error.message : '商品组删除失败，请重试'); }
    finally { setDeletingId(undefined); }
  };
  const managerColumns: TableProps<Group>['columns'] = [
    { title: '商品组名称', dataIndex: 'name', key: 'name', render: (value) => <Typography.Text strong>{value}</Typography.Text> },
    { title: '组内商品', dataIndex: 'productCount', key: 'count', width: 100, align: 'right', render: (value) => `${value} 件` },
    { title: '操作', key: 'actions', width: 190, render: (_, group) => <Space size={2}><Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEditor(group)} disabled={Boolean(deletingId)}>编辑</Button><Popconfirm title={`删除「${group.name}」？`} description={`将解除 ${group.productCount} 件商品的分组关系，保留商品、采集与预警记录。`} okText="删除商品组" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => void deleteGroup(group)}><Button danger type="link" size="small" icon={<DeleteOutlined />} loading={deletingId === group.id} disabled={Boolean(deletingId && deletingId !== group.id)}>删除</Button></Popconfirm></Space> },
  ];

  return <div className="page-stack">
    <PageHeading title="同款比价" description="把同款商品归入一组，横向比较京东、天猫与拼多多的最新采集价格。" extra={<Space wrap><Button icon={<ReloadOutlined />} loading={comparison.loading} onClick={refresh}>刷新价格</Button><Button icon={<AppstoreOutlined />} onClick={() => setManagerOpen(true)}>商品组管理</Button><Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor()}>新建商品组</Button></Space>} />
    <Row gutter={[16, 16]}>
      <Col xs={24} sm={8}><Card className="panel-card"><Statistic title="商品组" value={comparison.data ? allGroups.length : '—'} suffix={comparison.data ? '组' : undefined} /></Card></Col>
      <Col xs={24} sm={8}><Card className="panel-card"><Statistic title="参与比价商品" value={comparison.data ? productCount : '—'} suffix={comparison.data ? '件' : undefined} /></Card></Col>
      <Col xs={24} sm={8}><Card className="panel-card"><Statistic title="参与有效报价排名" value={comparison.data ? pricedProductCount : '—'} suffix={comparison.data ? '件' : undefined} valueStyle={{ color: '#247561' }} /></Card></Col>
    </Row>
    <Alert type="info" showIcon message="最低价排名只使用有效且与当前采集配置一致的报价" description="过期或更换采集配置后的旧价格仍保留原值、来源和成功采集时间，但不会获得有效最低标记。演示模拟仅用于演示验收，真实运营应使用实际采集价格；同价保留全部并列商品。" />
    {comparison.error && <Alert type="error" showIcon message={comparison.error} action={<Button size="small" onClick={comparison.reload}>重新加载</Button>} />}
    {comparison.loading && !comparison.data && <Card className="panel-card"><Skeleton active paragraph={{ rows: 8 }} /></Card>}
    {comparison.data && allGroups.length === 0 && <Card className="panel-card"><Empty description={<span>尚无商品组。新建商品组后，在监控商品的新增或编辑表单中选择所属商品组，即可开始跨平台比价。</span>}><Space wrap><Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor()}>新建商品组</Button><Button onClick={() => navigate('/products')}>前往监控商品</Button></Space></Empty></Card>}
    {allGroups.map((group) => {
      // 新接口使用有效报价排名，兼容旧接口时也排除明确过期或配置失配的价格。
      const usable = group.products.filter(hasUsablePrice);
      const fallbackMinimum = usable.length ? Math.min(...usable.map(product => product.currentPrice!)) : null;
      const cheapestPrice = group.freshCheapestPrice === undefined ? fallbackMinimum : group.freshCheapestPrice;
      const cheapestIds = new Set(cheapestPrice == null ? [] : group.freshCheapestProductIds ?? usable.filter(product => product.currentPrice === cheapestPrice).map(product => product.id));
      const cheapestPlatforms = [...new Set(group.products.filter((product) => cheapestIds.has(product.id)).map((product) => platformName(product.platform)))];
      return <Card className="panel-card group-card" key={group.id} data-testid={`comparison-${group.id}`} title={<div className="group-card-title"><span>{group.name}</span><Typography.Text type="secondary" className="group-meta">{group.products.length} 件商品 · {new Set(group.products.map((product) => product.platform)).size} 个平台</Typography.Text></div>} extra={<Button type="text" size="small" icon={<EditOutlined />} aria-label={`编辑商品组${group.name}`} onClick={() => openEditor({ id: group.id, name: group.name, productCount: group.products.length })}>编辑组名称</Button>}>
        {cheapestPrice != null && cheapestPlatforms.length > 0 && <Tag color="gold" icon={<TrophyOutlined />} data-testid={`cheapest-${group.id}`} style={{ padding: '5px 12px', marginBottom: 18, fontSize: 13, whiteSpace: 'normal' }}>{cheapestIds.size > 1 ? '有效报价并列最低' : '有效报价最低'}：{cheapestPlatforms.join('、')} · {formatMoney(cheapestPrice)}</Tag>}
        {group.products.length > 0 ? <div className="comparison-grid">{group.products.map((product) => {
          const isCheapest = product.currentPrice != null && cheapestIds.has(product.id);
          return <Card key={product.id} className={`comparison-product-card${isCheapest ? ' is-cheapest' : ''}`} size="small" data-testid={`comparison-product-${product.id}`}>
            <Space wrap style={{ width: '100%', justifyContent: 'space-between', marginBottom: 12 }}><PlatformTag platform={product.platform} />{isCheapest && <Tag color="gold" icon={<TrophyOutlined />}>有效报价最低</Tag>}</Space>
            <Link to={`/products/${product.id}`} className="table-product-name">{product.name}</Link>
            <Typography.Paragraph type="secondary" style={{ marginTop: 5, marginBottom: 14, fontSize: 12 }}>SKU {product.sku} · {product.enabled ? '监控已启用' : '监控已停用'}</Typography.Paragraph>
            <div className="compare-price"><Typography.Text type="secondary">当前价</Typography.Text><div><Price value={product.currentPrice} testId={`comparison-current-price-${product.id}`} /></div></div>
            <div style={{ marginTop: 7, marginBottom: 18 }}><SourceTag label={product.currentPrice == null ? null : product.currentPriceSourceLabel ?? product.sourceLabel} /></div>
            <PriceFreshness product={product} />
            <div className="compare-stat"><span>历史最低</span><Price value={product.minPrice} /></div>
            {product.minPrice != null && <div style={{ fontSize: 10, color: '#9aa7b9', marginBottom: 8 }}>历史统计来源：{product.sourceLabels?.map((label) => <SourceTag key={label} label={label} />)}</div>}
            <div className="compare-stat"><span>基准参考价</span><Price value={product.basePrice} /></div>
            <div className="compare-stat"><span>目标价</span><Price value={product.targetPrice} /></div>
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 15, marginBottom: 8 }}>最近采集（上海）<br />{formatTime(product.lastCollectedAt)}</Typography.Paragraph>
            {product.lastCollectionStatus === 'failure' ? <Tooltip title={product.lastFailureReason}><Tag color="error" style={{ whiteSpace: 'normal', marginBottom: 12 }}>最近采集失败{product.currentPrice != null ? ' · 沿用成功价' : ''}</Tag></Tooltip> : <Tag color={product.lastCollectionStatus === 'success' ? 'success' : 'default'} style={{ marginBottom: 12 }}>{product.lastCollectionStatus === 'success' ? '最近采集成功' : '尚未采集'}</Tag>}
            <Button block icon={<ArrowRightOutlined />} onClick={() => navigate(`/products/${product.id}`)}>查看详情与价格曲线</Button>
          </Card>;
        })}</div> : <Empty description="该组暂无商品。前往监控商品，新增或编辑商品并选择此商品组，即可在这里比较各平台价格。"><Button onClick={() => navigate('/products')}>添加同款监控商品</Button></Empty>}
        {group.products.length > 0 && cheapestPrice == null && <Alert type="warning" showIcon style={{ marginTop: 16 }} message="该组暂无有效报价，暂无法确定当前最便宜平台" description="历史成功价继续展示供复核。进入商品详情检查采集配置并立即采集；失败原因保留在采集记录中。" />}
      </Card>;
    })}
    <Modal open={managerOpen} onCancel={() => setManagerOpen(false)} title="商品组管理" width={800} footer={<Button onClick={() => setManagerOpen(false)}>关闭</Button>}>
      <Typography.Paragraph type="secondary">商品组用于关联不同平台的同款商品。组内商品在监控商品页新增或编辑；删除组仅解除归组关系，保留商品及全部采集记录。</Typography.Paragraph>
      <Space style={{ marginBottom: 16 }}><Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor()}>新建商品组</Button><Button icon={<ReloadOutlined />} loading={groupList.loading} onClick={groupList.reload}>刷新</Button></Space>
      {groupList.error && <Alert type="error" showIcon message={groupList.error} style={{ marginBottom: 16 }} />}
      <Table<Group> rowKey="id" size="middle" columns={managerColumns} dataSource={groupList.data?.items ?? []} loading={groupList.loading} scroll={{ x: 500 }} locale={{ emptyText: <Empty description={groupList.error ? '商品组加载失败，请刷新重试' : '还没有商品组，点击上方按钮新建'} /> }} pagination={{ current: groupPage, pageSize: groupPageSize, total: groupList.data?.total ?? 0, showSizeChanger: true, pageSizeOptions: [10, 20, 50], showTotal: (total) => `共 ${total} 组`, onChange: (nextPage, nextSize) => { setGroupPage(nextSize === groupPageSize ? nextPage : 1); setGroupPageSize(nextSize); } }} />
    </Modal>
    <Modal forceRender open={editorOpen} onCancel={() => !saving && setEditorOpen(false)} title={editingGroup ? '编辑商品组' : '新建商品组'} footer={null} maskClosable={!saving} closable={!saving}>
      <Form<GroupValues> form={groupForm} layout="vertical" onFinish={(values) => void saveGroup(values)} disabled={saving}>
        <Form.Item name="name" label="商品组名称" extra="建议填写完整同款名称与规格，例如 iPhone 16 128G。" rules={[{ required: true, whitespace: true, message: '请输入商品组名称' }, { max: 100, message: '商品组名称不能超过 100 个字符' }]}><Input maxLength={100} showCount autoComplete="off" /></Form.Item>
        <Space><Button type="primary" htmlType="submit" loading={saving}>{editingGroup ? '保存名称' : '创建商品组'}</Button><Button onClick={() => setEditorOpen(false)}>取消</Button></Space>
      </Form>
    </Modal>
  </div>;
}
