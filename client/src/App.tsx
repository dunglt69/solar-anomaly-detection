import { useEffect, lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from './stores/authStore';
import ErrorBoundary from './components/ErrorBoundary';
import DashboardLayout from './components/layout/DashboardLayout';
import './styles/index.css';

const LoginPage = lazy(() => import('./pages/LoginPage'));
const AccessDeniedPage = lazy(() => import('./pages/AccessDeniedPage'));
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const AlertsPage = lazy(() => import('./pages/AlertsPage'));
const AnalyticsPage = lazy(() => import('./pages/AnalyticsPage'));
const AdminPage = lazy(() => import('./pages/AdminPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuthStore();

  if (isLoading) {
    return (
      <div className="app-loading">
        <div className="app-loading-spinner" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

function PublicRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading, user } = useAuthStore();

  if (isLoading) {
    return (
      <div className="app-loading">
        <div className="app-loading-spinner" />
      </div>
    );
  }

  if (isAuthenticated) {
    if (user?.role === 'security_engineer') {
      return <Navigate to="/admin" replace />;
    }
    return <Navigate to="/dashboard" replace />;
  }

  return <>{children}</>;
}

function AdminRoute({ children }: { children: React.ReactNode }) {
  const { user } = useAuthStore();
  if (!user || (user.role !== 'admin' && user.role !== 'security_engineer')) {
    return <Navigate to="/dashboard" replace />;
  }
  return <>{children}</>;
}

function OperatorRoute({ children }: { children: React.ReactNode }) {
  const { user } = useAuthStore();
  if (user?.role === 'security_engineer') {
    return <Navigate to="/admin" replace />;
  }
  return <>{children}</>;
}

function RootRedirect() {
  const { user } = useAuthStore();
  if (user?.role === 'security_engineer') {
    return <Navigate to="/admin" replace />;
  }
  return <Navigate to="/dashboard" replace />;
}

export default function App() {
  const { refreshToken } = useAuthStore();

  useEffect(() => {
    refreshToken();
  }, [refreshToken]);

  return (
    <ErrorBoundary>
      <BrowserRouter>
        <Suspense fallback={<div className="page-loading">Loading...</div>}>
          <Routes>
            {/* Public */}
            <Route path="/login" element={
              <PublicRoute><LoginPage /></PublicRoute>
            } />
            <Route path="/access-denied" element={<AccessDeniedPage />} />

            {/* Protected */}
            <Route path="/" element={
              <ProtectedRoute><DashboardLayout /></ProtectedRoute>
            }>
              <Route index element={<RootRedirect />} />
              <Route path="dashboard" element={<OperatorRoute><DashboardPage /></OperatorRoute>} />
              <Route path="alerts" element={<OperatorRoute><AlertsPage /></OperatorRoute>} />
              <Route path="analytics" element={<OperatorRoute><AnalyticsPage /></OperatorRoute>} />
              <Route path="admin" element={<AdminRoute><AdminPage /></AdminRoute>} />
              <Route path="settings" element={<SettingsPage />} />
            </Route>

            {/* Fallback */}
            <Route path="*" element={<RootRedirect />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
