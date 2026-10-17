import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import Alert from 'antd/es/alert';
import Button from 'antd/es/button';
import Form from 'antd/es/form';
import Input from 'antd/es/input';
import LineChartOutlined from '@ant-design/icons/es/icons/LineChartOutlined';
import UserOutlined from '@ant-design/icons/es/icons/UserOutlined';
import LockOutlined from '@ant-design/icons/es/icons/LockOutlined';
import CheckCircleOutlined from '@ant-design/icons/es/icons/CheckCircleOutlined';
import { useAuth } from '../auth';
import { api, useRemote } from '../api';
import type { AuthStatus, User } from '../types';

export default function LoginPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = useRemote<AuthStatus>('/auth/status');
  const bootstrap = status.data?.bootstrapRequired === true;
  if (auth.token) return <Navigate to={auth.user?.mustChangePassword ? '/settings' : '/dashboard'} replace />;
  async function submit(values: { username: string; password: string; displayName?: string; bootstrapToken?: string }) {
    setLoading(true); setError(null);
    try {
      const user = bootstrap ? (await api<{ token: string; user: User }>('/auth/bootstrap', { method: 'POST', body: JSON.stringify({ username: values.username.trim(), displayName: values.displayName?.trim(), password: values.password, ...(values.bootstrapToken ? { bootstrapToken: values.bootstrapToken } : {}) }) })) : null;
      if (user) auth.renewSession(user);
      const account = user?.user || await auth.login(values.username, values.password);
      navigate(account.mustChangePassword ? '/settings' : '/dashboard', { replace: true });
    }
    catch (failure) { setError(failure instanceof Error ? failure.message : '登录失败'); }
    finally { setLoading(false); }
  }
  return <div className="login-page">
    <div className="login-story"><div className="login-brand"><span className="brand-icon"><LineChartOutlined /></span><strong>星图价格监控</strong></div><div className="login-story-content"><span className="eyebrow light">为电商运营而构建</span><h1>把握价格变化，<br />让运营更有依据。</h1><p>跨平台价格监控、趋势分析与降价提醒，<br />在一个清晰的工作台里协同运转。</p><div className="login-features"><span><CheckCircleOutlined /> 多平台同款比价</span><span><CheckCircleOutlined /> 可追溯的采集记录</span><span><CheckCircleOutlined /> 目标价与跌幅预警</span></div><div className="login-visual" aria-hidden="true"><div className="visual-grid" /><svg viewBox="0 0 480 160"><defs><linearGradient id="login-area" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#74e0d5" stopOpacity=".26" /><stop offset="100%" stopColor="#74e0d5" stopOpacity="0" /></linearGradient></defs><path d="M0 96 L45 110 L90 75 L135 86 L180 52 L225 63 L270 45 L315 65 L360 29 L410 40 L480 13 L480 160 L0 160Z" fill="url(#login-area)" /><path d="M0 96 L45 110 L90 75 L135 86 L180 52 L225 63 L270 45 L315 65 L360 29 L410 40 L480 13" fill="none" stroke="#74e0d5" strokeWidth="3" /><circle cx="360" cy="29" r="6" fill="#74e0d5" /></svg><div className="visual-caption">京东 · 天猫 · 拼多多</div></div></div><div className="login-story-footer">嘉兴星图优选 · 虚构演示企业</div></div>
    <div className="login-form-area"><div className="login-form-wrap"><span className="eyebrow">XINGTU WORKSPACE</span><h2>{bootstrap ? '初始化运营管理员' : '欢迎登录'}</h2><p className="login-description">{bootstrap ? '首次启动，请创建管理员账号和专用密码。初始化仅允许完成一次。' : '进入价格监控工作台，查看最新价格动态。'}</p>{error && <Alert message={error} type="error" showIcon style={{ marginBottom: 20 }} />}{status.error && <Alert message="无法确认系统初始化状态，请刷新重试" type="error" showIcon style={{ marginBottom: 20 }} />}<Form key={bootstrap ? 'bootstrap' : 'login'} layout="vertical" onFinish={submit} initialValues={{ username: bootstrap || status.data?.demoEnabled ? 'admin' : '' }} requiredMark={false}><Form.Item name="username" label="用户名" rules={[{ required: true, message: '请输入用户名' }]}><Input size="large" prefix={<UserOutlined />} autoComplete="username" placeholder="请输入用户名" /></Form.Item>{bootstrap && <Form.Item name="displayName" label="管理员姓名" rules={[{ required: true, whitespace: true, message: '请输入管理员姓名' }, { max: 100 }]}><Input size="large" autoComplete="name" placeholder="工作台显示的姓名" /></Form.Item>}{bootstrap && status.data?.bootstrapTokenRequired && <Form.Item name="bootstrapToken" label="初始化令牌" rules={[{ required: true, message: '请输入部署时配置的初始化令牌' }]}><Input.Password size="large" autoComplete="off" placeholder="由部署负责人提供" /></Form.Item>}<Form.Item name="password" label={bootstrap ? '管理员密码' : '密码'} rules={[{ required: true, message: '请输入密码' }, ...(bootstrap ? [{ min: 12, max: 100, message: '运营管理员密码需为 12–100 个字符' }] : [])]}><Input.Password size="large" prefix={<LockOutlined />} autoComplete={bootstrap ? 'new-password' : 'current-password'} placeholder="请输入密码" /></Form.Item>{bootstrap && <Form.Item name="confirmPassword" label="确认管理员密码" dependencies={['password']} rules={[{ required: true, message: '请再次输入密码' }, ({ getFieldValue }) => ({ validator(_, value: string) { return !value || value === getFieldValue('password') ? Promise.resolve() : Promise.reject(new Error('两次密码不一致')); } })]}><Input.Password size="large" autoComplete="new-password" /></Form.Item>}<Button type="primary" size="large" htmlType="submit" block loading={loading || status.loading && !status.data} disabled={!status.data}>{bootstrap ? '创建管理员并进入' : '登录'}</Button></Form>{status.data?.demoEnabled && !bootstrap && <div className="demo-account" data-testid="demo-account"><span>演示账号</span><strong>admin / admin123</strong><small>部署上线后请在系统设置中修改密码。</small></div>}<div className="login-source-note">{status.data?.demoEnabled ? '演示数据明确标注“演示模拟”，真实采集保留响应结果与失败原因。' : '运营模式：实际价格须通过真实采集产生；请使用团队的管理员账号。'}</div></div></div>
  </div>;
}
