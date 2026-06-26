import { create } from 'zustand';
import { API_BASE } from '../lib/api';


interface User {
  id: string;
  employeeId: string;
  username: string;
  email: string;
  displayName: string;
  role: 'admin' | 'solar_operator' | 'security_engineer';
  avatarUrl: string | null;
}

interface AuthState {
  user: User | null;
  accessToken: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;

  login: (username: string, password: string, turnstileToken?: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshToken: () => Promise<boolean>;
  clearError: () => void;
  setLoading: (loading: boolean) => void;
  updateUser: (updatedUser: Partial<User>) => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  accessToken: null,
  isAuthenticated: false,
  isLoading: true, // start true to check stored token
  error: null,

  login: async (username: string, password: string, turnstileToken?: string) => {
    set({ isLoading: true, error: null });
    try {
      const { getHardwareSignature, getDeviceInfo } = await import('../utils/fingerprint');
      const hwSignature = getHardwareSignature();
      const deviceInfo = getDeviceInfo();

      const res = await fetch(`${API_BASE}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'X-Hw-Signature': JSON.stringify(hwSignature),
          'X-Device-Info': JSON.stringify({ browser: deviceInfo.browser, os: deviceInfo.os }),
        },
        credentials: 'include',
        body: JSON.stringify({ username, password, turnstileToken }),
      });

      const data = await res.json();
      if (!res.ok) {
        // Redirect to access-denied page on 460 (device not registered)
        if (res.status === 460 || (data.reason === 'device_not_registered')) {
          window.location.href = '/access-denied';
          return;
        }
        throw new Error(data.error || 'Login failed');
      }

      // TODO: Move access token to memory-only storage to mitigate XSS token theft
      localStorage.setItem('accessToken', data.accessToken);

      set({
        user: data.user,
        accessToken: data.accessToken,
        isAuthenticated: true,
        isLoading: false,
        error: null,
      });
    } catch (err) {
      set({
        isLoading: false,
        error: err instanceof Error ? err.message : 'Login failed',
      });
      throw err;
    }
  },

  logout: async () => {
    const { accessToken } = get();
    try {
      await fetch(`${API_BASE}/api/v1/auth/logout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({}),
        credentials: 'include',
      });
    } catch {
      // Proceed with local cleanup even if API call fails
    }

    localStorage.removeItem('accessToken');
    set({
      user: null,
      accessToken: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,
    });
  },

  refreshToken: async () => {

    try {
      const res = await fetch(`${API_BASE}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        credentials: 'include',
      });

      if (!res.ok) {
        throw new Error('Refresh failed');
      }

      const data = await res.json();
      localStorage.setItem('accessToken', data.accessToken);

      // Fetch user profile with new token
      const meRes = await fetch(`${API_BASE}/api/v1/auth/me`, {
        headers: { Authorization: `Bearer ${data.accessToken}` },
      });

      if (meRes.ok) {
        const meData = await meRes.json();
        set({
          user: meData.user,
          accessToken: data.accessToken,
          isAuthenticated: true,
          isLoading: false,
        });
        return true;
      }

      throw new Error('Failed to fetch profile');
    } catch {
      localStorage.removeItem('accessToken');
      set({
        user: null,
        accessToken: null,
        isAuthenticated: false,
        isLoading: false,
      });
      return false;
    }
  },

  clearError: () => set({ error: null }),
  setLoading: (loading: boolean) => set({ isLoading: loading }),
  updateUser: (updatedUser) => set((state) => {
    if (!state.user) return state;
    return { user: { ...state.user, ...updatedUser } };
  }),
}));
