/**
 * EnergiaMind — Device Binding Service
 *
 * Implements proactive device-level access control:
 *   1. Each employee is bound to exactly one device
 *   2. Device identity = Registration Token (cookie) + Hardware Signature (fuzzy)
 *   3. First login auto-registers the device
 *   4. Subsequent logins validate token + hardware signature
 *   5. Admin can reset binding to allow device change
 */

import { db } from '../db/index.js';
import { registeredDevices, activityLog } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';

// ─── Types ──────────────────────────────────────────────────────────
export interface HardwareSignature {
  cpuCores: number;
  ram: number | null;     // navigator.deviceMemory (Chrome only, null on Firefox/Safari)
  screen: string;          // "1920x1080"
  platform: string;        // "Win32", "MacIntel", "Linux x86_64"
  timezone: string;        // "Asia/Ho_Chi_Minh"
  gpu: string;             // WebGL renderer string
  colorDepth: number;      // screen.colorDepth (24, 32)
  touchPoints: number;     // navigator.maxTouchPoints (0 for desktop)
}

export interface DeviceBindingInfo {
  id: string;
  userId: string;
  browser: string | null;
  os: string | null;
  hwSignature: HardwareSignature;
  registeredAt: Date;
  lastSeenAt: Date;
  isActive: boolean;
}

// ─── Hardware Signature Matching ────────────────────────────────────
// Fuzzy match: compare individual components, require ≥75% match

const HW_COMPONENTS: (keyof HardwareSignature)[] = [
  'cpuCores', 'ram', 'screen', 'platform', 'timezone', 'gpu', 'colorDepth', 'touchPoints',
];

const MATCH_THRESHOLD = 0.75; // 6 out of 8 must match

/**
 * Compare two hardware signatures component-by-component.
 * Returns { match: boolean, score: number, mismatches: string[] }
 */
export function compareHardwareSignatures(
  registered: HardwareSignature,
  current: HardwareSignature,
): { match: boolean; score: number; mismatches: string[] } {
  let matched = 0;
  const mismatches: string[] = [];

  for (const key of HW_COMPONENTS) {
    const regVal = registered[key];
    const curVal = current[key];

    // null == null counts as match; null vs non-null is mismatch
    if (regVal === curVal) {
      matched++;
    } else if (regVal === null || curVal === null) {
      // One side has data, other doesn't — mild mismatch
      mismatches.push(`${key}: ${String(regVal)} → ${String(curVal)}`);
    } else if (typeof regVal === 'string' && typeof curVal === 'string') {
      // String comparison (case-insensitive for GPU strings)
      if (regVal.toLowerCase() === curVal.toLowerCase()) {
        matched++;
      } else {
        mismatches.push(`${key}: "${regVal}" → "${curVal}"`);
      }
    } else {
      // Number comparison
      if (regVal === curVal) {
        matched++;
      } else {
        mismatches.push(`${key}: ${String(regVal)} → ${String(curVal)}`);
      }
    }
  }

  const score = matched / HW_COMPONENTS.length;
  return { match: score >= MATCH_THRESHOLD, score, mismatches };
}

// ─── Core Operations ────────────────────────────────────────────────

/**
 * Register a device for a user. Returns the device token.
 */
export async function registerDevice(
  userId: string,
  hwSignature: HardwareSignature,
  browser: string | null,
  os: string | null,
  actorRole: string,
  ip: string,
  userAgent: string,
): Promise<string> {
  // Revoke any existing device binding
  await db.delete(registeredDevices).where(eq(registeredDevices.userId, userId));

  const deviceToken = nanoid(64);
  const id = nanoid();

  await db.insert(registeredDevices).values({
    id,
    userId,
    deviceToken,
    hwSignature,
    browser,
    os,
    registeredAt: new Date(),
    lastSeenAt: new Date(),
    isActive: true,
  });

  // Log registration
  await db.insert(activityLog).values({
    actorId: userId,
    actorRole: actorRole as 'admin',
    action: 'DEVICE_REGISTERED',
    target: `user:${userId}`,
    details: {
      browser,
      os,
      fingerprint: `hw-${hwSignature.cpuCores}-${hwSignature.platform || 'unknown'}-${hwSignature.timezone || 'unknown'}`,
      deviceInfo: { browser, os },
      hwInfo: hwSignature,
    } as Record<string, unknown>,
    ip,
    userAgent,
  });

  return deviceToken;
}

