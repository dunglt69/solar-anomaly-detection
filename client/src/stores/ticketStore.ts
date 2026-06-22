import { create } from 'zustand';
import { authFetch, apiUrl } from '../lib/authFetch';

export interface Ticket {
  id: string;
  status: string;
  severity: string;
  faultType: number;
  affectedComponent: string | null;
  title: string;
  description: string | null;
  assigneeId: string | null;
  createdBy: string | null;
  alertId: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  resolutionSummary: string | null;
  comments?: TicketComment[];
}

export interface TicketComment {
  id: string;
  ticketId: string;
  authorId: string;
  content: string;
  createdAt: string;
}

export interface TicketStats {
  total: number;
  open: number;
  inProgress: number;
  resolved: number;
  closed: number;
  escalated: number;
}

interface TicketState {
  tickets: Ticket[];
  selectedTicket: Ticket | null;
  stats: TicketStats;
  total: number;
  loading: boolean;
  fetchTickets: (params?: Record<string, string>) => Promise<void>;
  fetchTicketById: (id: string) => Promise<void>;
  fetchStats: () => Promise<void>;
  updateTicket: (id: string, data: Record<string, string>) => Promise<void>;
  addComment: (ticketId: string, content: string) => Promise<void>;
}

export const useTicketStore = create<TicketState>((set, get) => ({
  tickets: [],
  selectedTicket: null,
  stats: { total: 0, open: 0, inProgress: 0, resolved: 0, closed: 0, escalated: 0 },
  total: 0,
  loading: false,

  fetchTickets: async (params = {}) => {
    set({ loading: true });
    try {
      const qs = new URLSearchParams(params).toString();
      const res = await authFetch(apiUrl(`/api/v1/tickets?${qs}`));
      if (res.ok) {
        const json = await res.json();
        set({ tickets: json.data, total: json.total });
      }
    } finally {
      set({ loading: false });
    }
  },

  fetchTicketById: async (id: string) => {
    try {
      const res = await authFetch(apiUrl(`/api/v1/tickets/${id}`));
      if (res.ok) {
        const ticket = await res.json();
        set({ selectedTicket: ticket });
      }
    } catch { /* silent */ }
  },

  fetchStats: async () => {
    try {
      const res = await authFetch(apiUrl('/api/v1/tickets/stats'));
      if (res.ok) {
        const stats = await res.json();
        set({ stats });
      }
    } catch { /* silent */ }
  },

  updateTicket: async (id: string, data: Record<string, string>) => {
    const res = await authFetch(apiUrl(`/api/v1/tickets/${id}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      let msg = 'Failed to update ticket';
      try {
        const body = await res.json();
        if (body.error) msg = body.error;
      } catch { /* ignored */ }
      throw new Error(msg);
    }
    await get().fetchTickets();
    await get().fetchStats();
  },

  addComment: async (ticketId: string, content: string) => {
    try {
      await authFetch(apiUrl(`/api/v1/tickets/${ticketId}/comments`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      await get().fetchTicketById(ticketId);
    } catch {
      // Silently handle comment errors
    }
  },
}));
