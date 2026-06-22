import { useLocation, useNavigate } from 'react-router-dom';
import { Bell, LogOut, User } from 'lucide-react';
import { useAuthStore } from '../../stores/authStore';
import './Header.css';

const ROUTE_TITLES: Record<string, string> = {
  '/dashboard': 'Dashboard',
  '/alerts': 'Alert History',
  '/tickets': 'Incident Tickets',
  '/analytics': 'Analytics',
  '/admin': 'Administration',
  '/settings': 'Settings',
};

export default function Header() {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();
  const location = useLocation();

  const title = ROUTE_TITLES[location.pathname] || 'EnergiaMind';

  return (
    <header className="app-header">
      <div className="header-left">
        <h2 className="header-title">{title}</h2>
      </div>

      <div className="header-right">
        <button className="header-icon-btn" onClick={() => navigate('/alerts')} aria-label="View alerts">
          <Bell size={18} />
        </button>

        {/* User info */}
        <div className="header-user">
          <div className="header-avatar">
            <User size={16} />
          </div>
          <div className="header-user-info">
            <span className="header-user-name">{user?.displayName}</span>
            <span className="header-user-role">{user?.role}</span>
          </div>
        </div>

        {/* Logout */}
        <button
          className="header-icon-btn header-logout"
          onClick={logout}
          aria-label="Sign out"
          title="Sign out"
        >
          <LogOut size={18} />
        </button>
      </div>
    </header>
  );
}
