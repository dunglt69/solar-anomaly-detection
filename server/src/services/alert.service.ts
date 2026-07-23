import { db } from '../db/index.js';
import { alerts, tickets, config } from '../db/schema.js';
import { eq, desc, sql, count, and, gte, lte, or } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { DetectionResult } from './detection.service.js';
import { FAULT_LABELS } from '../utils/constants.js';

// Re-export FAULT_LABELS for backwards compatibility
export { FAULT_LABELS };

// ─── Config cache with TTL ──────────────────────────────────────────
const configCache = new Map<string, { value: unknown; expiresAt: number }>();
const CONFIG_CACHE_TTL = 60_000; // 60 seconds

function getCachedConfig(key: string): unknown | undefined {
  const entry = configCache.get(key);
  if (entry && Date.now() < entry.expiresAt) return entry.value;
  configCache.delete(key);
  return undefined;
}

function setCachedConfig(key: string, value: unknown): void {
  configCache.set(key, { value, expiresAt: Date.now() + CONFIG_CACHE_TTL });
}

// ─── Severity mapping ───────────────────────────────────────────────
const FAULT_SEVERITY: Record<number, 'info' | 'warning' | 'critical' | 'emergency'> = {
  0: 'info',
  1: 'emergency',   // Short-Circuit — safety hazard
  2: 'warning',     // Degradation — gradual performance loss
  3: 'critical',    // Open Circuit — total loss of power
  4: 'warning',     // Shadowing — partial obstruction
};

const DEFAULT_COOLDOWN_MINUTES = 5;

// ─── Config helpers ──
async function getConfigNumber(key: string, field: string, fallback: number): Promise<number> {
  const cached = getCachedConfig(`${key}:${field}:number`);
  if (cached !== undefined) return cached as number;
  try {
    const [row] = await db.select({ value: config.value }).from(config).where(eq(config.key, key)).limit(1);
    if (row?.value != null) {
      if (typeof row.value === 'number' && isFinite(row.value)) {
        setCachedConfig(`${key}:${field}:number`, row.value);
        return row.value;
      }
      if (typeof row.value === 'object' && row.value !== null && field in (row.value as object)) {
        const v = Number((row.value as Record<string, unknown>)[field]);
        if (isFinite(v)) {
          setCachedConfig(`${key}:${field}:number`, v);
          return v;
        }
      }
    }
  } catch { /* use fallback */ }
  setCachedConfig(`${key}:${field}:number`, fallback);
  return fallback;
}

async function getConfigBoolean(key: string, fallback = false): Promise<boolean> {
  const cached = getCachedConfig(`${key}:boolean`);
  if (cached !== undefined) return cached as boolean;
  try {
    const [row] = await db.select({ value: config.value }).from(config).where(eq(config.key, key)).limit(1);
    if (row?.value === true || row?.value === false) {
      setCachedConfig(`${key}:boolean`, row.value);
      return row.value;
    }
    if (typeof row?.value === 'string') {
      const v = row.value === 'true';
      setCachedConfig(`${key}:boolean`, v);
      return v;
    }
    if (row?.value && typeof row.value === 'object' && 'enabled' in (row.value as object)) {
      const v = Boolean((row.value as Record<string, unknown>).enabled);
      setCachedConfig(`${key}:boolean`, v);
      return v;
    }
  } catch { /* use fallback */ }
  setCachedConfig(`${key}:boolean`, fallback);
  return fallback;
}

async function getConfigString(key: string, fallback = ''): Promise<string> {
  const cached = getCachedConfig(`${key}:string`);
  if (cached !== undefined) return cached as string;
  try {
    const [row] = await db.select({ value: config.value }).from(config).where(eq(config.key, key)).limit(1);
    if (row?.value !== undefined && row?.value !== null) {
      if (typeof row.value === 'string') {
        setCachedConfig(`${key}:string`, row.value);
        return row.value;
      }
      if (typeof row.value === 'object') {
        if ('email' in (row.value as object)) {
          const v = String((row.value as Record<string, unknown>).email);
          setCachedConfig(`${key}:string`, v);
          return v;
        }
        const v = JSON.stringify(row.value);
        setCachedConfig(`${key}:string`, v);
        return v;
      }
      const v = String(row.value);
      setCachedConfig(`${key}:string`, v);
      return v;
    }
  } catch { /* use fallback */ }
  setCachedConfig(`${key}:string`, fallback);
  return fallback;
}

// ─── Generate incident ID ───────────────────────────────────────────
function generateIncidentId(): string {
  const year = new Date().getFullYear();
  const seq = nanoid(8);
  return `INC-${year}-${seq}`;
}

