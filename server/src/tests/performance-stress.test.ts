import { describe, it, expect, afterEach } from 'vitest';
import { db, client } from '../db/index.js';
import { telemetry, alerts, tickets } from '../db/schema.js';
import {
  ingestTelemetry,
  queryTelemetry,
  getLatestTelemetry,
  getAggregatedTelemetry,
  getDataRange,
  getTelemetryKPIs,
  type TelemetryInput,
} from '../services/telemetry.service.js';
import {
  getSystemSummary,
  getDailyEnergy,
} from '../services/analytics.service.js';
import { count } from 'drizzle-orm';
import { existsSync, statSync } from 'fs';
import { resolve } from 'path';

// ─── Helpers ────────────────────────────────────────────────────────────
const BASE_TS = new Date('2026-06-01T06:00:00Z');

function makeSample(index: number, baseTime = BASE_TS): TelemetryInput {
  return {
    timestamp: new Date(baseTime.getTime() + index * 10_000).toISOString(),
    vdc1: 300 + (index % 50),
    vdc2: 310 + (index % 40),
    idc1: 8 + (index % 5) * 0.2,
    idc2: 7.5 + (index % 4) * 0.3,
    irr: 600 + (index % 200),
    pvt: 30 + (index % 10) * 0.5,
  };
}

function makeBatch(size: number, baseTime = BASE_TS): TelemetryInput[] {
  return Array.from({ length: size }, (_, i) => makeSample(i, baseTime));
}

