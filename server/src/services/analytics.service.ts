import { db } from '../db/index.js';
import { alerts, tickets } from '../db/schema.js';
import { gte, lte, and, sql, count, eq } from 'drizzle-orm';
import { FAULT_LABELS } from './telemetry.service.js';

// ─── Daily energy production ────────────────────────────────────────
export interface DailyEnergy {
  date: string;       // YYYY-MM-DD
  energyKwh: number;  // kWh produced that day
  peakPowerW: number; // max power that day
  avgIrradiance: number;
  dataPoints: number;
  faultCount: number;
}

export async function getDailyEnergy(from?: string, to?: string): Promise<DailyEnergy[]> {
  // Safe defaults: parameterised timestamps avoid SQL injection
  const fromTs = from ? Math.floor(new Date(from).getTime() / 1000) : 0;
  const toTs = to ? Math.floor(new Date(to).getTime() / 1000) : Math.floor(Date.now() / 1000) + 86400;
  if (isNaN(fromTs) || isNaN(toTs)) throw new Error('Invalid timestamp');

  const rows = await db.all(sql`
    SELECT
      DATE("timestamp", 'unixepoch', 'localtime') as date,
      ROUND(AVG(pdc_total), 2) as avgPower,
      ROUND(MAX(pdc_total), 2) as maxPower,
      ROUND(AVG(irr), 2) as avgIrr,
      COUNT(*) as dataPoints,
      SUM(CASE WHEN fault_label > 0 THEN 1 ELSE 0 END) as faultCount,
      MIN("timestamp") as minTs,
      MAX("timestamp") as maxTs
    FROM telemetry
    WHERE "timestamp" >= ${fromTs} AND "timestamp" <= ${toTs}
    GROUP BY DATE("timestamp", 'unixepoch', 'localtime')
    ORDER BY DATE("timestamp", 'unixepoch', 'localtime')
  `) as any[];

  return rows.map((r: any) => {
    // minTs/maxTs are in seconds
    const hours = Math.max((r.maxTs - r.minTs) / 3600, 0);
    const energyKwh = (r.avgPower * hours) / 1000;

    return {
      date: r.date,
      energyKwh: Math.round(energyKwh * 100) / 100,
      peakPowerW: r.maxPower || 0,
      avgIrradiance: r.avgIrr || 0,
      dataPoints: r.dataPoints,
      faultCount: Number(r.faultCount) || 0,
    };
  });
}

// ─── Hourly power profile (for a single day) ───────────────────────
export interface HourlyProfile {
  hour: number;   // 0-23
  avgPower: number;
  avgIrradiance: number;
  avgTemp: number;
}

export async function getHourlyProfile(date: string): Promise<HourlyProfile[]> {
  const dayStart = new Date(`${date}T00:00:00`);
  const dayEnd = new Date(`${date}T23:59:59`);
  const dayStartUnix = Math.floor(dayStart.getTime() / 1000);
  const dayEndUnix = Math.floor(dayEnd.getTime() / 1000);
  if (isNaN(dayStartUnix) || isNaN(dayEndUnix)) throw new Error('Invalid date');

  const rows = await db.all(sql`
    SELECT
      CAST(strftime('%H', "timestamp", 'unixepoch', 'localtime') AS INTEGER) as hour,
      ROUND(AVG(pdc_total), 2) as avgPower,
      ROUND(AVG(irr), 2) as avgIrr,
      ROUND(AVG(pvt), 1) as avgTemp
    FROM telemetry
    WHERE "timestamp" >= ${dayStartUnix} AND "timestamp" <= ${dayEndUnix}
    GROUP BY strftime('%H', "timestamp", 'unixepoch', 'localtime')
    ORDER BY CAST(strftime('%H', "timestamp", 'unixepoch', 'localtime') AS INTEGER)
  `) as any[];

  return rows.map((r: any) => ({
    hour: r.hour,
    avgPower: r.avgPower || 0,
    avgIrradiance: r.avgIrr || 0,
    avgTemp: r.avgTemp || 0,
  }));
}

// ─── Fault distribution over time ───────────────────────────────────
export interface FaultTrend {
  date: string;
  openCircuit: number;
  degradation: number;
  shortCircuit: number;
  shadowing: number;
  total: number;
}

export async function getFaultTrend(from?: string, to?: string): Promise<FaultTrend[]> {
  // Safe defaults: parameterised timestamps avoid SQL injection
  const fromTs = from ? Math.floor(new Date(from).getTime() / 1000) : 0;
  const toTs = to ? Math.floor(new Date(to).getTime() / 1000) : Math.floor(Date.now() / 1000) + 86400;
  if (isNaN(fromTs) || isNaN(toTs)) throw new Error('Invalid timestamp');

  const rows = await db.all(sql`
    SELECT
      DATE(timestamp, 'unixepoch', 'localtime') as date,
      SUM(CASE WHEN fault_type = 1 THEN 1 ELSE 0 END) as shortCircuit,
      SUM(CASE WHEN fault_type = 2 THEN 1 ELSE 0 END) as degradation,
      SUM(CASE WHEN fault_type = 3 THEN 1 ELSE 0 END) as openCircuit,
      SUM(CASE WHEN fault_type = 4 THEN 1 ELSE 0 END) as shadowing,
      COUNT(*) as total
    FROM alerts
    WHERE timestamp >= ${fromTs} AND timestamp <= ${toTs}
    GROUP BY DATE(timestamp, 'unixepoch', 'localtime')
    ORDER BY DATE(timestamp, 'unixepoch', 'localtime')
  `) as any[];

  return rows.map((r: any) => ({
    date: r.date,
    openCircuit: Number(r.openCircuit) || 0,
    degradation: Number(r.degradation) || 0,
    shortCircuit: Number(r.shortCircuit) || 0,
    shadowing: Number(r.shadowing) || 0,
    total: r.total,
  }));
}

