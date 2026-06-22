import { useMemo, useState, useEffect } from 'react';
import Chart from './Chart';
import type { AggregatedPoint, ChartInterval } from '../../stores/telemetryStore';
import type { EChartsOption } from 'echarts';
import { getChartTimeRanges, getChartTheme } from '../../lib/chartConstants';


interface Props {
  data: AggregatedPoint[];
  height?: number;
  interval?: ChartInterval;
  currentTime?: number;
}

export default function PowerChart({ data, height = 300, interval = '1h', currentTime }: Props) {
  const [fallbackTime] = useState(() => Date.now());
  const currentVal = currentTime ?? fallbackTime;
  const [smooth, setSmooth] = useState(
    () => localStorage.getItem('em_chart_smooth') !== 'false'
  );
  const [theme, setTheme] = useState<'dark' | 'light'>(
    () => (localStorage.getItem('em_theme') as 'dark' | 'light') || 'dark'
  );

  useEffect(() => {
    const handleSettingsChange = () => {
      setSmooth(localStorage.getItem('em_chart_smooth') !== 'false');
      setTheme((localStorage.getItem('em_theme') as 'dark' | 'light') || 'dark');
    };
    window.addEventListener('em-display-settings-changed', handleSettingsChange);
    return () => {
      window.removeEventListener('em-display-settings-changed', handleSettingsChange);
    };
  }, []);

  const option = useMemo<EChartsOption>(() => {
    const themeConfig = getChartTheme(theme);
    if (data.length === 0) return themeConfig;

    const avgData: [number, number | null][] = data.map(d => [
      d.timestamp * 1000,
      d.dataPoints > 0 ? d.avgPdcTotal : null,
    ]);
    const peakData: [number, number | null][] = data.map(d => [
      d.timestamp * 1000,
      d.dataPoints > 0 ? d.maxPdcTotal : null,
    ]);

    // Calculate visible and fetch range from shared constants
    const { startValue, endValue, minTime, maxTime } = getChartTimeRanges(interval, currentVal);
    const isDark = theme === 'dark';

    return {
      ...themeConfig,
      animation: false, // Disable animation for smooth zoom/pan
      title: {
        text: 'Power Output',
        textStyle: { color: isDark ? '#F1F5F9' : '#0F172A', fontSize: 14, fontWeight: 600 },
        left: 0,
      },
      legend: {
        data: ['Avg Power', 'Peak Power'],
        textStyle: { color: isDark ? '#94A3B8' : '#475569', fontSize: 11 },
        right: 0, top: 0,
      },
      tooltip: {
        ...themeConfig.tooltip,
        trigger: 'axis',
        axisPointer: { type: 'cross', lineStyle: { color: isDark ? '#475569' : '#CBD5E1' } },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        formatter: (params: any) => {
          const arr = Array.isArray(params) ? params : [params];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const valid = arr.filter((s: any) => s.value?.[1] != null);
          if (valid.length === 0) return '';
          const d = new Date(valid[0].value[0]);
          const ts = d.toLocaleString('vi-VN', {
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            day: '2-digit', month: '2-digit', year: 'numeric',
          });
          const lines = valid.map(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (s: any) => `${s.marker} ${s.seriesName}: <b>${s.value[1]?.toFixed?.(1) ?? s.value[1]}</b> W`
          );
          return `${ts}<br/>${lines.join('<br/>')}`;
        },
      },
      xAxis: {
        ...themeConfig.xAxis,
        type: 'time',
        min: minTime,
        max: maxTime,
        axisLabel: {
          ...themeConfig.xAxis.axisLabel,
          hideOverlap: true,
        },
      },
      yAxis: {
        ...themeConfig.yAxis,
        type: 'value',
        name: 'Power (W)',
        nameTextStyle: { color: isDark ? '#64748B' : '#475569', fontSize: 11 },
      },
      series: [
        {
          name: 'Avg Power',
          type: 'line',
          data: avgData,
          smooth: smooth,
          showSymbol: false,
          sampling: 'lttb',
          lineStyle: { width: 2, color: '#10B981' },
          areaStyle: {
            color: {
              type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(16, 185, 129, 0.25)' },
                { offset: 1, color: 'rgba(16, 185, 129, 0.0)' }
              ]
            }
          }
        },
        {
          name: 'Peak Power',
          type: 'line',
          data: peakData,
          smooth: smooth,
          showSymbol: false,
          sampling: 'lttb',
          connectNulls: false,
          lineStyle: { width: 1.5, color: '#34D399', type: 'dashed' },
        },
      ],

      dataZoom: [
        {
          type: 'slider',
          xAxisIndex: 0,
          bottom: 0,
          height: 24,
          filterMode: 'none', // Don't filter data on zoom — prevents disappearing
          startValue,
          endValue,
          borderColor: isDark ? '#1E293B' : '#E2E8F0',
          backgroundColor: isDark ? '#0F172A' : '#F8FAFC',
          fillerColor: 'rgba(59, 130, 246, 0.15)',
          handleStyle: { color: '#3B82F6', borderColor: '#3B82F6' },
          textStyle: { color: isDark ? '#64748B' : '#475569', fontSize: 10 },
          dataBackground: {
            lineStyle: { color: isDark ? '#334155' : '#CBD5E1' },
            areaStyle: { color: isDark ? 'rgba(51, 65, 85, 0.3)' : 'rgba(203, 213, 225, 0.3)' },
          },
        },
        {
          type: 'inside',
          xAxisIndex: 0,
          filterMode: 'none', // Don't filter data on zoom
          startValue,
          endValue,
          zoomOnMouseWheel: true,
          moveOnMouseMove: true,
          moveOnMouseWheel: false,
        },
      ],
    };
  }, [data, interval, currentVal, smooth, theme]);

  return <Chart option={option} height={height} className="chart-container" resetKey={interval} theme={theme} />;
}
