import { useState } from 'react';
import { useAuthStore } from '../stores/authStore';
import {
  User, Shield, Bell, Monitor, Save, Lock,
} from 'lucide-react';
import './SettingsPage.css';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000';

interface UserProfile {
  username: string;
  email: string;
  displayName: string;
  role: string;
}

export default function SettingsPage() {
  const { user, accessToken } = useAuthStore();
  const [activeTab, setActiveTab] = useState<'profile' | 'security' | 'notifications' | 'display'>('profile');
  const [prevUserId, setPrevUserId] = useState(user?.id);
  const [profile, setProfile] = useState<UserProfile>(() => ({
    username: user?.username || '',
    email: user?.email || '',
    displayName: user?.displayName || '',
    role: user?.role || '',
  }));

  // Reset form when user changes, but avoid reading or writing refs during render
  if (user && user.id !== prevUserId) {
    setPrevUserId(user.id);
    setProfile({
      username: user.username || '',
      email: user.email || '',
      displayName: user.displayName || '',
      role: user.role || '',
    });
  }

  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');

  // Notification preferences (local storage)
  const [notifToast, setNotifToast] = useState(
    () => localStorage.getItem('em_notif_toast') !== 'false'
  );
  const [notifCriticalOnly, setNotifCriticalOnly] = useState(
    () => localStorage.getItem('em_notif_critical') === 'true'
  );

  // Display preferences (local storage)
  const [chartSmooth, setChartSmooth] = useState(
    () => localStorage.getItem('em_chart_smooth') !== 'false'
  );
  const [compactMode, setCompactMode] = useState(
    () => localStorage.getItem('em_compact') === 'true'
  );
  const [theme, setTheme] = useState<'dark' | 'light'>(
    () => (localStorage.getItem('em_theme') as 'dark' | 'light') || 'dark'
  );

  // Password change
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordSaving, setPasswordSaving] = useState(false);

  const handleSaveProfile = async () => {
    if (!accessToken) return;
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/api/v1/auth/profile`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          displayName: profile.displayName,
          email: profile.email,
        }),
      });
      if (res.ok) {
        setSaveMsg('Profile updated successfully');
        useAuthStore.getState().updateUser({
          displayName: profile.displayName,
          email: profile.email,
        });
      } else {
        setSaveMsg('Failed to update profile');
      }
    } catch {
      setSaveMsg('Error saving profile');
    }
    setSaving(false);
    setTimeout(() => setSaveMsg(''), 3000);
  };

  // Immediate autosave handlers
  const handleToggleToast = (checked: boolean) => {
    setNotifToast(checked);
    localStorage.setItem('em_notif_toast', String(checked));
    window.dispatchEvent(new Event('em-display-settings-changed'));
  };

  const handleToggleCritical = (checked: boolean) => {
    setNotifCriticalOnly(checked);
    localStorage.setItem('em_notif_critical', String(checked));
    window.dispatchEvent(new Event('em-display-settings-changed'));
  };

  const handleToggleSmooth = (checked: boolean) => {
    setChartSmooth(checked);
    localStorage.setItem('em_chart_smooth', String(checked));
    window.dispatchEvent(new Event('em-display-settings-changed'));
  };

  const handleToggleCompact = (checked: boolean) => {
    setCompactMode(checked);
    localStorage.setItem('em_compact', String(checked));
    window.dispatchEvent(new Event('em-display-settings-changed'));
  };

  const handleThemeChange = (newTheme: 'dark' | 'light') => {
    setTheme(newTheme);
    localStorage.setItem('em_theme', newTheme);
    document.documentElement.setAttribute('data-theme', newTheme);
    window.dispatchEvent(new Event('em-display-settings-changed'));
  };

  const handleSaveNotifications = () => {
    localStorage.setItem('em_notif_toast', String(notifToast));
    localStorage.setItem('em_notif_critical', String(notifCriticalOnly));
    window.dispatchEvent(new Event('em-display-settings-changed'));
    setSaveMsg('Notification preferences saved');
    setTimeout(() => setSaveMsg(''), 3000);
  };

  const handleSaveDisplay = () => {
    localStorage.setItem('em_chart_smooth', String(chartSmooth));
    localStorage.setItem('em_compact', String(compactMode));
    localStorage.setItem('em_theme', theme);
    window.dispatchEvent(new Event('em-display-settings-changed'));
    setSaveMsg('Display preferences saved');
    setTimeout(() => setSaveMsg(''), 3000);
  };

  const handleChangePassword = async () => {
    if (!accessToken) return;
    if (newPassword !== confirmPassword) {
      setSaveMsg('Passwords do not match');
      setTimeout(() => setSaveMsg(''), 3000);
      return;
    }
    if (newPassword.length < 8) {
      setSaveMsg('Password must be at least 8 characters');
      setTimeout(() => setSaveMsg(''), 3000);
      return;
    }
    if (!/[A-Z]/.test(newPassword)) {
      setSaveMsg('Password must contain at least one uppercase letter');
      setTimeout(() => setSaveMsg(''), 3000);
      return;
    }
    if (!/[a-z]/.test(newPassword)) {
      setSaveMsg('Password must contain at least one lowercase letter');
      setTimeout(() => setSaveMsg(''), 3000);
      return;
    }
    if (!/[0-9]/.test(newPassword)) {
      setSaveMsg('Password must contain at least one digit');
      setTimeout(() => setSaveMsg(''), 3000);
      return;
    }
    if (!/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(newPassword)) {
      setSaveMsg('Password must contain at least one special character');
      setTimeout(() => setSaveMsg(''), 3000);
      return;
    }
    setPasswordSaving(true);
    try {
      const res = await fetch(`${API_BASE}/api/v1/auth/password`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          currentPassword,
          newPassword,
        }),
      });
      if (res.ok) {
        setSaveMsg('Password changed successfully');
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
      } else {
        const data = await res.json();
        setSaveMsg(data.error || 'Failed to change password');
      }
    } catch {
      setSaveMsg('Error changing password');
    }
    setPasswordSaving(false);
    setTimeout(() => setSaveMsg(''), 3000);
  };

  const tabs = [
    { key: 'profile' as const, label: 'Profile', icon: User },
    { key: 'security' as const, label: 'Security', icon: Lock },
    { key: 'notifications' as const, label: 'Notifications', icon: Bell },
    { key: 'display' as const, label: 'Display', icon: Monitor },
  ];

  return (
    <div className="settings-page">
      <h1 className="settings-title">Settings</h1>

      {saveMsg && (
        <div className="settings-toast">{saveMsg}</div>
      )}

      <div className="settings-layout">
        {/* Sidebar tabs */}
        <nav className="settings-nav">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              className={`settings-nav-btn ${activeTab === tab.key ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.key)}
            >
              <tab.icon size={16} />
              <span>{tab.label}</span>
            </button>
          ))}
        </nav>

        {/* Content area */}
        <div className="settings-content">
          {/* ─── Profile Tab ─────────────────────────────────── */}
          {activeTab === 'profile' && (
            <div className="settings-section">
              <div className="section-header">
                <User size={20} />
                <div>
                  <h2>Profile Settings</h2>
                  <p>Manage your account information</p>
                </div>
              </div>

              <div className="settings-form">
                <div className="form-group">
                  <label>Username</label>
                  <input type="text" value={profile.username} disabled className="input-disabled" />
                  <span className="form-hint">Username cannot be changed</span>
                </div>
                <div className="form-group">
                  <label>Display Name</label>
                  <input
                    type="text"
                    value={profile.displayName}
                    onChange={(e) => setProfile({ ...profile, displayName: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label>Email</label>
                  <input
                    type="email"
                    value={profile.email}
                    onChange={(e) => setProfile({ ...profile, email: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label>Role</label>
                  <div className="role-badge">
                    <Shield size={14} />
                    {profile.role.toUpperCase()}
                  </div>
                </div>

                <button className="save-btn" onClick={handleSaveProfile} disabled={saving}>
                  <Save size={14} />
                  {saving ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            </div>
          )}

          {/* ─── Security Tab ──────────────────────────────── */}
          {activeTab === 'security' && (
            <div className="settings-section">
              <div className="section-header">
                <Lock size={20} />
                <div>
                  <h2>Change Password</h2>
                  <p>Update your account password</p>
                </div>
              </div>

              <div className="settings-form">
                <div className="form-group">
                  <label>Current Password</label>
                  <input
                    type="password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    placeholder="Enter current password"
                  />
                </div>
                <div className="form-group">
                  <label>New Password</label>
                  <input
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Enter new password"
                  />
                </div>
                <div className="form-group">
                  <label>Confirm New Password</label>
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Confirm new password"
                  />
                </div>

                <button
                  className="save-btn"
                  onClick={handleChangePassword}
                  disabled={passwordSaving || !currentPassword || !newPassword || !confirmPassword}
                >
                  <Save size={14} />
                  {passwordSaving ? 'Changing...' : 'Change Password'}
                </button>
              </div>
            </div>
          )}

          {/* ─── Notifications Tab ───────────────────────────── */}
          {activeTab === 'notifications' && (
            <div className="settings-section">
              <div className="section-header">
                <Bell size={20} />
                <div>
                  <h2>Notification Preferences</h2>
                  <p>Configure how you receive alerts</p>
                </div>
              </div>

              <div className="settings-form">
                <div className="toggle-group">
                  <div className="toggle-info">
                    <span className="toggle-label">Toast Notifications</span>
                    <span className="toggle-desc">Show popup alerts on the dashboard</span>
                  </div>
                  <label className="toggle-switch">
                    <input type="checkbox" checked={notifToast} onChange={(e) => handleToggleToast(e.target.checked)} aria-label="Enable Toast Notifications" />
                    <span className="toggle-slider" />
                  </label>
                </div>



                <div className="toggle-group">
                  <div className="toggle-info">
                    <span className="toggle-label">Critical Only</span>
                    <span className="toggle-desc">Only show critical and emergency alerts</span>
                  </div>
                  <label className="toggle-switch">
                    <input type="checkbox" checked={notifCriticalOnly} onChange={(e) => handleToggleCritical(e.target.checked)} aria-label="Only Notify Critical Alerts" />
                    <span className="toggle-slider" />
                  </label>
                </div>

                <button className="save-btn" onClick={handleSaveNotifications}>
                  <Save size={14} /> Save Preferences
                </button>
              </div>
            </div>
          )}

          {/* ─── Display Tab ─────────────────────────────────── */}
          {activeTab === 'display' && (
            <div className="settings-section">
              <div className="section-header">
                <Monitor size={20} />
                <div>
                  <h2>Display Settings</h2>
                  <p>Customize the dashboard appearance</p>
                </div>
              </div>

              <div className="settings-form">
                <div className="toggle-group">
                  <div className="toggle-info">
                    <span className="toggle-label">Smooth Charts</span>
                    <span className="toggle-desc">Use smooth line interpolation for charts</span>
                  </div>
                  <label className="toggle-switch">
                    <input type="checkbox" checked={chartSmooth} onChange={(e) => handleToggleSmooth(e.target.checked)} aria-label="Enable Smooth Charts" />
                    <span className="toggle-slider" />
                  </label>
                </div>

                <div className="toggle-group">
                  <div className="toggle-info">
                    <span className="toggle-label">Compact Mode</span>
                    <span className="toggle-desc">Reduce spacing for denser information display</span>
                  </div>
                  <label className="toggle-switch">
                    <input type="checkbox" checked={compactMode} onChange={(e) => handleToggleCompact(e.target.checked)} aria-label="Enable Compact Mode Layout" />
                    <span className="toggle-slider" />
                  </label>
                </div>

                <div className="toggle-group">
                  <div className="toggle-info">
                    <span className="toggle-label">Theme Mode</span>
                    <span className="toggle-desc">Switch between Dark and Light mode</span>
                  </div>
                  <select
                    value={theme}
                    onChange={(e) => handleThemeChange(e.target.value as 'dark' | 'light')}
                    style={{
                      background: 'var(--color-bg-primary)',
                      border: '1px solid var(--border-subtle)',
                      borderRadius: 'var(--radius-md)',
                      color: 'var(--text-primary)',
                      padding: 'var(--space-2) var(--space-3)',
                      fontSize: 'var(--text-sm)',
                      outline: 'none',
                      cursor: 'pointer'
                    }}
                  >
                    <option value="dark">Dark Mode</option>
                    <option value="light">Light Mode</option>
                  </select>
                </div>

                <button className="save-btn" onClick={handleSaveDisplay}>
                  <Save size={14} /> Save Display Settings
                </button>
              </div>
            </div>
          )}


        </div>
      </div>
    </div>
  );
}
