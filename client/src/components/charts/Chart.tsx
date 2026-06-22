import { useRef, useEffect } from 'react';
import * as echarts from 'echarts/core';
import { LineChart, BarChart, PieChart } from 'echarts/charts';
import {
  TitleComponent,
  TooltipComponent,
  GridComponent,
  LegendComponent,
  DataZoomComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

// Register components once
echarts.use([
  LineChart, BarChart, PieChart,
  TitleComponent, TooltipComponent, GridComponent,
  LegendComponent, DataZoomComponent,
  CanvasRenderer,
]);

import type { EChartsOption } from 'echarts';

interface ChartProps {
  option: EChartsOption;
  height?: number;
  className?: string;
  resetKey?: string;
  theme?: 'dark' | 'light';
}

/**
 * Chart wrapper using echarts merge mode and custom zoom state tracking.
 */
export default function Chart({ option, height = 300, className, resetKey, theme = 'dark' }: ChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const isUpdatingRef = useRef(false);
  const optionRef = useRef<EChartsOption>(option);

  // Keep track of the user's manual zoom state
  const zoomStateRef = useRef<{
    start: number;
    end: number;
    startValue?: number | string;
    endValue?: number | string;
  } | null>(null);

  // Reset zoom state when resetKey (interval) changes
  useEffect(() => {
    zoomStateRef.current = null;
  }, [resetKey]);

  // Initialize chart instance once
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = echarts.init(containerRef.current, theme, {
      renderer: 'canvas',
    });
    chartRef.current = chart;

    // Listen to zoom changes to track the user's view
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    chart.on('datazoom', (params: any) => {
      if (isUpdatingRef.current) return;
      let start: number;
      let end: number;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let startValue: any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let endValue: any;

      if (params.batch && params.batch.length > 0) {
        start = params.batch[0].start;
        end = params.batch[0].end;
        startValue = params.batch[0].startValue;
        endValue = params.batch[0].endValue;
      } else {
        start = params.start;
        end = params.end;
        startValue = params.startValue;
        endValue = params.endValue;
      }

      // If user zooms out completely, return to live scrolling mode
      if (start === 0 && end === 100) {
        zoomStateRef.current = null;
      } else {
        zoomStateRef.current = { start, end, startValue, endValue };
      }
    });

    // Double click to reset zoom to default visible range
    chart.on('dblclick', () => {
      zoomStateRef.current = null;
      // Re-apply original option with default startValue/endValue (via ref to avoid stale closure)
      chart.setOption(optionRef.current);
    });

    // Resize observer for responsive layout
    const observer = new ResizeObserver(() => {
      chart.resize();
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, [theme]);

  // Update option using MERGE mode (and override dataZoom if manual zoom exists)
  useEffect(() => {
    optionRef.current = option;
    if (!chartRef.current) return;

    const finalOption = { ...option };

    // If manual zoom state exists, override dataZoom options to keep user's zoom locked
    if (zoomStateRef.current && finalOption.dataZoom) {
      const { start, end, startValue, endValue } = zoomStateRef.current;
      const dzList = Array.isArray(finalOption.dataZoom)
        ? finalOption.dataZoom
        : [finalOption.dataZoom];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      finalOption.dataZoom = dzList.map((dz: any) => {
        const newDz = { ...dz };
        if (startValue !== undefined && endValue !== undefined) {
          newDz.startValue = startValue;
          newDz.endValue = endValue;
          delete newDz.start;
          delete newDz.end;
        } else {
          newDz.start = start;
          newDz.end = end;
          delete newDz.startValue;
          delete newDz.endValue;
        }
        return newDz;
      });
    }

    isUpdatingRef.current = true;
    chartRef.current.setOption(finalOption, { notMerge: true });
    setTimeout(() => {
      isUpdatingRef.current = false;
    }, 50);
  }, [option, theme]);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ width: '100%', height }}
    />
  );
}

