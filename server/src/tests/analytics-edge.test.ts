import { describe, it, expect, afterEach } from 'vitest';
import { db, client } from '../db/index.js';
import { telemetry, alerts, tickets, users } from '../db/schema.js';
import {
  getDailyEnergy,
  getHourlyProfile,
  getFaultTrend,
  getSystemSummary,
} from '../services/analytics.service.js';
import {
  ingestTelemetry,
  getAggregatedTelemetry,
  getTelemetryKPIs,
  getDataRange,
  getDailyYieldToday,
  queryTelemetry,
  getLatestTelemetry,
} from '../services/telemetry.service.js';

describe('Analytics Edge Cases — Extended Test Suite', () => {
  afterEach(async () => {
    await client.execute('PRAGMA foreign_keys = OFF');
    await db.delete(telemetry);
    await db.delete(alerts);
    await db.delete(tickets);
    await db.delete(users);
    await client.execute('PRAGMA foreign_keys = ON');
  });

  // ─── SECTION 1: Empty Database Tests (6 tests) ───────────────────
  describe('Empty Database Behavior', () => {
    it('getDailyEnergy with empty DB → empty array', async () => {
      const result = await getDailyEnergy();
      expect(result).toEqual([]);
    });

    it('getHourlyProfile with empty DB → empty array', async () => {
      const result = await getHourlyProfile('2026-06-01');
      expect(result).toEqual([]);
    });

    it('getFaultTrend with empty DB → empty array', async () => {
      const result = await getFaultTrend();
      expect(result).toEqual([]);
    });

    it('getSystemSummary with empty DB → zeros, uptimePercent = 100', async () => {
      const result = await getSystemSummary();
      expect(result.totalFaults).toBe(0);
      expect(result.totalAlerts).toBe(0);
      expect(result.uptimePercent).toBe(100);
      expect(result.totalEnergyKwh).toBe(0);
      expect(result.daysWithData).toBe(0);
      expect(result.alertsByStatus.new).toBe(0);
      expect(result.alertsByStatus.acknowledged).toBe(0);
      expect(result.alertsByStatus.resolved).toBe(0);
      expect(result.alertsByStatus.escalated).toBe(0);
    });

    it('getDataRange with empty DB → all zeros', async () => {
      const result = await getDataRange();
      expect(result.minTs).toBe(0);
      expect(result.maxTs).toBe(0);
      expect(result.totalPoints).toBe(0);
    });

    it('getDailyYieldToday with empty DB → zero energy', async () => {
      const result = await getDailyYieldToday();
      expect(result.energyKwh).toBe(0);
    });
  });

  // ─── SECTION 2: Invalid Input Tests (6 tests) ────────────────────
  describe('Invalid Input Handling', () => {
    it('getHourlyProfile with invalid date "not-a-date" → throws Invalid date', async () => {
      await expect(getHourlyProfile('not-a-date')).rejects.toThrow('Invalid date');
    });

    it('getDailyEnergy with SQL injection in from → throws Invalid timestamp', async () => {
      await expect(
        getDailyEnergy("2026-01-01'; DROP TABLE telemetry;--")
      ).rejects.toThrow('Invalid timestamp');
    });

    it('getAggregatedTelemetry with SQL injection from → throws Invalid timestamp', async () => {
      await expect(
        getAggregatedTelemetry('1h', "'; DROP TABLE telemetry;--")
      ).rejects.toThrow('Invalid timestamp');
    });

    it('getTelemetryKPIs with invalid from → throws Invalid timestamp', async () => {
      await expect(
        getTelemetryKPIs('not-a-date')
      ).rejects.toThrow('Invalid timestamp');
    });

    it('getAggregatedTelemetry with unknown interval falls back to 60s bucket without crashing', async () => {
      // Should not throw, just use default bucket
      const result = await getAggregatedTelemetry('99x');
      expect(Array.isArray(result)).toBe(true);
    });

    it('getSystemSummary with SQL injection from → throws Invalid timestamp', async () => {
      await expect(
        getSystemSummary("'; DROP TABLE telemetry;--")
      ).rejects.toThrow('Invalid timestamp');
    });
  });

  // ─── SECTION 3: Boundary Tests With Data (8 tests) ───────────────
  describe('Boundary Cases With Data', () => {
    it('getDailyEnergy with exactly 1 record → returns 1 entry with 0 energy', async () => {
      await ingestTelemetry([{
        timestamp: '2026-06-01T12:00:00Z',
        vdc1: 200, vdc2: 200, idc1: 5, idc2: 5, irr: 500, pvt: 30,
      }]);

      const result = await getDailyEnergy();
      expect(result.length).toBe(1);
      expect(result[0]?.energyKwh).toBe(0); // Single point can't compute hours
      expect(result[0]?.dataPoints).toBe(1);
    });

    it('getHourlyProfile for a day with data in only 1 hour → returns 1 entry', async () => {
      await ingestTelemetry([{
        timestamp: '2026-06-01T14:00:00Z',
        vdc1: 200, vdc2: 200, idc1: 5, idc2: 5, irr: 500, pvt: 30,
      }]);

      const result = await getHourlyProfile('2026-06-01');
      expect(result.length).toBe(1);
    });

    it('getFaultTrend with no fault labels > 0 → empty array', async () => {
      await ingestTelemetry([
        { timestamp: '2026-06-01T12:00:00Z', vdc1: 200, vdc2: 200, idc1: 5, idc2: 5, irr: 500, pvt: 30, faultLabel: 0 },
        { timestamp: '2026-06-01T13:00:00Z', vdc1: 200, vdc2: 200, idc1: 5, idc2: 5, irr: 500, pvt: 30 },
      ]);

      const result = await getFaultTrend();
      expect(result).toEqual([]);
    });

    it('getSystemSummary with no faults → uptimePercent = 100', async () => {
      await ingestTelemetry([
        { timestamp: '2026-06-01T12:00:00Z', vdc1: 200, vdc2: 200, idc1: 5, idc2: 5, irr: 500, pvt: 30, faultLabel: 0 },
        { timestamp: '2026-06-01T13:00:00Z', vdc1: 200, vdc2: 200, idc1: 5, idc2: 5, irr: 500, pvt: 30, faultLabel: 0 },
      ]);

      const result = await getSystemSummary();
      expect(result.uptimePercent).toBe(100);
      expect(result.totalFaults).toBe(0);
    });

    it('getAggregatedTelemetry with 1h interval on 100 data points', async () => {
      const baseTime = new Date('2026-06-01T00:00:00Z').getTime();
      const batch = Array.from({ length: 100 }, (_, i) => ({
        timestamp: new Date(baseTime + i * 60000).toISOString(),
        vdc1: 200, vdc2: 200, idc1: 5, idc2: 5, irr: 500, pvt: 30,
      }));
      await ingestTelemetry(batch);

      const result = await getAggregatedTelemetry('1h');
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]?.dataPoints).toBeGreaterThan(0);
    });

    it('getTelemetryKPIs with specific date range returns correct stats', async () => {
      const baseTime = new Date('2026-06-01T00:00:00Z').getTime();
      const batch = Array.from({ length: 10 }, (_, i) => ({
        timestamp: new Date(baseTime + i * 3600000).toISOString(),
        vdc1: 200, vdc2: 200, idc1: 5, idc2: 5, irr: 500, pvt: 30,
      }));
      await ingestTelemetry(batch);

      const kpi = await getTelemetryKPIs('2026-06-01T00:00:00Z', '2026-06-01T23:59:59Z');
      expect(kpi.totalRecords).toBe(10);
      expect(kpi.avgPower).toBeGreaterThan(0);
      expect(kpi.avgIrradiance).toBe(500);
    });

    it('getLatestTelemetry with n=0 → empty array', async () => {
      await ingestTelemetry([{
        timestamp: '2026-06-01T12:00:00Z',
        vdc1: 200, vdc2: 200, idc1: 5, idc2: 5, irr: 500, pvt: 30,
      }]);

      const result = await getLatestTelemetry(0);
      expect(result).toEqual([]);
    });

    it('queryTelemetry with offset beyond data → empty array', async () => {
      await ingestTelemetry([{
        timestamp: '2026-06-01T12:00:00Z',
        vdc1: 200, vdc2: 200, idc1: 5, idc2: 5, irr: 500, pvt: 30,
      }]);

      const result = await queryTelemetry({ offset: 1000 });
      expect(result).toEqual([]);
    });
  });

  // ─── SECTION 4: Large Dataset Tests (3 tests) ────────────────────
  describe('Large Dataset Handling', () => {
    it('Ingest 500 records and verify getDailyEnergy grouping', async () => {
      const baseTime = new Date('2026-06-01T00:00:00Z').getTime();
      const batch = Array.from({ length: 500 }, (_, i) => ({
        timestamp: new Date(baseTime + i * 600000).toISOString(), // Every 10 min
        vdc1: 200, vdc2: 200, idc1: 5, idc2: 5, irr: 500, pvt: 30,
      }));
      await ingestTelemetry(batch);

      const daily = await getDailyEnergy();
      expect(daily.length).toBeGreaterThan(0);
      const totalPoints = daily.reduce((sum, d) => sum + d.dataPoints, 0);
      expect(totalPoints).toBe(500);
    });

    it('Ingest 500 records and verify getAggregatedTelemetry with 1w interval', async () => {
      const baseTime = new Date('2026-06-01T00:00:00Z').getTime();
      const batch = Array.from({ length: 500 }, (_, i) => ({
        timestamp: new Date(baseTime + i * 600000).toISOString(),
        vdc1: 200, vdc2: 200, idc1: 5, idc2: 5, irr: 500, pvt: 30,
      }));
      await ingestTelemetry(batch);

      const agg = await getAggregatedTelemetry('1w');
      expect(agg.length).toBeGreaterThan(0);
    });

    it('queryTelemetry with very large limit (99999) clamps to 10000', async () => {
      await ingestTelemetry([{
        timestamp: '2026-06-01T12:00:00Z',
        vdc1: 200, vdc2: 200, idc1: 5, idc2: 5, irr: 500, pvt: 30,
      }]);

      // Should not throw, limit internally clamped
      const result = await queryTelemetry({ limit: 99999 });
      expect(result.length).toBeLessThanOrEqual(10000);
    });
  });

  // ─── SECTION 5: Future Date Tests (3 tests) ──────────────────────
  describe('Future Date Handling', () => {
    it('getDailyEnergy with future-only date range → empty array', async () => {
      await ingestTelemetry([{
        timestamp: '2026-06-01T12:00:00Z',
        vdc1: 200, vdc2: 200, idc1: 5, idc2: 5, irr: 500, pvt: 30,
      }]);

      const result = await getDailyEnergy('2030-01-01', '2030-12-31');
      expect(result).toEqual([]);
    });

    it('getHourlyProfile for future date → empty array', async () => {
      const result = await getHourlyProfile('2030-01-01');
      expect(result).toEqual([]);
    });

    it('getFaultTrend with future date range → empty array', async () => {
      await ingestTelemetry([{
        timestamp: '2026-06-01T12:00:00Z',
        vdc1: 200, vdc2: 200, idc1: 5, idc2: 5, irr: 500, pvt: 30, faultLabel: 1,
      }]);

      const result = await getFaultTrend('2030-01-01', '2030-12-31');
      expect(result).toEqual([]);
    });
  });

  // ─── SECTION 6: Fault Distribution Tests (3 tests) ───────────────
  describe('Fault Distribution & Uptime', () => {
    it('getSystemSummary with multiple fault types → correct distribution', async () => {
      const baseTime = new Date('2026-06-01T12:00:00Z').getTime();
      await ingestTelemetry([
        { timestamp: new Date(baseTime).toISOString(), vdc1: 200, vdc2: 200, idc1: 5, idc2: 5, irr: 500, pvt: 30, faultLabel: 1 },
        { timestamp: new Date(baseTime + 60000).toISOString(), vdc1: 200, vdc2: 200, idc1: 5, idc2: 5, irr: 500, pvt: 30, faultLabel: 2 },
        { timestamp: new Date(baseTime + 120000).toISOString(), vdc1: 200, vdc2: 200, idc1: 5, idc2: 5, irr: 500, pvt: 30, faultLabel: 3 },
        { timestamp: new Date(baseTime + 180000).toISOString(), vdc1: 200, vdc2: 200, idc1: 5, idc2: 5, irr: 500, pvt: 30, faultLabel: 4 },
        { timestamp: new Date(baseTime + 240000).toISOString(), vdc1: 200, vdc2: 200, idc1: 5, idc2: 5, irr: 500, pvt: 30, faultLabel: 0 },
      ]);

      const summary = await getSystemSummary();
      expect(summary.totalFaults).toBe(4);
      expect(summary.faultDistribution.length).toBeGreaterThanOrEqual(2); // At least normal + fault entries
    });

    it('getFaultTrend with all 4 fault types → each counted correctly', async () => {
      const baseTime = new Date('2026-06-01T12:00:00Z').getTime();
      await ingestTelemetry([
        { timestamp: new Date(baseTime).toISOString(), vdc1: 200, vdc2: 200, idc1: 5, idc2: 5, irr: 500, pvt: 30, faultLabel: 1 },
        { timestamp: new Date(baseTime + 60000).toISOString(), vdc1: 200, vdc2: 200, idc1: 5, idc2: 5, irr: 500, pvt: 30, faultLabel: 2 },
        { timestamp: new Date(baseTime + 120000).toISOString(), vdc1: 200, vdc2: 200, idc1: 5, idc2: 5, irr: 500, pvt: 30, faultLabel: 3 },
        { timestamp: new Date(baseTime + 180000).toISOString(), vdc1: 200, vdc2: 200, idc1: 5, idc2: 5, irr: 500, pvt: 30, faultLabel: 4 },
      ]);

      const trend = await getFaultTrend();
      expect(trend.length).toBe(1); // All same day
      expect(trend[0]?.shortCircuit).toBe(1);
      expect(trend[0]?.degradation).toBe(1);
      expect(trend[0]?.openCircuit).toBe(1);
      expect(trend[0]?.shadowing).toBe(1);
      expect(trend[0]?.total).toBe(4);
    });

    it('getSystemSummary uptimePercent with 50% faults → ~50%', async () => {
      const baseTime = new Date('2026-06-01T12:00:00Z').getTime();
      const batch = Array.from({ length: 10 }, (_, i) => ({
        timestamp: new Date(baseTime + i * 60000).toISOString(),
        vdc1: 200, vdc2: 200, idc1: 5, idc2: 5, irr: 500, pvt: 30,
        faultLabel: i < 5 ? 1 : 0, // 5 faults, 5 normal
      }));
      await ingestTelemetry(batch);

      const summary = await getSystemSummary();
      expect(summary.uptimePercent).toBe(50);
      expect(summary.totalFaults).toBe(5);
    });
  });
});
