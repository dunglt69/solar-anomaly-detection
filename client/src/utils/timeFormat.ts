import type { ChartInterval } from '../stores/telemetryStore';

/**
 * Interval config: maps interval key to milliseconds & formatting rules.
 * This follows the TradingView/Binance pattern where the interval selector
 * controls the X-axis resolution, not the viewing range.
 */
const INTERVAL_MS: Record<ChartInterval, number> = {
  '1h':  3600_000,
  '6h':  21600_000,
  '1d':  86400_000,
  '3d':  259200_000,
  '1w':  604800_000,
};

/**
 * Default viewport size (in number of data points) per interval.
 * This determines how many candles/bars are shown initially.
 */
export const DEFAULT_VIEWPORT: Record<ChartInterval, number> = {
  '1h': 48,    // 48 hours = 2 days
  '6h': 28,    // 28 × 6h = 7 days
  '1d': 30,    // 30 days
  '3d': 30,    // 90 days
  '1w': 26,    // 26 weeks ≈ 6 months
};

/**
 * Format a Unix-seconds timestamp for X-axis display based on interval.
 * Follows professional dashboard conventions:
 * - 1h:  "09:00" (hourly marks)
 * - 6h:  "12:00" or "18/05" at day boundaries
 * - 1d:  "18/05" (daily marks)
 * - 3d:  "18/05" (date marks)
 * - 1w:  "18/05" (weekly marks, show date)
 */
export function formatAxisLabel(tsSeconds: number, interval: ChartInterval): string {
  const d = new Date(tsSeconds * 1000);
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  const dd = d.getDate().toString().padStart(2, '0');
  const mo = (d.getMonth() + 1).toString().padStart(2, '0');

  switch (interval) {
    case '1h':
      // Show HH:00 for hourly interval
      return `${hh}:${mm}`;
    case '6h':
      // Show time at 6h marks (00:00, 06:00, 12:00, 18:00)
      // At midnight boundary, show date instead
      if (d.getHours() === 0 && d.getMinutes() === 0) {
        return `${dd}/${mo}`;
      }
      return `${hh}:${mm}`;
    case '1d':
    case '3d':
    case '1w':
      // Show date
      return `${dd}/${mo}`;
  }
}

/**
 * Full tooltip date formatter — always shows complete date+time.
 */
export function formatTooltipDate(tsSeconds: number): string {
  const d = new Date(tsSeconds * 1000);
  return d.toLocaleString('vi-VN', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
  });
}

/**
 * Get the proper ECharts minInterval for X-axis based on chart interval.
 * This ensures ticks are placed at meaningful boundaries.
 */
export function getAxisInterval(interval: ChartInterval): number {
  return INTERVAL_MS[interval];
}