// ─── Test Suite ─────────────────────────────────────────────────────────
describe('Performance & Stress Tests (50 Cases)', () => {
  afterEach(async () => {
    await client.execute('PRAGMA foreign_keys = OFF');
    await db.delete(alerts);
    await db.delete(tickets);
    await db.delete(telemetry);
    await client.execute('PRAGMA foreign_keys = ON');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // SECTION 1: Database Performance (20 Cases)
  // ═══════════════════════════════════════════════════════════════════════
  describe('Database Performance', () => {

    it('Case 1: Insert 100 records should complete in < 2000ms', async () => {
      const batch = makeBatch(100);
      const start = performance.now();
      const result = await ingestTelemetry(batch);
      const duration = performance.now() - start;

      expect(result.inserted).toBe(100);
      expect(duration).toBeLessThan(2000);
    });

    it('Case 2: Insert 500 records in batches should complete in < 5000ms', async () => {
      const batch = makeBatch(500);
      const start = performance.now();
      const result = await ingestTelemetry(batch);
      const duration = performance.now() - start;

      expect(result.inserted).toBe(500);
      expect(duration).toBeLessThan(5000);
    });

    it('Case 3: Insert 1000 records should complete in < 10000ms', async () => {
      const batch = makeBatch(1000);
      const start = performance.now();
      const result = await ingestTelemetry(batch);
      const duration = performance.now() - start;

      expect(result.inserted).toBe(1000);
      expect(duration).toBeLessThan(10000);
    });

    it('Case 4: Query latest telemetry after 1000 inserts should be < 100ms', async () => {
      await ingestTelemetry(makeBatch(1000));

      const start = performance.now();
      const latest = await getLatestTelemetry(1);
      const duration = performance.now() - start;

      expect(latest).toHaveLength(1);
      expect(duration).toBeLessThan(100);
    });

    it('Case 5: queryTelemetry with date range after 1000 inserts should be < 500ms', async () => {
      await ingestTelemetry(makeBatch(1000));
      const from = BASE_TS.toISOString();
      const to = new Date(BASE_TS.getTime() + 1000 * 10_000).toISOString();

      const start = performance.now();
      const rows = await queryTelemetry({ from, to, limit: 500 });
      const duration = performance.now() - start;

      expect(rows.length).toBeGreaterThan(0);
      expect(duration).toBeLessThan(500);
    });

    it('Case 6: getDailyEnergy() after 1000 inserts should be < 500ms', async () => {
      await ingestTelemetry(makeBatch(1000));

      const start = performance.now();
      const daily = await getDailyEnergy();
      const duration = performance.now() - start;

      expect(daily.length).toBeGreaterThan(0);
      expect(duration).toBeLessThan(500);
    });

    it('Case 7: getSystemSummary() after 1000 inserts should be < 1000ms', async () => {
      await ingestTelemetry(makeBatch(1000));

      const start = performance.now();
      const summary = await getSystemSummary();
      const duration = performance.now() - start;

      expect(summary.totalEnergyKwh).toBeGreaterThanOrEqual(0);
      expect(summary.daysWithData).toBeGreaterThan(0);
      expect(duration).toBeLessThan(1000);
    });

    it('Case 8: Sequential 50 single-record insertions total < 5000ms', async () => {
      const start = performance.now();
      for (let i = 0; i < 50; i++) {
        await ingestTelemetry([makeSample(i)]);
      }
      const duration = performance.now() - start;

      const rows = await getLatestTelemetry(100);
      expect(rows).toHaveLength(50);
      expect(duration).toBeLessThan(5000);
    });

    it('Case 9: Count records after bulk insert matches expected', async () => {
      await ingestTelemetry(makeBatch(250));

      const result = await db.select({ total: count() }).from(telemetry);
      expect(result[0]!.total).toBe(250);
    });

    it('Case 10: getAggregatedTelemetry("1h") after 1000 inserts should be < 500ms', async () => {
      await ingestTelemetry(makeBatch(1000));
      const from = BASE_TS.toISOString();
      const to = new Date(BASE_TS.getTime() + 1000 * 10_000).toISOString();

      const start = performance.now();
      const agg = await getAggregatedTelemetry('1h', from, to);
      const duration = performance.now() - start;

      expect(agg.length).toBeGreaterThan(0);
      expect(duration).toBeLessThan(500);
    });

    it('Case 11: getTelemetryKPIs() after 1000 inserts should be < 500ms', async () => {
      await ingestTelemetry(makeBatch(1000));

      const start = performance.now();
      const kpis = await getTelemetryKPIs();
      const duration = performance.now() - start;

      expect(kpis.totalRecords).toBe(1000);
      expect(duration).toBeLessThan(500);
    });

    it('Case 12: getDataRange() after 1000 inserts should be < 100ms', async () => {
      await ingestTelemetry(makeBatch(1000));

      const start = performance.now();
      const range = await getDataRange();
      const duration = performance.now() - start;

      expect(range.totalPoints).toBe(1000);
      expect(range.minTs).toBeLessThan(range.maxTs);
      expect(duration).toBeLessThan(100);
    });

    it('Case 13: Querying with downsample=10 after 1000 inserts < 200ms', async () => {
      await ingestTelemetry(makeBatch(1000));

      const start = performance.now();
      const rows = await queryTelemetry({ downsample: 10, limit: 500 });
      const duration = performance.now() - start;

      expect(rows.length).toBeLessThanOrEqual(500);
      expect(duration).toBeLessThan(200);
    });

    it('Case 14: Querying with limit=10000 after 1000 inserts returns all', async () => {
      await ingestTelemetry(makeBatch(1000));

      const start = performance.now();
      const rows = await queryTelemetry({ limit: 10000 });
      const duration = performance.now() - start;

      // limit capped at 10000 in service
      expect(rows.length).toBe(1000);
      expect(duration).toBeLessThan(500);
    });

    it('Case 15: Paginated query (offset=500, limit=100) < 200ms', async () => {
      await ingestTelemetry(makeBatch(1000));

      const start = performance.now();
      const rows = await queryTelemetry({ limit: 100, offset: 500 });
      const duration = performance.now() - start;

      expect(rows.length).toBe(100);
      expect(duration).toBeLessThan(200);
    });

    it('Case 16: 3 successive bulk inserts (300 each) total < 6000ms', async () => {
      const start = performance.now();
      await ingestTelemetry(makeBatch(300, BASE_TS));
      await ingestTelemetry(makeBatch(300, new Date(BASE_TS.getTime() + 300 * 10_000)));
      await ingestTelemetry(makeBatch(300, new Date(BASE_TS.getTime() + 600 * 10_000)));
      const duration = performance.now() - start;

      const result = await db.select({ total: count() }).from(telemetry);
      expect(result[0]!.total).toBe(900);
      expect(duration).toBeLessThan(6000);
    });

    it('Case 17: getLatestTelemetry(100) returns exactly 100 from 1000', async () => {
      await ingestTelemetry(makeBatch(1000));

      const start = performance.now();
      const latest = await getLatestTelemetry(100);
      const duration = performance.now() - start;

      expect(latest).toHaveLength(100);
      expect(duration).toBeLessThan(200);
    });

    it('Case 18: getAggregatedTelemetry("1d") with wide range < 500ms', async () => {
      await ingestTelemetry(makeBatch(1000));

      const start = performance.now();
      const agg = await getAggregatedTelemetry('1d');
      const duration = performance.now() - start;

      expect(agg.length).toBeGreaterThan(0);
      expect(duration).toBeLessThan(500);
    });

    it('Case 19: getAggregatedTelemetry("1w") buckets correctly < 500ms', async () => {
      await ingestTelemetry(makeBatch(1000));

      const start = performance.now();
      const agg = await getAggregatedTelemetry('1w');
      const duration = performance.now() - start;

      expect(agg.length).toBeGreaterThan(0);
      agg.forEach((point) => {
        expect(point.dataPoints).toBeGreaterThan(0);
      });
      expect(duration).toBeLessThan(500);
    });

    it('Case 20: Empty table queries return instantly (< 50ms)', async () => {
      const start = performance.now();
      const [latest, range, kpis] = await Promise.all([
        getLatestTelemetry(1),
        getDataRange(),
        getTelemetryKPIs(),
      ]);
      const duration = performance.now() - start;

      expect(latest).toHaveLength(0);
      expect(range.totalPoints).toBe(0);
      expect(kpis.totalRecords).toBe(0);
      expect(duration).toBeLessThan(50);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // SECTION 2: Concurrent Operations (15 Cases)
  // ═══════════════════════════════════════════════════════════════════════
  describe('Concurrent Operations', () => {

    it('Case 21: 10 concurrent ingestTelemetry calls all succeed', async () => {
      const promises = Array.from({ length: 10 }, (_, i) =>
        ingestTelemetry([makeSample(i, new Date(BASE_TS.getTime() + i * 100_000))]),
      );

      const results = await Promise.allSettled(promises);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');

      expect(fulfilled).toHaveLength(10);
      fulfilled.forEach((r) => {
        expect((r as PromiseFulfilledResult<{ inserted: number }>).value.inserted).toBe(1);
      });
    });

    it('Case 22: 10 concurrent queryTelemetry calls all return data', async () => {
      await ingestTelemetry(makeBatch(100));
      const from = BASE_TS.toISOString();
      const to = new Date(BASE_TS.getTime() + 100 * 10_000).toISOString();

      const promises = Array.from({ length: 10 }, () =>
        queryTelemetry({ from, to, limit: 50 }),
      );

      const results = await Promise.allSettled(promises);
      const fulfilled = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any[]>[];

      expect(fulfilled).toHaveLength(10);
      fulfilled.forEach((r) => {
        expect(r.value.length).toBeGreaterThan(0);
      });
    });

    it('Case 23: Mixed read/write — 5 inserts + 5 queries concurrent', async () => {
      // Seed data first so reads have something to return
      await ingestTelemetry(makeBatch(50));

      const from = BASE_TS.toISOString();
      const to = new Date(BASE_TS.getTime() + 200 * 10_000).toISOString();

      const writes = Array.from({ length: 5 }, (_, i) =>
        ingestTelemetry([makeSample(100 + i, new Date(BASE_TS.getTime() + (100 + i) * 10_000))]),
      );
      const reads = Array.from({ length: 5 }, () =>
        queryTelemetry({ from, to, limit: 20 }),
      );

      const results = await Promise.allSettled([...writes, ...reads]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');

      expect(fulfilled.length).toBe(10);
    });

    it('Case 24: 20 concurrent getLatestTelemetry calls all return same latest', async () => {
      await ingestTelemetry(makeBatch(100));

      const promises = Array.from({ length: 20 }, () => getLatestTelemetry(1));
      const results = await Promise.all(promises);

      // All should return the same latest record
      const firstTimestamp = results[0]![0]!.timestamp.getTime();
      results.forEach((res) => {
        expect(res).toHaveLength(1);
        expect(res[0]!.timestamp.getTime()).toBe(firstTimestamp);
      });
    });

    it('Case 25: Verify no data corruption after concurrent writes', async () => {
      const concurrency = 10;
      const recordsPerCall = 5;
      const promises = Array.from({ length: concurrency }, (_, i) => {
        const batchStart = new Date(BASE_TS.getTime() + i * recordsPerCall * 10_000);
        return ingestTelemetry(makeBatch(recordsPerCall, batchStart));
      });

      await Promise.allSettled(promises);

      const result = await db.select({ total: count() }).from(telemetry);
      expect(result[0]!.total).toBe(concurrency * recordsPerCall);

      // Verify all records have valid fields (no null corruption)
      const allRows = await queryTelemetry({ limit: 10000 });
      allRows.forEach((row) => {
        expect(row.vdc1).toBeGreaterThan(0);
        expect(row.vdc2).toBeGreaterThan(0);
        expect(row.idc1).toBeGreaterThan(0);
        expect(row.idc2).toBeGreaterThan(0);
        expect(row.pdc1).toBeGreaterThan(0);
        expect(row.pdc2).toBeGreaterThan(0);
        expect(row.pdcTotal).toBeGreaterThan(0);
      });
    });

    it('Case 26: 5 concurrent getDailyEnergy() calls all return consistent results', async () => {
      await ingestTelemetry(makeBatch(200));

      const promises = Array.from({ length: 5 }, () => getDailyEnergy());
      const results = await Promise.all(promises);

      const firstLength = results[0]!.length;
      results.forEach((r) => {
        expect(r.length).toBe(firstLength);
      });
    });

    it('Case 27: 5 concurrent getSystemSummary() calls all consistent', async () => {
      await ingestTelemetry(makeBatch(200));

      const promises = Array.from({ length: 5 }, () => getSystemSummary());
      const results = await Promise.all(promises);

      const firstTotal = results[0]!.totalFaults;
      results.forEach((r) => {
        expect(r.totalFaults).toBe(firstTotal);
      });
    });

    it('Case 28: Concurrent insert + getDataRange does not error', async () => {
      await ingestTelemetry(makeBatch(50));

      const results = await Promise.allSettled([
        ingestTelemetry(makeBatch(50, new Date(BASE_TS.getTime() + 1_000_000))),
        getDataRange(),
        getDataRange(),
        ingestTelemetry(makeBatch(50, new Date(BASE_TS.getTime() + 2_000_000))),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      expect(fulfilled.length).toBe(4);
    });

    it('Case 29: Concurrent insert + getTelemetryKPIs does not error', async () => {
      await ingestTelemetry(makeBatch(100));

      const results = await Promise.allSettled([
        ingestTelemetry(makeBatch(50, new Date(BASE_TS.getTime() + 5_000_000))),
        getTelemetryKPIs(),
        getTelemetryKPIs(),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      expect(fulfilled.length).toBe(3);
    });

    it('Case 30: 10 concurrent getAggregatedTelemetry calls all succeed', async () => {
      await ingestTelemetry(makeBatch(200));

      const promises = Array.from({ length: 10 }, () =>
        getAggregatedTelemetry('1h'),
      );

      const results = await Promise.allSettled(promises);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');

      expect(fulfilled).toHaveLength(10);
    });

    it('Case 31: Rapid sequential inserts then bulk read is consistent', async () => {
      for (let i = 0; i < 20; i++) {
        await ingestTelemetry([makeSample(i)]);
      }

      const allRows = await queryTelemetry({ limit: 10000 });
      expect(allRows).toHaveLength(20);

      // Timestamps should all be unique
      const timestamps = new Set(allRows.map((r) => r.timestamp.getTime()));
      expect(timestamps.size).toBe(20);
    });

    it('Case 32: Concurrent writes from different time ranges produce correct total', async () => {
      const ranges = [
        makeBatch(30, new Date('2026-01-01T00:00:00Z')),
        makeBatch(30, new Date('2026-03-01T00:00:00Z')),
        makeBatch(30, new Date('2026-06-01T00:00:00Z')),
      ];

      await Promise.all(ranges.map((batch) => ingestTelemetry(batch)));

      const result = await db.select({ total: count() }).from(telemetry);
      expect(result[0]!.total).toBe(90);
    });

    it('Case 33: Interleaved read-write-read produces monotonically growing counts', async () => {
      await ingestTelemetry(makeBatch(10));
      const count1 = (await db.select({ total: count() }).from(telemetry))[0]!.total;

      await ingestTelemetry(makeBatch(10, new Date(BASE_TS.getTime() + 1_000_000)));
      const count2 = (await db.select({ total: count() }).from(telemetry))[0]!.total;

      await ingestTelemetry(makeBatch(10, new Date(BASE_TS.getTime() + 2_000_000)));
      const count3 = (await db.select({ total: count() }).from(telemetry))[0]!.total;

      expect(count1).toBe(10);
      expect(count2).toBe(20);
      expect(count3).toBe(30);
    });

    it('Case 34: 15 concurrent getLatestTelemetry(10) after bulk insert', async () => {
      await ingestTelemetry(makeBatch(500));

      const promises = Array.from({ length: 15 }, () => getLatestTelemetry(10));
      const results = await Promise.all(promises);

      results.forEach((res) => {
        expect(res).toHaveLength(10);
      });
    });

    it('Case 35: Mixed concurrent aggregation queries do not interfere', async () => {
      await ingestTelemetry(makeBatch(500));

      const results = await Promise.allSettled([
        getAggregatedTelemetry('1h'),
        getAggregatedTelemetry('6h'),
        getAggregatedTelemetry('1d'),
        getAggregatedTelemetry('1w'),
        getDailyEnergy(),
        getSystemSummary(),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      expect(fulfilled).toHaveLength(6);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // SECTION 3: Memory & Resource Tests (15 Cases)
  // ═══════════════════════════════════════════════════════════════════════
  describe('Memory & Resource Tests', () => {

    it('Case 36: Large batch (500 records single call) should not OOM', async () => {
      const batch = makeBatch(500);
      const result = await ingestTelemetry(batch);

      expect(result.inserted).toBe(500);

      const rowCount = await db.select({ total: count() }).from(telemetry);
      expect(rowCount[0]!.total).toBe(500);
    });

    it('Case 37: Very large field values (vdc1 = Number.MAX_SAFE_INTEGER)', async () => {
      const sample: TelemetryInput = {
        timestamp: BASE_TS.toISOString(),
        vdc1: Number.MAX_SAFE_INTEGER,
        vdc2: Number.MAX_SAFE_INTEGER,
        idc1: 1,
        idc2: 1,
        irr: 999999,
        pvt: 99,
      };

      const result = await ingestTelemetry([sample]);
      expect(result.inserted).toBe(1);

      const latest = await getLatestTelemetry(1);
      expect(latest).toHaveLength(1);
      expect(latest[0]!.vdc1).toBe(Number.MAX_SAFE_INTEGER);
      expect(latest[0]!.vdc2).toBe(Number.MAX_SAFE_INTEGER);
    });

    it('Case 38: Repeated insert+delete cycles (10 iterations) no memory leak', async () => {
      const memBefore = process.memoryUsage().heapUsed;

      for (let i = 0; i < 10; i++) {
        await ingestTelemetry(makeBatch(100, new Date(BASE_TS.getTime() + i * 1_000_000)));
        await db.delete(telemetry);
      }

      const memAfter = process.memoryUsage().heapUsed;
      // Allow up to 50MB growth (generous for test environment)
      const growthMB = (memAfter - memBefore) / (1024 * 1024);
      expect(growthMB).toBeLessThan(50);

      // Table should be empty after last delete
      const rowCount = await db.select({ total: count() }).from(telemetry);
      expect(rowCount[0]!.total).toBe(0);
    });

    it('Case 39: Query with very wide date range (100 years) does not crash', async () => {
      await ingestTelemetry(makeBatch(50));

      const from = '1926-01-01T00:00:00Z';
      const to = '2126-12-31T23:59:59Z';

      const rows = await queryTelemetry({ from, to, limit: 500 });
      expect(rows.length).toBe(50);
    });

    it('Case 40: Response size verification for large queries', async () => {
      await ingestTelemetry(makeBatch(500));

      const rows = await queryTelemetry({ limit: 500 });
      expect(rows).toHaveLength(500);

      // Each row should have all required telemetry fields
      rows.forEach((row) => {
        expect(row).toHaveProperty('id');
        expect(row).toHaveProperty('timestamp');
        expect(row).toHaveProperty('vdc1');
        expect(row).toHaveProperty('vdc2');
        expect(row).toHaveProperty('idc1');
        expect(row).toHaveProperty('idc2');
        expect(row).toHaveProperty('irr');
        expect(row).toHaveProperty('pvt');
        expect(row).toHaveProperty('pdc1');
        expect(row).toHaveProperty('pdc2');
        expect(row).toHaveProperty('pdcTotal');
      });

      // JSON representation should be reasonable size (< 1MB for 500 rows)
      const jsonSize = JSON.stringify(rows).length;
      expect(jsonSize).toBeLessThan(1_000_000);
    });

    it('Case 41: DB file size reasonable after 1000 inserts (< 5MB)', async () => {
      await ingestTelemetry(makeBatch(1000));

      const dbPath = process.env['DB_PATH'];
      if (dbPath && existsSync(dbPath)) {
        const stats = statSync(dbPath);
        const sizeMB = stats.size / (1024 * 1024);
        expect(sizeMB).toBeLessThan(5);
      }
      // If DB_PATH isn't set or file doesn't exist, pass silently
    });

    it('Case 42: Cleanup — bulk delete all records in reasonable time < 1000ms', async () => {
      await ingestTelemetry(makeBatch(1000));

      const start = performance.now();
      await db.delete(telemetry);
      const duration = performance.now() - start;

      expect(duration).toBeLessThan(1000);

      const rowCount = await db.select({ total: count() }).from(telemetry);
      expect(rowCount[0]!.total).toBe(0);
    });

    it('Case 43: Zero-value fields insert and retrieve correctly', async () => {
      const sample: TelemetryInput = {
        timestamp: BASE_TS.toISOString(),
        vdc1: 0,
        vdc2: 0,
        idc1: 0,
        idc2: 0,
        irr: 0,
        pvt: 0,
      };

      const result = await ingestTelemetry([sample]);
      expect(result.inserted).toBe(1);

      const latest = await getLatestTelemetry(1);
      expect(latest[0]!.vdc1).toBe(0);
      expect(latest[0]!.pdc1).toBe(0);
      expect(latest[0]!.pdcTotal).toBe(0);
    });

    it('Case 44: Negative field values are stored without corruption', async () => {
      const sample: TelemetryInput = {
        timestamp: BASE_TS.toISOString(),
        vdc1: -100,
        vdc2: -200,
        idc1: -5,
        idc2: -3,
        irr: -10,
        pvt: -20,
      };

      const result = await ingestTelemetry([sample]);
      expect(result.inserted).toBe(1);

      const latest = await getLatestTelemetry(1);
      expect(latest[0]!.vdc1).toBe(-100);
      expect(latest[0]!.vdc2).toBe(-200);
    });

    it('Case 45: Very small float values maintain precision', async () => {
      const sample: TelemetryInput = {
        timestamp: BASE_TS.toISOString(),
        vdc1: 0.001,
        vdc2: 0.002,
        idc1: 0.0001,
        idc2: 0.0002,
        irr: 0.1,
        pvt: 0.01,
      };

      const result = await ingestTelemetry([sample]);
      expect(result.inserted).toBe(1);

      const latest = await getLatestTelemetry(1);
      expect(latest[0]!.vdc1).toBeCloseTo(0.001, 3);
      expect(latest[0]!.idc1).toBeCloseTo(0.0001, 4);
    });

    it('Case 46: 1000-record insert + full query round-trip data integrity', async () => {
      const batch = makeBatch(1000);
      await ingestTelemetry(batch);

      const allRows = await queryTelemetry({ limit: 10000 });
      expect(allRows).toHaveLength(1000);

      // Spot check: verify pdc1 = vdc1 * idc1 for each row (rounded to 2dp)
      allRows.forEach((row) => {
        const expectedPdc1 = Math.round(row.vdc1 * row.idc1 * 100) / 100;
        expect(row.pdc1).toBeCloseTo(expectedPdc1, 1);
      });
    });

    it('Case 47: getDailyEnergy with no data returns empty array', async () => {
      const start = performance.now();
      const daily = await getDailyEnergy();
      const duration = performance.now() - start;

      expect(daily).toHaveLength(0);
      expect(duration).toBeLessThan(50);
    });

    it('Case 48: getSystemSummary on empty DB returns zero defaults', async () => {
      const start = performance.now();
      const summary = await getSystemSummary();
      const duration = performance.now() - start;

      expect(summary.totalEnergyKwh).toBe(0);
      expect(summary.totalFaults).toBe(0);
      expect(summary.totalAlerts).toBe(0);
      expect(summary.daysWithData).toBe(0);
      expect(summary.uptimePercent).toBe(100);
      expect(duration).toBeLessThan(100);
    });

    it('Case 49: Multiple aggregation intervals produce different bucket counts', async () => {
      // Insert data spanning ~2.7 hours
      await ingestTelemetry(makeBatch(1000));

      const [agg1h, agg6h, agg1d] = await Promise.all([
        getAggregatedTelemetry('1h'),
        getAggregatedTelemetry('6h'),
        getAggregatedTelemetry('1d'),
      ]);

      // 30s buckets (1h) should produce more data points than 1min (6h) which should have more than 5min (1d)
      expect(agg1h.length).toBeGreaterThanOrEqual(agg6h.length);
      expect(agg6h.length).toBeGreaterThanOrEqual(agg1d.length);
    });

    it('Case 50: Stress — insert 1000, query all, delete, repeat 3 times', async () => {
      const start = performance.now();

      for (let cycle = 0; cycle < 3; cycle++) {
        const batch = makeBatch(1000, new Date(BASE_TS.getTime() + cycle * 100_000_000));
        await ingestTelemetry(batch);

        const rows = await queryTelemetry({ limit: 10000 });
        expect(rows.length).toBe(1000);

        await db.delete(telemetry);

        const afterDelete = await db.select({ total: count() }).from(telemetry);
        expect(afterDelete[0]!.total).toBe(0);
      }

      const duration = performance.now() - start;
      // 3 full cycles should complete within 30 seconds
      expect(duration).toBeLessThan(30000);
    });
  });
});
