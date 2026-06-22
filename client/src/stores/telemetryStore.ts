import { create } from 'zustand';
import { useAuthStore } from './authStore';
import { authFetch, apiUrl } from '../lib/authFetch';

const WS_URL = (import.meta.env.VITE_WS_URL || 'ws://localhost:3000') + '/ws/telemetry';

// ─── Types ──────────────────────────────────────────────────────────

export interface TelemetryPoint {
  id?: number;
  timestamp: string;
  vdc1: number;
  vdc2: number;
  idc1: number;
  idc2: number;
  irr: number;
  pvt: number;
  pdc1: number;
  pdc2: number;
  pdcTotal: number;
  faultLabel: number | null;
}

/** Aggregated data point — one per interval bucket */
export interface AggregatedPoint {
  timestamp: number;     // bucket start (Unix seconds)
  avgPdcTotal: number;
  maxPdcTotal: number;
  minPdcTotal: number;
  avgVdc1: number;
  avgVdc2: number;
  avgIdc1: number;
  avgIdc2: number;
  avgIrr: number;
  avgPvt: number;
  faultCount: number;
  dataPoints: number;
}

export interface KPIs {
  totalRecords: number;
  totalEnergy: number;
  avgPower: number;
  avgIrradiance: number;
  faultCount: number;
  faultDistribution: { label: string; code: number | null; count: number }[];
}

// Alert from WebSocket
export interface WsAlert {
  alertId: string;
  ticketId: string;
  severity: string;
  faultName: string;
}

/**
 * Interval = the X-axis resolution / bucket size.
 * Like TradingView's candlestick interval selector.
 * - 1h: Each data point = 1 hour of aggregated data
 * - 6h: Each data point = 6 hours
 * - 1d: Each data point = 1 day
 * - 3d: Each data point = 3 days
 * - 1w: Each data point = 1 week
 */
export type ChartInterval = '1h' | '6h' | '1d' | '3d' | '1w';

function fillDataGaps(data: AggregatedPoint[], interval: ChartInterval): AggregatedPoint[] {
  if (data.length <= 1) return data;

  const BUCKET_SIZE: Record<ChartInterval, number> = {
    '1h': 30,
    '6h': 60,
    '1d': 300,
    '3d': 900,
    '1w': 3600,
  };

  const bucketSize = BUCKET_SIZE[interval];
  const maxGap = bucketSize * 3; // 3 missing buckets constitutes a gap

  const result: AggregatedPoint[] = [data[0]];

  for (let i = 1; i < data.length; i++) {
    const prev = data[i - 1];
    const curr = data[i];
    const diff = curr.timestamp - prev.timestamp;

    if (diff > maxGap) {
      // Insert a null-representing point in the middle to break the line
      result.push({
        timestamp: prev.timestamp + bucketSize,
        avgPdcTotal: 0,
        maxPdcTotal: 0,
        minPdcTotal: 0,
        avgVdc1: 0,
        avgVdc2: 0,
        avgIdc1: 0,
        avgIdc2: 0,
        avgIrr: 0,
        avgPvt: 0,
        faultCount: 0,
        dataPoints: 0, // 0 triggers null values mapping in the charts
      });
    }
    result.push(curr);
  }

  return result;
}

interface TelemetryState {
  // Aggregated chart data (used by all dashboard charts)
  chartData: AggregatedPoint[];
  chartInterval: ChartInterval;
  chartLoading: boolean;
  currentTime: number;

  // Cache storage for instant interval switching
  chartCache: Record<ChartInterval, AggregatedPoint[] | null>;

  // Live latest point (for KPI cards)
  latestPoint: TelemetryPoint | null;
  kpis: KPIs | null;
  isConnected: boolean;
  wsClients: number;

  // Data range (earliest / latest timestamp in DB)
  dataRange: { minTs: number; maxTs: number; totalPoints: number } | null;

  // Track when data was last received via WebSocket
  lastDataReceived: number | null;

  // Custom date range for filtering
  customFrom: string | null;
  customTo: string | null;

  // Error state for user-facing feedback
  error: string | null;

  // Alerts toast
  recentAlerts: WsAlert[];
  dismissAlert: (alertId: string) => void;

  // Actions
  setChartInterval: (interval: ChartInterval) => void;
  setCustomRange: (from: string, to: string) => void;
  clearCustomRange: () => void;
  clearError: () => void;
  fetchChartData: () => Promise<void>;
  fetchKPIs: () => Promise<void>;
  fetchDataRange: () => Promise<void>;
  fetchLatestPoint: () => Promise<void>;
  preFetchAllRanges: () => Promise<void>;
  connectWebSocket: () => void;
  disconnectWebSocket: () => void;
}



let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let isIntentionallyClosed = false;
let reconnectAttempts = 0;

