import { useDeferredValue, useEffect, useState, type HTMLAttributes } from 'react';
import { useNavigate } from 'react-router-dom';
import Alert from 'antd/es/alert';
import AntdApp from 'antd/es/app';
import AutoComplete from 'antd/es/auto-complete';
import Button from 'antd/es/button';
import Card from 'antd/es/card';
import Form from 'antd/es/form';
import Input from 'antd/es/input';
import InputNumber from 'antd/es/input-number';
import Modal from 'antd/es/modal';
import Popconfirm from 'antd/es/popconfirm';
import Radio from 'antd/es/radio';
import Select from 'antd/es/select';
import Space from 'antd/es/space';
import Switch from 'antd/es/switch';
import Table from 'antd/es/table';
import Tag from 'antd/es/tag';
import Tooltip from 'antd/es/tooltip';
import PlusOutlined from '@ant-design/icons/es/icons/PlusOutlined';
import SearchOutlined from '@ant-design/icons/es/icons/SearchOutlined';
import SyncOutlined from '@ant-design/icons/es/icons/SyncOutlined';
import type { TableColumnsType } from 'antd';
import { api, query, useRemote } from '../api';
import type { AuthStatus, Collection, CollectorConfig, CollectorPreview, Group, ListResponse, Platform, PriceAlert, Product, SourceType } from '../types';
import { ChangePercent, PageHeading, PlatformTag, Price, PriceFreshness, RefreshButton, SourceTag, formatTime, PLATFORM_OPTIONS, SOURCE_OPTIONS } from '../components/Ui';

type ProductBody = Pick<Product, 'name' | 'platform' | 'url' | 'sku' | 'category' | 'basePrice' | 'targetPrice' | 'sourceType' | 'collectorConfig' | 'enabled' | 'groupId'>;
interface ProductFormValues extends Omit<ProductBody, 'collectorConfig'> { mode: 'json' | 'html'; priceUrl?: string; jsonPath?: string; cssSelector?: string; priceRegex?: string; timeoutMs?: number; dropThresholdPercent?: number }

// 编辑、开关监控均显式提交白名单字段，统计和价格始终由服务端采集流水推导。
function productBody(product: Product): ProductBody {
  return { name: product.name, platform: product.platform, url: product.url, sku: product.sku, category: product.category, basePrice: product.basePrice, targetPrice: product.targetPrice, sourceType: product.sourceType, collectorConfig: product.collectorConfig, enabled: product.enabled, groupId: product.groupId };
}
function formBody(values: ProductFormValues): ProductBody {
  const collectorConfig: CollectorConfig = {};
  if (values.sourceType === 'http') {
    collectorConfig.mode = values.mode;
    if (values.priceUrl?.trim()) collectorConfig.priceUrl = values.priceUrl.trim();
    if (values.mode === 'json' && values.jsonPath?.trim()) collectorConfig.jsonPath = values.jsonPath.trim();
    if (values.mode === 'html' && values.cssSelector?.trim()) collectorConfig.cssSelector = values.cssSelector.trim();
    if (values.priceRegex?.trim()) collectorConfig.priceRegex = values.priceRegex.trim();
    if (values.timeoutMs != null) collectorConfig.timeoutMs = values.timeoutMs;
  }
  if (values.dropThresholdPercent != null) collectorConfig.dropThresholdPercent = values.dropThresholdPercent;
  return { name: values.name.trim(), platform: values.platform as Platform, url: values.url.trim(), sku: values.sku.trim(), category: values.category.trim(), basePrice: values.basePrice, targetPrice: values.targetPrice, sourceType: values.sourceType as SourceType, collectorConfig, enabled: values.enabled, groupId: values.groupId || null };
}