/**
 * Validate a device token + hardware signature.
 * Returns { valid, reason, shouldReRegister }
 */
export async function validateDevice(
  userId: string,
  deviceToken: string,
  currentHw: HardwareSignature,
): Promise<{ valid: boolean; reason: string; shouldUpdateHw?: boolean }> {
  const [device] = await db.select()
    .from(registeredDevices)
    .where(eq(registeredDevices.userId, userId))
    .limit(1);

  if (!device) {
    return { valid: false, reason: 'no_device_registered' };
  }

  if (!device.isActive) {
    return { valid: false, reason: 'device_deactivated' };
  }

  if (device.deviceToken !== deviceToken) {
    return { valid: false, reason: 'invalid_device_token' };
  }

  // Fuzzy hardware match
  const comparison = compareHardwareSignatures(device.hwSignature, currentHw);

  if (!comparison.match) {
    return {
      valid: false,
      reason: `hardware_mismatch (score: ${(comparison.score * 100).toFixed(0)}%, mismatches: ${comparison.mismatches.join(', ')})`,
    };
  }

  // Update last seen timestamp
  await db.update(registeredDevices)
    .set({ lastSeenAt: new Date() })
    .where(eq(registeredDevices.id, device.id));

  // If minor drift detected (score < 1.0 but ≥ threshold), auto-update signature
  if (comparison.score < 1.0) {
    await db.update(registeredDevices)
      .set({ hwSignature: currentHw })
      .where(eq(registeredDevices.id, device.id));
    return { valid: true, reason: 'ok_hw_updated', shouldUpdateHw: true };
  }

  return { valid: true, reason: 'ok' };
}

/**
 * Check if a user has a registered device (without validating).
 */
export async function hasRegisteredDevice(userId: string): Promise<boolean> {
  const [device] = await db.select({ id: registeredDevices.id })
    .from(registeredDevices)
    .where(eq(registeredDevices.userId, userId))
    .limit(1);
  return !!device;
}

/**
 * Get device binding info for a user.
 */
export async function getDeviceBinding(userId: string): Promise<DeviceBindingInfo | null> {
  const [device] = await db.select({
    id: registeredDevices.id,
    userId: registeredDevices.userId,
    browser: registeredDevices.browser,
    os: registeredDevices.os,
    hwSignature: registeredDevices.hwSignature,
    registeredAt: registeredDevices.registeredAt,
    lastSeenAt: registeredDevices.lastSeenAt,
    isActive: registeredDevices.isActive,
  })
    .from(registeredDevices)
    .where(eq(registeredDevices.userId, userId))
    .limit(1);

  return device || null;
}

/**
 * Admin: Reset device binding for a user.
 * Next login will auto-register the new device.
 */
export async function resetDeviceBinding(
  userId: string,
  adminId: string,
  adminRole: string,
  ip: string,
  userAgent: string,
): Promise<void> {
  await db.delete(registeredDevices).where(eq(registeredDevices.userId, userId));

  await db.insert(activityLog).values({
    actorId: adminId,
    actorRole: adminRole as 'admin',
    action: 'DEVICE_RESET',
    target: `user:${userId}`,
    details: { resetBy: adminId } as Record<string, unknown>,
    ip,
    userAgent,
  });
}

/**
 * Log a rejected device access attempt.
 */
export async function logDeviceRejection(
  userId: string,
  reason: string,
  ip: string,
  userAgent: string,
  hwSignature?: HardwareSignature,
  deviceInfo?: { browser?: string; os?: string },
): Promise<void> {
  const details: Record<string, any> = { reason };
  if (hwSignature) {
    details.fingerprint = `hw-${hwSignature.cpuCores}-${hwSignature.platform || 'unknown'}-${hwSignature.timezone || 'unknown'}`;
    details.deviceInfo = { browser: deviceInfo?.browser || null, os: deviceInfo?.os || null };
    details.hwInfo = hwSignature;
  }
  await db.insert(activityLog).values({
    actorId: userId,
    actorRole: 'system',
    action: 'DEVICE_REJECTED',
    target: `user:${userId}`,
    details,
    ip,
    userAgent,
  });
}
