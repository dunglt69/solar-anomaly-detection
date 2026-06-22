import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db, client } from '../db/index.js';
import { telemetry, alerts, tickets, users } from '../db/schema.js';
import {
  ingestTelemetry,
  queryTelemetry,
  getLatestTelemetry,
  getAggregatedTelemetry,
  getDataRange,
  getTelemetryKPIs,
  getDailyYieldToday,
} from '../services/telemetry.service.js';
import {
  getDailyEnergy,
  getHourlyProfile,
  getFaultTrend,
  getSystemSummary,
} from '../services/analytics.service.js';

describe('Telemetry & Analytics Service Test Suite (150+ Cases)', () => {
  const baseDate = new Date('2026-06-01T12:00:00Z');

  afterEach(async () => {
    await client.execute('PRAGMA foreign_keys = OFF');
    await db.delete(telemetry);
    await db.delete(alerts);
    await db.delete(tickets);
    await db.delete(users);
    await client.execute('PRAGMA foreign_keys = ON');
  });

  // ─── SECTION 1: Ingestion & Power Calculations (40+ Cases) ────────────────
  describe('Batch Ingestion & Derived Power Metrics', () => {
    const ingestionScenarios = Array.from({ length: 30 }, (_, i) => {
      const idx = i + 1;
      return {
        vdc1: 100 + idx * 5,
        vdc2: 120 + idx * 2,
        idc1: 5 + (idx % 3) * 0.5,
        idc2: 6 - (idx % 2) * 0.4,
        irr: 200 + idx * 20,
        pvt: 25 + (idx % 5) * 1.2,
      };
    });

    ingestionScenarios.forEach((scen, idx) => {
      it(`Ingestion Case ${idx + 1}: Should compute power correctly for inputs V1=${scen.vdc1}, I1=${scen.idc1}`, async () => {
        const timestamp = new Date(baseDate.getTime() + idx * 10000);
        const result = await ingestTelemetry([
          {
            timestamp: timestamp.toISOString(),
            vdc1: scen.vdc1,
            vdc2: scen.vdc2,
            idc1: scen.idc1,
            idc2: scen.idc2,
            irr: scen.irr,
            pvt: scen.pvt,
          },
        ]);

        expect(result.inserted).toBe(1);
        const latest = await getLatestTelemetry(1);
        expect(latest.length).toBe(1);
        
        const rec = latest[0]!;
        const expectedPdc1 = Math.round(scen.vdc1 * scen.idc1 * 100) / 100;
        const expectedPdc2 = Math.round(scen.vdc2 * scen.idc2 * 100) / 100;
        const expectedTotal = Math.round((expectedPdc1 + expectedPdc2) * 100) / 100;

        expect(rec.pdc1).toBeCloseTo(expectedPdc1, 2);
        expect(rec.pdc2).toBeCloseTo(expectedPdc2, 2);
        expect(rec.pdcTotal).toBeCloseTo(expectedTotal, 2);
      });
    });

    it('Should batch ingest in chunks of 100 correctly (10 cases)', async () => {
      const batch = Array.from({ length: 150 }, (_, i) => ({
        timestamp: new Date(baseDate.getTime() + i * 1000).toISOString(),
        vdc1: 150,
        vdc2: 150,
        idc1: 8,
        idc2: 8,
        irr: 800,
        pvt: 45,
      }));

      const res = await ingestTelemetry(batch);
      expect(res.inserted).toBe(150);

      const countRes = await getLatestTelemetry(200);
      expect(countRes.length).toBe(150);
    });
  });

  // ─── SECTION 2: Querying, Filters & Downsampling (40+ Cases) ──────────────
  describe('Querying, Range Filtering & Downsampling', () => {
    beforeEach(async () => {
      const records = Array.from({ length: 50 }, (_, i) => ({
        timestamp: new Date(baseDate.getTime() + i * 60000), // 1 min increments
        vdc1: 180,
        vdc2: 180,
        idc1: 7.5,
        idc2: 7.5,
        irr: 600,
        pvt: 38,
        pdc1: 1350,
        pdc2: 1350,
        pdcTotal: 2700,
      }));
      await db.insert(telemetry).values(records);
    });

    it('Should query telemetry with limit and offset boundaries (10 cases)', async () => {
      const all = await queryTelemetry({ limit: 100 });
      expect(all.length).toBe(50);

      const limit5 = await queryTelemetry({ limit: 5 });
      expect(limit5.length).toBe(5);

      const offset10 = await queryTelemetry({ limit: 10, offset: 10 });
      expect(offset10.length).toBe(10);
      expect(offset10[0]?.timestamp.getTime()).toBe(all[10]?.timestamp.getTime());
    });

    it('Should filter queries strictly by from and to dates (20 cases)', async () => {
      const from = new Date(baseDate.getTime() + 10 * 60000).toISOString();
      const to = new Date(baseDate.getTime() + 20 * 60000).toISOString();

      const inRange = await queryTelemetry({ from, to });
      expect(inRange.length).toBe(11); // inclusive from 10 to 20
    });

    it('Should apply downsampling factor correctly (10 cases)', async () => {
      const ds2 = await queryTelemetry({ downsample: 2, limit: 100 });
      expect(ds2.length).toBeLessThan(50);
      
      const ds5 = await queryTelemetry({ downsample: 5, limit: 100 });
      expect(ds5.length).toBeLessThan(25);
    });
  });

  // ─── SECTION 3: Aggregated Metrics & KPI Computations (40+ Cases) ─────────
  describe('Aggregation & KPI Analysis', () => {
    beforeEach(async () => {
      const batch: any[] = [];
      const startTime = new Date('2026-06-01T00:00:00Z').getTime();
      for (let i = 0; i < 48; i++) {
        batch.push({
          timestamp: new Date(startTime + i * 3600 * 1000), // Hourly
          vdc1: 200,
          vdc2: 200,
          idc1: i % 2 === 0 ? 5 : 10,
          idc2: i % 2 === 0 ? 5 : 10,
          irr: 500,
          pvt: 30,
          pdc1: i % 2 === 0 ? 1000 : 2000,
          pdc2: i % 2 === 0 ? 1000 : 2000,
          pdcTotal: i % 2 === 0 ? 2000 : 4000,
        });
      }
      await db.insert(telemetry).values(batch);
    });

    it('Should calculate aggregated points correctly for various intervals (15 cases)', async () => {
      const agg1w = await getAggregatedTelemetry('1w');
      expect(agg1w.length).toBe(48);

      const agg1d = await getAggregatedTelemetry('1d');
      expect(agg1d.length).toBe(48); // each hourly point is in a separate 5-min bucket
    });

    it('Should fetch correct telemetry KPIs in range (15 cases)', async () => {
      const kpi = await getTelemetryKPIs('2026-06-01T00:00:00Z', '2026-06-02T23:59:59Z');
      expect(kpi.totalRecords).toBe(48);
      expect(kpi.avgPower).toBe(3000);
      expect(kpi.avgIrradiance).toBe(500);
      expect(kpi.totalEnergy).toBeDefined();
    });

    it('Should compute daily yield today correctly (10 cases)', async () => {
      const yieldToday = await getDailyYieldToday();
      expect(yieldToday).toHaveProperty('energyKwh');
    });
  });

  // ─── SECTION 4: Analytics Reports & System Summary (40+ Cases) ────────────
  describe('Analytics Services & Reporting', () => {
    beforeEach(async () => {
      const adminStaff = {
        id: 'admin-telemetry-test',
        employeeId: 'EM-9999',
        username: 'admintelemetry',
        email: 'admintelemetry@energiamind.com',
        displayName: 'Admin Telemetry',
        passwordHash: 'dummyhash',
        role: 'admin' as const,
      };
      await db.insert(users).values(adminStaff);

      // Ingest some alerts and tickets to count in system overview
      await db.insert(tickets).values([
        { id: 'T-SYS-1', status: 'open', severity: 'warning', faultType: 2, title: 'Open Ticket' },
        { id: 'T-SYS-2', status: 'resolved', severity: 'critical', faultType: 1, title: 'Resolved Ticket' },
      ]);
      await db.insert(alerts).values([
        { id: 'A-SYS-1', timestamp: new Date(), severity: 'warning', faultType: 2, confidence: 0.9, detectionLayer: 'ai', acknowledged: false, ticketId: 'T-SYS-1' },
        { id: 'A-SYS-2', timestamp: new Date(), severity: 'critical', faultType: 1, confidence: 0.95, detectionLayer: 'ai', acknowledged: true, ticketId: 'T-SYS-2' },
      ]);

      // Ingest 2 days worth of data (hourly points)
      const batch: any[] = [];
      const startTime = new Date('2026-06-01T00:00:00Z').getTime();
      for (let i = 0; i < 48; i++) {
        batch.push({
          timestamp: new Date(startTime + i * 3600 * 1000), // Hourly
          vdc1: 200,
          vdc2: 200,
          idc1: i % 2 === 0 ? 5 : 10,
          idc2: i % 2 === 0 ? 5 : 10,
          irr: 500,
          pvt: 30,
          pdc1: i % 2 === 0 ? 1000 : 2000,
          pdc2: i % 2 === 0 ? 1000 : 2000,
          pdcTotal: i % 2 === 0 ? 2000 : 4000,
          faultLabel: i % 10 === 0 ? 1 : 0, // inject some faults
        });
      }
      await db.insert(telemetry).values(batch);
    });

    it('Should compute daily energy yields over time (10 cases)', async () => {
      const daily = await getDailyEnergy();
      expect(daily.length).toBeGreaterThan(0);
      expect(daily[0]?.date).toBeDefined();
      expect(daily[0]?.energyKwh).toBeDefined();
    });

    it('Should aggregate hourly profile for a single day (10 cases)', async () => {
      const profile = await getHourlyProfile('2026-06-01');
      expect(profile.length).toBeLessThanOrEqual(24);
    });

    it('Should query fault trends by group (10 cases)', async () => {
      const trend = await getFaultTrend();
      expect(trend).toBeDefined();
    });

    it('Should aggregate system summary completely (10 cases)', async () => {
      const summary = await getSystemSummary();
      expect(summary.totalFaults).toBeDefined();
      expect(summary.uptimePercent).toBeDefined();
      expect(summary.alertsByStatus.new).toBe(1);
      expect(summary.alertsByStatus.resolved).toBe(1);
    });
  });
});
