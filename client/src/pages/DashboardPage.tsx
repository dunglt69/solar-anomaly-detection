import { useEffect, useState, useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useTelemetryStore, type ChartInterval } from '../stores/telemetryStore';
import KPICards from '../components/dashboard/KPICards';
import PowerChart from '../components/charts/PowerChart';
import VoltageCurrentChart from '../components/charts/VoltageCurrentChart';
import EnvironmentChart from '../components/charts/EnvironmentChart';
import TemperatureChart from '../components/charts/TemperatureChart';
import {
  Wifi, WifiOff, RefreshCw,
  Calendar, X, Bell,
} from 'lucide-react';
import './DashboardPage.css';

const INTERVALS: { value: ChartInterval; label: string; tooltip: string }[] = [
  { value: '1h', label: '1H', tooltip: 'Last 1 hour (30s resolution)' },
  { value: '6h', label: '6H', tooltip: 'Last 6 hours (1min resolution)' },
  { value: '1d', label: '1D', tooltip: 'Last 24 hours (5min resolution)' },
  { value: '3d', label: '3D', tooltip: 'Last 3 days (15min resolution)' },
  { value: '1w', label: '1W', tooltip: 'Last 7 days (1h resolution)' },
];

export default function DashboardPage() {
  const {
    chartData, chartInterval, isConnected,
    recentAlerts, lastDataReceived, currentTime
  } = useTelemetryStore(useShallow((state) => ({
    chartData: state.chartData,
    chartInterval: state.chartInterval,
    isConnected: state.isConnected,
    recentAlerts: state.recentAlerts,
    lastDataReceived: state.lastDataReceived,
    currentTime: state.currentTime,
  })));

  const {
    fetchChartData, fetchKPIs, fetchLatestPoint,
    setChartInterval, setCustomRange, clearCustomRange,
    dismissAlert, connectWebSocket, disconnectWebSocket,
    preFetchAllRanges,
  } = useTelemetryStore(useShallow((state) => ({
    fetchChartData: state.fetchChartData,
    fetchKPIs: state.fetchKPIs,
    fetchLatestPoint: state.fetchLatestPoint,
    setChartInterval: state.setChartInterval,
    setCustomRange: state.setCustomRange,
    clearCustomRange: state.clearCustomRange,
    dismissAlert: state.dismissAlert,
    connectWebSocket: state.connectWebSocket,
    disconnectWebSocket: state.disconnectWebSocket,
    preFetchAllRanges: state.preFetchAllRanges,
  })));

  const [showDatePicker, setShowDatePicker] = useState(false);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  useEffect(() => {
    // Initial load
    fetchChartData();
    fetchKPIs();
    fetchLatestPoint();
    connectWebSocket();

    // Refresh KPIs every 10s, chart data every 30s (only if tab is visible)
    const kpiTimer = setInterval(() => {
      if (!document.hidden) {
        fetchKPIs();
      }
    }, 10_000);

    const chartTimer = setInterval(() => {
      if (!document.hidden) {
        fetchChartData();
      }
    }, 30_000);

    // Refresh instantly when user returns to tab
    const handleVisibility = () => {
      if (!document.hidden) {
        fetchChartData();
        fetchKPIs();
        fetchLatestPoint();
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      disconnectWebSocket();
      clearInterval(kpiTimer);
      clearInterval(chartTimer);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [fetchChartData, fetchKPIs, fetchLatestPoint, connectWebSocket, disconnectWebSocket, preFetchAllRanges]);

  const handleRefresh = useCallback(() => {
    fetchChartData();
    fetchKPIs();
  }, [fetchChartData, fetchKPIs]);

  const handleCustomDate = useCallback(() => {
    if (dateFrom) {
      const from = new Date(dateFrom).toISOString();
      const to = dateTo ? new Date(dateTo + 'T23:59:59').toISOString() : new Date().toISOString();
      setCustomRange(from, to);
      setShowDatePicker(false);
    }
  }, [dateFrom, dateTo, setCustomRange]);

  const handleIntervalChange = useCallback((interval: ChartInterval) => {
    setChartInterval(interval);
    setShowDatePicker(false);
  }, [setChartInterval]);



  return (
    <div className="dashboard-page">
      {/* Alert Toasts */}
      {recentAlerts.length > 0 && (
        <div className="alert-toast-container">
          {recentAlerts.map((alert) => (
            <div key={alert.alertId} className={`alert-toast alert-toast--${alert.severity}`}>
              <div className="alert-toast-icon">
                <Bell size={16} />
              </div>
              <div className="alert-toast-content">
                <div className="alert-toast-severity">{alert.severity.toUpperCase()}</div>
                <div className="alert-toast-message">
                  {alert.faultName} detected
                </div>
              </div>
              <button className="alert-toast-close" onClick={() => dismissAlert(alert.alertId)}>
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}



      {/* Top bar with interval selector */}
      <div className="dashboard-toolbar">
        <div className="ws-status">
          {(() => {
            const isDataFlowing = lastDataReceived && (currentTime - lastDataReceived) < 30000;
            if (isDataFlowing) {
              return <><Wifi size={14} /> <span className="ws-connected">Live Stream Active</span></>;
            } else if (isConnected) {
              return <><Wifi size={14} /> <span className="ws-waiting">Connected · Waiting for data</span></>;
            } else {
              return <><WifiOff size={14} /> <span className="ws-disconnected">Offline</span></>;
            }
          })()}
        </div>

        {/* Interval selector — controls chart resolution, not data range */}
        <div className="time-range-selector">
          {INTERVALS.map((tr) => (
            <button
              key={tr.value}
              className={`time-range-btn ${chartInterval === tr.value ? 'active' : ''}`}
              onClick={() => handleIntervalChange(tr.value)}
              title={tr.tooltip}
            >
              {tr.label}
            </button>
          ))}
          <button
            className={`time-range-btn time-range-btn--calendar ${showDatePicker ? 'active' : ''}`}
            onClick={() => setShowDatePicker(!showDatePicker)}
            title="Filter by date range"
          >
            <Calendar size={14} />
          </button>
        </div>

        <button className="refresh-btn" onClick={handleRefresh} title="Refresh data">
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {/* Custom date picker */}
      {showDatePicker && (
        <div className="date-picker-panel">
          <div className="date-field">
            <label>From</label>
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
          </div>
          <div className="date-field">
            <label>To</label>
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          </div>
          <button className="date-apply-btn" onClick={handleCustomDate} disabled={!dateFrom}>
            Apply
          </button>
          <button className="date-cancel-btn" onClick={() => { setShowDatePicker(false); clearCustomRange(); }}>
            Clear
          </button>
        </div>
      )}



      {/* KPI Cards */}
      <KPICards />

      {/* Charts grid */}
      <div className="charts-grid">
        <div className="chart-card chart-card--wide">
          <PowerChart data={chartData} height={320} interval={chartInterval} currentTime={currentTime} />
        </div>
        <div className="chart-card">
          <VoltageCurrentChart data={chartData} height={280} interval={chartInterval} currentTime={currentTime} />
        </div>
        <div className="chart-card">
          <EnvironmentChart data={chartData} height={280} interval={chartInterval} currentTime={currentTime} />
        </div>
        <div className="chart-card chart-card--wide">
          <TemperatureChart data={chartData} height={280} interval={chartInterval} currentTime={currentTime} />
        </div>
      </div>
    </div>
  );
}
