import { useState, useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import Header from './Header';
import ErrorBoundary from '../ErrorBoundary';
import './DashboardLayout.css';

export default function DashboardLayout() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [compact, setCompact] = useState(
    () => localStorage.getItem('em_compact') === 'true'
  );

  useEffect(() => {
    const handleSettingsChange = () => {
      setCompact(localStorage.getItem('em_compact') === 'true');
    };
    window.addEventListener('em-display-settings-changed', handleSettingsChange);
    return () => {
      window.removeEventListener('em-display-settings-changed', handleSettingsChange);
    };
  }, []);

  return (
    <div className={`dashboard-layout ${sidebarCollapsed ? 'sidebar-collapsed' : ''} ${compact ? 'compact-mode' : ''}`}>
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed(!sidebarCollapsed)}
      />
      <div className="dashboard-main">
        <Header />
        <main className="dashboard-content">
          <ErrorBoundary>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
