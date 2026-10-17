import { useEffect, useState } from 'react';
import Alert from 'antd/es/alert';
import App from 'antd/es/app';
import Badge from 'antd/es/badge';
import Button from 'antd/es/button';
import Card from 'antd/es/card';
import Col from 'antd/es/col';
import Descriptions from 'antd/es/descriptions';
import Empty from 'antd/es/empty';
import Form from 'antd/es/form';
import Input from 'antd/es/input';
import InputNumber from 'antd/es/input-number';
import Row from 'antd/es/row';
import Skeleton from 'antd/es/skeleton';
import Space from 'antd/es/space';
import Table from 'antd/es/table';
import Tag from 'antd/es/tag';
import Typography from 'antd/es/typography';
import LockOutlined from '@ant-design/icons/es/icons/LockOutlined';
import PlayCircleOutlined from '@ant-design/icons/es/icons/PlayCircleOutlined';
import ReloadOutlined from '@ant-design/icons/es/icons/ReloadOutlined';
import SaveOutlined from '@ant-design/icons/es/icons/SaveOutlined';
import type { TableProps } from 'antd';
import { api, invalidateData, query, useRemote } from '../api';
import { useAuth } from '../auth';
import type { ListResponse, SchedulerRun, Settings, User } from '../types';
import { PageHeading, SourceTag, formatTime } from '../components/Ui';

type SettingsValues = Pick<Settings, 'collectionIntervalMinutes' | 'demoVolatilityPercent' | 'dropThresholdPercent'>;
interface PasswordValues { oldPassword: string; newPassword: string; confirmPassword: string }
interface RunResult { runId: string; total: number; successCount: number; failureCount: number; interruptedCount: number; status: string }

