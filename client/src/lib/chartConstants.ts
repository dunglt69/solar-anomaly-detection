import type { ChartInterval } from '../stores/telemetryStore';

/** Default visible range per interval (milliseconds) */
export const RANGE_MS: Record<ChartInterval, number> = {
  '1h': 3_600_000,
  '6h': 21_600_000,
  '1d': 86_400_000,
  '3d': 259_200_000,
  '1w': 604_800_000,
};

/** Fetch buffer range per interval (milliseconds) — wider than visible range for pan/scroll */
export const FETCH_RANGE_MS: Record<ChartInterval, number> = {
  '1h': 86_400_000,
  '6h': 259_200_000,
  '1d': 604_800_000,
  '3d': 1_296_000_000,
  '1w': 2_592_000_000,
};

/** Compute visible and fetch time boundaries for chart dataZoom */
export function getChartTimeRanges(interval: ChartInterval, currentTime: number) {
  const visibleRangeMs = RANGE_MS[interval] ?? RANGE_MS['1h'];
  const fetchRangeMs = FETCH_RANGE_MS[interval] ?? FETCH_RANGE_MS['1h'];
  return {
    startValue: currentTime - visibleRangeMs,
    endValue: currentTime,
    minTime: currentTime - fetchRangeMs,
    maxTime: currentTime,
  };
}

// ─── Theme defaults for ISA-101 ──────────────────────────────────
export const CHART_THEME = {
  backgroundColor: 'transparent',
  textStyle: {
    fontFamily: "'Inter', sans-serif",
    fontSize: 12,
    color: '#94A3B8',
  },
  grid: {
    top: 60,
    right: 30,
    bottom: 50,
    left: 55,
    containLabel: false,
  },
  tooltip: {
    backgroundColor: '#1E293B',
    borderColor: '#334155',
    textStyle: { color: '#F1F5F9', fontSize: 12 },
  },
  xAxis: {
    axisLine: { lineStyle: { color: '#334155' } },
    axisTick: { show: false },
    axisLabel: { color: '#64748B', fontSize: 11 },
    splitLine: { show: false },
  },
  yAxis: {
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color: '#64748B', fontSize: 11 },
    splitLine: { lineStyle: { color: '#1E293B', type: 'dashed' as const } },
  },
};

export function getChartTheme(theme: 'dark' | 'light') {
  const isDark = theme === 'dark';
  return {
    backgroundColor: 'transparent',
    textStyle: {
      fontFamily: "'Inter', sans-serif",
      fontSize: 12,
      color: isDark ? '#94A3B8' : '#475569',
    },
    grid: {
      top: 60,
      right: 30,
      bottom: 50,
      left: 55,
      containLabel: false,
    },
    tooltip: {
      backgroundColor: isDark ? '#1E293B' : '#FFFFFF',
      borderColor: isDark ? '#334155' : '#E2E8F0',
      textStyle: { color: isDark ? '#F1F5F9' : '#0F172A', fontSize: 12 },
    },
    xAxis: {
      axisLine: { lineStyle: { color: isDark ? '#334155' : '#E2E8F0' } },
      axisTick: { show: false },
      axisLabel: { color: isDark ? '#64748B' : '#475569', fontSize: 11 },
      splitLine: { show: false },
    },
    yAxis: {
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: isDark ? '#64748B' : '#475569', fontSize: 11 },
      splitLine: { lineStyle: { color: isDark ? '#1E293B' : '#E2E8F0', type: 'dashed' as const } },
    },
  };
}

