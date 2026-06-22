// ─── Shared API Configuration ───────────────────────────────────────
const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000';
export const API_V1 = `${API_BASE}/api/v1`;

export function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem('accessToken');
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export { API_BASE };