// ─── Process detection result from AI pipeline ──────────────
export async function processDetectionResult(
  detection: DetectionResult,
  timestamp: Date,
  readings: { vdc1: number; vdc2: number; idc1: number; idc2: number; pdcTotal: number; irr: number }
) {
  if (!detection.faultDetected) return null;

  // Maintenance mode: still ingest telemetry, but suppress new alerts/tickets
  if (await getConfigBoolean('maintenance_mode', false)) {
    return null;
  }

  // Cooldown: suppress duplicate alerts of the same fault type within N minutes
  const cooldownMin = await getConfigNumber('alert_cooldown_minutes', 'minutes', DEFAULT_COOLDOWN_MINUTES);
  if (cooldownMin > 0) {
    const since = new Date(timestamp.getTime() - cooldownMin * 60_000);
    const [recent] = await db.select({ id: alerts.id })
      .from(alerts)
      .where(and(
        eq(alerts.faultType, detection.faultLabel),
        gte(alerts.timestamp, since),
      ))
      .limit(1);
    if (recent) return null;
  }

  const severity = FAULT_SEVERITY[detection.faultLabel] || 'warning';
  const alertId = nanoid();
  const faultName = detection.faultName;
  const detectionLayer = detection.detectionLayer === 'rule' ? 'rule' as const : 'ai' as const;
  const autoAckInfo = severity === 'info' && await getConfigBoolean('auto_acknowledge_info', false);

  const result = await db.transaction(async (tx) => {
    await tx.insert(alerts).values({
      id: alertId,
      timestamp,
      severity,
      faultType: detection.faultLabel,
      confidence: detection.confidence,
      detectionLayer,
      telemetryId: null,
      acknowledged: autoAckInfo,
      acknowledgedAt: autoAckInfo ? timestamp : null,
    });

    const ticketId = generateIncidentId();
    const layerLabel = detectionLayer === 'rule' ? 'Rule-based fallback' : 'AI InceptionTime';
    const detectionInfo = `${layerLabel} (${(detection.confidence * 100).toFixed(1)}% confidence)`;

    await tx.insert(tickets).values({
      id: ticketId,
      status: autoAckInfo ? 'acknowledged' : 'open',
      severity,
      faultType: detection.faultLabel,
      affectedComponent: 'DC Strings 1 & 2',
      title: `${faultName} Detected — ${readings.pdcTotal.toFixed(0)}W @ ${readings.irr.toFixed(0)} W/m²`,
      description: `Fault detection triggered.\n\n` +
        `**Fault Type:** ${faultName} (Label ${detection.faultLabel})\n` +
        `**Severity:** ${severity.toUpperCase()}\n` +
        `**Confidence:** ${(detection.confidence * 100).toFixed(1)}%\n` +
        `**Detection:** ${detectionInfo}\n` +
        `**Details:** ${detection.details}\n` +
        `**String 1:** V1=${readings.vdc1.toFixed(1)}V, I1=${readings.idc1.toFixed(2)}A\n` +
        `**String 2:** V2=${readings.vdc2.toFixed(1)}V, I2=${readings.idc2.toFixed(2)}A\n` +
        `**Total Power:** ${readings.pdcTotal.toFixed(1)}W\n` +
        `**Irradiance:** ${readings.irr.toFixed(1)} W/m²\n` +
        `**Timestamp:** ${timestamp.toISOString()}`,
      alertId,
      createdBy: null,
    });

    await tx.update(alerts).set({ ticketId }).where(eq(alerts.id, alertId));

    return { ticketId, detectionInfo };
  });

  const email = await getConfigString('notification_email', '');
  if (email) {
    console.log(`[Email Alert Simulation] Sending email to ${email} - Alert ID: ${alertId}, Severity: ${severity.toUpperCase()}, Fault: ${faultName}`);
  }

  return { alertId, ticketId: result.ticketId, severity, faultName, detectionLayer, confidence: detection.confidence };
}

// ─── Query alerts ───────────────────────────────────────────────────
export interface AlertQuery {
  from?: string;
  to?: string;
  severity?: string;
  acknowledged?: string; // 'true' | 'false'
  status?: string;
  limit?: number;
  offset?: number;
}

