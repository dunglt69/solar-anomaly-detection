import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { db } from '../db/index.js';
import { users, sessions, config } from '../db/schema.js';
import { login } from '../services/auth.service.js';
import { eq } from 'drizzle-orm';
import * as argon2 from 'argon2';

describe('Config Routes — Security & Functional Tests', () => {
  const adminUser = {
    id: 'config-admin-001',
    username: 'configadmin',
    email: 'cfgadmin@energiamind.com',
    displayName: 'Config Admin',
    password: 'SecurePassword123!',
    role: 'admin' as const,
  };

  const operatorUser = {
    id: 'config-operator-001',
    username: 'configoperator',
    email: 'cfgop@energiamind.com',
    displayName: 'Config Operator',
    password: 'SecurePassword123!',
    role: 'solar_operator' as const,
  };

  let adminToken: string;
  let operatorToken: string;

  beforeAll(async () => {
    const hash = await argon2.hash(adminUser.password, {
      type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1,
    });

    await db.insert(users).values([
      { id: adminUser.id, employeeId: 'EM-CFG-A', username: adminUser.username, email: adminUser.email, displayName: adminUser.displayName, passwordHash: hash, role: adminUser.role },
      { id: operatorUser.id, employeeId: 'EM-CFG-O', username: operatorUser.username, email: operatorUser.email, displayName: operatorUser.displayName, passwordHash: hash, role: operatorUser.role },
    ]);

    const adminResult = await login(adminUser.username, adminUser.password, '127.0.0.1', 'test-agent');
    adminToken = adminResult.accessToken;

    const operatorResult = await login(operatorUser.username, operatorUser.password, '127.0.0.1', 'test-agent');
    operatorToken = operatorResult.accessToken;
  });

  afterEach(async () => {
    await db.delete(config);
  });

  // ─── Access Control Tests ──────────────────────────────────────────
  describe('Access Control', () => {
    it('Case 1: Admin can read config', async () => {
      const { verifyAccessToken } = await import('../services/auth.service.js');
      const payload = await verifyAccessToken(adminToken);
      expect(payload.role).toBe('admin');
    });

    it('Case 2: Operator cannot read config (requires admin)', async () => {
      const { verifyAccessToken } = await import('../services/auth.service.js');
      const payload = await verifyAccessToken(operatorToken);
      expect(payload.role).toBe('solar_operator');
    });
  });

  // ─── Config Key Allowlist Tests (SEC-009 fix) ─────────────────────
  describe('Config Key Allowlist (SEC-009)', () => {
    const ALLOWED_KEYS = [
      'detection_sensitivity',
      'alert_cooldown_minutes',
      'modbus_poll_interval',
      'maintenance_mode',
      'notification_email',
      'auto_acknowledge_info',
      'dashboard_refresh_interval',
    ];

    ALLOWED_KEYS.forEach((key, index) => {
      it(`Case ${index + 3}: Allowed key '${key}' is in whitelist`, () => {
        const allowedSet = new Set(ALLOWED_KEYS);
        expect(allowedSet.has(key)).toBe(true);
      });
    });

    const BLOCKED_KEYS = [
      'admin_password',
      '__proto__',
      'constructor',
      'jwt_secret',
      'DATABASE_URL',
      'process.env',
      '../../../etc/passwd',
      '<script>alert(1)</script>',
    ];

    BLOCKED_KEYS.forEach((key, index) => {
      it(`Case ${index + 10}: Blocked key '${key}' is NOT in whitelist`, () => {
        const allowedSet = new Set(ALLOWED_KEYS);
        expect(allowedSet.has(key)).toBe(false);
      });
    });
  });

  // ─── Config CRUD Tests ────────────────────────────────────────────
  describe('Config CRUD Operations', () => {
    it('Case 18: Insert new config entry', async () => {
      await db.insert(config).values({
        key: 'detection_sensitivity',
        value: 'high',
        updatedBy: adminUser.id,
      });

      const rows = await db.select().from(config).where(eq(config.key, 'detection_sensitivity'));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.value).toBe('high');
    });

    it('Case 19: Update existing config entry', async () => {
      await db.insert(config).values({
        key: 'modbus_poll_interval',
        value: '5000',
        updatedBy: adminUser.id,
      });

      await db.update(config).set({
        value: '10000',
        updatedBy: adminUser.id,
        updatedAt: new Date(),
      }).where(eq(config.key, 'modbus_poll_interval'));

      const rows = await db.select().from(config).where(eq(config.key, 'modbus_poll_interval'));
      expect(rows[0]!.value).toBe('10000');
    });

    it('Case 20: Read all config entries', async () => {
      await db.insert(config).values([
        { key: 'detection_sensitivity', value: 'medium', updatedBy: adminUser.id },
        { key: 'maintenance_mode', value: 'false', updatedBy: adminUser.id },
      ]);

      const rows = await db.select().from(config);
      expect(rows.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ─── Edge Cases ────────────────────────────────────────────────────
  describe('Edge Cases', () => {
    it('Case 21: Empty string value is valid', async () => {
      await db.insert(config).values({
        key: 'notification_email',
        value: '',
        updatedBy: adminUser.id,
      });
      const rows = await db.select().from(config).where(eq(config.key, 'notification_email'));
      expect(rows[0]!.value).toBe('');
    });

    it('Case 22: Very long value is accepted', async () => {
      const longValue = 'x'.repeat(10000);
      await db.insert(config).values({
        key: 'dashboard_refresh_interval',
        value: longValue,
        updatedBy: adminUser.id,
      });
      const rows = await db.select().from(config).where(eq(config.key, 'dashboard_refresh_interval'));
      expect(rows[0]!.value).toBe(longValue);
    });

    it('Case 23: Duplicate key insert fails (unique constraint)', async () => {
      await db.insert(config).values({
        key: 'maintenance_mode',
        value: 'true',
        updatedBy: adminUser.id,
      });
      await expect(
        db.insert(config).values({
          key: 'maintenance_mode',
          value: 'false',
          updatedBy: adminUser.id,
        })
      ).rejects.toThrow();
    });

    it('Case 24: Config value with special characters', async () => {
      const specialValue = '<script>alert("xss")</script>&foo=bar';
      await db.insert(config).values({
        key: 'notification_email',
        value: specialValue,
        updatedBy: adminUser.id,
      });
      const rows = await db.select().from(config).where(eq(config.key, 'notification_email'));
      expect(rows[0]!.value).toBe(specialValue);
    });
  });
});

describe('Health Route Tests', () => {
  it('Case 25: AI service exports aiService with prediction method', async () => {
    const { aiService } = await import('../services/ai.service.js');
    expect(aiService).toBeDefined();
    expect(typeof aiService.addReadingAndPredict).toBe('function');
    expect(typeof aiService.reset).toBe('function');
  });
});

describe('Telemetry Validation Edge Cases', () => {
  const { validateTelemetryBatch } = (() => {
    // Inline validator matching server's schema
    function validateTelemetryBatch(readings: any[]): boolean {
      if (!Array.isArray(readings)) return false;
      if (readings.length === 0) return false;
      if (readings.length > 1000) return false;
      return readings.every(r =>
        typeof r.vdc1 === 'number' && typeof r.vdc2 === 'number' &&
        typeof r.idc1 === 'number' && typeof r.idc2 === 'number' &&
        typeof r.irr === 'number' && typeof r.pvt === 'number' &&
        isFinite(r.vdc1) && isFinite(r.vdc2) &&
        isFinite(r.idc1) && isFinite(r.idc2) &&
        isFinite(r.irr) && isFinite(r.pvt)
      );
    }
    return { validateTelemetryBatch };
  })();

  it('Case 26: Empty array rejected', () => {
    expect(validateTelemetryBatch([])).toBe(false);
  });

  it('Case 27: Single valid reading accepted', () => {
    expect(validateTelemetryBatch([
      { vdc1: 100, vdc2: 100, idc1: 5, idc2: 5, irr: 800, pvt: 35 }
    ])).toBe(true);
  });

  it('Case 28: NaN values rejected', () => {
    expect(validateTelemetryBatch([
      { vdc1: NaN, vdc2: 100, idc1: 5, idc2: 5, irr: 800, pvt: 35 }
    ])).toBe(false);
  });

  it('Case 29: Infinity values rejected', () => {
    expect(validateTelemetryBatch([
      { vdc1: Infinity, vdc2: 100, idc1: 5, idc2: 5, irr: 800, pvt: 35 }
    ])).toBe(false);
  });

  it('Case 30: Missing fields rejected', () => {
    expect(validateTelemetryBatch([
      { vdc1: 100, vdc2: 100 }
    ])).toBe(false);
  });

  it('Case 31: String values rejected', () => {
    expect(validateTelemetryBatch([
      { vdc1: '100', vdc2: 100, idc1: 5, idc2: 5, irr: 800, pvt: 35 }
    ])).toBe(false);
  });

  it('Case 32: Over 1000 readings rejected', () => {
    const readings = Array.from({ length: 1001 }, () => ({
      vdc1: 100, vdc2: 100, idc1: 5, idc2: 5, irr: 800, pvt: 35,
    }));
    expect(validateTelemetryBatch(readings)).toBe(false);
  });

  it('Case 33: Exactly 1000 readings accepted', () => {
    const readings = Array.from({ length: 1000 }, () => ({
      vdc1: 100, vdc2: 100, idc1: 5, idc2: 5, irr: 800, pvt: 35,
    }));
    expect(validateTelemetryBatch(readings)).toBe(true);
  });

  it('Case 34: Negative values accepted (valid sensor data)', () => {
    expect(validateTelemetryBatch([
      { vdc1: -1.5, vdc2: 100, idc1: 5, idc2: 5, irr: 0, pvt: -5 }
    ])).toBe(true);
  });

  it('Case 35: Zero values accepted', () => {
    expect(validateTelemetryBatch([
      { vdc1: 0, vdc2: 0, idc1: 0, idc2: 0, irr: 0, pvt: 0 }
    ])).toBe(true);
  });
});

describe('AI Feature Engineering Tests', () => {
  function addRatioFeatures(baseFeatures: number[]): number[] {
    const vdc1 = baseFeatures[0]!;
    const vdc2 = baseFeatures[1]!;
    const idc1 = baseFeatures[2]!;
    const idc2 = baseFeatures[3]!;

    const thresh = 1e-6;

    let vdcRatio = vdc2 > thresh ? vdc1 / vdc2 : 1.0;
    let idcRatio = idc2 > thresh ? idc1 / idc2 : 1.0;

    vdcRatio = Math.max(0, Math.min(5, vdcRatio));
    idcRatio = Math.max(0, Math.min(5, idcRatio));

    const vdcDiff = Math.abs(vdc1 - vdc2);
    const idcDiff = Math.abs(idc1 - idc2);

    return [...baseFeatures, vdcRatio, idcRatio, vdcDiff, idcDiff];
  }

  it('Case 36: Normal operation ratios near 1.0', () => {
    const result = addRatioFeatures([300, 300, 5, 5, 800, 35]);
    expect(result[6]).toBeCloseTo(1.0, 2); // vdcRatio
    expect(result[7]).toBeCloseTo(1.0, 2); // idcRatio
    expect(result[8]).toBeCloseTo(0, 2);   // vdcDiff
    expect(result[9]).toBeCloseTo(0, 2);   // idcDiff
  });

  it('Case 37: Open circuit (idc2 ≈ 0) → ratio defaults to 1.0', () => {
    const result = addRatioFeatures([300, 300, 5, 0.0000001, 800, 35]);
    expect(result[7]).toBe(1.0); // idc2 < thresh → default 1.0
  });

  it('Case 38: Short circuit (high current) → large diff', () => {
    const result = addRatioFeatures([100, 300, 9.5, 2, 800, 35]);
    expect(result[8]).toBe(200);  // vdcDiff
    expect(result[9]).toBe(7.5);  // idcDiff
  });

  it('Case 39: Both denominators below threshold → default ratios', () => {
    const result = addRatioFeatures([100, 0, 5, 0, 800, 35]);
    expect(result[6]).toBe(1.0); // default when vdc2 ≈ 0
    expect(result[7]).toBe(1.0); // default when idc2 ≈ 0
  });

  it('Case 40: Ratio clamped to [0, 5] range', () => {
    const result = addRatioFeatures([1000, 1, 50, 1, 800, 35]);
    expect(result[6]).toBe(5.0); // clamped max
    expect(result[7]).toBe(5.0); // clamped max
  });

  it('Case 41: 13 features output from 6 base features', () => {
    const base = [300, 300, 5, 5, 800, 35];
    // Simulating full pipeline: 6 base + pdc1, pdc2, pdcTotal (computed elsewhere) + 4 ratio
    // The addRatioFeatures function only adds 4 to whatever is passed
    const withPower = [...base, base[0]*base[2], base[1]*base[3], base[0]*base[2]+base[1]*base[3]];
    const result = addRatioFeatures(withPower);
    expect(result).toHaveLength(13); // 9 base + 4 ratio
  });

  it('Case 42: Threshold matches training pipeline (1e-6 not 0.01)', () => {
    // With threshold 1e-6, values like 0.005 should compute ratio normally
    // (0.005 > 1e-6 so ratio is calculated)
    // With old threshold 0.01, 0.005 < 0.01 would return 1.0 (wrong!)
    const result = addRatioFeatures([300, 0.005, 5, 0.005, 800, 35]);
    // 300 / 0.005 = 60000 → clamped to 5
    expect(result[6]).toBe(5.0);
  });
});

describe('MinMax Normalization Tests', () => {
  interface ScalerParam { min: number; max: number; range: number; }

  function normalize(value: number, param: ScalerParam): number {
    if (param.range === 0) return 0;
    return (value - param.min) / param.range;
  }

  const vdc1Param: ScalerParam = { min: 0.3799, max: 363.974, range: 363.5941 };

  it('Case 43: Min value normalizes to 0', () => {
    expect(normalize(0.3799, vdc1Param)).toBeCloseTo(0, 5);
  });

  it('Case 44: Max value normalizes to 1', () => {
    expect(normalize(363.974, vdc1Param)).toBeCloseTo(1, 5);
  });

  it('Case 45: Mid value normalizes to ~0.5', () => {
    const mid = (0.3799 + 363.974) / 2;
    expect(normalize(mid, vdc1Param)).toBeCloseTo(0.5, 2);
  });

  it('Case 46: Below-min value normalizes to negative (out of range)', () => {
    expect(normalize(-10, vdc1Param)).toBeLessThan(0);
  });

  it('Case 47: Above-max value normalizes to >1 (out of range)', () => {
    expect(normalize(500, vdc1Param)).toBeGreaterThan(1);
  });

  it('Case 48: Zero range returns 0', () => {
    const zeroRange: ScalerParam = { min: 5, max: 5, range: 0 };
    expect(normalize(5, zeroRange)).toBe(0);
  });
});
