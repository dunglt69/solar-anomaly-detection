import { db } from '../db/index.js';
import { telemetry } from '../db/schema.js';
import { gte, lte, and, desc, eq, sql } from 'drizzle-orm';
import { FAULT_LABELS } from '../utils/constants.js';

// Re-export FAULT_LABELS for backwards compatibility
export { FAULT_LABELS };

export interface TelemetryInput {
  timestamp: string | number;
  vdc1: number;
  vdc2: number;
  idc1: number;
  idc2: number;
  irr: number;
  pvt: number;
  pdc1?: number;
  pdc2?: number;
  pdcTotal?: number;
  faultLabel?: number;
}

export interface TelemetryRecord {
  id: number;
  timestamp: Date;
  vdc1: number;
  vdc2: number;
  idc1: number;
  idc2: number;
  irr: number;
  pvt: number;
  pdc1: number;
  pdc2: number;
  pdcTotal: number;
  faultLabel: number | null;
}

// ─── Interval config ────────────────────────────────────────────────
// The interval name = view range selector (like TradingView).
// BUCKET_SECONDS = aggregation resolution for smooth chart navigation.
// VIEW_RANGE_SECONDS = how far back to fetch data.
const BUCKET_SECONDS: Record<string, number> = {
  '1h': 30,       // 30s buckets → ~120 points for 1h view
  '6h': 60,       // 1min buckets → ~360 points for 6h view
  '1d': 300,      // 5min buckets → ~288 points for 1d view
  '3d': 900,      // 15min buckets → ~288 points for 3d view
  '1w': 3600,     // 1h buckets → ~168 points for 1w view
};

const VIEW_RANGE_SECONDS: Record<string, number> = {
  '1h': 3600,        // 1 hour
  '6h': 21600,       // 6 hours
  '1d': 86400,       // 1 day
  '3d': 259200,      // 3 days
  '1w': 604800,      // 7 days
};

// ─── Ingest ─────────────────────────────────────────────────────────
export async function ingestTelemetry(batch: TelemetryInput[]): Promise<{ inserted: number }> {
  const rows = batch.map((r) => {
    const ts = typeof r.timestamp === 'string' ? new Date(r.timestamp) : new Date(r.timestamp);
    const pdc1 = r.pdc1 ?? Math.round(r.vdc1 * r.idc1 * 100) / 100;
    const pdc2 = r.pdc2 ?? Math.round(r.vdc2 * r.idc2 * 100) / 100;
    return {
      timestamp: ts,
      vdc1: r.vdc1,
      vdc2: r.vdc2,
      idc1: r.idc1,
      idc2: r.idc2,
      irr: r.irr,
      pvt: r.pvt,
      pdc1,
      pdc2,
      pdcTotal: r.pdcTotal ?? Math.round((pdc1 + pdc2) * 100) / 100,
      faultLabel: r.faultLabel ?? null,
    };
  });

  // Batch insert in chunks of 100
  const CHUNK_SIZE = 100;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    await db.insert(telemetry).values(chunk);
    inserted += chunk.length;
  }

  return { inserted };
}

// ─── Update fault label on most-recent row ──────────────────────────
export async function updateFaultLabel(timestamp: Date, faultLabel: number): Promise<void> {
  await db.update(telemetry)
    .set({ faultLabel })
    .where(eq(telemetry.timestamp, timestamp));
}

// ─── Query: time range ──────────────────────────────────────────────
export interface TelemetryQuery {
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
  downsample?: number;
}

export async function queryTelemetry(q: TelemetryQuery) {
  const conditions = [];
  if (q.from) conditions.push(gte(telemetry.timestamp, new Date(q.from)));
  if (q.to) conditions.push(lte(telemetry.timestamp, new Date(q.to)));

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const limit = Math.min(q.limit || 500, 10000);
  const offset = q.offset || 0;

  const downsample = Math.max(1, q.downsample || 0);
  if (downsample > 1) {
    const rows = await db.select().from(telemetry)
      .where(where ? and(where, sql`${telemetry.id} % ${downsample} = 0`) : sql`${telemetry.id} % ${downsample} = 0`)
      .orderBy(desc(telemetry.timestamp))
      .limit(limit)
      .offset(offset);
    return rows;
  }

  const rows = await db.select().from(telemetry)
    .where(where)
    .orderBy(desc(telemetry.timestamp))
    .limit(limit)
    .offset(offset);

  return rows;
}

