import { useLayoutEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { LineChart, PieChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent, DataZoomComponent, MarkLineComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsCoreOption } from 'echarts/core';

echarts.use([LineChart, PieChart, GridComponent, TooltipComponent, LegendComponent, DataZoomComponent, MarkLineComponent, CanvasRenderer]);

// 图表输入只接收接口返回的成功采集点；容器尺寸变化时同步调整画布。
export default function Chart({ option, height = 340, testId, pointCount = 0, rawPointCount = pointCount, sampled = false, seriesCount = 1, latestPrice }: { option: EChartsCoreOption; height?: number; testId?: string; pointCount?: number; rawPointCount?: number; sampled?: boolean; seriesCount?: number; latestPrice?: number | null }) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.EChartsType | null>(null);
  useLayoutEffect(() => {
    if (!container.current) return;
    const instance = echarts.init(container.current, undefined, { renderer: 'canvas' });
    chart.current = instance;
    const resize = new ResizeObserver(() => instance.resize());
    resize.observe(container.current);
    return () => { resize.disconnect(); instance.dispose(); chart.current = null; };
  }, []);
  useLayoutEffect(() => { chart.current?.setOption(option, { notMerge: true }); }, [option]);
  return <div ref={container} className="chart-container" style={{ height }} data-testid={testId} data-point-count={pointCount} data-raw-point-count={rawPointCount} data-sampled={String(sampled)} data-series-count={seriesCount} data-latest-price={latestPrice ?? undefined} />;
}
