// ─── Shared API Configuration ───────────────────────────────────────
const getApiBase = () => {
  if (import.meta.env.VITE_API_URL) {
    return import.meta.env.VITE_API_URL;
  }
  if (typeof window !== 'undefined') {
    if (window.location.port === '5173') {
      // devskim: ignore DS137138 - Local development uses plain HTTP
      return `http://${window.location.hostname}:3000`;
    }
    return window.location.origin;
  }
  // devskim: ignore DS137138 - Local development uses plain HTTP
  return 'http://localhost:3000';
};

const API_BASE = getApiBase();
export const API_V1 = `${API_BASE}/api/v1`;

export function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem('accessToken');
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export { API_BASE };