// ─── Latest readings ────────────────────────────────────────────────
export async function getLatestTelemetry(n = 1) {
  return db.select().from(telemetry)
    .orderBy(desc(telemetry.timestamp))
    .limit(n);
}

// ─── Aggregated telemetry (interval-based) ──────────────────────────
export interface AggregatedPoint {
  timestamp: number;
  avgPdcTotal: number;
  maxPdcTotal: number;
  minPdcTotal: number;
  avgVdc1: number;
  avgVdc2: number;
  avgIdc1: number;
  avgIdc2: number;
  avgIrr: number;
  avgPvt: number;
  faultCount: number;
  dataPoints: number;
}

export async function getAggregatedTelemetry(
  interval: string = '1h',
  from?: string,
  to?: string,
): Promise<AggregatedPoint[]> {
  const bucketSize = BUCKET_SECONDS[interval] || 60;

  // Safe defaults: parameterised timestamps avoid SQL injection
  const fromTs = from ? Math.floor(new Date(from).getTime() / 1000) : 0;
  const toTs = to ? Math.floor(new Date(to).getTime() / 1000) : Math.floor(Date.now() / 1000) + 86400;
  if (isNaN(fromTs) || isNaN(toTs)) throw new Error('Invalid timestamp');

  // Count rows in this range to see if we should downsample for performance
  const countRes = await db.all(sql`
    SELECT COUNT(*) as count FROM telemetry WHERE "timestamp" >= ${fromTs} AND "timestamp" <= ${toTs}
  `) as any[];
  const totalInQuery = Number(countRes[0]?.count) || 0;

  // We want to limit the raw rows processed to around 15,000 for event-loop safety
  const maxRawRows = 15000;
  const downsample = totalInQuery > maxRawRows ? Math.ceil(totalInQuery / maxRawRows) : 1;

  const whereClause = downsample > 1 
    ? sql`WHERE "timestamp" >= ${fromTs} AND "timestamp" <= ${toTs} AND (id % ${downsample} = 0)`
    : sql`WHERE "timestamp" >= ${fromTs} AND "timestamp" <= ${toTs}`;

  const rows = await db.all(sql`
    SELECT 
      ("timestamp" / ${bucketSize}) * ${bucketSize} as bucket,
      ROUND(AVG(pdc_total), 2) as avgPdcTotal,
      ROUND(MAX(pdc_total), 2) as maxPdcTotal,
      ROUND(MIN(pdc_total), 2) as minPdcTotal,
      ROUND(AVG(vdc1), 2) as avgVdc1,
      ROUND(AVG(vdc2), 2) as avgVdc2,
      ROUND(AVG(idc1), 2) as avgIdc1,
      ROUND(AVG(idc2), 2) as avgIdc2,
      ROUND(AVG(irr), 2) as avgIrr,
      ROUND(AVG(pvt), 1) as avgPvt,
      SUM(CASE WHEN fault_label > 0 THEN 1 ELSE 0 END) as faultCount,
      COUNT(*) as dataPoints
    FROM telemetry
    ${whereClause}
    GROUP BY ("timestamp" / ${bucketSize}) * ${bucketSize}
    ORDER BY bucket ASC
  `) as any[];

  return rows.map((r: any) => ({
    timestamp: r.bucket,
    avgPdcTotal: r.avgPdcTotal || 0,
    maxPdcTotal: r.maxPdcTotal || 0,
    minPdcTotal: r.minPdcTotal || 0,
    avgVdc1: r.avgVdc1 || 0,
    avgVdc2: r.avgVdc2 || 0,
    avgIdc1: r.avgIdc1 || 0,
    avgIdc2: r.avgIdc2 || 0,
    avgIrr: r.avgIrr || 0,
    avgPvt: r.avgPvt || 0,
    faultCount: (Number(r.faultCount) || 0) * downsample,
    dataPoints: r.dataPoints * downsample,
  }));
}

// ─── Data range info ────────────────────────────────────────────────
export async function getDataRange(): Promise<{ minTs: number; maxTs: number; totalPoints: number }> {
  const rows = await db.all(sql`
    SELECT
      MIN("timestamp") as minTs,
      MAX("timestamp") as maxTs,
      COUNT(*) as totalPoints
    FROM telemetry
  `) as any[];

  const result = rows[0];
  return {
    minTs: result?.minTs || 0,
    maxTs: result?.maxTs || 0,
    totalPoints: result?.totalPoints || 0,
  };
}