export async function queryAlerts(q: AlertQuery) {
  const conditions = [];
  if (q.from) conditions.push(gte(alerts.timestamp, new Date(q.from)));
  if (q.to) conditions.push(lte(alerts.timestamp, new Date(q.to)));
  if (q.severity) conditions.push(eq(alerts.severity, q.severity as typeof alerts.severity.enumValues[number]));
  if (q.acknowledged === 'true') conditions.push(eq(alerts.acknowledged, true));
  if (q.acknowledged === 'false') conditions.push(eq(alerts.acknowledged, false));

  if (q.status) {
    if (q.status === 'new') {
      conditions.push(eq(alerts.acknowledged, false));
    } else if (q.status === 'acknowledged') {
      conditions.push(eq(alerts.acknowledged, true));
      conditions.push(
        and(
          sql`${tickets.id} IS NOT NULL`,
          or(eq(tickets.status, 'acknowledged'), eq(tickets.status, 'in_progress'))
        )
      );
    } else if (q.status === 'escalated') {
      conditions.push(
        and(
          sql`${tickets.id} IS NOT NULL`,
          eq(tickets.status, 'escalated')
        )
      );
    } else if (q.status === 'resolved') {
      conditions.push(
        and(
          sql`${tickets.id} IS NOT NULL`,
          or(eq(tickets.status, 'resolved'), eq(tickets.status, 'closed'))
        )
      );
    }
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const limit = Math.min(q.limit || 50, 200);
  const offset = q.offset || 0;

  const rows = await db.select({
    id: alerts.id,
    timestamp: alerts.timestamp,
    severity: alerts.severity,
    faultType: alerts.faultType,
    confidence: alerts.confidence,
    detectionLayer: alerts.detectionLayer,
    telemetryId: alerts.telemetryId,
    acknowledged: alerts.acknowledged,
    acknowledgedBy: alerts.acknowledgedBy,
    acknowledgedAt: alerts.acknowledgedAt,
    ticketId: alerts.ticketId,
    ticketStatus: tickets.status,
  })
  .from(alerts)
  .leftJoin(tickets, eq(alerts.ticketId, tickets.id))
  .where(where)
  .orderBy(desc(alerts.timestamp))
  .limit(limit)
  .offset(offset);

  const [total] = await db.select({ count: count() })
    .from(alerts)
    .leftJoin(tickets, eq(alerts.ticketId, tickets.id))
    .where(where);

  return { data: rows, total: total?.count || 0 };
}

// ─── Acknowledge alert ──────────────────────────────────────────────
export async function acknowledgeAlert(alertId: string, userId: string): Promise<boolean> {
  const updatedAlerts = await db.update(alerts)
    .set({
      acknowledged: true,
      acknowledgedBy: userId,
      acknowledgedAt: new Date(),
    })
    .where(
      and(
        eq(alerts.id, alertId),
        eq(alerts.acknowledged, false)
      )
    )
    .returning({ id: alerts.id, ticketId: alerts.ticketId });

  if (updatedAlerts.length === 0) {
    return false;
  }

  const alert = updatedAlerts[0];
  if (alert && alert.ticketId) {
    await db.update(tickets)
      .set({
        status: 'acknowledged',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(tickets.id, alert.ticketId),
          eq(tickets.status, 'open')
        )
      );
  }

  return true;
}

// ─── Resolve alert (New → Acknowledged → Resolved) ─────────────────
export async function resolveAlert(alertId: string, userId: string): Promise<boolean> {
  const [alert] = await db.select({
    ticketId: alerts.ticketId,
    acknowledged: alerts.acknowledged,
    acknowledgedBy: alerts.acknowledgedBy,
  })
    .from(alerts)
    .where(eq(alerts.id, alertId));

  if (!alert) {
    throw new Error('Alert not found');
  }

  if (alert.ticketId) {
    const updatedTickets = await db.update(tickets)
      .set({
        status: 'resolved',
        resolvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(tickets.id, alert.ticketId),
          sql`${tickets.status} NOT IN ('resolved', 'closed')`
        )
      )
      .returning({ id: tickets.id });

    if (updatedTickets.length === 0) {
      return false;
    }
  }

  const updateData: Record<string, unknown> = {
    acknowledged: true,
    acknowledgedAt: new Date(),
  };
  if (!alert.acknowledgedBy) {
    updateData.acknowledgedBy = userId;
  }

  await db.update(alerts)
    .set(updateData)
    .where(eq(alerts.id, alertId));

  return true;
}

// ─── Alert stats ────────────────────────────────────────────────────
export async function getAlertStats() {
  const result = await db.all(sql`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN a.acknowledged = 0 THEN 1 ELSE 0 END) AS unacknowledged,
      SUM(CASE WHEN a.severity IN ('critical', 'emergency') THEN 1 ELSE 0 END) AS critical
    FROM ${alerts} a
    LEFT JOIN ${tickets} t ON a.ticket_id = t.id
    WHERE t.status IS NULL OR t.status NOT IN ('resolved', 'closed')
  `);

  const row = (result as any)[0] ?? {};
  return {
    total: Number(row.total ?? 0),
    unacknowledged: Number(row.unacknowledged ?? 0),
    critical: Number(row.critical ?? 0),
  };
}
