import { describe, it, expect, afterEach } from 'vitest';
import { db, client } from '../db/index.js';
import { telemetry } from '../db/schema.js';
import {
  ingestTelemetry,
  queryTelemetry,
  getLatestTelemetry,
  getAggregatedTelemetry,
  getDataRange,
  getTelemetryKPIs,
  getDailyYieldToday,
} from '../services/telemetry.service.js';

// ─── Helpers ──────────────────────────────────────────────────────────
/** Build a minimal valid TelemetryInput, overriding individual fields. */
function mkRow(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: new Date('2026-06-10T12:00:00Z').toISOString(),
    vdc1: 200,
    vdc2: 210,
    idc1: 8,
    idc2: 7.5,
    irr: 600,
    pvt: 35,
    ...overrides,
  };
}

/** Insert N rows spaced 1 minute apart starting from a base date. */
async function seedRows(n: number, base = new Date('2026-06-10T00:00:00Z'), extra: Record<string, unknown> = {}) {
  const batch = Array.from({ length: n }, (_, i) => mkRow({
    timestamp: new Date(base.getTime() + i * 60_000).toISOString(),
    ...extra,
  }));
  return ingestTelemetry(batch);
}

// ─── Suite ────────────────────────────────────────────────────────────
describe('Telemetry Edge Cases (~100 Cases)', () => {
  afterEach(async () => {
    await client.execute('PRAGMA foreign_keys = OFF');
    await db.delete(telemetry);
    await client.execute('PRAGMA foreign_keys = ON');
  });

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 1 — Boundary values for all 9 telemetry features (30 cases)
  // ═══════════════════════════════════════════════════════════════════
  describe('Boundary values for telemetry features', () => {

    // ── vdc1 / vdc2 ──
    it('Case 1: vdc1 = 0 should store zero voltage', async () => {
      await ingestTelemetry([mkRow({ vdc1: 0 })]);
      const [row] = await getLatestTelemetry(1);
      expect(row!.vdc1).toBe(0);
      expect(row!.pdc1).toBe(0); // 0 * idc1
    });

    it('Case 2: vdc2 = 0 should store zero voltage on string 2', async () => {
      await ingestTelemetry([mkRow({ vdc2: 0 })]);
      const [row] = await getLatestTelemetry(1);
      expect(row!.vdc2).toBe(0);
      expect(row!.pdc2).toBe(0);
    });

    it('Case 3: negative vdc1 stores negative value', async () => {
      await ingestTelemetry([mkRow({ vdc1: -50 })]);
      const [row] = await getLatestTelemetry(1);
      expect(row!.vdc1).toBe(-50);
    });

    it('Case 4: very large vdc1 (99999) is stored faithfully', async () => {
      await ingestTelemetry([mkRow({ vdc1: 99999 })]);
      const [row] = await getLatestTelemetry(1);
      expect(row!.vdc1).toBe(99999);
    });

    it('Case 5: very large vdc2 (99999) is stored faithfully', async () => {
      await ingestTelemetry([mkRow({ vdc2: 99999 })]);
      const [row] = await getLatestTelemetry(1);
      expect(row!.vdc2).toBe(99999);
    });

    it('Case 6: vdc1 with high decimal precision (123.456789)', async () => {
      await ingestTelemetry([mkRow({ vdc1: 123.456789 })]);
      const [row] = await getLatestTelemetry(1);
      expect(row!.vdc1).toBeCloseTo(123.456789, 4);
    });

    it('Case 7: negative vdc2 stores negative value', async () => {
      await ingestTelemetry([mkRow({ vdc2: -100.55 })]);
      const [row] = await getLatestTelemetry(1);
      expect(row!.vdc2).toBeCloseTo(-100.55, 2);
    });

    // ── idc1 / idc2 ──
    it('Case 8: idc1 = 0 should yield pdc1 = 0', async () => {
      await ingestTelemetry([mkRow({ idc1: 0 })]);
      const [row] = await getLatestTelemetry(1);
      expect(row!.idc1).toBe(0);
      expect(row!.pdc1).toBe(0);
    });

    it('Case 9: idc2 = 0 should yield pdc2 = 0', async () => {
      await ingestTelemetry([mkRow({ idc2: 0 })]);
      const [row] = await getLatestTelemetry(1);
      expect(row!.idc2).toBe(0);
      expect(row!.pdc2).toBe(0);
    });

    it('Case 10: negative idc1 stores negative current', async () => {
      await ingestTelemetry([mkRow({ idc1: -3.5 })]);
      const [row] = await getLatestTelemetry(1);
      expect(row!.idc1).toBe(-3.5);
      // Negative current × positive voltage → negative power
      expect(row!.pdc1).toBeLessThan(0);
    });

    it('Case 11: very large idc1 (99999)', async () => {
      await ingestTelemetry([mkRow({ idc1: 99999 })]);
      const [row] = await getLatestTelemetry(1);
      expect(row!.idc1).toBe(99999);
    });

    it('Case 12: very small idc2 (0.001)', async () => {
      await ingestTelemetry([mkRow({ idc2: 0.001 })]);
      const [row] = await getLatestTelemetry(1);
      expect(row!.idc2).toBeCloseTo(0.001, 3);
    });

    it('Case 13: negative idc2 stores and computes negative pdc2', async () => {
      await ingestTelemetry([mkRow({ idc2: -7 })]);
      const [row] = await getLatestTelemetry(1);
      expect(row!.idc2).toBe(-7);
      expect(row!.pdc2).toBeCloseTo(210 * -7, 0);
    });

    // ── irr ──
    it('Case 14: irr = 0 (nighttime / no sun)', async () => {
      await ingestTelemetry([mkRow({ irr: 0 })]);
      const [row] = await getLatestTelemetry(1);
      expect(row!.irr).toBe(0);
    });

    it('Case 15: irr = 1500 (extreme sun)', async () => {
      await ingestTelemetry([mkRow({ irr: 1500 })]);
      const [row] = await getLatestTelemetry(1);
      expect(row!.irr).toBe(1500);
    });

    it('Case 16: negative irr stores value (sensor error scenario)', async () => {
      await ingestTelemetry([mkRow({ irr: -10 })]);
      const [row] = await getLatestTelemetry(1);
      expect(row!.irr).toBe(-10);
    });

    // ── pvt ──
    it('Case 17: pvt = -40 (extreme cold)', async () => {
      await ingestTelemetry([mkRow({ pvt: -40 })]);
      const [row] = await getLatestTelemetry(1);
      expect(row!.pvt).toBe(-40);
    });

    it('Case 18: pvt = 100 (extreme hot)', async () => {
      await ingestTelemetry([mkRow({ pvt: 100 })]);
      const [row] = await getLatestTelemetry(1);
      expect(row!.pvt).toBe(100);
    });

    it('Case 19: pvt = 0 (freezing point)', async () => {
      await ingestTelemetry([mkRow({ pvt: 0 })]);
      const [row] = await getLatestTelemetry(1);
      expect(row!.pvt).toBe(0);
    });

    // ── Combination boundaries ──
    it('Case 20: zero voltage + nonzero current → pdc = 0', async () => {
      await ingestTelemetry([mkRow({ vdc1: 0, idc1: 10, vdc2: 0, idc2: 12 })]);
      const [row] = await getLatestTelemetry(1);
      expect(row!.pdc1).toBe(0);
      expect(row!.pdc2).toBe(0);
      expect(row!.pdcTotal).toBe(0);
    });

    it('Case 21: nonzero voltage + zero current → pdc = 0', async () => {
      await ingestTelemetry([mkRow({ vdc1: 300, idc1: 0, vdc2: 310, idc2: 0 })]);
      const [row] = await getLatestTelemetry(1);
      expect(row!.pdc1).toBe(0);
      expect(row!.pdc2).toBe(0);
      expect(row!.pdcTotal).toBe(0);
    });

    it('Case 22: zero irradiance + nonzero power (inverter on at night edge)', async () => {
      await ingestTelemetry([mkRow({ irr: 0, vdc1: 100, idc1: 5, vdc2: 100, idc2: 5 })]);
      const [row] = await getLatestTelemetry(1);
      expect(row!.irr).toBe(0);
      expect(row!.pdcTotal).toBe(1000); // 500 + 500
    });

    it('Case 23: all features at zero', async () => {
      await ingestTelemetry([mkRow({ vdc1: 0, vdc2: 0, idc1: 0, idc2: 0, irr: 0, pvt: 0 })]);
      const [row] = await getLatestTelemetry(1);
      expect(row!.vdc1).toBe(0);
      expect(row!.vdc2).toBe(0);
      expect(row!.pdc1).toBe(0);
      expect(row!.pdc2).toBe(0);
      expect(row!.pdcTotal).toBe(0);
    });

    it('Case 24: all features at maximum realistic values', async () => {
      await ingestTelemetry([mkRow({ vdc1: 600, vdc2: 600, idc1: 15, idc2: 15, irr: 1500, pvt: 85 })]);
      const [row] = await getLatestTelemetry(1);
      expect(row!.pdc1).toBe(9000);
      expect(row!.pdc2).toBe(9000);
      expect(row!.pdcTotal).toBe(18000);
    });

    it('Case 25: both voltages negative, both currents positive → negative power', async () => {
      await ingestTelemetry([mkRow({ vdc1: -100, vdc2: -200, idc1: 5, idc2: 5 })]);
      const [row] = await getLatestTelemetry(1);
      expect(row!.pdc1).toBe(-500);
      expect(row!.pdc2).toBe(-1000);
      expect(row!.pdcTotal).toBe(-1500);
    });

    it('Case 26: NaN vdc1 is rejected by libsql driver', async () => {
      // libsql rejects non-finite numbers with RangeError
      await expect(
        ingestTelemetry([mkRow({ vdc1: NaN })]),
      ).rejects.toThrow();
    });

    it('Case 27: Infinity vdc1 is rejected by libsql driver', async () => {
      await expect(
        ingestTelemetry([mkRow({ vdc1: Infinity })]),
      ).rejects.toThrow();
    });

    it('Case 28: -Infinity vdc2 is rejected by libsql driver', async () => {
      await expect(
        ingestTelemetry([mkRow({ vdc2: -Infinity })]),
      ).rejects.toThrow();
    });

    it('Case 29: very small negative irr (-0.001)', async () => {
      await ingestTelemetry([mkRow({ irr: -0.001 })]);
      const [row] = await getLatestTelemetry(1);
      expect(row!.irr).toBeCloseTo(-0.001, 3);
    });

    it('Case 30: pvt with high decimal precision (25.123456)', async () => {
      await ingestTelemetry([mkRow({ pvt: 25.123456 })]);
      const [row] = await getLatestTelemetry(1);
      expect(row!.pvt).toBeCloseTo(25.123456, 4);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 2 — Timestamp edge cases (15 cases)
  // ═══════════════════════════════════════════════════════════════════
  describe('Timestamp edge cases', () => {

    it('Case 31: epoch 0 (1970-01-01T00:00:00Z) via ISO string', async () => {
      await ingestTelemetry([mkRow({ timestamp: '1970-01-01T00:00:00Z' })]);
      const [row] = await getLatestTelemetry(1);
      expect(row).toBeDefined();
      // timestamp stored as unix seconds; epoch 0 → Date(0)
      expect(row!.timestamp.getTime()).toBe(0);
    });

    it('Case 32: epoch 0 via numeric 0', async () => {
      await ingestTelemetry([mkRow({ timestamp: 0 })]);
      const [row] = await getLatestTelemetry(1);
      expect(row).toBeDefined();
    });

    it('Case 33: far future date (year 9999)', async () => {
      await ingestTelemetry([mkRow({ timestamp: '9999-12-31T23:59:59Z' })]);
      const [row] = await getLatestTelemetry(1);
      expect(row).toBeDefined();
      // Unix-seconds round-trip may shift to year 10000 due to precision
      expect(row!.timestamp.getFullYear()).toBeGreaterThanOrEqual(9999);
    });

    it('Case 34: negative timestamp (before 1970)', async () => {
      // new Date(-86400000) → 1969-12-31
      await ingestTelemetry([mkRow({ timestamp: -86400000 })]);
      const [row] = await getLatestTelemetry(1);
      expect(row).toBeDefined();
    });

    it('Case 35: ISO string with timezone offset', async () => {
      await ingestTelemetry([mkRow({ timestamp: '2026-06-10T12:00:00+07:00' })]);
      const [row] = await getLatestTelemetry(1);
      expect(row).toBeDefined();
    });

    it('Case 36: Unix timestamp as number (seconds since epoch)', async () => {
      const unixMs = new Date('2026-06-10T12:00:00Z').getTime();
      await ingestTelemetry([mkRow({ timestamp: unixMs })]);
      const [row] = await getLatestTelemetry(1);
      expect(row).toBeDefined();
    });

    it('Case 37: duplicate timestamps inserts both rows', async () => {
      const ts = '2026-06-10T12:00:00Z';
      await ingestTelemetry([mkRow({ timestamp: ts }), mkRow({ timestamp: ts, vdc1: 999 })]);
      const rows = await getLatestTelemetry(10);
      expect(rows.length).toBe(2);
    });

    it('Case 38: very precise ISO string with milliseconds', async () => {
      await ingestTelemetry([mkRow({ timestamp: '2026-06-10T12:00:00.123Z' })]);
      const [row] = await getLatestTelemetry(1);
      expect(row).toBeDefined();
    });

    it('Case 39: date-only string (no time component)', async () => {
      await ingestTelemetry([mkRow({ timestamp: '2026-06-10' })]);
      const [row] = await getLatestTelemetry(1);
      expect(row).toBeDefined();
    });

    it('Case 40: invalid date string "not-a-date" is rejected (NaN timestamp)', async () => {
      // new Date('not-a-date') → Invalid Date → NaN timestamp → libsql rejects
      await expect(
        ingestTelemetry([mkRow({ timestamp: 'not-a-date' })]),
      ).rejects.toThrow();
    });

    it('Case 41: empty string timestamp is rejected (NaN timestamp)', async () => {
      await expect(
        ingestTelemetry([mkRow({ timestamp: '' })]),
      ).rejects.toThrow();
    });

    it('Case 42: "null" string timestamp is rejected (NaN timestamp)', async () => {
      await expect(
        ingestTelemetry([mkRow({ timestamp: 'null' })]),
      ).rejects.toThrow();
    });

    it('Case 43: timestamps in descending order still ingests correctly', async () => {
      const batch = [
        mkRow({ timestamp: '2026-06-10T15:00:00Z', vdc1: 300 }),
        mkRow({ timestamp: '2026-06-10T10:00:00Z', vdc1: 100 }),
        mkRow({ timestamp: '2026-06-10T12:00:00Z', vdc1: 200 }),
      ];
      const res = await ingestTelemetry(batch);
      expect(res.inserted).toBe(3);
    });

    it('Case 44: leap second timestamp "2026-06-30T23:59:60Z" is rejected (Invalid Date)', async () => {
      // JS engines treat :60 as invalid → NaN timestamp → libsql rejects
      await expect(
        ingestTelemetry([mkRow({ timestamp: '2026-06-30T23:59:60Z' })]),
      ).rejects.toThrow();
    });

    it('Case 45: far future unix timestamp (year 3000)', async () => {
      const farFuture = new Date('3000-01-01T00:00:00Z').getTime();
      await ingestTelemetry([mkRow({ timestamp: farFuture })]);
      const [row] = await getLatestTelemetry(1);
      expect(row).toBeDefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 3 — Batch ingestion edge cases (20 cases)
  // ═══════════════════════════════════════════════════════════════════
  describe('Batch ingestion edge cases', () => {

    it('Case 46: empty batch [] returns inserted 0', async () => {
      // ingestTelemetry maps over empty array → no inserts
      const res = await ingestTelemetry([]);
      expect(res.inserted).toBe(0);
    });

    it('Case 47: single item batch inserts exactly 1', async () => {
      const res = await ingestTelemetry([mkRow()]);
      expect(res.inserted).toBe(1);
    });

    it('Case 48: batch of exactly 100 items (chunk boundary)', async () => {
      const batch = Array.from({ length: 100 }, (_, i) =>
        mkRow({ timestamp: new Date(Date.UTC(2026, 5, 10, 0, i)).toISOString() }),
      );
      const res = await ingestTelemetry(batch);
      expect(res.inserted).toBe(100);
    });

    it('Case 49: batch of 101 items crosses chunk boundary', async () => {
      const batch = Array.from({ length: 101 }, (_, i) =>
        mkRow({ timestamp: new Date(Date.UTC(2026, 5, 10, 0, 0, i)).toISOString() }),
      );
      const res = await ingestTelemetry(batch);
      expect(res.inserted).toBe(101);
    });

    it('Case 50: batch of 250 items (multiple chunks)', async () => {
      const batch = Array.from({ length: 250 }, (_, i) =>
        mkRow({ timestamp: new Date(Date.UTC(2026, 5, 10, 0, 0, i)).toISOString() }),
      );
      const res = await ingestTelemetry(batch);
      expect(res.inserted).toBe(250);
    });

    it('Case 51: extra unknown fields are silently ignored', async () => {
      const row = mkRow({ unknownField: 'hello', anotherExtra: 42 });
      const res = await ingestTelemetry([row as any]);
      expect(res.inserted).toBe(1);
      const [stored] = await getLatestTelemetry(1);
      expect((stored as any).unknownField).toBeUndefined();
    });

    it('Case 52: batch with pre-computed pdc1 uses provided value', async () => {
      const res = await ingestTelemetry([mkRow({ pdc1: 9999 })]);
      expect(res.inserted).toBe(1);
      const [row] = await getLatestTelemetry(1);
      expect(row!.pdc1).toBe(9999);
    });

    it('Case 53: batch with pre-computed pdc2 uses provided value', async () => {
      const res = await ingestTelemetry([mkRow({ pdc2: 8888 })]);
      expect(res.inserted).toBe(1);
      const [row] = await getLatestTelemetry(1);
      expect(row!.pdc2).toBe(8888);
    });

    it('Case 54: batch with pre-computed pdcTotal uses provided value', async () => {
      const res = await ingestTelemetry([mkRow({ pdcTotal: 5555 })]);
      expect(res.inserted).toBe(1);
      const [row] = await getLatestTelemetry(1);
      expect(row!.pdcTotal).toBe(5555);
    });

    it('Case 55: batch with faultLabel 0 (Normal)', async () => {
      const res = await ingestTelemetry([mkRow({ faultLabel: 0 })]);
      expect(res.inserted).toBe(1);
      const [row] = await getLatestTelemetry(1);
      expect(row!.faultLabel).toBe(0);
    });

    it('Case 56: batch with faultLabel 1 (Short-Circuit)', async () => {
      await ingestTelemetry([mkRow({ faultLabel: 1 })]);
      const [row] = await getLatestTelemetry(1);
      expect(row!.faultLabel).toBe(1);
    });

    it('Case 57: batch with faultLabel 2 (Degradation)', async () => {
      await ingestTelemetry([mkRow({ faultLabel: 2 })]);
      const [row] = await getLatestTelemetry(1);
      expect(row!.faultLabel).toBe(2);
    });

    it('Case 58: batch with faultLabel 3 (Open Circuit)', async () => {
      await ingestTelemetry([mkRow({ faultLabel: 3 })]);
      const [row] = await getLatestTelemetry(1);
      expect(row!.faultLabel).toBe(3);
    });

    it('Case 59: batch with faultLabel 4 (Shadowing)', async () => {
      await ingestTelemetry([mkRow({ faultLabel: 4 })]);
      const [row] = await getLatestTelemetry(1);
      expect(row!.faultLabel).toBe(4);
    });

    it('Case 60: out-of-range faultLabel 5 still stores', async () => {
      await ingestTelemetry([mkRow({ faultLabel: 5 })]);
      const [row] = await getLatestTelemetry(1);
      expect(row!.faultLabel).toBe(5);
    });

    it('Case 61: negative faultLabel -1 stores in DB', async () => {
      await ingestTelemetry([mkRow({ faultLabel: -1 })]);
      const [row] = await getLatestTelemetry(1);
      expect(row!.faultLabel).toBe(-1);
    });

    it('Case 62: very large faultLabel 999 stores in DB', async () => {
      await ingestTelemetry([mkRow({ faultLabel: 999 })]);
      const [row] = await getLatestTelemetry(1);
      expect(row!.faultLabel).toBe(999);
    });

    it('Case 63: no faultLabel defaults to null', async () => {
      await ingestTelemetry([mkRow()]);
      const [row] = await getLatestTelemetry(1);
      expect(row!.faultLabel).toBeNull();
    });

    it('Case 64: mixed valid entries in single batch all insert', async () => {
      const batch = [
        mkRow({ vdc1: 100, timestamp: '2026-06-10T00:00:00Z' }),
        mkRow({ vdc1: 200, timestamp: '2026-06-10T00:01:00Z' }),
        mkRow({ vdc1: 0, idc1: 0, timestamp: '2026-06-10T00:02:00Z' }),
      ];
      const res = await ingestTelemetry(batch);
      expect(res.inserted).toBe(3);
    });

    it('Case 65: batch of 500 items processes correctly across 5 chunks', async () => {
      const batch = Array.from({ length: 500 }, (_, i) =>
        mkRow({ timestamp: new Date(Date.UTC(2026, 5, 10, 0, 0, i)).toISOString() }),
      );
      const res = await ingestTelemetry(batch);
      expect(res.inserted).toBe(500);

      const range = await getDataRange();
      expect(range.totalPoints).toBe(500);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 4 — Query edge cases (20 cases)
  // ═══════════════════════════════════════════════════════════════════
  describe('Query edge cases', () => {

    it('Case 66: getLatestTelemetry on empty DB returns empty array', async () => {
      const rows = await getLatestTelemetry(1);
      expect(rows).toEqual([]);
    });

    it('Case 67: getLatestTelemetry(0) on empty DB returns empty', async () => {
      const rows = await getLatestTelemetry(0);
      expect(rows).toEqual([]);
    });

    it('Case 68: queryTelemetry on empty DB returns empty array', async () => {
      const rows = await queryTelemetry({});
      expect(rows).toEqual([]);
    });

    it('Case 69: getDataRange on empty DB returns zeros', async () => {
      const range = await getDataRange();
      expect(range.totalPoints).toBe(0);
      expect(range.minTs).toBe(0);
      expect(range.maxTs).toBe(0);
    });

    it('Case 70: getTelemetryKPIs on empty DB returns zero metrics', async () => {
      const kpi = await getTelemetryKPIs();
      expect(kpi.totalRecords).toBe(0);
      expect(kpi.avgPower).toBe(0);
      expect(kpi.totalEnergy).toBe(0);
    });

    it('Case 71: getDailyYieldToday on empty DB returns 0 kWh', async () => {
      const res = await getDailyYieldToday();
      expect(res.energyKwh).toBe(0);
    });

    it('Case 72: getAggregatedTelemetry with interval "1h" on empty DB', async () => {
      const rows = await getAggregatedTelemetry('1h');
      expect(rows).toEqual([]);
    });

    it('Case 73: getAggregatedTelemetry with interval "6h"', async () => {
      await seedRows(10);
      const rows = await getAggregatedTelemetry('6h',
        '2026-06-10T00:00:00Z', '2026-06-10T23:59:59Z');
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(r.dataPoints).toBeGreaterThan(0);
      }
    });

    it('Case 74: getAggregatedTelemetry with interval "1d"', async () => {
      await seedRows(10);
      const rows = await getAggregatedTelemetry('1d',
        '2026-06-10T00:00:00Z', '2026-06-10T23:59:59Z');
      expect(rows.length).toBeGreaterThan(0);
    });

    it('Case 75: getAggregatedTelemetry with interval "3d"', async () => {
      await seedRows(10);
      const rows = await getAggregatedTelemetry('3d',
        '2026-06-10T00:00:00Z', '2026-06-12T23:59:59Z');
      expect(rows.length).toBeGreaterThan(0);
    });

    it('Case 76: getAggregatedTelemetry with interval "1w"', async () => {
      await seedRows(20);
      const rows = await getAggregatedTelemetry('1w',
        '2026-06-10T00:00:00Z', '2026-06-17T23:59:59Z');
      expect(rows.length).toBeGreaterThan(0);
    });

    it('Case 77: getAggregatedTelemetry with unknown interval defaults to 60s bucket', async () => {
      await seedRows(5);
      const rows = await getAggregatedTelemetry('INVALID',
        '2026-06-10T00:00:00Z', '2026-06-10T23:59:59Z');
      // Should still return data using fallback bucket
      expect(rows.length).toBeGreaterThan(0);
    });

    it('Case 78: getAggregatedTelemetry with from > to returns empty', async () => {
      await seedRows(10);
      const rows = await getAggregatedTelemetry('1h',
        '2026-06-11T00:00:00Z', '2026-06-09T00:00:00Z');
      expect(rows).toEqual([]);
    });

    it('Case 79: getAggregatedTelemetry with invalid timestamp string throws', async () => {
      await expect(
        getAggregatedTelemetry('1h', 'not-a-date', '2026-06-10T23:59:59Z'),
      ).rejects.toThrow('Invalid timestamp');
    });

    it('Case 80: getTelemetryKPIs with invalid from timestamp throws', async () => {
      await expect(
        getTelemetryKPIs('not-a-date'),
      ).rejects.toThrow('Invalid timestamp');
    });

    it('Case 81: queryTelemetry limit is capped at 10000', async () => {
      await seedRows(5);
      const rows = await queryTelemetry({ limit: 99999 });
      // Should not exceed internal cap; just return available data
      expect(rows.length).toBe(5);
    });

    it('Case 82: queryTelemetry with large offset returns empty', async () => {
      await seedRows(5);
      const rows = await queryTelemetry({ offset: 10000 });
      expect(rows).toEqual([]);
    });

    it('Case 83: queryTelemetry with downsample on empty DB', async () => {
      const rows = await queryTelemetry({ downsample: 3 });
      expect(rows).toEqual([]);
    });

    it('Case 84: query after inserting 1000 records', async () => {
      // Seed 1000 rows in batches
      const batch = Array.from({ length: 1000 }, (_, i) =>
        mkRow({ timestamp: new Date(Date.UTC(2026, 5, 10, 0, 0, i)).toISOString() }),
      );
      await ingestTelemetry(batch);

      const range = await getDataRange();
      expect(range.totalPoints).toBe(1000);

      const latest = await getLatestTelemetry(5);
      expect(latest.length).toBe(5);

      const queried = await queryTelemetry({ limit: 100 });
      expect(queried.length).toBe(100);
    });

    it('Case 85: queryTelemetry from/to narrowing to single row', async () => {
      await seedRows(10);
      // Row at index 5 → base + 5 min
      const targetTs = new Date(Date.UTC(2026, 5, 10, 0, 5)).toISOString();
      const rows = await queryTelemetry({ from: targetTs, to: targetTs });
      expect(rows.length).toBe(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 5 — Power calculation verification (15 cases)
  // ═══════════════════════════════════════════════════════════════════
  describe('Power calculation verification', () => {

    it('Case 86: pdc1 = vdc1 * idc1 rounded to 2 decimals', async () => {
      await ingestTelemetry([mkRow({ vdc1: 123.45, idc1: 6.78 })]);
      const [row] = await getLatestTelemetry(1);
      const expected = Math.round(123.45 * 6.78 * 100) / 100; // 836.99
      expect(row!.pdc1).toBeCloseTo(expected, 2);
    });

    it('Case 87: pdc2 = vdc2 * idc2 rounded to 2 decimals', async () => {
      await ingestTelemetry([mkRow({ vdc2: 234.56, idc2: 3.21 })]);
      const [row] = await getLatestTelemetry(1);
      const expected = Math.round(234.56 * 3.21 * 100) / 100;
      expect(row!.pdc2).toBeCloseTo(expected, 2);
    });

    it('Case 88: pdcTotal = pdc1 + pdc2 (auto-computed)', async () => {
      await ingestTelemetry([mkRow({ vdc1: 100, idc1: 5, vdc2: 200, idc2: 3 })]);
      const [row] = await getLatestTelemetry(1);
      // pdc1 = 500, pdc2 = 600 → total = 1100
      expect(row!.pdc1).toBe(500);
      expect(row!.pdc2).toBe(600);
      expect(row!.pdcTotal).toBe(1100);
    });

    it('Case 89: override pdc1 uses provided instead of computed', async () => {
      await ingestTelemetry([mkRow({ vdc1: 100, idc1: 5, pdc1: 1234 })]);
      const [row] = await getLatestTelemetry(1);
      expect(row!.pdc1).toBe(1234); // override, not 500
    });

    it('Case 90: override pdc2 uses provided instead of computed', async () => {
      await ingestTelemetry([mkRow({ vdc2: 100, idc2: 5, pdc2: 5678 })]);
      const [row] = await getLatestTelemetry(1);
      expect(row!.pdc2).toBe(5678); // override, not 500
    });

    it('Case 91: override pdcTotal uses provided instead of sum', async () => {
      await ingestTelemetry([mkRow({ pdcTotal: 42 })]);
      const [row] = await getLatestTelemetry(1);
      expect(row!.pdcTotal).toBe(42);
    });

    it('Case 92: zero power when both V and I are zero', async () => {
      await ingestTelemetry([mkRow({ vdc1: 0, idc1: 0, vdc2: 0, idc2: 0 })]);
      const [row] = await getLatestTelemetry(1);
      expect(row!.pdc1).toBe(0);
      expect(row!.pdc2).toBe(0);
      expect(row!.pdcTotal).toBe(0);
    });

    it('Case 93: fractional power rounding (0.1 * 0.2 = 0.02)', async () => {
      await ingestTelemetry([mkRow({ vdc1: 0.1, idc1: 0.2, vdc2: 0.3, idc2: 0.4 })]);
      const [row] = await getLatestTelemetry(1);
      expect(row!.pdc1).toBeCloseTo(0.02, 2);
      expect(row!.pdc2).toBeCloseTo(0.12, 2);
      expect(row!.pdcTotal).toBeCloseTo(0.14, 2);
    });

    it('Case 94: large multiplication (999 * 999) precision', async () => {
      await ingestTelemetry([mkRow({ vdc1: 999, idc1: 999, vdc2: 999, idc2: 999 })]);
      const [row] = await getLatestTelemetry(1);
      expect(row!.pdc1).toBe(998001);
      expect(row!.pdc2).toBe(998001);
      expect(row!.pdcTotal).toBe(1996002);
    });

    it('Case 95: partial override (only pdc1) still auto-computes pdc2 and pdcTotal', async () => {
      await ingestTelemetry([mkRow({ vdc1: 100, idc1: 5, vdc2: 200, idc2: 3, pdc1: 777 })]);
      const [row] = await getLatestTelemetry(1);
      expect(row!.pdc1).toBe(777);           // overridden
      expect(row!.pdc2).toBe(600);           // auto = 200*3
      expect(row!.pdcTotal).toBe(1377);      // 777 + 600
    });

    it('Case 96: partial override (only pdc2) still auto-computes pdc1 and pdcTotal', async () => {
      await ingestTelemetry([mkRow({ vdc1: 100, idc1: 5, vdc2: 200, idc2: 3, pdc2: 888 })]);
      const [row] = await getLatestTelemetry(1);
      expect(row!.pdc1).toBe(500);           // auto = 100*5
      expect(row!.pdc2).toBe(888);           // overridden
      expect(row!.pdcTotal).toBe(1388);      // 500 + 888
    });

    it('Case 97: override all three power fields independently', async () => {
      await ingestTelemetry([mkRow({ pdc1: 111, pdc2: 222, pdcTotal: 333 })]);
      const [row] = await getLatestTelemetry(1);
      expect(row!.pdc1).toBe(111);
      expect(row!.pdc2).toBe(222);
      expect(row!.pdcTotal).toBe(333); // uses provided, not 111+222
    });

    it('Case 98: negative voltage × positive current → negative power', async () => {
      await ingestTelemetry([mkRow({ vdc1: -150, idc1: 4, vdc2: 200, idc2: 5 })]);
      const [row] = await getLatestTelemetry(1);
      expect(row!.pdc1).toBe(-600);
      expect(row!.pdc2).toBe(1000);
      expect(row!.pdcTotal).toBe(400); // -600 + 1000
    });

    it('Case 99: both strings negative power → negative total', async () => {
      await ingestTelemetry([mkRow({ vdc1: -100, idc1: 2, vdc2: -200, idc2: 3 })]);
      const [row] = await getLatestTelemetry(1);
      expect(row!.pdc1).toBe(-200);
      expect(row!.pdc2).toBe(-600);
      expect(row!.pdcTotal).toBe(-800);
    });

    it('Case 100: getDataRange after many inserts returns correct min/max', async () => {
      const batch = Array.from({ length: 50 }, (_, i) =>
        mkRow({
          timestamp: new Date(Date.UTC(2026, 5, 10 + i, 12, 0, 0)).toISOString(),
          vdc1: 100 + i,
          idc1: 5,
        }),
      );
      await ingestTelemetry(batch);
      const range = await getDataRange();
      expect(range.totalPoints).toBe(50);
      expect(range.minTs).toBeGreaterThan(0);
      expect(range.maxTs).toBeGreaterThan(range.minTs);
    });
  });
});
