import { NavLink } from 'react-router-dom';
import {
  Sun, LayoutDashboard, AlertTriangle,
  BarChart3, Shield, Settings, PanelLeftClose, PanelLeftOpen,
} from 'lucide-react';
import { useAuthStore } from '../../stores/authStore';
import './Sidebar.css';

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

const NAV_ITEMS = [
  { path: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { path: '/alerts', label: 'Alerts', icon: AlertTriangle },
  { path: '/analytics', label: 'Analytics', icon: BarChart3 },
];

const ADMIN_ITEMS = [
  { path: '/admin', label: 'Administration', icon: Shield },
];

export default function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const { user } = useAuthStore();

  return (
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
      {/* Brand */}
      <div className="sidebar-brand">
        <div className="sidebar-logo">
          <Sun size={22} strokeWidth={2.5} />
        </div>
        {!collapsed && <span className="sidebar-brand-text">EnergiaMind</span>}
      </div>

      {/* Navigation */}
      <nav className="sidebar-nav">
        {user?.role !== 'security_engineer' && (
          <div className="sidebar-section">
            {!collapsed && <span className="sidebar-section-label">Monitoring</span>}
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}
                title={collapsed ? item.label : undefined}
              >
                <item.icon size={18} />
                {!collapsed && <span>{item.label}</span>}
              </NavLink>
            ))}
          </div>
        )}

        {(user?.role === 'admin' || user?.role === 'security_engineer') && (
          <div className="sidebar-section">
            {!collapsed && <span className="sidebar-section-label">System</span>}
            {ADMIN_ITEMS.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}
                title={collapsed ? item.label : undefined}
              >
                <item.icon size={18} />
                {!collapsed && <span>{item.label}</span>}
              </NavLink>
            ))}
          </div>
        )}
      </nav>

      {/* Footer */}
      <div className="sidebar-footer">
        <NavLink
          to="/settings"
          className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}
          title={collapsed ? 'Settings' : undefined}
        >
          <Settings size={18} />
          {!collapsed && <span>Settings</span>}
        </NavLink>

        <button
          className="sidebar-toggle"
          onClick={onToggle}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          {!collapsed && <span>Collapse</span>}
        </button>
      </div>
    </aside>
  );
}