export default function ProductsPage() {
  const navigate = useNavigate();
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<ProductFormValues>();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [search, setSearch] = useState('');
  const [platform, setPlatform] = useState<string>();
  const [category, setCategory] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [sourceFilter, setSourceFilter] = useState<string>();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [saving, setSaving] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [preview, setPreview] = useState<CollectorPreview>();
  const [previewing, setPreviewing] = useState(false);
  const [groupSearch, setGroupSearch] = useState('');
  const [groupPage, setGroupPage] = useState(1);
  const [groupChoices, setGroupChoices] = useState<Group[]>([]);
  const deferredGroupSearch = useDeferredValue(groupSearch);
  const products = useRemote<ListResponse<Product>>(`/products${query({ page, pageSize, search, platform, category, status, sourceType: sourceFilter })}`);
  const authStatus = useRemote<AuthStatus>('/auth/status');
  const demoEnabled = authStatus.data?.demoEnabled !== false;
  const availableSources = SOURCE_OPTIONS.map(source => ({ ...source, disabled: source.value === 'demo' && !demoEnabled, label: source.value === 'demo' && !demoEnabled ? '演示模拟（运营模式已禁用）' : source.label }));
  const categoryList = useRemote<{ items: string[] }>('/categories');
  const groups = useRemote<ListResponse<Group>>(modalOpen ? `/groups${query({ page: groupPage, pageSize: 20, search: deferredGroupSearch })}` : null);
  const sourceType = Form.useWatch('sourceType', form) || 'demo';
  const formPlatform = Form.useWatch('platform', form) || 'jd';
  const mode = Form.useWatch('mode', form) || 'json';
  const categories = categoryList.data?.items || [];
  useEffect(() => { if (groups.data) setGroupChoices(existing => { const merged = new Map(existing.map(group => [group.id, group])); for (const group of groups.data!.items) merged.set(group.id, group); return [...merged.values()]; }); }, [groups.data]);
  function reload() { products.reload(); categoryList.reload(); }
  function changeFilter(setter: (value: string | undefined) => void, value: string | undefined) { setter(value); setPage(1); }
  function openForm(product?: Product) {
    setEditing(product || null);
    setPreview(undefined); setGroupSearch(''); setGroupPage(1);
    setGroupChoices(product?.group ? [{ ...product.group, productCount: 0 }] : []);
    form.resetFields();
    form.setFieldsValue(product ? { ...productBody(product), ...product.collectorConfig, mode: product.collectorConfig.mode || 'json' } : { platform: 'jd', sourceType: demoEnabled ? 'demo' : 'http', mode: 'json', enabled: true, timeoutMs: 10000, jsonPath: '$[0].p', groupId: null });
    groups.reload();
    setModalOpen(true);
  }
  async function save(values: ProductFormValues) {
    const body = formBody(values);
    setSaving(true);
    try {
      await api<Product>(editing ? `/products/${editing.id}` : '/products', { method: editing ? 'PUT' : 'POST', body: JSON.stringify(body) });
      message.success(editing ? '商品配置已保存' : '监控商品已创建，请立即采集获取第一条价格');
      setModalOpen(false); reload();
    } catch (failure) { message.error(failure instanceof Error ? failure.message : '保存失败'); }
    finally { setSaving(false); }
  }
  async function previewConfiguration() {
    setPreview(undefined);
    try {
      const values = await form.validateFields();
      setPreviewing(true);
      setPreview(await api<CollectorPreview>('/collectors/preview', { method: 'POST', body: JSON.stringify(formBody(values)) }));
    } catch (failure) { if (failure instanceof Error) message.error(failure.message); }
    finally { setPreviewing(false); }
  }
  async function collect(product: Product) {
    setWorking(product.id);
    try {
      const result = await api<{ collection: Collection; product: Product; alertsCreated: PriceAlert[] }>(`/products/${product.id}/collect`, { method: 'POST' });
      if (result.collection.status === 'success') message.success(`采集成功 · ${result.collection.sourceLabel} · ¥${result.collection.price!.toFixed(2)}`);
      else message.error(`采集失败：${result.collection.failureReason}`);
      reload();
    } catch (failure) { message.error(failure instanceof Error ? failure.message : '采集失败'); }
    finally { setWorking(null); }
  }
  async function toggle(product: Product, enabled: boolean) {
    setWorking(product.id);
    try { await api<Product>(`/products/${product.id}`, { method: 'PUT', body: JSON.stringify({ ...productBody(product), enabled }) }); message.success(enabled ? '已启用定时监控' : '已关闭定时监控，可继续手动采集'); reload(); }
    catch (failure) { message.error(failure instanceof Error ? failure.message : '更新失败'); }
    finally { setWorking(null); }
  }
  async function remove(product: Product) {
    setWorking(product.id);
    try { await api(`/products/${product.id}`, { method: 'DELETE' }); message.success('商品及关联采集、预警记录已删除'); if (products.data?.items.length === 1 && page > 1) setPage(page - 1); reload(); }
    catch (failure) { message.error(failure instanceof Error ? failure.message : '删除失败'); }
    finally { setWorking(null); }
  }
  const columns: TableColumnsType<Product> = [
    { title: '监控商品', key: 'name', fixed: 'left', width: 270, render: (_, product) => <div><button className="product-name-button" onClick={() => navigate(`/products/${product.id}`)}>{product.name}</button><div className="cell-meta"><PlatformTag platform={product.platform} /><span className="muted">{product.category}</span></div><div className="product-sku">SKU {product.sku}</div></div> },
    { title: '最近成功价格 / 来源', key: 'price', width: 210, render: (_, product) => <div><Price value={product.currentPrice} testId={`product-price-${product.id}`} /><div className="cell-meta">{product.currentPrice == null ? <Tag>尚未成功采集</Tag> : <SourceTag label={product.currentPriceSourceLabel || product.sourceLabel} />}</div><PriceFreshness product={product} /><small className="muted">目标 <Price value={product.targetPrice} className="small-price" /></small></div> },
    { title: '较昨日', dataIndex: 'changeFromYesterdayPercent', width: 105, render: value => <ChangePercent value={value} /> },
    { title: '较基准价', dataIndex: 'changeFromBasePercent', width: 110, render: value => <ChangePercent value={value} /> },
    { title: '历史最低', key: 'minPrice', width: 135, render: (_, product) => <div><Price value={product.minPrice} className="secondary-price" /><div className="cell-meta">{product.sourceLabels?.map(label => <SourceTag key={label} label={label} />)}</div></div> },
    { title: '最近采集状态', key: 'collection', width: 200, render: (_, product) => <div><Tag color={product.lastCollectionStatus === 'success' ? 'success' : product.lastCollectionStatus === 'failure' ? 'error' : 'default'}>{product.lastCollectionStatus === 'success' ? '采集成功' : product.lastCollectionStatus === 'failure' ? `连续失败 ${product.consecutiveFailures} 次` : '尚未采集'}</Tag>{product.lastFailureReason && <Tooltip title={product.lastFailureReason}><div className="collection-failure-short">{product.lastFailureReason}</div></Tooltip>}<div className="cell-time">{formatTime(product.lastCollectedAt)}</div><div className="cell-time">监控源：{product.configuredSourceLabel}</div></div> },
    { title: '监控', key: 'enabled', width: 95, render: (_, product) => <Switch checked={product.enabled} loading={working === product.id} checkedChildren="开启" unCheckedChildren="关闭" aria-label={`${product.name}启用监控`} data-testid={`product-enabled-${product.id}`} onChange={enabled => toggle(product, enabled)} /> },
    { title: '操作', key: 'actions', fixed: 'right', width: 185, render: (_, product) => <div className="table-actions"><Button type="link" size="small" onClick={() => navigate(`/products/${product.id}`)}>查看详情</Button><Button type="link" size="small" onClick={() => openForm(product)}>编辑</Button><Button size="small" icon={<SyncOutlined />} loading={working === product.id} onClick={() => collect(product)}>立即采集</Button><Popconfirm title="删除监控商品？" description="该商品的采集历史和预警记录也会删除。" okText="确认删除" cancelText="取消" onConfirm={() => remove(product)}><Button type="link" size="small" danger>删除</Button></Popconfirm></div> },
  ];
  return <div className="page-stack"><PageHeading title="监控商品" description="管理监控范围、目标价与采集规则。当前价格始终对应最新一条成功采集记录。" extra={<><RefreshButton loading={products.loading} onClick={reload} /><Button type="primary" icon={<PlusOutlined />} onClick={() => openForm()} data-testid="product-create">新增商品</Button></>} />
    {products.error && <Alert type="error" showIcon message={products.error} action={<Button onClick={reload}>重试</Button>} />}
    <Card className="panel-card product-list-card"><div className="filter-toolbar"><Input.Search prefix={<SearchOutlined />} placeholder="搜索商品名称或 SKU" allowClear onSearch={value => { setSearch(value.trim()); setPage(1); }} onChange={event => { if (!event.target.value) { setSearch(''); setPage(1); } }} className="product-search" /><Select aria-label="平台" data-testid="platform-filter" placeholder="全部平台" allowClear options={PLATFORM_OPTIONS} value={platform} onChange={value => changeFilter(setPlatform, value)} /><Select aria-label="分类" placeholder="全部分类" allowClear showSearch optionFilterProp="label" options={categories.map(value => ({ value, label: value }))} value={category} onChange={value => changeFilter(setCategory, value)} /><Select aria-label="监控状态" placeholder="全部状态" allowClear value={status} options={[{ value: 'enabled', label: '监控开启' }, { value: 'disabled', label: '监控关闭' }, { value: 'failing', label: '采集失败' }]} onChange={value => changeFilter(setStatus, value)} /><Select aria-label="配置数据源" placeholder="全部数据源" allowClear value={sourceFilter} options={SOURCE_OPTIONS} onChange={value => changeFilter(setSourceFilter, value)} /></div><div className="table-section-header"><span>商品列表 <strong>{products.data?.total ?? '—'}</strong></span><small>金额保留两位小数 · 涨跌对比成功采集价</small></div><Table<Product> rowKey="id" onRow={product => ({ 'data-testid': `product-${product.id}` } as HTMLAttributes<HTMLTableRowElement>)} columns={columns} dataSource={products.data?.items || []} loading={products.loading} scroll={{ x: 1470 }} pagination={{ current: page, pageSize, total: products.data?.total || 0, showSizeChanger: true, showTotal: total => `共 ${total} 件商品`, onChange: (nextPage, size) => { setPage(nextPage); setPageSize(size); } }} locale={{ emptyText: '没有符合筛选条件的商品，可新增监控商品或调整筛选。' }} /></Card>
    <div className="inline-business-note"><SourceTag label="演示模拟" />基于确定性游走，可复算；<SourceTag label="真实采集" />拉取实际响应，失败会保留原因。切换数据源后，旧价格仍保留原采集来源。</div>
    <Modal title={editing ? '编辑监控商品' : '新增监控商品'} open={modalOpen} onCancel={() => setModalOpen(false)} width={760} forceRender footer={<Space><Button onClick={() => setModalOpen(false)}>取消</Button><Button type="primary" form="product-form" htmlType="submit" loading={saving}>{editing ? '保存修改' : '创建商品'}</Button></Space>}>
      <Form<ProductFormValues> id="product-form" form={form} layout="vertical" onFinish={save} onValuesChange={() => setPreview(undefined)} requiredMark={false} initialValues={{ platform: 'jd', sourceType: 'demo', mode: 'json', enabled: true, timeoutMs: 10000, jsonPath: '$[0].p' }}><div className="form-section-title">商品信息</div><div className="form-grid"><Form.Item name="name" label="商品名称" rules={[{ required: true, whitespace: true, message: '请输入商品名称' }, { max: 150 }]}><Input maxLength={150} placeholder="完整名称与规格" /></Form.Item><Form.Item name="platform" label="平台" rules={[{ required: true }]}><Select options={PLATFORM_OPTIONS} /></Form.Item><Form.Item name="category" label="分类" rules={[{ required: true, whitespace: true, message: '请输入商品分类' }, { max: 50 }]}><AutoComplete options={categories.map(value => ({ value }))} placeholder="选择或输入分类" /></Form.Item><Form.Item name="sku" label="SKU" rules={[{ required: true, whitespace: true, message: '请输入平台商品 SKU' }, { max: 100 }]}><Input maxLength={100} placeholder="用于标识平台商品" /></Form.Item><Form.Item name="url" label="商品链接" className="form-span-two" rules={[{ required: true, message: '请输入商品链接' }, { type: 'url', message: '请输入有效的 http / https 地址' }, { validator: (_, value: string) => !value || /^https?:\/\//i.test(value) ? Promise.resolve() : Promise.reject(new Error('只支持 http / https 链接')) }]}><Input placeholder="https://..." /></Form.Item><Form.Item name="basePrice" label="基准价（元）" rules={[{ required: true, message: '请输入基准价' }]}><InputNumber min={0.01} max={21474836.47} precision={2} addonBefore="¥" style={{ width: '100%' }} /></Form.Item><Form.Item name="targetPrice" label="目标价（元）" rules={[{ required: true, message: '请输入目标价' }]}><InputNumber min={0.01} max={21474836.47} precision={2} addonBefore="¥" style={{ width: '100%' }} /></Form.Item><Form.Item name="groupId" label="商品组" extra="远程搜索同款组，已选商品组会保留。"><Select allowClear showSearch filterOption={false} searchValue={groupSearch} onSearch={value => { setGroupSearch(value); setGroupPage(1); setGroupChoices(editing?.group ? [{ ...editing.group, productCount: 0 }] : []); }} options={groupChoices.map(group => ({ label: group.name, value: group.id }))} loading={groups.loading} placeholder="搜索同款商品组" notFoundContent={groups.loading ? '正在搜索…' : groups.error || '没有匹配商品组'} dropdownRender={menu => <>{menu}{groups.data && groupPage * groups.data.pageSize < groups.data.total && <Button type="link" block loading={groups.loading} onMouseDown={event => event.preventDefault()} onClick={() => setGroupPage(value => value + 1)}>加载更多商品组</Button>}</>} /></Form.Item><Form.Item name="enabled" label="启用监控" valuePropName="checked" extra="关闭后不参与定时采集，仍可手动采集。"><Switch checkedChildren="开启" unCheckedChildren="关闭" /></Form.Item></div>
      <div className="form-section-title">数据源与预警</div><div className="form-grid"><Form.Item name="sourceType" label="数据源" rules={[{ required: true }]}><Select options={availableSources} /></Form.Item><Form.Item name="dropThresholdPercent" label="单品跌幅阈值（%）" extra="留空使用系统默认的 24 小时跌幅阈值。"><InputNumber min={0.1} max={100} precision={2} addonAfter="%" placeholder="使用系统默认" style={{ width: '100%' }} /></Form.Item></div>
      {sourceType === 'demo' ? <Alert type="info" showIcon message="演示模拟" description="使用商品 ID 与日期确定随机种子，按系统波动率游走；价格始终标注演示模拟。新商品首次采集从基准价开始，后续与上一成功价格连续衔接。" /> : <div className="collector-config-panel"><Form.Item name="mode" label="解析方式"><Radio.Group options={[{ label: 'JSON 价格接口', value: 'json' }, { label: '网页 CSS 选择器', value: 'html' }]} /></Form.Item><Form.Item name="priceUrl" label={mode === 'json' ? '价格接口 URL' : '采集网页 URL'} extra={mode === 'json' && formPlatform === 'jd' ? '京东留空时默认请求公开价格接口，SKU 取上方商品配置。' : mode === 'html' ? '留空时请求上方商品链接。' : '填写可访问的 JSON 价格接口。'} rules={[{ type: 'url', message: '请输入有效 URL' }, { required: mode === 'json' && formPlatform !== 'jd', message: '非京东 JSON 采集必须配置价格接口' }, { validator: (_, value: string) => !value || /^https?:\/\//i.test(value) ? Promise.resolve() : Promise.reject(new Error('只支持 http / https 链接')) }]}><Input placeholder="https://..." /></Form.Item><div className="form-grid">{mode === 'json' ? <Form.Item name="jsonPath" label="JSON 路径" extra="京东默认路径为 $[0].p。" rules={[{ max: 200 }]}><Input placeholder="$[0].p" maxLength={200} /></Form.Item> : <Form.Item name="cssSelector" label="CSS 选择器" rules={[{ required: true, whitespace: true, message: '网页采集必须配置价格选择器' }, { max: 300 }]}><Input placeholder="匹配价格文本的选择器" maxLength={300} /></Form.Item>}<Form.Item name="timeoutMs" label="请求超时（毫秒）"><InputNumber min={100} max={30000} step={1000} precision={0} style={{ width: '100%' }} /></Form.Item></div><Alert type="warning" showIcon message="真实采集可能失败" description="网络超时、平台拦截或解析失败都会记入采集日志，不会用演示价格补填。接口需无需登录即可访问。" /></div>}
      {sourceType === 'http' && <div style={{ marginTop: 18 }}>
        <Form.Item name="priceRegex" label="售价匹配规则（可选）" extra={'填写售价字面量前缀及标准金额捕获组，例如 到手价¥(\\d+(?:\\.\\d{1,2})?)；必须唯一匹配。'} rules={[{ max: 300, message: '规则最多 300 个字符' }]}><Input maxLength={300} placeholder={'到手价¥(\\d+(?:\\.\\d{1,2})?)'} /></Form.Item>
        <Button onClick={() => void previewConfiguration()} loading={previewing} disabled={saving} data-testid="collector-preview">测试采集配置</Button>
        <div className="cell-time" style={{ marginTop: 8 }}>预览会实际请求配置的地址并解析响应，不写入商品、价格历史或预警。保存配置后再立即采集。</div>
        {preview && <Alert style={{ marginTop: 12 }} showIcon type={preview.status === 'success' ? 'success' : 'error'} message={preview.status === 'success' ? <>预览解析成功：<Price value={preview.price} /> · {preview.sourceLabel}</> : `预览失败：${preview.failureReason || '未获得有效售价'}`} description={<><div>采集时间（上海）：{formatTime(preview.collectedAt)}</div>{preview.requestUrl && <div style={{ overflowWrap: 'anywhere' }}>实际请求地址（已脱敏）：{preview.requestUrl}</div>}<div>此预览结果没有产生价格记录或历史统计。</div></>} data-testid="collector-preview-result" />}
      </div>}
    </Form></Modal>
  </div>;
}