export const useTelemetryStore = create<TelemetryState>((set, get) => ({
  chartData: [],
  chartInterval: '1h',
  chartLoading: false,
  currentTime: Date.now(),
  chartCache: {
    '1h': null,
    '6h': null,
    '1d': null,
    '3d': null,
    '1w': null,
  },
  latestPoint: null,
  kpis: null,
  isConnected: false,
  wsClients: 0,
  dataRange: null,
  lastDataReceived: null,
  customFrom: null,
  customTo: null,
  error: null,
  recentAlerts: [],

  setChartInterval: (interval: ChartInterval) => {
    const cached = get().chartCache[interval];
    if (cached) {
      set({ chartInterval: interval, customFrom: null, customTo: null, chartData: cached });
    } else {
      set({ chartInterval: interval, customFrom: null, customTo: null, chartData: [] });
    }
    get().fetchChartData();
    get().fetchKPIs();
  },

  setCustomRange: (from: string, to: string) => {
    set({ customFrom: from, customTo: to });
    get().fetchChartData();
    get().fetchKPIs();
  },

  clearCustomRange: () => {
    set({ customFrom: null, customTo: null });
    get().fetchChartData();
    get().fetchKPIs();
  },

  dismissAlert: (alertId: string) => {
    set((state) => ({
      recentAlerts: state.recentAlerts.filter((a) => a.alertId !== alertId),
    }));
  },

  clearError: () => set({ error: null }),

  // ─── Fetch aggregated chart data ──────────────────────────────
  fetchChartData: async () => {
    // Only show loading indicator if there is no cached or current data to show
    const isCacheEmpty = get().chartData.length === 0;
    if (isCacheEmpty) {
      set({ chartLoading: true });
    }

    const { chartInterval, customFrom, customTo } = get();
    const params = new URLSearchParams();
    params.set('interval', chartInterval);
    
    // If custom range is set, use it; otherwise calculate range from interval (fetch wide history buffer)
    if (customFrom) {
      params.set('from', customFrom);
      if (customTo) params.set('to', customTo);
    } else {
      // Fetch wider history buffer so users can scroll/pan back
      const now = new Date();
      const FETCH_RANGE_SECONDS: Record<string, number> = {
        '1h': 86400,          // 24 hours (for 30s buckets)
        '6h': 259200,         // 3 days (for 1m buckets)
        '1d': 604800,         // 7 days (for 5m buckets)
        '3d': 1296000,        // 15 days (for 15m buckets)
        '1w': 2592000,        // 30 days (for 1h buckets)
      };
      const rangeSeconds = FETCH_RANGE_SECONDS[chartInterval] || 86400;
      const from = new Date(now.getTime() - rangeSeconds * 1000);
      params.set('from', from.toISOString());
      params.set('to', now.toISOString());
    }

    try {
      const res = await authFetch(apiUrl(`/api/v1/telemetry/aggregated?${params}`));
      if (res.ok) {
        const json = await res.json();
        const rawData = json.data as AggregatedPoint[];
        const processedData = fillDataGaps(rawData, chartInterval);
        
        set((state) => ({
          chartData: processedData,
          currentTime: Date.now(),
          error: null,
          chartCache: {
            ...state.chartCache,
            [chartInterval]: processedData,
          },
        }));
      } else {
        set({ error: `Failed to load chart data (${res.status})` });
      }
    } catch (err) {
      set({ error: 'Network error loading chart data' });
      console.error('fetchChartData error:', err);
    }

    set({ chartLoading: false });
  },

  // ─── Fetch KPIs ───────────────────────────────────────────────
  fetchKPIs: async () => {
    const { chartInterval, customFrom, customTo } = get();
    const params = new URLSearchParams();
    if (customFrom) {
      params.set('from', customFrom);
      if (customTo) params.set('to', customTo);
    } else {
      const now = new Date();
      const RANGE_SECONDS: Record<string, number> = {
        '1h': 3600,
        '6h': 21600,
        '1d': 86400,
        '3d': 259200,
        '1w': 604800,
      };
      const rangeSeconds = RANGE_SECONDS[chartInterval] || 3600;
      const from = new Date(now.getTime() - rangeSeconds * 1000);
      params.set('from', from.toISOString());
      params.set('to', now.toISOString());
    }

    try {
      const res = await authFetch(apiUrl(`/api/v1/telemetry/kpis?${params}`));
      if (res.ok) {
        const kpis = (await res.json()) as KPIs;
        set({ kpis, error: null });
      } else {
        set({ error: `Failed to load KPIs (${res.status})` });
      }
    } catch (err) {
      set({ error: 'Network error loading KPIs' });
      console.error('fetchKPIs error:', err);
    }
  },

  // ─── Fetch data range ────────────────────────────────────────
  fetchDataRange: async () => {
    try {
      const res = await authFetch(apiUrl('/api/v1/telemetry/data-range'));
      if (res.ok) {
        const data = await res.json();
        set({ dataRange: data });
      }
    } catch (err) {
      console.error('fetchDataRange error:', err);
    }
  },

  fetchLatestPoint: async () => {
    try {
      const res = await authFetch(apiUrl('/api/v1/telemetry/latest?n=1'));
      if (res.ok) {
        const json = await res.json();
        const point = json.data?.[0] || null;
        if (point) {
          set({
            latestPoint: point,
            currentTime: Date.now(),
          });
        }
      }
    } catch (err) {
      console.error('fetchLatestPoint error:', err);
    }
  },

  preFetchAllRanges: async () => {
    const intervals: ChartInterval[] = ['1h', '6h', '1d', '3d', '1w'];
    for (const interval of intervals) {
      const now = new Date();
      const FETCH_RANGE_SECONDS: Record<string, number> = {
        '1h': 86400,          // 24 hours
        '6h': 259200,         // 3 days
        '1d': 604800,         // 7 days
        '3d': 1296000,        // 15 days
        '1w': 2592000,        // 30 days
      };
      const rangeSeconds = FETCH_RANGE_SECONDS[interval] || 86400;
      const from = new Date(now.getTime() - rangeSeconds * 1000);
      
      const params = new URLSearchParams();
      params.set('interval', interval);
      params.set('from', from.toISOString());
      params.set('to', now.toISOString());

      try {
        const res = await authFetch(apiUrl(`/api/v1/telemetry/aggregated?${params}`));
        if (res.ok) {
          const json = await res.json();
          const rawData = json.data as AggregatedPoint[];
          const processed = fillDataGaps(rawData, interval);
          
          set((state) => ({
            chartCache: {
              ...state.chartCache,
              [interval]: processed,
            },
          }));
        }
      } catch (err) {
        console.error(`preFetchAllRanges error for ${interval}:`, err);
      }
    }
  },

  // ─── WebSocket connection ────────────────────────────────────
  connectWebSocket: () => {
    if (ws && ws.readyState === WebSocket.OPEN) return;
    isIntentionallyClosed = false;

    try {
      const token = useAuthStore.getState().accessToken;
      // BUG-009: Use WebSocket subprotocol for token instead of query string to avoid logging token in URLs
      ws = new WebSocket(WS_URL, [`bearer-${token}`]);

      ws.onopen = () => {
        reconnectAttempts = 0;
        set({ isConnected: true });
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'connected') {
            set({ wsClients: msg.clients });
          } else if (msg.type === 'telemetry') {
            // Update latestPoint for KPI cards (real-time)
            set({ latestPoint: msg.data, lastDataReceived: Date.now(), currentTime: Date.now() });
          } else if (msg.type === 'alert') {
            const alert = msg.data as WsAlert;
            const toastEnabled = localStorage.getItem('em_notif_toast') !== 'false';
            const criticalOnly = localStorage.getItem('em_notif_critical') === 'true';

            const isCritical = alert.severity === 'critical' || alert.severity === 'emergency';
            if (criticalOnly && !isCritical) {
              return;
            }

            if (toastEnabled) {
              set((state) => {
                const existing = state.recentAlerts.find((a) => a.alertId === alert.alertId);
                if (existing) return state;
                const updated = [alert, ...state.recentAlerts].slice(0, 10);
                return { recentAlerts: updated };
              });
              setTimeout(() => {
                get().dismissAlert(alert.alertId);
              }, 15000);
            }
          }
        } catch {
          // Ignore parse errors
        }
      };

      ws.onclose = () => {
        set({ isConnected: false });
        ws = null;
        if (!isIntentionallyClosed) {
          const delay = Math.min(3000 * Math.pow(1.5, reconnectAttempts), 30000);
          reconnectAttempts++;
          reconnectTimer = setTimeout(() => {
            get().connectWebSocket();
          }, delay);
        }
      };

      ws.onerror = () => {
        ws?.close();
      };
    } catch {
      set({ isConnected: false });
    }
  },

  disconnectWebSocket: () => {
    isIntentionallyClosed = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      ws.close();
      ws = null;
    }
    set({ isConnected: false });
  },
}));

if (typeof window !== 'undefined') {
  window.addEventListener('em-display-settings-changed', () => {
    const criticalOnly = localStorage.getItem('em_notif_critical') === 'true';
    if (criticalOnly) {
      useTelemetryStore.setState((state) => ({
        recentAlerts: state.recentAlerts.filter(
          (a) => a.severity === 'critical' || a.severity === 'emergency'
        ),
      }));
    }
  });
}