// ─── System overview summary ────────────────────────────────────────
export interface SystemSummary {
  totalEnergyKwh: number;
  totalFaults: number;
  totalAlerts: number;
  alertsByStatus: { new: number; acknowledged: number; resolved: number; escalated: number };
  faultDistribution: Array<{ label: string; code: number | null; count: number }>;
  uptimePercent: number;
  daysWithData: number;
}

export async function getSystemSummary(from?: string, to?: string): Promise<SystemSummary> {
  // Safe defaults: parameterised timestamps avoid SQL injection
  const fromTs = from ? Math.floor(new Date(from).getTime() / 1000) : 0;
  const toTs = to ? Math.floor(new Date(to).getTime() / 1000) : Math.floor(Date.now() / 1000) + 86400;
  if (isNaN(fromTs) || isNaN(toTs)) throw new Error('Invalid timestamp');

  // Telemetry stats via parameterised sql tagged template
  const telStatsRows = await db.all(sql`
    SELECT
      COUNT(*) as totalRecords,
      ROUND(AVG(pdc_total), 2) as avgPower,
      SUM(CASE WHEN fault_label > 0 THEN 1 ELSE 0 END) as faultCount,
      MIN("timestamp") as minTs,
      MAX("timestamp") as maxTs,
      COUNT(DISTINCT DATE("timestamp", 'unixepoch', 'localtime')) as daysWithData
    FROM telemetry
    WHERE "timestamp" >= ${fromTs} AND "timestamp" <= ${toTs}
  `) as any[];
  const telStats = telStatsRows[0];

  // Fault distribution computed from alerts (incidents)
  const faultDist = await db.all(sql`
    SELECT fault_type as faultLabel, COUNT(*) as count
    FROM alerts
    WHERE timestamp >= ${fromTs} AND timestamp <= ${toTs}
    GROUP BY fault_type
  `) as any[];

  // Alert count by status (linking to ticket status and wasEscalated flag)
  const alertConditions = [];
  if (from) alertConditions.push(gte(alerts.timestamp, new Date(from)));
  if (to) alertConditions.push(lte(alerts.timestamp, new Date(to)));
  const alertWhere = alertConditions.length > 0 ? and(...alertConditions) : undefined;

  const alertRows = await db.select({
    acknowledged: alerts.acknowledged,
    ticketStatus: tickets.status,
    wasEscalated: tickets.wasEscalated,
    count: count(),
  })
  .from(alerts)
  .leftJoin(tickets, eq(alerts.ticketId, tickets.id))
  .where(alertWhere)
  .groupBy(alerts.acknowledged, tickets.status, tickets.wasEscalated);

  const alertsByStatus = { new: 0, acknowledged: 0, resolved: 0, escalated: 0 };
  for (const r of alertRows) {
    const status = r.ticketStatus;
    const wasEscalated = r.wasEscalated === true;

    if (wasEscalated || status === 'escalated') {
      alertsByStatus.escalated += r.count;
    } else if (status === 'resolved' || status === 'closed') {
      alertsByStatus.resolved += r.count;
    } else if (r.acknowledged) {
      alertsByStatus.acknowledged += r.count;
    } else {
      alertsByStatus.new += r.count;
    }
  }

  const totalAlerts = alertsByStatus.new + alertsByStatus.acknowledged + alertsByStatus.resolved + alertsByStatus.escalated;

  // Energy calculation (timestamps are in seconds — raw integers)
  let totalEnergyKwh = 0;
  if (telStats?.minTs && telStats?.maxTs && telStats?.avgPower) {
    const hours = (telStats.maxTs - telStats.minTs) / 3600;
    totalEnergyKwh = (telStats.avgPower * hours) / 1000;
  }

  const totalRecords = telStats?.totalRecords || 0;
  const telemetryFaultCount = Number(telStats?.faultCount) || 0;
  const uptimePercent = totalRecords > 0
    ? Math.round(((totalRecords - telemetryFaultCount) / totalRecords) * 10000) / 100
    : 100;

  return {
    totalEnergyKwh: Math.round(totalEnergyKwh * 100) / 100,
    totalFaults: totalAlerts, // Total faults is now equal to total alerts (incidents)
    totalAlerts,
    alertsByStatus,
    faultDistribution: faultDist.map((d: any) => ({
      label: FAULT_LABELS[d.faultLabel ?? 0] || `Unknown(${d.faultLabel})`,
      code: d.faultLabel,
      count: d.count,
    })),
    uptimePercent,
    daysWithData: Number(telStats?.daysWithData) || 0,
  };
}
