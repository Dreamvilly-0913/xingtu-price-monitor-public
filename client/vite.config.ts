import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: { dedupe: ['react', 'react-dom'] },
  optimizeDeps: {
    include: [
      'react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react-router-dom',
      'antd/es/alert', 'antd/es/app', 'antd/es/auto-complete', 'antd/es/avatar', 'antd/es/badge',
      'antd/es/button', 'antd/es/card', 'antd/es/checkbox', 'antd/es/col', 'antd/es/config-provider',
      'antd/es/descriptions', 'antd/es/drawer', 'antd/es/dropdown', 'antd/es/empty', 'antd/es/form',
      'antd/es/input', 'antd/es/input-number', 'antd/es/layout', 'antd/es/locale/zh_CN', 'antd/es/menu',
      'antd/es/modal', 'antd/es/popconfirm', 'antd/es/radio', 'antd/es/result', 'antd/es/row',
      'antd/es/segmented', 'antd/es/select', 'antd/es/skeleton', 'antd/es/space', 'antd/es/spin',
      'antd/es/statistic', 'antd/es/switch', 'antd/es/table', 'antd/es/tabs', 'antd/es/tag',
      'antd/es/tooltip', 'antd/es/typography', 'echarts/core', 'echarts/charts', 'echarts/components', 'echarts/renderers',
    ],
  },
  server: {
    port: Number(process.env.WEB_PORT || 4173),
    strictPort: true,
    proxy: { '/api': { target: process.env.API_PROXY_URL || 'http://127.0.0.1:4010', changeOrigin: true } },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/echarts/') || id.includes('/zrender/')) return 'charts';
          if (id.includes('/antd/') || id.includes('/@ant-design/') || id.includes('/@rc-component/') || id.includes('/rc-')) return 'ui';
          if (id.includes('/react-dom/') || id.includes('/react/') || id.includes('/react-router')) return 'react';
        },
      },
    },
  },
});
