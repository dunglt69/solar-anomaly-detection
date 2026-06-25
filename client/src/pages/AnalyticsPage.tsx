import { useEffect, useState, useMemo, useCallback } from 'react';
import { useAuthStore } from '../stores/authStore';
import { authFetch } from '../lib/authFetch';
import Chart from '../components/charts/Chart';
import { CHART_THEME } from '../lib/chartConstants';
import type { EChartsOption } from 'echarts';
import './AnalyticsPage.css';

import { API_BASE as API } from '../lib/api';


// ─── Types ──────────────────────────────────────────────────────────
interface DailyEnergy {
  date: string;
  energyKwh: number;
  peakPowerW: number;
  avgIrradiance: number;
  dataPoints: number;
  faultCount: number;
}

interface FaultTrend {
  date: string;
  openCircuit: number;
  degradation: number;
  shortCircuit: number;
  shadowing: number;
  total: number;
}

interface HourlyProfile {
  hour: number;
  avgPower: number;
  avgIrradiance: number;
  avgTemp: number;
}

interface SystemSummary {
  totalEnergyKwh: number;
  totalFaults: number;
  totalAlerts: number;
  alertsByStatus: { new: number; acknowledged: number; resolved: number; escalated: number };
  faultDistribution: Array<{ label: string; code: number | null; count: number }>;
  uptimePercent: number;
  daysWithData: number;
}

type RangeKey = '7d' | '14d' | '30d' | '90d';
const RANGES: { key: RangeKey; label: string; days: number }[] = [
  { key: '7d', label: '7 Days', days: 7 },
  { key: '14d', label: '14 Days', days: 14 },
  { key: '30d', label: '30 Days', days: 30 },
  { key: '90d', label: '90 Days', days: 90 },
];

function getHeaders(): Record<string, string> {
  const token = useAuthStore.getState().accessToken;
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

function getRange(days: number) {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86400000);
  return { from: from.toISOString(), to: to.toISOString() };
}

// ─── Fault distribution colors ──────────────────────────────────────
const FAULT_COLORS: Record<string, string> = {
  Normal: '#64748B',
  'Open Circuit': '#EF4444',
  Degradation: '#F59E0B',
  'Short Circuit': '#DC2626',
  Shadowing: '#8B5CF6',
};

