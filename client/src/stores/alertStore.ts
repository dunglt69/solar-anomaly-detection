import { create } from 'zustand';
import { authFetch, apiUrl } from '../lib/authFetch';

export interface Alert {
  id: string;
  timestamp: string;
  severity: 'info' | 'warning' | 'critical' | 'emergency';
  faultType: number;
  confidence: number;
  detectionLayer: string;
  telemetryId: number | null;
  acknowledged: boolean;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
  ticketId: string | null;
  ticketStatus?: string | null;
}

export interface AlertStats {
  total: number;
  unacknowledged: number;
  critical: number;
}

interface AlertState {
  alerts: Alert[];
  stats: AlertStats;
  total: number;
  loading: boolean;
  fetchAlerts: (params?: Record<string, string>) => Promise<void>;
  fetchStats: () => Promise<void>;
  acknowledgeAlert: (id: string) => Promise<void>;
}

export const useAlertStore = create<AlertState>((set, get) => ({
  alerts: [],
  stats: { total: 0, unacknowledged: 0, critical: 0 },
  total: 0,
  loading: false,

  fetchAlerts: async (params = {}) => {
    set({ loading: true });
    try {
      const qs = new URLSearchParams(params).toString();
      const res = await authFetch(apiUrl(`/api/v1/alerts?${qs}`));
      if (res.ok) {
        const json = await res.json();
        set({ alerts: json.data, total: json.total });
      }
    } finally {
      set({ loading: false });
    }
  },

  fetchStats: async () => {
    try {
      const res = await authFetch(apiUrl('/api/v1/alerts/stats'));
      if (res.ok) {
        const stats = await res.json();
        set({ stats });
      }
    } catch { /* silent */ }
  },

  acknowledgeAlert: async (id: string) => {
    const res = await authFetch(apiUrl(`/api/v1/alerts/${id}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      let msg = 'Failed to acknowledge alert';
      try {
        const body = await res.json();
        if (body.error) msg = body.error;
      } catch { /* ignored */ }
      throw new Error(msg);
    }
    // Refresh
    await get().fetchAlerts();
    await get().fetchStats();
  },
}));
