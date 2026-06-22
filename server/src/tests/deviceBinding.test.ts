import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { db, client } from '../db/index.js';
import { users, registeredDevices, activityLog } from '../db/schema.js';
import {
  registerDevice,
  validateDevice,
  hasRegisteredDevice,
  getDeviceBinding,
  resetDeviceBinding,
  logDeviceRejection,
  compareHardwareSignatures,
  type HardwareSignature,
} from '../services/deviceBinding.service.js';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';

const IP = '127.0.0.1';
const UA = 'vitest-agent';

const baseHw: HardwareSignature = {
  cpuCores: 8,
  ram: 16,
  screen: '1920x1080',
  platform: 'Win32',
  timezone: 'Asia/Ho_Chi_Minh',
  gpu: 'NVIDIA GeForce RTX 4060',
  colorDepth: 24,
  touchPoints: 0,
};

describe('Device Binding Security System Test Suite', () => {
  const testUser = {
    id: 'dev-bind-user-1',
    employeeId: 'EM-1001',
    username: 'devbinduser',
    email: 'devbind@test.com',
    displayName: 'Device Binding User',
    passwordHash: 'dummyhash',
    role: 'solar_operator' as const,
  };

  beforeAll(async () => {
    await db.insert(users).values(testUser);
  });

  afterEach(async () => {
    await db.delete(registeredDevices);
    await db.delete(activityLog);
  });

  describe('Fuzzy Hardware Matching', () => {
    it('Should return 100% match for identical signatures', () => {
      const result = compareHardwareSignatures(baseHw, baseHw);
      expect(result.match).toBe(true);
      expect(result.score).toBe(1.0);
      expect(result.mismatches.length).toBe(0);
    });

    it('Should allow minor drift (7/8 components match)', () => {
      const currentHw = { ...baseHw, screen: '2560x1440' }; // screen changes
      const result = compareHardwareSignatures(baseHw, currentHw);
      expect(result.match).toBe(true);
      expect(result.score).toBe(0.875);
      expect(result.mismatches.length).toBe(1);
    });

    it('Should allow boundary drift (6/8 components match)', () => {
      const currentHw = {
        ...baseHw,
        screen: '2560x1440',
        timezone: 'America/New_York',
      }; // 2 components change
      const result = compareHardwareSignatures(baseHw, currentHw);
      expect(result.match).toBe(true);
      expect(result.score).toBe(0.75);
      expect(result.mismatches.length).toBe(2);
    });

    it('Should reject major drift (5/8 components match)', () => {
      const currentHw = {
        ...baseHw,
        screen: '2560x1440',
        timezone: 'America/New_York',
        gpu: 'AMD Radeon', // 3 components change
      };
      const result = compareHardwareSignatures(baseHw, currentHw);
      expect(result.match).toBe(false);
      expect(result.score).toBe(0.625);
      expect(result.mismatches.length).toBe(3);
    });
  });

  describe('Device Registry Lifecycle Operations', () => {
    it('Should register a device and query it', async () => {
      expect(await hasRegisteredDevice(testUser.id)).toBe(false);

      const token = await registerDevice(
        testUser.id,
        baseHw,
        'Chrome',
        'Windows',
        'solar_operator',
        IP,
        UA
      );
      expect(token).toBeDefined();
      expect(token.length).toBeGreaterThan(32);

      expect(await hasRegisteredDevice(testUser.id)).toBe(true);

      const binding = await getDeviceBinding(testUser.id);
      expect(binding).not.toBeNull();
      expect(binding?.browser).toBe('Chrome');
      expect(binding?.os).toBe('Windows');
      expect(binding?.isActive).toBe(true);
    });

    it('Should validate registered device with 100% match', async () => {
      const token = await registerDevice(
        testUser.id,
        baseHw,
        'Chrome',
        'Windows',
        'solar_operator',
        IP,
        UA
      );

      const validation = await validateDevice(testUser.id, token, baseHw);
      expect(validation.valid).toBe(true);
      expect(validation.reason).toBe('ok');
    });

    it('Should reject verification with incorrect token', async () => {
      await registerDevice(
        testUser.id,
        baseHw,
        'Chrome',
        'Windows',
        'solar_operator',
        IP,
        UA
      );

      const validation = await validateDevice(testUser.id, 'wrong-token', baseHw);
      expect(validation.valid).toBe(false);
      expect(validation.reason).toBe('invalid_device_token');
    });

    it('Should allow minor drift and auto-update hardware signature', async () => {
      const token = await registerDevice(
        testUser.id,
        baseHw,
        'Chrome',
        'Windows',
        'solar_operator',
        IP,
        UA
      );

      const driftedHw = { ...baseHw, screen: '2560x1440' };
      const validation = await validateDevice(testUser.id, token, driftedHw);
      expect(validation.valid).toBe(true);
      expect(validation.reason).toBe('ok_hw_updated');
      expect(validation.shouldUpdateHw).toBe(true);

      const updatedBinding = await getDeviceBinding(testUser.id);
      expect(updatedBinding?.hwSignature.screen).toBe('2560x1440');
    });

    it('Should reject and log on major hardware mismatch', async () => {
      const token = await registerDevice(
        testUser.id,
        baseHw,
        'Chrome',
        'Windows',
        'solar_operator',
        IP,
        UA
      );

      const differentHw = {
        ...baseHw,
        cpuCores: 4,
        ram: 8,
        screen: '1024x768',
        gpu: 'Intel UHD Graphics',
      };

      const validation = await validateDevice(testUser.id, token, differentHw);
      expect(validation.valid).toBe(false);
      expect(validation.reason).toContain('hardware_mismatch');

      // Check registration activity log
      const logs = await db.select().from(activityLog).where(eq(activityLog.action, 'DEVICE_REGISTERED'));
      expect(logs.length).toBe(1);
    });

    it('Should support admin resetting device binding', async () => {
      await registerDevice(
        testUser.id,
        baseHw,
        'Chrome',
        'Windows',
        'solar_operator',
        IP,
        UA
      );
      expect(await hasRegisteredDevice(testUser.id)).toBe(true);

      await resetDeviceBinding(testUser.id, 'admin-id', 'admin', IP, UA);
      expect(await hasRegisteredDevice(testUser.id)).toBe(false);

      const logs = await db.select().from(activityLog).where(eq(activityLog.action, 'DEVICE_RESET'));
      expect(logs.length).toBe(1);
      expect(logs[0]?.target).toBe(`user:${testUser.id}`);
    });

    it('Should record device rejection logs', async () => {
      await logDeviceRejection(testUser.id, 'missing_device_token', IP, UA);

      const logs = await db.select().from(activityLog).where(eq(activityLog.action, 'DEVICE_REJECTED'));
      expect(logs.length).toBe(1);
      expect(logs[0]?.details).toEqual({ reason: 'missing_device_token' });
    });
  });
});