export default function SettingsPage() {
  const { message } = App.useApp();
  const auth = useAuth();
  const mustChangePassword = auth.user?.mustChangePassword === true;
  const [settingsForm] = Form.useForm<SettingsValues>();
  const [passwordForm] = Form.useForm<PasswordValues>();
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [runResult, setRunResult] = useState<RunResult>();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const settings = useRemote<Settings>(mustChangePassword ? null : '/settings');
  const runs = useRemote<ListResponse<SchedulerRun>>(mustChangePassword ? null : `/scheduler/runs${query({ page, pageSize })}`);
  const refresh = () => { settings.reload(); runs.reload(); };

  useEffect(() => {
    if (settings.data && !settingsForm.isFieldsTouched()) settingsForm.setFieldsValue({ collectionIntervalMinutes: settings.data.collectionIntervalMinutes, demoVolatilityPercent: settings.data.demoVolatilityPercent, dropThresholdPercent: settings.data.dropThresholdPercent });
  }, [settings.data, settingsForm]);

  const saveSettings = async (values: SettingsValues) => {
    setSaving(true);
    try { await api<Settings>('/settings', { method: 'PUT', body: JSON.stringify(values) }); settingsForm.resetFields(); settingsForm.setFieldsValue(values); message.success('全局设置已保存'); settings.reload(); }
    catch (error) { message.error(error instanceof Error ? error.message : '设置保存失败，请重试'); }
    finally { setSaving(false); }
  };
  const runCollection = async () => {
    setRunning(true);
    setRunResult(undefined);
    try {
      const result = await api<RunResult>('/scheduler/run', { method: 'POST' });
      setRunResult(result);
      if (result.interruptedCount > 0) message.warning(`本轮中断：${result.successCount} 个成功，${result.failureCount} 个失败，${result.interruptedCount} 个未完成。可重新采集或等待下次调度。`);
      else if (result.failureCount > 0) message.warning(`本轮已结束：${result.successCount} 个成功，${result.failureCount} 个失败。失败原因请查看采集记录。`);
      else message.success(`本轮已完成：${result.successCount} / ${result.total} 个商品采集成功`);
      refresh();
    } catch (error) { message.error(error instanceof Error ? error.message : '全轮采集失败，请重试'); refresh(); }
    finally { setRunning(false); }
  };
  const changePassword = async (values: PasswordValues) => {
    setChangingPassword(true);
    try { const session = await api<{ token: string; user: User }>('/auth/change-password', { method: 'POST', body: JSON.stringify({ oldPassword: values.oldPassword, newPassword: values.newPassword }) }); auth.renewSession(session); invalidateData(); passwordForm.resetFields(); message.success('密码已修改，旧登录会话已失效，本次会话已更新'); }
    catch (error) { message.error(error instanceof Error ? error.message : '密码修改失败，请重试'); }
    finally { setChangingPassword(false); }
  };
  const runColumns: TableProps<SchedulerRun>['columns'] = [
    { title: '开始时间（上海）', dataIndex: 'startedAt', width: 195, render: formatTime },
    { title: '触发方式', dataIndex: 'trigger', width: 110, render: (value) => <Tag color={value === 'scheduled' ? 'blue' : 'default'}>{value === 'scheduled' ? '定时调度' : value === 'manual' ? '手动全轮' : value}</Tag> },
    { title: '轮次状态', key: 'status', width: 115, render: (_, record) => <Badge status={record.status === 'running' ? 'processing' : record.status === 'completed' ? 'success' : record.status === 'failed' ? 'error' : 'warning'} text={record.status === 'running' ? '采集中' : record.status === 'interrupted' ? '已中断' : record.status === 'completed' ? '已完成' : record.status === 'failed' ? '运行失败' : '部分失败'} /> },
    { title: '商品数', dataIndex: 'total', width: 90, align: 'right' },
    { title: '成功', dataIndex: 'successCount', width: 85, align: 'right', render: (value) => <span style={{ color: '#247561' }}>{value}</span> },
    { title: '失败', dataIndex: 'failureCount', width: 85, align: 'right', render: (value) => <span style={{ color: value > 0 ? '#bc3d49' : undefined }}>{value}</span> },
    { title: '中断', dataIndex: 'interruptedCount', width: 85, align: 'right', render: (value) => <span style={{ color: value > 0 ? '#ad6800' : undefined }}>{value}</span> },
    { title: '成功率', key: 'rate', width: 100, align: 'right', render: (_, record) => record.finishedAt && record.total > 0 ? `${(record.successCount / record.total * 100).toFixed(2)}%` : '—' },
    { title: '耗时', key: 'duration', width: 100, align: 'right', render: (_, record) => record.finishedAt ? `${Math.max(0, (new Date(record.finishedAt).getTime() - new Date(record.startedAt).getTime()) / 1000).toFixed(2)} 秒` : '进行中' },
    { title: '结束时间（上海）', dataIndex: 'finishedAt', width: 195, render: formatTime },
  ];
  const scheduler = settings.data?.scheduler;
  const passwordCard = <Card className="panel-card" title="账号密码" extra={<LockOutlined />}>
    <Typography.Paragraph type="secondary">为管理员设置专用密码，至少 12 个字符，UTF-8 长度不超过 72 字节。修改后所有旧登录会话失效。</Typography.Paragraph>
    <Form<PasswordValues> form={passwordForm} layout="vertical" onFinish={(values) => void changePassword(values)} disabled={changingPassword} style={{ maxWidth: 540 }}>
      <Form.Item name="oldPassword" label="当前密码" rules={[{ required: true, message: '请输入当前密码' }, { max: 100, message: '密码不能超过 100 个字符' }]}><Input.Password autoComplete="current-password" maxLength={100} /></Form.Item>
      <Form.Item name="newPassword" label="新密码" rules={[{ required: true, message: '请输入新密码' }, { min: 12, max: 100, message: '新密码需为 12–100 个字符' }, { validator: (_, value: string) => !value || new TextEncoder().encode(value).length <= 72 ? Promise.resolve() : Promise.reject(new Error('新密码的 UTF-8 长度不能超过 72 字节')) }]}><Input.Password autoComplete="new-password" maxLength={100} /></Form.Item>
      <Form.Item name="confirmPassword" label="确认新密码" dependencies={['newPassword']} rules={[{ required: true, message: '请再次输入新密码' }, ({ getFieldValue }) => ({ validator(_, value: string) { return !value || getFieldValue('newPassword') === value ? Promise.resolve() : Promise.reject(new Error('两次输入的新密码不一致')); } })]}><Input.Password autoComplete="new-password" maxLength={100} /></Form.Item>
      <Button type="primary" htmlType="submit" icon={<LockOutlined />} loading={changingPassword}>修改密码</Button>
    </Form>
  </Card>;
  if (mustChangePassword) return <div className="page-stack"><PageHeading title="设置运营管理员密码" description="当前账号仍使用默认演示密码，请先设置专用密码再访问运营数据。" /><Alert type="warning" showIcon message="运营模式要求先修改默认密码" description="修改成功后会更新本次登录状态，并撤销所有旧登录会话。" />{passwordCard}</div>;

  return <div className="page-stack">
    <PageHeading title="系统设置" description="管理采集节奏、演示波动与预警阈值，查看每一轮调度的实际结果。" extra={<Button icon={<ReloadOutlined />} loading={settings.loading || runs.loading} onClick={refresh}>刷新状态</Button>} />
    {settings.data?.productionReadiness && <Alert type={settings.data.productionReadiness.blockers?.length ? 'warning' : 'info'} showIcon message={settings.data.productionReadiness.demoEnabled ? '当前为演示模式' : '当前为真实运营模式'} description={<><div>{settings.data.productionReadiness.demoEnabled ? '演示采集器可用，所有模拟价格均保留演示标记。正式运营时关闭演示模式，并为商品配置价格接口或网页采集规则。' : '已禁用演示数据采集，价格来自实际响应。请关注报价时效、解析失败及数据源可用性。'}</div>{[...(settings.data.productionReadiness.blockers || []), ...(settings.data.productionReadiness.warnings || [])].map(item => <div key={item}>• {item}</div>)}</>} data-testid="production-readiness" />}
    {(settings.error || runs.error) && <Alert type="error" showIcon message={settings.error || runs.error} action={<Button size="small" onClick={refresh}>重新加载</Button>} />}
    <Row gutter={[20, 20]}>
      <Col xs={24} xl={12}>
        <Card className="panel-card" title="全局采集与预警配置">
          {settings.loading && !settings.data ? <Skeleton active paragraph={{ rows: 7 }} /> : <Form<SettingsValues> form={settingsForm} layout="vertical" onFinish={(values) => void saveSettings(values)} disabled={!settings.data || saving}>
            <Form.Item name="collectionIntervalMinutes" label="采集间隔（分钟）" extra="默认 30 分钟；只采集启用中的商品。调度每分钟检查一次是否到期。" rules={[{ required: true, message: '请输入采集间隔' }, { type: 'integer', min: 1, max: 1440, message: '请输入 1–1440 的整数分钟' }]}><InputNumber min={1} max={1440} precision={0} addonAfter="分钟" style={{ width: '100%' }} /></Form.Item>
            <Form.Item name="demoVolatilityPercent" label="演示源波动率（%）" extra="演示模拟的单次变动上限，默认 2.50%；允许 0–3%。价格始终位于基准价的 60%–130%。" rules={[{ required: true, message: '请输入演示波动率' }, { type: 'number', min: 0, max: 3, message: '请输入 0–3 之间的波动率' }]}><InputNumber min={0} max={3} precision={2} step={0.1} addonAfter="%" style={{ width: '100%' }} /></Form.Item>
            <Form.Item name="dropThresholdPercent" label="24 小时跌幅预警默认阈值（%）" extra="默认 5.00%；单个商品可在采集配置中覆盖该阈值。目标价预警使用商品自身目标价。" rules={[{ required: true, message: '请输入跌幅阈值' }, { type: 'number', min: 0.1, max: 100, message: '请输入 0.1–100 之间的阈值' }]}><InputNumber min={0.1} max={100} precision={2} step={0.1} addonAfter="%" style={{ width: '100%' }} /></Form.Item>
            <Space wrap><Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={saving}>保存全局设置</Button><Button onClick={() => { if (settings.data) { settingsForm.resetFields(); settingsForm.setFieldsValue({ collectionIntervalMinutes: settings.data.collectionIntervalMinutes, demoVolatilityPercent: settings.data.demoVolatilityPercent, dropThresholdPercent: settings.data.dropThresholdPercent }); } }}>恢复已保存值</Button></Space>
          </Form>}
        </Card>
      </Col>
      <Col xs={24} xl={12}>
        <Card className="panel-card" title="调度运行状态" extra={<Badge status={running || scheduler?.running ? 'processing' : scheduler?.enabled ? 'success' : 'default'} text={running || scheduler?.running ? '正在采集' : scheduler?.enabled ? '调度已启用' : scheduler ? '调度未启用' : '正在读取'} />}>
          <Descriptions column={1} size="small" items={[{ key: 'interval', label: '当前全局间隔', children: settings.data ? `每 ${settings.data.collectionIntervalMinutes} 分钟` : '—' }, { key: 'running', label: '当前执行状态', children: scheduler ? (running || scheduler.running ? '采集中' : '空闲') : '—' }, { key: 'last', label: '上次运行 / 调度基准', children: formatTime(scheduler?.lastRunAt) }, { key: 'next', label: '下次定时采集（上海）', children: formatTime(scheduler?.nextRunAt) }]} />
          <Typography.Paragraph type="secondary" style={{ marginTop: 18 }}>后端进程内运行定时任务，逐个采集启用商品。单个商品失败会继续本轮；相同轮次不会重叠。进程初次启动时建立调度时间基准。</Typography.Paragraph>
          <Button type="primary" icon={<PlayCircleOutlined />} loading={running} disabled={!settings.data || scheduler?.running || saving} onClick={() => void runCollection()} data-testid="run-all-collections">立即采集全部启用商品</Button>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 10, marginBottom: 0 }}>手动全轮保留原有定时计划。完成后自动刷新运行状态和轮次记录。</Typography.Paragraph>
          {runResult && <Alert showIcon type={runResult.failureCount > 0 || runResult.interruptedCount > 0 ? 'warning' : 'success'} style={{ marginTop: 16 }} message={`本轮 ${runResult.total} 个商品：${runResult.successCount} 个成功，${runResult.failureCount} 个失败，${runResult.interruptedCount} 个中断`} description={runResult.interruptedCount > 0 ? '已完成的采集结果已保存；未完成商品可重新采集或等待下一轮。' : runResult.failureCount > 0 ? '失败原因已写入采集记录，可前往采集记录页查看。' : '成功价格和预警已写入数据库。'} />}
        </Card>
        <Card className="panel-card" title="数据源说明" style={{ marginTop: 20 }}>
          {settings.data?.dataSources.map((source) => <div key={source.type} style={{ marginBottom: 16 }}><SourceTag label={source.label} /><Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>{source.description}</Typography.Paragraph></div>)}
          {!settings.data && <Skeleton active paragraph={{ rows: 3 }} />}
          <Typography.Text type="secondary">所有成功价格来自采集器；失败不生成价格。当前价与统计均以成功采集流水为依据。</Typography.Text>
        </Card>
      </Col>
    </Row>
    <Card className="panel-card" title="采集轮次记录" extra={<Typography.Text type="secondary">共 {runs.data?.total ?? '—'} 轮</Typography.Text>}>
      <Table<SchedulerRun> rowKey="id" columns={runColumns} dataSource={runs.data?.items ?? []} loading={runs.loading} size="middle" scroll={{ x: 1170 }} pagination={{ current: page, pageSize, total: runs.data?.total ?? 0, showSizeChanger: true, pageSizeOptions: [10, 20, 50], showTotal: (total) => `共 ${total} 轮`, onChange: (nextPage, nextSize) => { setPage(nextSize === pageSize ? nextPage : 1); setPageSize(nextSize); } }} locale={{ emptyText: <Empty description={runs.error ? '调度记录加载失败，请重试' : '尚无采集轮次，可点击上方按钮执行第一轮'} /> }} expandable={{ expandedRowRender: (record) => <Space direction="vertical"><Typography.Text type="secondary">轮次 ID：{record.id}</Typography.Text>{record.error && <Typography.Text type="warning">{record.error}</Typography.Text>}</Space> }} />
    </Card>
    {passwordCard}
  </div>;
}
