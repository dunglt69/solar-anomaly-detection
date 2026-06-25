import { useEffect, useState } from 'react';
import { useAuthStore } from '../stores/authStore';
import { authFetch, apiUrl } from '../lib/authFetch';
import { formatTime, formatLastSeen } from '../lib/formatTime';
import './AdminPage.css';

const API = `${import.meta.env.VITE_API_URL || 'http://localhost:3000'}/api/v1`;

function getHeaders() {
  return {
    'Content-Type': 'application/json',
  };
}

interface User {
  id: string;
  employeeId: string;
  username: string;
  email: string;
  personalEmail: string;
  dob: string;
  displayName: string;
  role: string;
  createdAt: string;
  failedAttempts: number;
  lockedUntil: string | null;
  deviceBrowser: string | null;
  deviceOs: string | null;
  isOnline?: boolean;
  lastSeenAt?: string | null;
}

function formatDOB(dob: string): string {
  if (!dob) return '—';
  // yyyy-mm-dd -> dd/mm/yyyy
  const parts = dob.split('-');
  if (parts.length === 3 && parts[0].length === 4) {
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  }
  // mm/dd/yyyy -> dd/mm/yyyy
  const slashParts = dob.split('/');
  if (slashParts.length === 3 && slashParts[2].length === 4) {
    // If the input was mm/dd/yyyy, swap day and month to get dd/mm/yyyy
    return `${slashParts[1]}/${slashParts[0]}/${slashParts[2]}`;
  }
  return dob;
}

interface LogDetails {
  fingerprint?: string;
  deviceInfo?: {
    browser?: string;
    os?: string;
  };
  hwInfo?: {
    cpuCores?: number;
    ram?: number | string;
    gpu?: string;
    screen?: string;
    timezone?: string;
    platform?: string;
  };
  reason?: string;
  detail?: string;
}

interface LogEntry {
  id: number;
  timestamp: string;
  actorId: string | null;
  actorRole: string;
  action: string;
  target: string | null;
  details: LogDetails | null;
  ip: string | null;
  userAgent: string | null;
  actorName?: string;
  targetDisplay?: string;
}

