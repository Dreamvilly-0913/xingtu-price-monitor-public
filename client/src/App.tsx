import { lazy, Suspense, useEffect, useState } from 'react';
import { Link, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import Layout from 'antd/es/layout';
import Menu from 'antd/es/menu';
import Drawer from 'antd/es/drawer';
import Button from 'antd/es/button';
import Avatar from 'antd/es/avatar';
import Badge from 'antd/es/badge';
import Dropdown from 'antd/es/dropdown';
import Spin from 'antd/es/spin';
import Result from 'antd/es/result';
import DashboardOutlined from '@ant-design/icons/es/icons/DashboardOutlined';
import ShoppingOutlined from '@ant-design/icons/es/icons/ShoppingOutlined';
import SwapOutlined from '@ant-design/icons/es/icons/SwapOutlined';
import DatabaseOutlined from '@ant-design/icons/es/icons/DatabaseOutlined';
import BellOutlined from '@ant-design/icons/es/icons/BellOutlined';
import SettingOutlined from '@ant-design/icons/es/icons/SettingOutlined';
import MenuOutlined from '@ant-design/icons/es/icons/MenuOutlined';
import LogoutOutlined from '@ant-design/icons/es/icons/LogoutOutlined';
import LineChartOutlined from '@ant-design/icons/es/icons/LineChartOutlined';
import { useAuth } from './auth';
import { useRemote } from './api';
import type { ListResponse, PriceAlert } from './types';

const LoginPage = lazy(() => import('./pages/LoginPage'));
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const ProductsPage = lazy(() => import('./pages/ProductsPage'));
const DetailPage = lazy(() => import('./pages/DetailPage'));
const ComparisonPage = lazy(() => import('./pages/ComparisonPage'));
const CollectionsPage = lazy(() => import('./pages/CollectionsPage'));
const AlertsPage = lazy(() => import('./pages/AlertsPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const menuItems = [
  { key: '/dashboard', icon: <DashboardOutlined />, label: '运营仪表盘' },
  { key: '/products', icon: <ShoppingOutlined />, label: '监控商品' },
  { key: '/comparison', icon: <SwapOutlined />, label: '同款比价' },
  { key: '/collections', icon: <DatabaseOutlined />, label: '采集记录' },
  { key: '/alerts', icon: <BellOutlined />, label: '预警中心' },
  { key: '/settings', icon: <SettingOutlined />, label: '系统设置' },
];
function Brand() { return <div className="brand"><span className="brand-icon"><LineChartOutlined /></span><div><strong>星图价格监控</strong><small>XINGTU PRICE MONITOR</small></div></div>; }
function Workspace() {
  const { token, user, loading, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [drawer, setDrawer] = useState(false);
  const alerts = useRemote<ListResponse<PriceAlert>>(token && user && !loading && !user.mustChangePassword ? '/alerts?status=unread&pageSize=1' : null);
  useEffect(() => { alerts.reload(); }, [location.pathname]);
  useEffect(() => { window.scrollTo(0, 0); }, [location.pathname]);
  if (!token) return <Navigate to="/login" replace />;
  if (loading || !user) return <div className="page-loading"><Spin size="large" /><span>正在确认登录状态</span></div>;
  if (user?.mustChangePassword && location.pathname !== '/settings') return <Navigate to="/settings" replace />;
  const selected = `/${location.pathname.split('/')[1]}`;
  const activeTitle = location.pathname.startsWith('/products/') ? '商品详情' : menuItems.find(item => item.key === selected)?.label || '运营工作台';
  const navigation = <Menu mode="inline" selectedKeys={[selected]} items={menuItems} onClick={({ key }) => { navigate(key); setDrawer(false); }} />;
  return <Layout className="app-layout">
    <Layout.Sider width={230} theme="light" className="app-sider"><Brand /><div className="nav-section-label">运营工作台</div>{navigation}<div className="sidebar-bottom"><div className="workspace-company"><span className="company-dot" /><div><strong>嘉兴星图优选</strong><small>虚构演示企业 · 电商运营</small></div></div><div className="sidebar-footnote">每一笔价格都可追溯</div></div></Layout.Sider>
    <Drawer open={drawer} onClose={() => setDrawer(false)} placement="left" width={260} title={<Brand />} className="mobile-nav-drawer">{navigation}</Drawer>
    <Layout className="workspace-main">
      <Layout.Header className="app-header"><div className="header-left"><Button type="text" className="mobile-menu-button" icon={<MenuOutlined />} aria-label="打开导航" onClick={() => setDrawer(true)} /><span className="header-breadcrumb">工作台 <span>/</span> <strong>{activeTitle}</strong></span></div><div className="header-right"><span className="timezone-pill">Asia/Shanghai</span><span data-testid="header-unread-count" data-count={alerts.data?.total ?? 0}><Badge count={alerts.data?.total} size="small"><Button type="text" icon={<BellOutlined />} aria-label="查看预警" onClick={() => navigate('/alerts')} /></Badge></span><span className="header-divider" /><Dropdown menu={{ items: [{ key: 'settings', label: '账号与系统设置', icon: <SettingOutlined /> }, { key: 'logout', label: '退出登录', icon: <LogoutOutlined /> }], onClick: ({ key }) => { if (key === 'logout') { logout(); navigate('/login'); } else navigate('/settings'); } }} trigger={['click']}><button className="account-button"><Avatar size={32} className="user-avatar">管</Avatar><span>{user?.displayName || '管理员'}</span></button></Dropdown></div></Layout.Header>
      <Layout.Content className="page-content"><Outlet /></Layout.Content><footer className="workspace-footer"><span>嘉兴星图优选 · 价格运营工作台</span><span>演示价格明确标注来源 · 时间统一按上海时区</span></footer>
    </Layout>
  </Layout>;
}
export default function App() {
  return <Suspense fallback={<div className="page-loading"><Spin size="large" /><span>正在加载工作台</span></div>}><Routes><Route path="/login" element={<LoginPage />} /><Route element={<Workspace />}><Route path="/" element={<Navigate to="/dashboard" replace />} /><Route path="/dashboard" element={<DashboardPage />} /><Route path="/products" element={<ProductsPage />} /><Route path="/products/:id" element={<DetailPage />} /><Route path="/comparison" element={<ComparisonPage />} /><Route path="/collections" element={<CollectionsPage />} /><Route path="/alerts" element={<AlertsPage />} /><Route path="/settings" element={<SettingsPage />} /><Route path="*" element={<Result status="404" title="页面不存在" subTitle="请选择左侧导航继续工作。" extra={<Link to="/dashboard"><Button type="primary">返回仪表盘</Button></Link>} />} /></Route></Routes></Suspense>;
}
