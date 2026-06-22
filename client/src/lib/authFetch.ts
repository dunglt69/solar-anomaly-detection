import { useAuthStore } from '../stores/authStore';
import { getDeviceFingerprint, getDeviceInfo } from '../utils/fingerprint';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000';

let isRefreshing = false;
let refreshQueue: Array<{ resolve: (token: string) => void; reject: (err: Error) => void }> = [];

function processQueue(token: string | null, error: Error | null) {
  refreshQueue.forEach(({ resolve, reject }) => {
    if (error) reject(error);
    else resolve(token!);
  });
  refreshQueue = [];
}

/**
 * Authenticated fetch wrapper with auto-refresh on 401.
 * Drop-in replacement for fetch() that:
 * 1. Adds Bearer token header
 * 2. Retries once with refreshed token on 401
 * 3. Queues concurrent refresh attempts (only one refresh at a time)
 * 4. Redirects to login if refresh also fails
 */
export async function authFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const token = useAuthStore.getState().accessToken;
  const headers = new Headers(init?.headers);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  // Inject device fingerprint for audit and blocklist verification
  headers.set('X-Device-Fingerprint', await getDeviceFingerprint());

  // Inject human-readable device info for admin panel display
  try {
    headers.set('X-Device-Info', JSON.stringify(getDeviceInfo()));
  } catch { /* ignored */ }

  const res = await fetch(url, { ...init, headers });

  // 403 — blocked IP or device → redirect to blocked page
  if (res.status === 403) {
    try {
      const body = await res.clone().json();
      if (body.reason === 'ip_blocked' || body.reason === 'device_blocked') {
        const params = new URLSearchParams({ reason: body.reason });
        if (body.expiresAt) params.set('expiresAt', body.expiresAt);
        window.location.href = `/blocked?${params.toString()}`;
        return res;
      }
    } catch { /* not a block response — fall through */ }
  }

  if (res.status !== 401) return res;

  // 401 — try to refresh token
  if (isRefreshing) {
    // Another refresh is in progress — wait for it
    return new Promise<Response>((resolve, reject) => {
      refreshQueue.push({
        resolve: async (newToken: string) => {
          headers.set('Authorization', `Bearer ${newToken}`);
          try {
            resolve(await fetch(url, { ...init, headers }));
          } catch (err) {
            reject(err);
          }
        },
        reject,
      });
    });
  }

  isRefreshing = true;
  try {
    const success = await useAuthStore.getState().refreshToken();
    if (success) {
      const newToken = useAuthStore.getState().accessToken!;
      processQueue(newToken, null);
      headers.set('Authorization', `Bearer ${newToken}`);
      return fetch(url, { ...init, headers });
    } else {
      const err = new Error('Session expired');
      processQueue(null, err);
      // Redirect to login
      useAuthStore.getState().logout();
      return res; // Return original 401
    }
  } catch (err) {
    processQueue(null, err as Error);
    useAuthStore.getState().logout();
    return res;
  } finally {
    isRefreshing = false;
  }
}

/**
 * Helper to build API URLs
 */
export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}
