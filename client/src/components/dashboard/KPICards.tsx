import { useEffect, useState, useMemo } from 'react';
import { useTelemetryStore } from '../../stores/telemetryStore';
import { authFetch, apiUrl } from '../../lib/authFetch';
import {
  Zap, Sun, AlertTriangle, Activity,
  ThermometerSun, TrendingUp,
} from 'lucide-react';
import { FAULT_LABELS } from '../../lib/constants';
import './KPICards.css';



export default function KPICards() {
  const { kpis, latestPoint, isConnected, lastDataReceived, currentTime } = useTelemetryStore();
  const [dailyYield, setDailyYield] = useState(0);

  // PERF-005: Use useMemo to derive staleness from store's currentTime (updated by WS messages)
  // instead of a setInterval that forces a re-render every 5 seconds
  const isDataFlowing = useMemo(() => {
    if (!lastDataReceived) return false;
    return (currentTime - lastDataReceived) < 35000;
  }, [lastDataReceived, currentTime]);

  // Fetch today-only daily yield
  useEffect(() => {
    const fetchDailyYield = async () => {
      try {
        const res = await authFetch(apiUrl('/api/v1/telemetry/daily-yield-today'));
        if (res.ok) {
          const data = await res.json();
          setDailyYield(data.energyKwh);
        }
      } catch { /* ignore */ }
    };
    fetchDailyYield();
    const interval = setInterval(fetchDailyYield, 30_000);
    return () => clearInterval(interval);
  }, []);



  const cards = [
    {
      id: 'power',
      label: 'Total Power',
      value: (latestPoint && isDataFlowing)
        ? `${latestPoint.pdcTotal.toFixed(1)}`
        : '—',
      unit: 'W',
      icon: Zap,
      color: 'var(--color-brand)',
      detail: (latestPoint && isDataFlowing)
        ? `S1: ${latestPoint.pdc1.toFixed(0)}W | S2: ${latestPoint.pdc2.toFixed(0)}W`
        : 'No live stream',
    },
    {
      id: 'energy',
      label: 'Daily Energy Yield',
      value: `${dailyYield.toFixed(2)}`,
      unit: 'kWh',
      icon: Activity,
      color: '#10B981',
      detail: 'Today only',
    },
    {
      id: 'irradiance',
      label: 'Irradiance',
      value: (latestPoint && isDataFlowing)
        ? `${latestPoint.irr.toFixed(0)}`
        : '—',
      unit: 'W/m²',
      icon: Sun,
      color: '#F59E0B',
      detail: (latestPoint && isDataFlowing) ? 'Solar irradiation' : 'No live stream',
    },
    {
      id: 'temperature',
      label: 'PV Temperature',
      value: (latestPoint && isDataFlowing)
        ? `${latestPoint.pvt.toFixed(1)}`
        : '—',
      unit: '°C',
      icon: ThermometerSun,
      color: '#EF4444',
      detail: (latestPoint && isDataFlowing)
        ? `V1: ${latestPoint.vdc1.toFixed(1)}V | V2: ${latestPoint.vdc2.toFixed(1)}V`
        : 'No live stream',
    },
    {
      id: 'faults',
      label: 'Faults Detected',
      value: kpis ? `${kpis.faultCount.toLocaleString()}` : '—',
      unit: '',
      icon: AlertTriangle,
      color: kpis && kpis.faultCount > 0 ? 'var(--color-critical)' : 'var(--color-warning)',
      detail: 'In selected range',
    },
    {
      id: 'status',
      label: 'System Status',
      value: (() => {
        if (!isDataFlowing) return 'Not Connected';
        if (latestPoint) return FAULT_LABELS[latestPoint.faultLabel ?? 0] || 'Unknown';
        return 'Normal';
      })(),
      unit: '',
      icon: TrendingUp,
      color: (() => {
        if (!isDataFlowing) return '#64748B';
        if (latestPoint) return latestPoint.faultLabel === 0 ? 'var(--color-healthy)' : 'var(--color-critical)';
        return 'var(--color-healthy)';
      })(),
      detail: (() => {
        if (isDataFlowing) return '● Live Stream';
        if (isConnected) return '◐ Waiting for data';
        return '○ Disconnected';
      })(),
    },
  ];


  return (
    <div className="kpi-grid">
      {cards.map((card) => (
        <div key={card.id} className="kpi-card">
          <div className="kpi-header">
            <span className="kpi-label">{card.label}</span>
            <div className="kpi-icon" style={{ color: card.color }}>
              <card.icon size={18} />
            </div>
          </div>
          <div className="kpi-value">
            <span className="kpi-number" style={{ color: card.color }}>{card.value}</span>
            {card.unit && <span className="kpi-unit">{card.unit}</span>}
          </div>
          <div className="kpi-detail">{card.detail}</div>
        </div>
      ))}
    </div>
  );
}