// ═══════════════════════════════════════════════════════════════════
//  ANALYTICS PAGE
// ═══════════════════════════════════════════════════════════════════
export default function AnalyticsPage() {
  const [range, setRange] = useState<RangeKey>('30d');
  const [dailyEnergy, setDailyEnergy] = useState<DailyEnergy[]>([]);
  const [faultTrend, setFaultTrend] = useState<FaultTrend[]>([]);
  const [hourlyProfile, setHourlyProfile] = useState<HourlyProfile[]>([]);
  const [summary, setSummary] = useState<SystemSummary | null>(null);
  const [loading, setLoading] = useState(true);

  const days = RANGES.find((r) => r.key === range)!.days;
  const { from, to } = useMemo(() => getRange(days), [days]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    const params = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const headers = getHeaders();

    try {
      const [energyRes, faultRes, summaryRes, hourlyRes] = await Promise.all([
        authFetch(`${API}/api/v1/analytics/daily-energy?${params}`, { headers }),
        authFetch(`${API}/api/v1/analytics/fault-trend?${params}`, { headers }),
        authFetch(`${API}/api/v1/analytics/summary?${params}`, { headers }),
        authFetch(`${API}/api/v1/analytics/hourly-profile?date=${new Date().toISOString().split('T')[0]}`, { headers }),
      ]);

      if (energyRes.ok) {
        const d = await energyRes.json();
        setDailyEnergy(d.data || []);
      }
      if (faultRes.ok) {
        const d = await faultRes.json();
        setFaultTrend(d.data || []);
      }
      if (summaryRes.ok) {
        const d = await summaryRes.json();
        setSummary(d);
      }
      if (hourlyRes.ok) {
        const d = await hourlyRes.json();
        setHourlyProfile(d.data || []);
      }
    } catch (err) {
      console.error('Analytics fetch error:', err);
    }
    setLoading(false);
  }, [from, to]);

  useEffect(() => {
    const timer = setTimeout(() => {
      fetchData();
    }, 0);
    return () => clearTimeout(timer);
  }, [fetchData]);

  // ─── Chart: Daily Energy Production ───────────────────────────────
  const dailyEnergyOption: EChartsOption = useMemo(() => ({
    ...CHART_THEME,
    title: { show: false },
    tooltip: {
      ...CHART_THEME.tooltip,
      trigger: 'axis',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      formatter: (params: any) => {
        const p = Array.isArray(params) ? params : [params];
        let html = `<b>${p[0]?.axisValue}</b><br/>`;
        for (const item of p) {
          html += `${item.marker} ${item.seriesName}: <b>${item.value}</b><br/>`;
        }
        return html;
      },
    },
    legend: { show: true, top: 5, textStyle: { color: '#94A3B8', fontSize: 11 } },
    grid: { top: 40, right: 50, bottom: 30, left: 55 },
    xAxis: {
      ...CHART_THEME.xAxis,
      type: 'category',
      data: dailyEnergy.map((d) => d.date),
      axisLabel: {
        ...CHART_THEME.xAxis.axisLabel,
        rotate: dailyEnergy.length > 14 ? 45 : 0,
        formatter: (v: string) => v.slice(5), // MM-DD
      },
    },
    yAxis: [
      {
        ...CHART_THEME.yAxis,
        type: 'value',
        name: 'Energy (kWh)',
        nameTextStyle: { color: '#64748B', fontSize: 10 },
      },
      {
        ...CHART_THEME.yAxis,
        type: 'value',
        name: 'Peak (W)',
        nameTextStyle: { color: '#64748B', fontSize: 10 },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: 'Energy (kWh)',
        type: 'bar',
        data: dailyEnergy.map((d) => d.energyKwh),
        itemStyle: {
          color: {
            type: 'linear',
            x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(59, 130, 246, 0.8)' },
              { offset: 1, color: 'rgba(59, 130, 246, 0.2)' },
            ],
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
          borderRadius: [4, 4, 0, 0],
        },
        barMaxWidth: 30,
      },
      {
        name: 'Peak Power (W)',
        type: 'line',
        yAxisIndex: 1,
        data: dailyEnergy.map((d) => d.peakPowerW),
        smooth: true,
        lineStyle: { color: '#F59E0B', width: 2 },
        itemStyle: { color: '#F59E0B' },
        symbol: 'circle',
        symbolSize: 5,
      },
    ],
  }), [dailyEnergy]);

  // ─── Chart: Fault Trend ───────────────────────────────────────────
  const faultTrendOption: EChartsOption = useMemo(() => ({
    ...CHART_THEME,
    title: { show: false },
    tooltip: { ...CHART_THEME.tooltip, trigger: 'axis' },
    legend: { show: true, top: 5, textStyle: { color: '#94A3B8', fontSize: 11 } },
    grid: { top: 40, right: 30, bottom: 30, left: 45 },
    xAxis: {
      ...CHART_THEME.xAxis,
      type: 'category',
      data: faultTrend.map((d) => d.date),
      axisLabel: {
        ...CHART_THEME.xAxis.axisLabel,
        rotate: faultTrend.length > 14 ? 45 : 0,
        formatter: (v: string) => v.slice(5),
      },
    },
    yAxis: {
      ...CHART_THEME.yAxis,
      type: 'value',
      name: 'Faults',
      nameTextStyle: { color: '#64748B', fontSize: 10 },
      minInterval: 1,
    },
    series: [
      {
        name: 'Open Circuit',
        type: 'bar',
        stack: 'faults',
        data: faultTrend.map((d) => d.openCircuit),
        itemStyle: { color: '#EF4444' },
      },
      {
        name: 'Short Circuit',
        type: 'bar',
        stack: 'faults',
        data: faultTrend.map((d) => d.shortCircuit),
        itemStyle: { color: '#DC2626' },
      },
      {
        name: 'Degradation',
        type: 'bar',
        stack: 'faults',
        data: faultTrend.map((d) => d.degradation),
        itemStyle: { color: '#F59E0B' },
      },
      {
        name: 'Shadowing',
        type: 'bar',
        stack: 'faults',
        data: faultTrend.map((d) => d.shadowing),
        itemStyle: { color: '#8B5CF6' },
      },
    ],
  }), [faultTrend]);

  // ─── Chart: Hourly Profile ────────────────────────────────────────
  const hourlyOption: EChartsOption = useMemo(() => {
    const hours = Array.from({ length: 24 }, (_, i) => i);
    const powerData = hours.map((h) => {
      const match = hourlyProfile.find((p) => p.hour === h);
      return match?.avgPower || 0;
    });
    const irrData = hours.map((h) => {
      const match = hourlyProfile.find((p) => p.hour === h);
      return match?.avgIrradiance || 0;
    });

    return {
      ...CHART_THEME,
      title: { show: false },
      tooltip: { ...CHART_THEME.tooltip, trigger: 'axis' },
      legend: { show: true, top: 5, textStyle: { color: '#94A3B8', fontSize: 11 } },
      grid: { top: 40, right: 50, bottom: 30, left: 55 },
      xAxis: {
        ...CHART_THEME.xAxis,
        type: 'category',
        data: hours.map((h) => `${h}:00`),
        axisLabel: {
          ...CHART_THEME.xAxis.axisLabel,
          interval: 1,
        },
      },
      yAxis: [
        {
          ...CHART_THEME.yAxis,
          type: 'value',
          name: 'Power (W)',
          nameTextStyle: { color: '#64748B', fontSize: 10 },
        },
        {
          ...CHART_THEME.yAxis,
          type: 'value',
          name: 'Irr (W/m²)',
          nameTextStyle: { color: '#64748B', fontSize: 10 },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: 'Avg Power',
          type: 'bar',
          data: powerData,
          itemStyle: {
            color: {
              type: 'linear',
              x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(34, 197, 94, 0.7)' },
                { offset: 1, color: 'rgba(34, 197, 94, 0.15)' },
              ],
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any,
            borderRadius: [3, 3, 0, 0],
          },
          barMaxWidth: 18,
        },
        {
          name: 'Irradiance',
          type: 'line',
          yAxisIndex: 1,
          data: irrData,
          smooth: true,
          lineStyle: { color: '#F97316', width: 2 },
          itemStyle: { color: '#F97316' },
          areaStyle: { color: 'rgba(249, 115, 22, 0.08)' },
          symbol: 'none',
        },
      ],
    };
  }, [hourlyProfile]);

  // ─── Chart: Fault Distribution Pie ────────────────────────────────
  const faultPieOption: EChartsOption = useMemo(() => {
    if (!summary) return {};
    const faults = summary.faultDistribution.filter((d) => d.label !== 'Normal');
    if (faults.length === 0) return {};

    return {
      ...CHART_THEME,
      tooltip: {
        ...CHART_THEME.tooltip,
        trigger: 'item',
        formatter: '{b}: {c} ({d}%)',
      },
      series: [{
        type: 'pie',
        radius: ['45%', '75%'],
        center: ['50%', '50%'],
        avoidLabelOverlap: true,
        itemStyle: { borderRadius: 6, borderColor: '#0F172A', borderWidth: 2 },
        label: { show: false },
        data: faults.map((d) => ({
          name: d.label,
          value: d.count,
          itemStyle: { color: FAULT_COLORS[d.label] || '#64748B' },
        })),
      }],
    };
  }, [summary]);

  // Alert status colors
  const STATUS_COLORS: Record<string, string> = {
    new: '#F59E0B',
    acknowledged: '#3B82F6',
    resolved: '#22C55E',
    escalated: '#EF4444',
  };

  const faultsOnly = summary?.faultDistribution.filter((d) => d.label !== 'Normal') || [];

  return (
    <div className="analytics-page">
      <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 700, color: 'var(--color-text-primary)' }}>
        System Analytics
      </h1>

      {/* Range selector */}
      <div className="analytics-toolbar">
        <div className="analytics-range-group">
          {RANGES.map((r) => (
            <button
              key={r.key}
              className={range === r.key ? 'active' : ''}
              onClick={() => setRange(r.key)}
            >
              {r.label}
            </button>
          ))}
        </div>
        <span className="toolbar-info">
          {dailyEnergy.length} day(s)
        </span>
      </div>

      {loading ? (
        <div className="analytics-loading">Loading analytics data...</div>
      ) : (
        <>
          {/* Summary cards */}
          <div className="analytics-summary">
            <div className="summary-card">
              <div className="card-label">Total Energy</div>
              <div className="card-value energy">
                {summary?.totalEnergyKwh.toFixed(2) || '0.00'}
                <span className="card-unit">kWh</span>
              </div>
              <div className="card-sub">over {days} days</div>
            </div>
            <div className="summary-card">
              <div className="card-label">System Uptime</div>
              <div className="card-value uptime">
                {summary?.uptimePercent.toFixed(2) || '100.00'}
                <span className="card-unit">%</span>
              </div>
              <div className="card-sub">fault-free readings ratio</div>
            </div>
            <div className="summary-card">
              <div className="card-label">Total Faults</div>
              <div className="card-value faults">
                {summary?.totalFaults || 0}
              </div>
              <div className="card-sub">{summary?.totalAlerts || 0} alerts generated</div>
            </div>
          </div>

          {/* Charts Row 1: Energy + Fault Trend */}
          <div className="analytics-charts">
            <div className="chart-card span-2">
              <h3><span className="chart-icon">⚡</span> Daily Energy Production</h3>
              {dailyEnergy.length > 0 ? (
                <Chart option={dailyEnergyOption} height={320} />
              ) : (
                <div className="analytics-empty">
                  <div className="empty-icon">📊</div>
                  <p>No energy data for this period</p>
                </div>
              )}
            </div>
          </div>

          <div className="analytics-charts">
            {/* Fault trend */}
            <div className="chart-card">
              <h3><span className="chart-icon">⚠️</span> Fault Trend</h3>
              {faultTrend.length > 0 ? (
                <Chart option={faultTrendOption} height={280} />
              ) : (
                <div className="analytics-empty">
                  <p style={{ fontSize: 'var(--text-sm)' }}>No faults in this period ✅</p>
                </div>
              )}
            </div>

            {/* Fault distribution */}
            <div className="chart-card">
              <h3><span className="chart-icon">🔍</span> Fault Distribution</h3>
              {faultsOnly.length > 0 ? (
                <div className="fault-distribution-grid">
                  <Chart option={faultPieOption} height={220} />
                  <div className="fault-legend">
                    {faultsOnly.map((d) => (
                      <div key={d.label} className="fault-legend-item">
                        <div
                          className="fault-legend-dot"
                          style={{ background: FAULT_COLORS[d.label] || '#64748B' }}
                        />
                        <span className="fault-legend-label">{d.label}</span>
                        <span className="fault-legend-count">{d.count}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="analytics-empty">
                  <p style={{ fontSize: 'var(--text-sm)' }}>All readings normal ✅</p>
                </div>
              )}
            </div>
          </div>

          {/* Charts Row 2: Hourly Profile + Alert Breakdown */}
          <div className="analytics-charts">
            <div className="chart-card">
              <h3><span className="chart-icon">🕐</span> Today's Hourly Profile</h3>
              <Chart option={hourlyOption} height={280} />
            </div>

            <div className="chart-card">
              <h3><span className="chart-icon">📈</span> Fault Severity Analysis</h3>
              {summary && summary.totalAlerts > 0 ? (
                <div className="severity-analysis">
                  <div className="severity-metrics">
                    <div className="severity-metric">
                      <span className="metric-value" style={{ color: '#EF4444' }}>
                        {summary.totalAlerts > 0
                          ? `${(((summary.alertsByStatus.escalated || 0) / summary.totalAlerts) * 100).toFixed(1)}%`
                          : '0%'}
                      </span>
                      <span className="metric-label">Escalation Rate</span>
                    </div>
                    <div className="severity-metric">
                      <span className="metric-value" style={{ color: '#3B82F6' }}>
                        {summary.daysWithData > 0
                          ? (summary.totalFaults / summary.daysWithData).toFixed(1)
                          : '0'}
                      </span>
                      <span className="metric-label">Avg Faults/Day</span>
                    </div>
                    <div className="severity-metric">
                      <span className="metric-value" style={{ color: '#EF4444' }}>
                        {summary.alertsByStatus.escalated || 0}
                      </span>
                      <span className="metric-label">Escalated</span>
                    </div>
                  </div>
                  <div className="severity-bar">
                    {Object.entries(summary.alertsByStatus).map(([status, count]) => {
                      const pct = (count / summary.totalAlerts) * 100;
                      if (pct === 0) return null;
                      return (
                        <div
                          key={status}
                          className="severity-bar-segment"
                          style={{
                            width: `${pct}%`,
                            background: STATUS_COLORS[status] || '#64748B',
                          }}
                          title={`${status}: ${count} (${pct.toFixed(0)}%)`}
                        />
                      );
                    })}
                  </div>
                  <div className="severity-legend">
                    {Object.entries(summary.alertsByStatus).map(([status, count]) => (
                      <span key={status} className="severity-legend-item">
                        <span className="severity-legend-dot" style={{ background: STATUS_COLORS[status] || '#64748B' }} />
                        {status} ({count})
                      </span>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="analytics-empty">
                  <p style={{ fontSize: 'var(--text-sm)' }}>No alerts in this period ✅</p>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
