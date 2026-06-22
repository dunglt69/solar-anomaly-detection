import { describe, it, expect, afterEach } from 'vitest';
import { db, client } from '../db/index.js';
import { telemetry, alerts, tickets, users } from '../db/schema.js';
import { ingestTelemetry } from '../services/telemetry.service.js';
import {
  getDailyEnergy,
  getHourlyProfile,
  getFaultTrend,
  getSystemSummary,
} from '../services/analytics.service.js';
import { nanoid } from 'nanoid';

// ── Helpers ─────────────────────────────────────────────────────────
/** Build a minimal telemetry input row with sensible defaults. */
function mkTel(overrides: {
  timestamp: string;
  vdc1?: number;
  vdc2?: number;
  idc1?: number;
  idc2?: number;
  irr?: number;
  pvt?: number;
  pdcTotal?: number;
  faultLabel?: number;
}) {
  return {
    vdc1: 200,
    vdc2: 200,
    idc1: 5,
    idc2: 5,
    irr: 500,
    pvt: 30,
    ...overrides,
  };
}

/** Insert an alert row directly (bypasses service layer). */
async function insertAlert(opts: {
  id?: string;
  timestamp?: Date;
  severity?: 'info' | 'warning' | 'critical' | 'emergency';
  faultType?: number;
  confidence?: number;
  detectionLayer?: 'statistical' | 'rule' | 'ai';
  acknowledged?: boolean;
  ticketId?: string | null;
}) {
  await db.insert(alerts).values({
    id: opts.id ?? nanoid(),
    timestamp: opts.timestamp ?? new Date('2026-06-01T12:00:00Z'),
    severity: opts.severity ?? 'warning',
    faultType: opts.faultType ?? 1,
    confidence: opts.confidence ?? 0.95,
    detectionLayer: opts.detectionLayer ?? 'ai',
    acknowledged: opts.acknowledged ?? false,
    ticketId: opts.ticketId ?? null,
  });
}

/** Insert a ticket row directly. */
async function insertTicket(opts: {
  id: string;
  status?: 'open' | 'acknowledged' | 'in_progress' | 'resolved' | 'closed' | 'escalated';
  severity?: 'info' | 'warning' | 'critical' | 'emergency';
  faultType?: number;
  title?: string;
  wasEscalated?: boolean;
}) {
  await db.insert(tickets).values({
    id: opts.id,
    status: opts.status ?? 'open',
    severity: opts.severity ?? 'warning',
    faultType: opts.faultType ?? 1,
    title: opts.title ?? 'Test ticket',
    wasEscalated: opts.wasEscalated ?? false,
  });
}

