import React from 'react';
import ReactDOM from 'react-dom/client';
import ConfigProvider from 'antd/es/config-provider';
import AntdApp from 'antd/es/app';
import zhCN from 'antd/es/locale/zh_CN';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './auth';
import 'antd/dist/reset.css';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN} theme={{ token: { colorPrimary: '#225deb', borderRadius: 9, fontFamily: "Inter, 'Microsoft YaHei', sans-serif" } }}>
      <AntdApp><BrowserRouter><AuthProvider><App /></AuthProvider></BrowserRouter></AntdApp>
    </ConfigProvider>
  </React.StrictMode>,
);