// ─── Users Tab ──────────────────────────────────────────────────────
function UsersTab() {
  const [users, setUsers] = useState<User[]>([]);
  const [form, setForm] = useState({ username: '', email: '', personalEmail: '', dob: '', displayName: '', password: '', role: 'solar_operator' });
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);

  const currentUser = useAuthStore.getState().user;

  const fetchUsers = async () => {
    try {
      const res = await authFetch(`${API}/users`, { headers: getHeaders() });
      if (res.ok) {
        const json = await res.json();
        setUsers(json.data);
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      fetchUsers();
    }, 0);
    const interval = setInterval(fetchUsers, 5000);
    return () => {
      clearTimeout(timer);
      clearInterval(interval);
    };
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setMessage(null);
    try {
      const res = await authFetch(`${API}/users`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify(form),
      });
      if (res.ok) {
        setMessage({ type: 'success', text: 'Employee registered successfully!' });
        setForm({ username: '', email: '', personalEmail: '', dob: '', displayName: '', password: '', role: 'solar_operator' });
        fetchUsers();
      } else {
        const err = await res.json();
        setMessage({ type: 'error', text: err.error || 'Failed to create user' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Network error' });
    } finally {
      setCreating(false);
    }
  };

  const handleUpdateUser = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!editingUser) return;
    const formData = new FormData(e.currentTarget);
    const displayName = formData.get('displayName') as string;
    const email = formData.get('email') as string;
    const personalEmail = formData.get('personalEmail') as string;
    const dob = formData.get('dob') as string;
    const role = formData.get('role') as string;
    const password = formData.get('password') as string;

    const payload: Record<string, unknown> = { displayName, email, personalEmail, dob };
    if (role && editingUser.id !== currentUser?.id) {
      payload.role = role;
    }
    if (password && password.trim()) {
      payload.password = password.trim();
    }

    try {
      const res = await authFetch(`${API}/users/${editingUser.id}`, {
        method: 'PATCH',
        headers: getHeaders(),
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        if (currentUser && editingUser.id === currentUser.id) {
          useAuthStore.getState().updateUser({
            displayName,
            email,
          });
        }
        setEditingUser(null);
        fetchUsers();
      } else {
        const err = await res.json();
        alert(err.error || 'Failed to update employee details');
      }
    } catch {
      alert('Network error');
    }
  };

  const handleDeleteUser = async (userId: string) => {
    if (!window.confirm('WARNING: Are you sure you want to permanently delete this employee account? This action cannot be undone.')) return;
    try {
      const res = await authFetch(`${API}/users/${userId}`, {
        method: 'DELETE',
        headers: getHeaders(),
      });

      if (res.ok) {
        setEditingUser(null);
        fetchUsers();
      } else {
        const err = await res.json();
        alert(err.error || 'Failed to delete employee account');
      }
    } catch {
      alert('Network error');
    }
  };

  const handleResetDevice = async (userId: string) => {
    if (!window.confirm('Are you sure you want to reset device binding for this employee? The next login will bind their new device.')) return;
    try {
      const res = await authFetch(`${API}/admin/device-bindings/${userId}/reset`, {
        method: 'POST',
        headers: getHeaders(),
      });
      if (res.ok) {
        fetchUsers();
      } else {
        const err = await res.json();
        alert(err.error || 'Failed to reset device binding');
      }
    } catch {
      alert('Network error');
    }
  };

  const handleUnlock = async (userId: string) => {
    if (!window.confirm('Are you sure you want to unlock this employee account?')) return;
    try {
      const res = await authFetch(`${API}/admin/users/${userId}/unlock`, {
        method: 'POST',
        headers: getHeaders(),
      });
      if (res.ok) {
        fetchUsers();
      } else {
        const err = await res.json();
        alert(err.error || 'Failed to unlock user');
      }
    } catch {
      alert('Network error');
    }
  };

  return (
    <>
      <h2 style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: 'var(--space-4)' }}>
        Register New Employee
      </h2>
      <form className="create-user-form" onSubmit={handleCreate}>
        <div className="form-group">
          <label>Username</label>
          <input type="text" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required minLength={3} />
        </div>
        <div className="form-group">
          <label>Work Email</label>
          <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
        </div>
        <div className="form-group">
          <label>Personal Email</label>
          <input type="email" value={form.personalEmail} onChange={(e) => setForm({ ...form, personalEmail: e.target.value })} required />
        </div>
        <div className="form-group">
          <label>Date of Birth</label>
          <input type="date" value={form.dob} onChange={(e) => setForm({ ...form, dob: e.target.value })} required />
        </div>
        <div className="form-group">
          <label>Full Name</label>
          <input type="text" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} required />
        </div>
        <div className="form-group">
          <label>Password</label>
          <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required minLength={8} />
        </div>
        <div className="form-group">
          <label>Role</label>
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            <option value="solar_operator">Solar Operator</option>
            <option value="security_engineer">Security Engineer</option>
            <option value="admin">Admin</option>
          </select>
        </div>
        <div className="form-group" style={{ gridColumn: '1 / -1', justifyContent: 'flex-end', display: 'flex' }}>
          <button className="btn-create" type="submit" disabled={creating}>
            {creating ? 'Creating...' : 'Register Employee'}
          </button>
        </div>
        {message && <div className={`form-message ${message.type}`} style={{ gridColumn: '1 / -1' }}>{message.text}</div>}
      </form>

      <h2 style={{ fontSize: '1.1rem', fontWeight: 600, margin: 'var(--space-5) 0 var(--space-3)' }}>
        All Employees ({users.length})
      </h2>
      <div className="user-table-container">
        <table className="user-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Username</th>
              <th>Full Name</th>
              <th>Work Email</th>
              <th>Personal Email</th>
              <th>Date of Birth</th>
              <th>Status</th>
              <th>Device Binding</th>
              <th>Created</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const isSelf = currentUser && u.id === currentUser.id;
              const isLocked = u.lockedUntil && new Date(u.lockedUntil) > new Date();
              const isBound = u.deviceBrowser || u.deviceOs;
              return (
                <tr key={u.id}>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem' }}>{u.employeeId}</td>
                  <td style={{ fontFamily: 'var(--font-mono)' }}>{u.username}</td>
                  <td>{u.displayName}</td>
                  <td style={{ fontSize: '0.75rem' }}>{u.email}</td>
                  <td style={{ fontSize: '0.75rem' }}>{u.personalEmail || '—'}</td>
                  <td style={{ fontSize: '0.75rem' }}>{formatDOB(u.dob)}</td>
                  <td>
                    {isLocked ? (
                      <span className="badge-locked" style={{ color: 'var(--status-critical)', backgroundColor: 'rgba(239, 68, 68, 0.1)', padding: '2px 6px', borderRadius: '4px', fontSize: '0.75rem', fontWeight: 600 }}>
                        Locked (Failed Logins)
                      </span>
                    ) : u.isOnline ? (
                      <span className="badge-active" style={{ color: 'var(--status-normal)', backgroundColor: 'rgba(16, 185, 129, 0.1)', padding: '2px 6px', borderRadius: '4px', fontSize: '0.75rem', fontWeight: 600 }}>
                        Online
                      </span>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                        <span className="badge-offline" style={{ color: 'var(--text-tertiary)', backgroundColor: 'rgba(148, 163, 184, 0.1)', padding: '2px 6px', borderRadius: '4px', fontSize: '0.75rem', fontWeight: 600, width: 'fit-content' }}>
                          Offline
                        </span>
                        <span style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)' }}>
                          {formatLastSeen(u.lastSeenAt)}
                        </span>
                      </div>
                    )}
                  </td>
                  <td style={{ fontSize: '0.75rem' }}>
                    {isBound ? (
                      <span style={{ color: 'var(--status-normal)', fontWeight: 500 }}>
                        Bound ({u.deviceBrowser} · {u.deviceOs})
                      </span>
                    ) : (
                      <span style={{ color: 'var(--text-tertiary)', fontStyle: 'italic' }}>
                        Not bound
                      </span>
                    )}
                  </td>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem' }}>{formatTime(u.createdAt)}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                      <button onClick={() => setEditingUser(u)} style={{ background: 'transparent', border: 'none', color: 'var(--accent-primary)', cursor: 'pointer', fontSize: '0.75rem', fontWeight: 600 }}>
                        Configure
                      </button>
                      {isLocked && (
                        <button onClick={() => handleUnlock(u.id)} style={{ background: 'transparent', border: 'none', color: '#10b981', cursor: 'pointer', fontSize: '0.75rem', fontWeight: 600 }}>
                          Unlock
                        </button>
                      )}
                      {isBound && !isSelf && (
                        <button onClick={() => handleResetDevice(u.id)} style={{ background: 'transparent', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: '0.75rem', fontWeight: 600 }}>
                          Reset Device
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {editingUser && (
        <div className="admin-modal-overlay">
          <div className="admin-modal">
            <div className="admin-modal-header">
              <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600 }}>
                Configure Employee: {editingUser.username}
              </h3>
              <button onClick={() => setEditingUser(null)} style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '1.4rem', padding: 0, lineHeight: 1 }}>
                &times;
              </button>
            </div>
            <form onSubmit={handleUpdateUser}>
              <div className="admin-modal-body">
                <div className="form-group">
                  <label>Full Name</label>
                  <input type="text" defaultValue={editingUser.displayName} name="displayName" required />
                </div>
                <div className="form-group">
                  <label>Work Email</label>
                  <input type="email" defaultValue={editingUser.email} name="email" required />
                </div>
                <div className="form-group">
                  <label>Personal Email</label>
                  <input type="email" defaultValue={editingUser.personalEmail} name="personalEmail" required />
                </div>
                <div className="form-group">
                  <label>Date of Birth</label>
                  <input type="date" defaultValue={editingUser.dob} name="dob" required />
                </div>
                <div className="form-group">
                  <label>Role</label>
                  <select defaultValue={editingUser.role} name="role" disabled={editingUser.id === currentUser?.id}>
                    <option value="solar_operator">Solar Operator</option>
                    <option value="security_engineer">Security Engineer</option>
                    <option value="admin">Admin</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>New Password (blank if unchanged)</label>
                  <input type="password" name="password" placeholder="Enter new password" minLength={8} />
                </div>
              </div>
              <div className="admin-modal-footer">
                <div>
                  {editingUser.id !== currentUser?.id && (
                    <button type="button" onClick={() => handleDeleteUser(editingUser.id)} className="btn-create" style={{ backgroundColor: 'var(--status-critical)', color: 'white' }}>
                      Delete Employee
                    </button>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                  <button type="button" onClick={() => setEditingUser(null)} style={{ background: 'var(--surface-3)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)', padding: 'var(--space-2) var(--space-4)', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontSize: 'var(--text-sm)', fontWeight: 600 }}>
                    Cancel
                  </button>
                  <button type="submit" className="btn-create">
                    Save Changes
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}


// ─── Activity Log Tab ───────────────────────────────────────────────
function ActivityLogTab() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let active = true;
    const loadInitial = async () => {
      try {
        const res = await authFetch(`${API}/activity-log?limit=50&offset=0`, { headers: getHeaders() });
        if (res.ok && active) {
          const json = await res.json();
          setLogs(json.data);
          setTotal(json.total);
        }
      } catch {
        // ignore
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };
    loadInitial();
    return () => {
      active = false;
    };
  }, []);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const currentOffset = logs.length;
      const res = await authFetch(`${API}/activity-log?limit=50&offset=${currentOffset}`, { headers: getHeaders() });
      if (res.ok) {
        const json = await res.json();
        setLogs(prev => [...prev, ...json.data]);
        setTotal(json.total);
      }
    } catch {
      // ignore
    } finally {
      setLoadingMore(false);
    }
  };

  if (logs.length === 0 && !loading) {
    return (
      <div className="admin-empty">
        <div className="empty-icon">📝</div>
        <p>No activity recorded yet.</p>
      </div>
    );
  }

  return (
    <>
      <div className="log-table-container">
        <table className="log-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Action</th>
              <th>Actor</th>
              <th>IP</th>
              <th>Device & Hardware Details</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((log) => (
              <tr key={log.id}>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem', whiteSpace: 'nowrap' }}>
                  {formatTime(log.timestamp)}
                </td>
                <td>
                  <span className={`action-badge ${log.action}`} style={{
                    backgroundColor: log.action === 'DEVICE_REGISTERED' ? 'rgba(16, 185, 129, 0.15)' :
                                     log.action === 'DEVICE_RESET' ? 'rgba(239, 68, 68, 0.15)' :
                                     log.action === 'DEVICE_REJECTED' ? 'rgba(239, 68, 68, 0.2)' : undefined,
                    color: log.action === 'DEVICE_REGISTERED' ? 'var(--status-normal)' :
                           log.action === 'DEVICE_RESET' ? 'var(--status-critical)' :
                           log.action === 'DEVICE_REJECTED' ? 'var(--status-critical)' : undefined
                  }}>
                    {log.action}
                  </span>
                </td>
                <td style={{ fontSize: '0.8rem', whiteSpace: 'nowrap' }}>
                  <span style={{ fontWeight: 600 }}>{log.actorName || 'SYSTEM'}</span>
                  <span style={{ color: 'var(--text-tertiary)', marginLeft: '0.5rem', fontSize: '0.7rem' }}>{log.actorRole}</span>
                </td>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem' }}>{log.ip || '—'}</td>
                <td style={{ fontSize: '0.75rem', lineHeight: '1.4' }}>
                  {log.details?.fingerprint ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.7rem', color: 'var(--text-primary)' }}>
                        <strong>FP:</strong> {log.details.fingerprint}
                      </span>
                      {log.details.deviceInfo && (
                        <span style={{ color: 'var(--text-secondary)', fontSize: '0.7rem' }}>
                          <strong>Web:</strong> {log.details.deviceInfo.browser || 'Unknown Browser'} ({log.details.deviceInfo.os || 'Unknown OS'})
                        </span>
                      )}
                      {log.details.hwInfo && (
                        <span style={{ color: 'var(--text-tertiary)', fontSize: '0.65rem', display: 'block', fontStyle: 'italic' }}>
                          <strong>HW Signature:</strong> {log.details.hwInfo.cpuCores} CPU Cores • {log.details.hwInfo.ram ? `${log.details.hwInfo.ram} GB RAM` : 'RAM Info unavailable'} • GPU: {log.details.hwInfo.gpu || 'GPU Info unavailable'} • Screen: {log.details.hwInfo.screen || 'Unknown Resolution'} • Timezone: {log.details.hwInfo.timezone || 'Unknown'} • Platform: {log.details.hwInfo.platform || 'Unknown'}
                        </span>
                      )}
                      {log.details.reason && (
                        <span style={{ color: 'var(--status-critical)', fontSize: '0.7rem', fontWeight: 600 }}>
                          Reason: {log.details.reason}
                        </span>
                      )}
                      {log.details.detail && (
                        <span style={{ color: 'var(--status-critical)', fontSize: '0.7rem' }}>
                          Mismatch details: {log.details.detail}
                        </span>
                      )}
                    </div>
                  ) : log.details?.reason ? (
                    <span style={{ color: 'var(--status-critical)', fontSize: '0.7rem', fontWeight: 600 }}>
                      Failed: {log.details.reason}
                    </span>
                  ) : (
                    <span style={{ color: 'var(--text-tertiary)' }}>—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {logs.length < total && (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 'var(--space-4)' }}>
          <button
            className="btn-create"
            onClick={loadMore}
            disabled={loadingMore}
            style={{ padding: 'var(--space-2) var(--space-6)' }}
          >
            {loadingMore ? 'Loading...' : 'Load more'}
          </button>
        </div>
      )}
    </>
  );
}

// ─── Main Admin Page ────────────────────────────────────────────────
export default function AdminPage() {
  const user = useAuthStore.getState().user;
  const isSecurity = user?.role === 'security_engineer';
  const [tab, setTab] = useState<'users' | 'logs'>(isSecurity ? 'logs' : 'users');

  return (
    <div className="admin-page">
      <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 700 }}>
        Administration Center
      </h1>

      <div className="admin-tabs">
        {!isSecurity && (
          <button className={`admin-tab ${tab === 'users' ? 'active' : ''}`} onClick={() => setTab('users')}>
            User Management
          </button>
        )}
        <button className={`admin-tab ${tab === 'logs' ? 'active' : ''}`} onClick={() => setTab('logs')}>
          Activity Log
        </button>
      </div>

      <div style={{ marginTop: 'var(--space-4)' }}>
        {tab === 'users' && !isSecurity && <UsersTab />}
        {tab === 'logs' && <ActivityLogTab />}
      </div>
    </div>
  );
}