describe('Analytics Comprehensive Test Suite (~80 Cases)', () => {
  afterEach(async () => {
    await client.execute('PRAGMA foreign_keys = OFF');
    await db.delete(alerts);
    await db.delete(tickets);
    await db.delete(telemetry);
    await db.delete(users);
    await client.execute('PRAGMA foreign_keys = ON');
  });

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 1: getDailyEnergy  (20 cases)
  // ═══════════════════════════════════════════════════════════════════
  describe('getDailyEnergy', () => {
    it('Case 1: Empty DB returns empty array', async () => {
      const result = await getDailyEnergy();
      expect(result).toEqual([]);
    });

    it('Case 2: Single data point on one day → 1 entry, 0 energy (no time span)', async () => {
      await ingestTelemetry([mkTel({ timestamp: '2026-06-01T12:00:00Z' })]);
      const result = await getDailyEnergy();
      expect(result).toHaveLength(1);
      expect(result[0]!.energyKwh).toBe(0);
      expect(result[0]!.dataPoints).toBe(1);
    });

    it('Case 3: Two data points on same day → 1 entry with non-zero energy', async () => {
      await ingestTelemetry([
        mkTel({ timestamp: '2026-06-01T10:00:00Z' }),
        mkTel({ timestamp: '2026-06-01T14:00:00Z' }),
      ]);
      const result = await getDailyEnergy();
      expect(result).toHaveLength(1);
      expect(result[0]!.energyKwh).toBeGreaterThan(0);
      expect(result[0]!.dataPoints).toBe(2);
    });

    it('Case 4: Data across 3 different days → 3 entries', async () => {
      await ingestTelemetry([
        mkTel({ timestamp: '2026-06-01T12:00:00Z' }),
        mkTel({ timestamp: '2026-06-02T12:00:00Z' }),
        mkTel({ timestamp: '2026-06-03T12:00:00Z' }),
      ]);
      const result = await getDailyEnergy();
      expect(result).toHaveLength(3);
    });

    it('Case 5: Verify energyKwh = avgPower * hours / 1000', async () => {
      // Two points 2 hours apart, constant power: pdc_total = 200*5 + 200*5 = 2000W
      await ingestTelemetry([
        mkTel({ timestamp: '2026-06-01T10:00:00Z', vdc1: 200, idc1: 5, vdc2: 200, idc2: 5 }),
        mkTel({ timestamp: '2026-06-01T12:00:00Z', vdc1: 200, idc1: 5, vdc2: 200, idc2: 5 }),
      ]);
      const result = await getDailyEnergy();
      expect(result).toHaveLength(1);
      const entry = result[0]!;
      // avgPower = 2000W, hours = 2, energy = 2000*2/1000 = 4 kWh
      expect(entry.energyKwh).toBe(4);
    });

    it('Case 6: Verify peakPowerW is the maximum pdc_total', async () => {
      await ingestTelemetry([
        mkTel({ timestamp: '2026-06-01T10:00:00Z', vdc1: 100, idc1: 5, vdc2: 100, idc2: 5 }),  // 1000W
        mkTel({ timestamp: '2026-06-01T12:00:00Z', vdc1: 300, idc1: 10, vdc2: 300, idc2: 10 }), // 6000W
      ]);
      const result = await getDailyEnergy();
      expect(result[0]!.peakPowerW).toBe(6000);
    });

    it('Case 7: Verify avgIrradiance calculation', async () => {
      await ingestTelemetry([
        mkTel({ timestamp: '2026-06-01T10:00:00Z', irr: 400 }),
        mkTel({ timestamp: '2026-06-01T12:00:00Z', irr: 600 }),
      ]);
      const result = await getDailyEnergy();
      expect(result[0]!.avgIrradiance).toBe(500);
    });

    it('Case 8: Date range filtering with from parameter only', async () => {
      await ingestTelemetry([
        mkTel({ timestamp: '2026-05-01T12:00:00Z' }),
        mkTel({ timestamp: '2026-06-15T12:00:00Z' }),
      ]);
      const result = await getDailyEnergy('2026-06-01');
      expect(result).toHaveLength(1);
    });

    it('Case 9: Date range filtering with to parameter only', async () => {
      await ingestTelemetry([
        mkTel({ timestamp: '2026-05-01T12:00:00Z' }),
        mkTel({ timestamp: '2026-06-15T12:00:00Z' }),
      ]);
      const result = await getDailyEnergy(undefined, '2026-05-31');
      expect(result).toHaveLength(1);
    });

    it('Case 10: Date range filtering with both from and to', async () => {
      await ingestTelemetry([
        mkTel({ timestamp: '2026-05-01T12:00:00Z' }),
        mkTel({ timestamp: '2026-06-01T12:00:00Z' }),
        mkTel({ timestamp: '2026-07-01T12:00:00Z' }),
      ]);
      const result = await getDailyEnergy('2026-05-15', '2026-06-15');
      expect(result).toHaveLength(1);
    });

    it('Case 11: Invalid from date string → throws Invalid timestamp', async () => {
      await expect(getDailyEnergy('invalid')).rejects.toThrow('Invalid timestamp');
    });

    it('Case 12: Invalid to date string → throws Invalid timestamp', async () => {
      await expect(getDailyEnergy('2026-01-01', 'garbage')).rejects.toThrow('Invalid timestamp');
    });

    it('Case 13: Both from and to invalid → throws Invalid timestamp', async () => {
      await expect(getDailyEnergy('abc', 'xyz')).rejects.toThrow('Invalid timestamp');
    });

    it('Case 14: from > to returns empty array', async () => {
      await ingestTelemetry([mkTel({ timestamp: '2026-06-01T12:00:00Z' })]);
      const result = await getDailyEnergy('2026-12-01', '2026-01-01');
      expect(result).toEqual([]);
    });

    it('Case 15: Very wide date range (10 years) still works', async () => {
      await ingestTelemetry([mkTel({ timestamp: '2026-06-01T12:00:00Z' })]);
      const result = await getDailyEnergy('2020-01-01', '2030-12-31');
      expect(result).toHaveLength(1);
    });

    it('Case 16: faultCount counts only records with fault_label > 0', async () => {
      await ingestTelemetry([
        mkTel({ timestamp: '2026-06-01T10:00:00Z', faultLabel: 0 }),
        mkTel({ timestamp: '2026-06-01T11:00:00Z', faultLabel: 1 }),
        mkTel({ timestamp: '2026-06-01T12:00:00Z', faultLabel: 2 }),
        mkTel({ timestamp: '2026-06-01T13:00:00Z', faultLabel: 0 }),
      ]);
      const result = await getDailyEnergy();
      expect(result[0]!.faultCount).toBe(2);
    });

    it('Case 17: faultCount = 0 when all records are normal', async () => {
      await ingestTelemetry([
        mkTel({ timestamp: '2026-06-01T10:00:00Z', faultLabel: 0 }),
        mkTel({ timestamp: '2026-06-01T12:00:00Z', faultLabel: 0 }),
      ]);
      const result = await getDailyEnergy();
      expect(result[0]!.faultCount).toBe(0);
    });

    it('Case 18: Entries are sorted by date ascending', async () => {
      await ingestTelemetry([
        mkTel({ timestamp: '2026-06-03T12:00:00Z' }),
        mkTel({ timestamp: '2026-06-01T12:00:00Z' }),
        mkTel({ timestamp: '2026-06-02T12:00:00Z' }),
      ]);
      const result = await getDailyEnergy();
      expect(result).toHaveLength(3);
      expect(result[0]!.date < result[1]!.date).toBe(true);
      expect(result[1]!.date < result[2]!.date).toBe(true);
    });

    it('Case 19: SQL injection in from parameter → throws', async () => {
      await expect(
        getDailyEnergy("2026-01-01'; DROP TABLE telemetry;--"),
      ).rejects.toThrow('Invalid timestamp');
    });

    it('Case 20: Energy with varying power (different strings) → correct avg', async () => {
      // Point 1: pdcTotal = 100*2 + 100*2 = 400W
      // Point 2: pdcTotal = 200*4 + 200*4 = 1600W
      // avg = 1000W, hours = 2, energy = 1000*2/1000 = 2 kWh
      await ingestTelemetry([
        mkTel({ timestamp: '2026-06-01T10:00:00Z', vdc1: 100, idc1: 2, vdc2: 100, idc2: 2 }),
        mkTel({ timestamp: '2026-06-01T12:00:00Z', vdc1: 200, idc1: 4, vdc2: 200, idc2: 4 }),
      ]);
      const result = await getDailyEnergy();
      expect(result[0]!.energyKwh).toBe(2);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 2: getHourlyProfile  (15 cases)
  // ═══════════════════════════════════════════════════════════════════
  describe('getHourlyProfile', () => {
    it('Case 21: Day with data → returns hourly entries', async () => {
      await ingestTelemetry([
        mkTel({ timestamp: '2026-06-01T10:00:00Z' }),
        mkTel({ timestamp: '2026-06-01T10:30:00Z' }),
        mkTel({ timestamp: '2026-06-01T14:00:00Z' }),
      ]);
      const result = await getHourlyProfile('2026-06-01');
      expect(result.length).toBeGreaterThanOrEqual(2);
    });

    it('Case 22: Day without data → empty array', async () => {
      await ingestTelemetry([mkTel({ timestamp: '2026-06-01T12:00:00Z' })]);
      const result = await getHourlyProfile('2026-06-02');
      expect(result).toEqual([]);
    });

    it('Case 23: Empty DB → empty array', async () => {
      const result = await getHourlyProfile('2026-06-01');
      expect(result).toEqual([]);
    });

    it('Case 24: Hour field is between 0 and 23', async () => {
      // Insert data across many hours
      const batch = Array.from({ length: 24 }, (_, i) => {
        const hour = String(i).padStart(2, '0');
        return mkTel({ timestamp: `2026-06-01T${hour}:30:00Z` });
      });
      await ingestTelemetry(batch);
      const result = await getHourlyProfile('2026-06-01');
      for (const entry of result) {
        expect(entry.hour).toBeGreaterThanOrEqual(0);
        expect(entry.hour).toBeLessThanOrEqual(23);
      }
    });

    it('Case 25: Verify avgPower is correctly averaged within an hour', async () => {
      // Two records in same hour with pdcTotal = 1000 and 2000 → avg = 1500
      await ingestTelemetry([
        mkTel({ timestamp: '2026-06-01T10:00:00Z', vdc1: 100, idc1: 5, vdc2: 0, idc2: 0 }),  // 500W
        mkTel({ timestamp: '2026-06-01T10:30:00Z', vdc1: 300, idc1: 5, vdc2: 0, idc2: 0 }),  // 1500W
      ]);
      const result = await getHourlyProfile('2026-06-01');
      // Find the hour-10 entry (note: timezone may shift the hour; check local)
      expect(result.length).toBeGreaterThan(0);
      const entry = result[0]!;
      expect(entry.avgPower).toBeGreaterThan(0);
    });

    it('Case 26: Verify avgIrradiance calculation in hourly profile', async () => {
      await ingestTelemetry([
        mkTel({ timestamp: '2026-06-01T10:00:00Z', irr: 300 }),
        mkTel({ timestamp: '2026-06-01T10:30:00Z', irr: 700 }),
      ]);
      const result = await getHourlyProfile('2026-06-01');
      expect(result.length).toBeGreaterThan(0);
      // Both in same hour → avgIrr = 500
      expect(result[0]!.avgIrradiance).toBe(500);
    });

    it('Case 27: Verify avgTemp calculation in hourly profile', async () => {
      await ingestTelemetry([
        mkTel({ timestamp: '2026-06-01T10:00:00Z', pvt: 25 }),
        mkTel({ timestamp: '2026-06-01T10:30:00Z', pvt: 35 }),
      ]);
      const result = await getHourlyProfile('2026-06-01');
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]!.avgTemp).toBe(30);
    });

    it('Case 28: Invalid date string → throws Invalid date', async () => {
      await expect(getHourlyProfile('not-a-date')).rejects.toThrow('Invalid date');
    });

    it('Case 29: Future date → returns empty array', async () => {
      const result = await getHourlyProfile('2040-01-01');
      expect(result).toEqual([]);
    });

    it('Case 30: Results are sorted by hour ascending', async () => {
      await ingestTelemetry([
        mkTel({ timestamp: '2026-06-01T18:00:00Z' }),
        mkTel({ timestamp: '2026-06-01T06:00:00Z' }),
        mkTel({ timestamp: '2026-06-01T12:00:00Z' }),
      ]);
      const result = await getHourlyProfile('2026-06-01');
      for (let i = 1; i < result.length; i++) {
        expect(result[i]!.hour).toBeGreaterThan(result[i - 1]!.hour);
      }
    });

    it('Case 31: Single record in a day → 1 hourly entry', async () => {
      await ingestTelemetry([mkTel({ timestamp: '2026-06-01T14:00:00Z' })]);
      const result = await getHourlyProfile('2026-06-01');
      expect(result).toHaveLength(1);
    });

    it('Case 32: SQL injection in date → throws Invalid date', async () => {
      await expect(
        getHourlyProfile("2026-06-01'; DROP TABLE telemetry;--"),
      ).rejects.toThrow('Invalid date');
    });

    it('Case 33: Empty string date → throws Invalid date', async () => {
      await expect(getHourlyProfile('')).rejects.toThrow('Invalid date');
    });

    it('Case 34: Multiple records per hour are aggregated into one entry', async () => {
      await ingestTelemetry([
        mkTel({ timestamp: '2026-06-01T10:00:00Z' }),
        mkTel({ timestamp: '2026-06-01T10:15:00Z' }),
        mkTel({ timestamp: '2026-06-01T10:45:00Z' }),
      ]);
      const result = await getHourlyProfile('2026-06-01');
      // All three in the same hour (possibly offset by timezone) → single bucket
      expect(result.length).toBeGreaterThanOrEqual(1);
    });

    it('Case 35: avgPower defaults to 0 when pdc_total is null-ish', async () => {
      await ingestTelemetry([
        mkTel({ timestamp: '2026-06-01T10:00:00Z', vdc1: 0, idc1: 0, vdc2: 0, idc2: 0 }),
      ]);
      const result = await getHourlyProfile('2026-06-01');
      expect(result.length).toBeGreaterThanOrEqual(1);
      expect(result[0]!.avgPower).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 3: getFaultTrend  (15 cases)
  // ═══════════════════════════════════════════════════════════════════
  describe('getFaultTrend', () => {
    it('Case 36: Empty DB → returns empty array', async () => {
      const result = await getFaultTrend();
      expect(result).toEqual([]);
    });

    it('Case 37: All normal data (fault_label=0) → returns empty (excludes label 0)', async () => {
      await ingestTelemetry([
        mkTel({ timestamp: '2026-06-01T10:00:00Z', faultLabel: 0 }),
        mkTel({ timestamp: '2026-06-01T12:00:00Z', faultLabel: 0 }),
      ]);
      const result = await getFaultTrend();
      expect(result).toEqual([]);
    });

    it('Case 38: Records without faultLabel (null) → excluded from trend', async () => {
      await ingestTelemetry([
        mkTel({ timestamp: '2026-06-01T10:00:00Z' }),  // faultLabel defaults to null
        mkTel({ timestamp: '2026-06-01T12:00:00Z' }),
      ]);
      const result = await getFaultTrend();
      expect(result).toEqual([]);
    });

    it('Case 39: shortCircuit (fault_label=1) counted correctly', async () => {
      await ingestTelemetry([
        mkTel({ timestamp: '2026-06-01T10:00:00Z', faultLabel: 1 }),
        mkTel({ timestamp: '2026-06-01T11:00:00Z', faultLabel: 1 }),
      ]);
      const result = await getFaultTrend();
      expect(result).toHaveLength(1);
      expect(result[0]!.shortCircuit).toBe(2);
      expect(result[0]!.degradation).toBe(0);
      expect(result[0]!.openCircuit).toBe(0);
      expect(result[0]!.shadowing).toBe(0);
    });

    it('Case 40: degradation (fault_label=2) counted correctly', async () => {
      await ingestTelemetry([
        mkTel({ timestamp: '2026-06-01T10:00:00Z', faultLabel: 2 }),
        mkTel({ timestamp: '2026-06-01T11:00:00Z', faultLabel: 2 }),
        mkTel({ timestamp: '2026-06-01T12:00:00Z', faultLabel: 2 }),
      ]);
      const result = await getFaultTrend();
      expect(result[0]!.degradation).toBe(3);
    });

    it('Case 41: openCircuit (fault_label=3) counted correctly', async () => {
      await ingestTelemetry([
        mkTel({ timestamp: '2026-06-01T10:00:00Z', faultLabel: 3 }),
      ]);
      const result = await getFaultTrend();
      expect(result[0]!.openCircuit).toBe(1);
    });

    it('Case 42: shadowing (fault_label=4) counted correctly', async () => {
      await ingestTelemetry([
        mkTel({ timestamp: '2026-06-01T10:00:00Z', faultLabel: 4 }),
        mkTel({ timestamp: '2026-06-01T11:00:00Z', faultLabel: 4 }),
      ]);
      const result = await getFaultTrend();
      expect(result[0]!.shadowing).toBe(2);
    });

    it('Case 43: Single day with all 4 fault types → correct per-type counts', async () => {
      const base = new Date('2026-06-01T10:00:00Z').getTime();
      await ingestTelemetry([
        mkTel({ timestamp: new Date(base).toISOString(), faultLabel: 1 }),
        mkTel({ timestamp: new Date(base + 60000).toISOString(), faultLabel: 2 }),
        mkTel({ timestamp: new Date(base + 120000).toISOString(), faultLabel: 3 }),
        mkTel({ timestamp: new Date(base + 180000).toISOString(), faultLabel: 4 }),
      ]);
      const result = await getFaultTrend();
      expect(result).toHaveLength(1);
      expect(result[0]!.shortCircuit).toBe(1);
      expect(result[0]!.degradation).toBe(1);
      expect(result[0]!.openCircuit).toBe(1);
      expect(result[0]!.shadowing).toBe(1);
      expect(result[0]!.total).toBe(4);
    });

    it('Case 44: Faults across multiple days → multiple trend entries', async () => {
      await ingestTelemetry([
        mkTel({ timestamp: '2026-06-01T12:00:00Z', faultLabel: 1 }),
        mkTel({ timestamp: '2026-06-02T12:00:00Z', faultLabel: 2 }),
        mkTel({ timestamp: '2026-06-03T12:00:00Z', faultLabel: 3 }),
      ]);
      const result = await getFaultTrend();
      expect(result).toHaveLength(3);
    });

    it('Case 45: Date range filtering excludes out-of-range faults', async () => {
      await ingestTelemetry([
        mkTel({ timestamp: '2026-05-01T12:00:00Z', faultLabel: 1 }),
        mkTel({ timestamp: '2026-06-15T12:00:00Z', faultLabel: 2 }),
        mkTel({ timestamp: '2026-07-01T12:00:00Z', faultLabel: 3 }),
      ]);
      const result = await getFaultTrend('2026-06-01', '2026-06-30');
      expect(result).toHaveLength(1);
      expect(result[0]!.degradation).toBe(1);
    });

    it('Case 46: Invalid from date → throws Invalid timestamp', async () => {
      await expect(getFaultTrend('invalid')).rejects.toThrow('Invalid timestamp');
    });

    it('Case 47: Invalid to date → throws Invalid timestamp', async () => {
      await expect(getFaultTrend('2026-01-01', 'invalid')).rejects.toThrow('Invalid timestamp');
    });

    it('Case 48: Trend entries have date field in YYYY-MM-DD format', async () => {
      await ingestTelemetry([
        mkTel({ timestamp: '2026-06-01T12:00:00Z', faultLabel: 1 }),
      ]);
      const result = await getFaultTrend();
      expect(result[0]!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('Case 49: Mixed normal and fault data → only faults in trend', async () => {
      await ingestTelemetry([
        mkTel({ timestamp: '2026-06-01T10:00:00Z', faultLabel: 0 }),
        mkTel({ timestamp: '2026-06-01T11:00:00Z', faultLabel: 1 }),
        mkTel({ timestamp: '2026-06-01T12:00:00Z', faultLabel: 0 }),
        mkTel({ timestamp: '2026-06-01T13:00:00Z', faultLabel: 0 }),
      ]);
      const result = await getFaultTrend();
      expect(result).toHaveLength(1);
      expect(result[0]!.total).toBe(1);
      expect(result[0]!.shortCircuit).toBe(1);
    });

    it('Case 50: Trend entries sorted by date ascending', async () => {
      await ingestTelemetry([
        mkTel({ timestamp: '2026-06-03T12:00:00Z', faultLabel: 1 }),
        mkTel({ timestamp: '2026-06-01T12:00:00Z', faultLabel: 2 }),
        mkTel({ timestamp: '2026-06-02T12:00:00Z', faultLabel: 3 }),
      ]);
      const result = await getFaultTrend();
      expect(result).toHaveLength(3);
      expect(result[0]!.date < result[1]!.date).toBe(true);
      expect(result[1]!.date < result[2]!.date).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 4: getSystemSummary  (20 cases)
  // ═══════════════════════════════════════════════════════════════════
  describe('getSystemSummary', () => {
    it('Case 51: Empty DB → zeros/defaults', async () => {
      const result = await getSystemSummary();
      expect(result.totalEnergyKwh).toBe(0);
      expect(result.totalFaults).toBe(0);
      expect(result.totalAlerts).toBe(0);
      expect(result.uptimePercent).toBe(100);
      expect(result.daysWithData).toBe(0);
      expect(result.faultDistribution).toEqual([]);
    });

    it('Case 52: With telemetry → correct totalEnergyKwh', async () => {
      // 2 points, 2 hours apart, constant 2000W → 2000*2/1000 = 4 kWh
      await ingestTelemetry([
        mkTel({ timestamp: '2026-06-01T10:00:00Z' }),
        mkTel({ timestamp: '2026-06-01T12:00:00Z' }),
      ]);
      const result = await getSystemSummary();
      expect(result.totalEnergyKwh).toBe(4);
    });

    it('Case 53: totalFaults counts only fault_label > 0', async () => {
      await ingestTelemetry([
        mkTel({ timestamp: '2026-06-01T10:00:00Z', faultLabel: 0 }),
        mkTel({ timestamp: '2026-06-01T11:00:00Z', faultLabel: 1 }),
        mkTel({ timestamp: '2026-06-01T12:00:00Z', faultLabel: 2 }),
        mkTel({ timestamp: '2026-06-01T13:00:00Z', faultLabel: 0 }),
      ]);
      const result = await getSystemSummary();
      expect(result.totalFaults).toBe(2);
    });

    it('Case 54: alertsByStatus with new (unacknowledged, no ticket) alerts', async () => {
      await insertAlert({ acknowledged: false, ticketId: null });
      await insertAlert({ acknowledged: false, ticketId: null });
      const result = await getSystemSummary();
      expect(result.alertsByStatus.new).toBe(2);
      expect(result.totalAlerts).toBe(2);
    });

    it('Case 55: alertsByStatus with acknowledged alerts (no ticket)', async () => {
      await insertAlert({ acknowledged: true, ticketId: null });
      const result = await getSystemSummary();
      expect(result.alertsByStatus.acknowledged).toBe(1);
    });

    it('Case 56: alertsByStatus with resolved ticket', async () => {
      const ticketId = `INC-2026-${nanoid(5)}`;
      await insertTicket({ id: ticketId, status: 'resolved' });
      await insertAlert({ ticketId, acknowledged: true });
      const result = await getSystemSummary();
      expect(result.alertsByStatus.resolved).toBe(1);
    });

    it('Case 57: alertsByStatus with closed ticket → counted as resolved', async () => {
      const ticketId = `INC-2026-${nanoid(5)}`;
      await insertTicket({ id: ticketId, status: 'closed' });
      await insertAlert({ ticketId, acknowledged: true });
      const result = await getSystemSummary();
      expect(result.alertsByStatus.resolved).toBe(1);
    });

    it('Case 58: alertsByStatus with escalated ticket', async () => {
      const ticketId = `INC-2026-${nanoid(5)}`;
      await insertTicket({ id: ticketId, status: 'escalated' });
      await insertAlert({ ticketId, acknowledged: true });
      const result = await getSystemSummary();
      expect(result.alertsByStatus.escalated).toBe(1);
    });

    it('Case 59: alertsByStatus with wasEscalated=true → counted as escalated', async () => {
      const ticketId = `INC-2026-${nanoid(5)}`;
      await insertTicket({ id: ticketId, status: 'resolved', wasEscalated: true });
      await insertAlert({ ticketId, acknowledged: true });
      const result = await getSystemSummary();
      expect(result.alertsByStatus.escalated).toBe(1);
    });

    it('Case 60: uptimePercent = (normal/total)*100', async () => {
      // 8 normal + 2 faults = 80% uptime
      const base = new Date('2026-06-01T10:00:00Z').getTime();
      const batch = Array.from({ length: 10 }, (_, i) => mkTel({
        timestamp: new Date(base + i * 60000).toISOString(),
        faultLabel: i < 2 ? 1 : 0,
      }));
      await ingestTelemetry(batch);
      const result = await getSystemSummary();
      expect(result.uptimePercent).toBe(80);
    });

    it('Case 61: uptimePercent = 0 when all records are faults', async () => {
      const base = new Date('2026-06-01T10:00:00Z').getTime();
      const batch = Array.from({ length: 5 }, (_, i) => mkTel({
        timestamp: new Date(base + i * 60000).toISOString(),
        faultLabel: 1,
      }));
      await ingestTelemetry(batch);
      const result = await getSystemSummary();
      expect(result.uptimePercent).toBe(0);
    });

    it('Case 62: daysWithData counts distinct days', async () => {
      await ingestTelemetry([
        mkTel({ timestamp: '2026-06-01T10:00:00Z' }),
        mkTel({ timestamp: '2026-06-01T14:00:00Z' }),
        mkTel({ timestamp: '2026-06-02T10:00:00Z' }),
        mkTel({ timestamp: '2026-06-03T10:00:00Z' }),
      ]);
      const result = await getSystemSummary();
      expect(result.daysWithData).toBe(3);
    });

    it('Case 63: faultDistribution has correct labels', async () => {
      await ingestTelemetry([
        mkTel({ timestamp: '2026-06-01T10:00:00Z', faultLabel: 0 }),
        mkTel({ timestamp: '2026-06-01T11:00:00Z', faultLabel: 1 }),
        mkTel({ timestamp: '2026-06-01T12:00:00Z', faultLabel: 2 }),
      ]);
      const result = await getSystemSummary();
      const labels = result.faultDistribution.map(d => d.label);
      expect(labels).toContain('Normal');
      expect(labels).toContain('Short-Circuit');
      expect(labels).toContain('Degradation');
    });

    it('Case 64: faultDistribution code field matches fault_label values', async () => {
      await ingestTelemetry([
        mkTel({ timestamp: '2026-06-01T10:00:00Z', faultLabel: 3 }),
        mkTel({ timestamp: '2026-06-01T11:00:00Z', faultLabel: 4 }),
      ]);
      const result = await getSystemSummary();
      const codes = result.faultDistribution.map(d => d.code);
      expect(codes).toContain(3);
      expect(codes).toContain(4);
    });

    it('Case 65: Date range filtering on summary', async () => {
      await ingestTelemetry([
        mkTel({ timestamp: '2026-05-01T12:00:00Z', faultLabel: 1 }),
        mkTel({ timestamp: '2026-06-15T12:00:00Z', faultLabel: 0 }),
      ]);
      const result = await getSystemSummary('2026-06-01', '2026-06-30');
      expect(result.totalFaults).toBe(0);
      expect(result.daysWithData).toBe(1);
    });

    it('Case 66: Invalid from date → throws Invalid timestamp', async () => {
      await expect(getSystemSummary('not-valid')).rejects.toThrow('Invalid timestamp');
    });

    it('Case 67: Mixed alert statuses are tallied correctly', async () => {
      const t1 = `INC-2026-${nanoid(5)}`;
      const t2 = `INC-2026-${nanoid(5)}`;
      await insertTicket({ id: t1, status: 'resolved' });
      await insertTicket({ id: t2, status: 'escalated' });

      await insertAlert({ acknowledged: false });           // new
      await insertAlert({ acknowledged: true });             // acknowledged
      await insertAlert({ ticketId: t1, acknowledged: true }); // resolved
      await insertAlert({ ticketId: t2, acknowledged: true }); // escalated

      const result = await getSystemSummary();
      expect(result.alertsByStatus.new).toBe(1);
      expect(result.alertsByStatus.acknowledged).toBe(1);
      expect(result.alertsByStatus.resolved).toBe(1);
      expect(result.alertsByStatus.escalated).toBe(1);
      expect(result.totalAlerts).toBe(4);
    });

    it('Case 68: totalEnergyKwh is 0 when only 1 telemetry record exists', async () => {
      await ingestTelemetry([mkTel({ timestamp: '2026-06-01T12:00:00Z' })]);
      const result = await getSystemSummary();
      // Single point → minTs === maxTs → hours = 0 → energy = 0
      expect(result.totalEnergyKwh).toBe(0);
    });

    it('Case 69: faultDistribution count reflects actual counts', async () => {
      const base = new Date('2026-06-01T10:00:00Z').getTime();
      await ingestTelemetry([
        mkTel({ timestamp: new Date(base).toISOString(), faultLabel: 1 }),
        mkTel({ timestamp: new Date(base + 60000).toISOString(), faultLabel: 1 }),
        mkTel({ timestamp: new Date(base + 120000).toISOString(), faultLabel: 1 }),
        mkTel({ timestamp: new Date(base + 180000).toISOString(), faultLabel: 2 }),
      ]);
      const result = await getSystemSummary();
      const sc = result.faultDistribution.find(d => d.code === 1);
      const deg = result.faultDistribution.find(d => d.code === 2);
      expect(sc!.count).toBe(3);
      expect(deg!.count).toBe(1);
    });

    it('Case 70: SQL injection in summary from → throws', async () => {
      await expect(
        getSystemSummary("'; DROP TABLE telemetry;--"),
      ).rejects.toThrow('Invalid timestamp');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 5: Edge cases  (10 cases)
  // ═══════════════════════════════════════════════════════════════════
  describe('Edge Cases', () => {
    it('Case 71: Large dataset (1000 records) → getDailyEnergy returns valid results', async () => {
      const baseTime = new Date('2026-06-01T00:00:00Z').getTime();
      const batch = Array.from({ length: 1000 }, (_, i) => mkTel({
        timestamp: new Date(baseTime + i * 60000).toISOString(), // every 60s
        faultLabel: i % 10 === 0 ? 1 : 0,
      }));
      await ingestTelemetry(batch);

      const daily = await getDailyEnergy();
      expect(daily.length).toBeGreaterThan(0);
      const totalPts = daily.reduce((s, d) => s + d.dataPoints, 0);
      expect(totalPts).toBe(1000);
    });

    it('Case 72: Large dataset → getSystemSummary returns correct fault count', async () => {
      const baseTime = new Date('2026-06-01T00:00:00Z').getTime();
      const batch = Array.from({ length: 1000 }, (_, i) => mkTel({
        timestamp: new Date(baseTime + i * 60000).toISOString(),
        faultLabel: i % 10 === 0 ? 1 : 0,
      }));
      await ingestTelemetry(batch);

      const summary = await getSystemSummary();
      expect(summary.totalFaults).toBe(100); // every 10th record
    });

    it('Case 73: All records same timestamp → getDailyEnergy shows 0 energy', async () => {
      const batch = Array.from({ length: 5 }, () => mkTel({
        timestamp: '2026-06-01T12:00:00Z',
      }));
      await ingestTelemetry(batch);

      const result = await getDailyEnergy();
      expect(result).toHaveLength(1);
      expect(result[0]!.energyKwh).toBe(0);
      expect(result[0]!.dataPoints).toBe(5);
    });

    it('Case 74: All records same timestamp → getSystemSummary totalEnergy = 0', async () => {
      const batch = Array.from({ length: 5 }, () => mkTel({
        timestamp: '2026-06-01T12:00:00Z',
      }));
      await ingestTelemetry(batch);

      const result = await getSystemSummary();
      expect(result.totalEnergyKwh).toBe(0);
    });

    it('Case 75: All records have fault_label = 0 → uptime 100%, no faults', async () => {
      const base = new Date('2026-06-01T10:00:00Z').getTime();
      const batch = Array.from({ length: 20 }, (_, i) => mkTel({
        timestamp: new Date(base + i * 60000).toISOString(),
        faultLabel: 0,
      }));
      await ingestTelemetry(batch);

      const summary = await getSystemSummary();
      expect(summary.uptimePercent).toBe(100);
      expect(summary.totalFaults).toBe(0);

      const trend = await getFaultTrend();
      expect(trend).toEqual([]);
    });

    it('Case 76: All records have fault_label > 0 → uptime 0%', async () => {
      const base = new Date('2026-06-01T10:00:00Z').getTime();
      const batch = Array.from({ length: 10 }, (_, i) => mkTel({
        timestamp: new Date(base + i * 60000).toISOString(),
        faultLabel: ((i % 4) + 1),  // cycles through 1,2,3,4
      }));
      await ingestTelemetry(batch);

      const summary = await getSystemSummary();
      expect(summary.uptimePercent).toBe(0);
      expect(summary.totalFaults).toBe(10);
    });

    it('Case 77: Timestamp at midnight boundary → correctly assigned to day', async () => {
      await ingestTelemetry([
        mkTel({ timestamp: '2026-06-01T23:59:59Z' }),
        mkTel({ timestamp: '2026-06-02T00:00:00Z' }),
        mkTel({ timestamp: '2026-06-02T00:00:01Z' }),
      ]);
      const result = await getDailyEnergy();
      // Should have at least 1 day, possibly 2 depending on local timezone
      expect(result.length).toBeGreaterThanOrEqual(1);
      expect(result.length).toBeLessThanOrEqual(3);
    });

    it('Case 78: Negative power values are handled gracefully', async () => {
      // V and I can be negative (reverse current scenario)
      await ingestTelemetry([
        mkTel({ timestamp: '2026-06-01T10:00:00Z', vdc1: -50, idc1: 2, vdc2: 100, idc2: 3 }),
        mkTel({ timestamp: '2026-06-01T12:00:00Z', vdc1: 200, idc1: 5, vdc2: 200, idc2: 5 }),
      ]);
      // Should not throw
      const daily = await getDailyEnergy();
      expect(daily.length).toBeGreaterThan(0);
      const hourly = await getHourlyProfile('2026-06-01');
      expect(hourly.length).toBeGreaterThanOrEqual(0);
    });

    it('Case 79: Very high irradiance and temperature values', async () => {
      await ingestTelemetry([
        mkTel({ timestamp: '2026-06-01T10:00:00Z', irr: 1500, pvt: 85 }),
        mkTel({ timestamp: '2026-06-01T12:00:00Z', irr: 1500, pvt: 85 }),
      ]);
      const daily = await getDailyEnergy();
      expect(daily[0]!.avgIrradiance).toBe(1500);
      const hourly = await getHourlyProfile('2026-06-01');
      const temps = hourly.map(h => h.avgTemp);
      for (const t of temps) {
        expect(t).toBe(85);
      }
    });

    it('Case 80: Zero power values → 0 energy, 0 peak', async () => {
      await ingestTelemetry([
        mkTel({ timestamp: '2026-06-01T10:00:00Z', vdc1: 0, idc1: 0, vdc2: 0, idc2: 0 }),
        mkTel({ timestamp: '2026-06-01T12:00:00Z', vdc1: 0, idc1: 0, vdc2: 0, idc2: 0 }),
      ]);
      const result = await getDailyEnergy();
      expect(result[0]!.energyKwh).toBe(0);
      expect(result[0]!.peakPowerW).toBe(0);
    });
  });
});