// ─── KPI summary ────────────────────────────────────────────────────
export async function getTelemetryKPIs(from?: string, to?: string) {
  // Safe defaults: parameterised timestamps avoid SQL injection
  const fromTs = from ? Math.floor(new Date(from).getTime() / 1000) : 0;
  const toTs = to ? Math.floor(new Date(to).getTime() / 1000) : Math.floor(Date.now() / 1000) + 86400;
  if (isNaN(fromTs) || isNaN(toTs)) throw new Error('Invalid timestamp');

  // Count first for exact total records
  const countRes = await db.all(sql`
    SELECT COUNT(*) as count FROM telemetry WHERE "timestamp" >= ${fromTs} AND "timestamp" <= ${toTs}
  `) as any[];
  const totalRecords = Number(countRes[0]?.count) || 0;

  // We want to limit raw rows processed for averages to around 15,000 for speed
  const maxRawRows = 15000;
  const downsample = totalRecords > maxRawRows ? Math.ceil(totalRecords / maxRawRows) : 1;

  const whereClause = downsample > 1
    ? sql`WHERE "timestamp" >= ${fromTs} AND "timestamp" <= ${toTs} AND (id % ${downsample} = 0)`
    : sql`WHERE "timestamp" >= ${fromTs} AND "timestamp" <= ${toTs}`;

  const statsRows = await db.all(sql`
    SELECT
      ROUND(AVG(pdc_total), 2) as avgPower,
      MIN("timestamp") as minTs,
      MAX("timestamp") as maxTs,
      ROUND(AVG(irr), 2) as avgIrr,
      ROUND(AVG(pvt), 2) as avgPvt,
      ROUND(AVG(vdc1), 2) as avgVdc1,
      ROUND(AVG(vdc2), 2) as avgVdc2,
      ROUND(AVG(idc1), 2) as avgIdc1,
      ROUND(AVG(idc2), 2) as avgIdc2
    FROM telemetry
    ${whereClause}
  `) as any[];

  const stats = statsRows[0];

  // Query alerts count in range
  const alertsStatsRows = await db.all(sql`
    SELECT COUNT(*) as alertCount
    FROM alerts
    WHERE "timestamp" >= ${fromTs} AND "timestamp" <= ${toTs}
  `) as any[];
  const faultCount = Number(alertsStatsRows[0]?.alertCount) || 0;

  // Fault distribution
  const faultDist = await db.all(sql`
    SELECT fault_label as faultLabel, COUNT(*) as count
    FROM telemetry
    ${whereClause}
    GROUP BY fault_label
  `) as any[];

  let totalEnergy = 0;
  if (stats?.minTs && stats?.maxTs && stats?.avgPower) {
    const hours = (stats.maxTs - stats.minTs) / 3600;
    totalEnergy = (stats.avgPower * hours) / 1000;
  }

  return {
    totalRecords,
    totalEnergy: Math.round(totalEnergy * 100) / 100,
    avgPower: stats?.avgPower || 0,
    avgIrradiance: stats?.avgIrr || 0,
    avgPvt: stats?.avgPvt || 0,
    avgVdc1: stats?.avgVdc1 || 0,
    avgVdc2: stats?.avgVdc2 || 0,
    avgIdc1: stats?.avgIdc1 || 0,
    avgIdc2: stats?.avgIdc2 || 0,
    faultCount,
    faultDistribution: faultDist.map((d: any) => ({
      label: FAULT_LABELS[d.faultLabel ?? 0] || `Unknown(${d.faultLabel})`,
      code: d.faultLabel,
      count: d.count * downsample,
    })),
  };
}

// ─── Daily Yield (today only) ───────────────────────────────────────
export async function getDailyYieldToday() {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayStartUnix = Math.floor(todayStart.getTime() / 1000);

  const rows = await db.all(sql`
    SELECT
      ROUND(AVG(pdc_total), 2) as avgPower,
      MIN("timestamp") as minTs,
      MAX("timestamp") as maxTs,
      COUNT(*) as dataPoints
    FROM telemetry
    WHERE "timestamp" >= ${todayStartUnix}
  `) as any[];

  const stats = rows[0];
  let energyKwh = 0;
  if (stats?.minTs && stats?.maxTs && stats?.avgPower && stats.dataPoints > 1) {
    const hours = (stats.maxTs - stats.minTs) / 3600;
    energyKwh = (stats.avgPower * hours) / 1000;
  }

  return { energyKwh: Math.round(energyKwh * 100) / 100 };
}
