import * as argon2 from 'argon2';
import * as jose from 'jose';
import { db } from '../db/index.js';
import { users, sessions, activityLog } from '../db/schema.js';
import { eq, and, lte } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import {
  validateDevice,
  registerDevice,
  hasRegisteredDevice,
  logDeviceRejection,
  type HardwareSignature,
} from './deviceBinding.service.js';

const JWT_SECRET_RAW = process.env['JWT_SECRET'];
if (!JWT_SECRET_RAW || JWT_SECRET_RAW.length < 32) {
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('FATAL: JWT_SECRET must be set to a 32+ character string in production');
  }
  console.warn('⚠ WARNING: JWT_SECRET not set or too short (min 32 chars). Using dev default — NOT SAFE FOR PRODUCTION.');
}
const JWT_SECRET = new TextEncoder().encode(JWT_SECRET_RAW || 'energiamind-dev-secret-change-in-prod');
const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 30 * 60 * 1000; // 30 min

interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

interface JWTPayload {
  sub: string;
  role: 'admin' | 'solar_operator' | 'security_engineer';
  username: string;
}

export interface LoginResult extends TokenPair {
  user: {
    id: string;
    username: string;
    email: string;
    displayName: string;
    role: string;
    avatarUrl: string | null;
    employeeId: string;
  };
  deviceRegistered?: boolean;
}

export async function login(
  username: string,
  password: string,
  ip: string,
  userAgent: string,
  hwSignature?: HardwareSignature,
  deviceToken?: string,
  deviceInfo?: { browser?: string; os?: string },
): Promise<LoginResult> {
  const [user] = await db.select().from(users).where(eq(users.username, username)).limit(1);

  if (!user) {
    // Perform dummy Argon2id verification to mitigate timing attacks (user enumeration)
    await argon2.verify(
      '$argon2id$v=19$m=19456,t=2,p=1$dummyhashdummyhashdummyha$dummyhashdummyhashdummyhashdummyhashdummyha',
      'dummypassword'
    );
    await logActivity(null, 'system', 'LOGIN_FAILED', `user:${username}`, { reason: 'not_found' }, ip, userAgent);
    throw new AuthError('Invalid credentials', 401);
  }

  // Check lockout
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    // Perform dummy verification even on lockout to keep timings uniform
    await argon2.verify(
      '$argon2id$v=19$m=19456,t=2,p=1$dummyhashdummyhashdummyha$dummyhashdummyhashdummyhashdummyhashdummyha',
      'dummypassword'
    );
    const remaining = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
    const fingerprint = hwSignature ? `hw-${hwSignature.cpuCores}-${hwSignature.platform || 'unknown'}-${hwSignature.timezone || 'unknown'}` : null;
    await logActivity(user.id, user.role, 'LOGIN_FAILED', `user:${username}`, {
      reason: 'locked',
      remaining,
      browser: deviceInfo?.browser || null,
      os: deviceInfo?.os || null,
      fingerprint,
      deviceInfo: { browser: deviceInfo?.browser || null, os: deviceInfo?.os || null },
      hwInfo: hwSignature || null
    }, ip, userAgent);
    throw new AuthError(`Account locked. Try again in ${remaining} minutes.`, 423);
  }

  // Verify password
  const valid = await argon2.verify(user.passwordHash, password);
  if (!valid) {
    const attempts = user.failedAttempts + 1;
    const updates: Record<string, unknown> = { failedAttempts: attempts };
    if (attempts >= MAX_FAILED_ATTEMPTS) {
      updates['lockedUntil'] = new Date(Date.now() + LOCKOUT_DURATION_MS);
    }
    await db.update(users).set(updates).where(eq(users.id, user.id));
    const fingerprint = hwSignature ? `hw-${hwSignature.cpuCores}-${hwSignature.platform || 'unknown'}-${hwSignature.timezone || 'unknown'}` : null;
    await logActivity(user.id, user.role, 'LOGIN_FAILED', `user:${username}`, {
      reason: 'wrong_password',
      attempts,
      browser: deviceInfo?.browser || null,
      os: deviceInfo?.os || null,
      fingerprint,
      deviceInfo: { browser: deviceInfo?.browser || null, os: deviceInfo?.os || null },
      hwInfo: hwSignature || null
    }, ip, userAgent);
    throw new AuthError('Invalid credentials', 401);
  }

  // ─── Device Binding Check ──────────────────────────────────────
  let deviceRegistered = false;

  if (hwSignature) {
    const hasDevice = await hasRegisteredDevice(user.id);

    if (hasDevice) {
      // User has a registered device — validate
      if (!deviceToken) {
        // No device token cookie — device not registered from this browser
        await logDeviceRejection(user.id, 'missing_device_token', ip, userAgent, hwSignature, deviceInfo);
        const fingerprint = `hw-${hwSignature.cpuCores}-${hwSignature.platform || 'unknown'}-${hwSignature.timezone || 'unknown'}`;
        await logActivity(user.id, user.role, 'LOGIN_FAILED', `user:${username}`, {
          reason: 'unregistered_device',
          browser: deviceInfo?.browser || null,
          os: deviceInfo?.os || null,
          fingerprint,
          deviceInfo: { browser: deviceInfo?.browser || null, os: deviceInfo?.os || null },
          hwInfo: hwSignature
        }, ip, userAgent);
        throw new AuthError('DEVICE_NOT_REGISTERED', 460);
      }

      const validation = await validateDevice(user.id, deviceToken, hwSignature);
      if (!validation.valid) {
        await logDeviceRejection(user.id, validation.reason, ip, userAgent, hwSignature, deviceInfo);
        const fingerprint = `hw-${hwSignature.cpuCores}-${hwSignature.platform || 'unknown'}-${hwSignature.timezone || 'unknown'}`;
        await logActivity(user.id, user.role, 'LOGIN_FAILED', `user:${username}`, {
          reason: 'device_rejected',
          detail: validation.reason,
          browser: deviceInfo?.browser || null,
          os: deviceInfo?.os || null,
          fingerprint,
          deviceInfo: { browser: deviceInfo?.browser || null, os: deviceInfo?.os || null },
          hwInfo: hwSignature
        }, ip, userAgent);
        throw new AuthError('DEVICE_NOT_REGISTERED', 460);
      }
    } else {
      // No device registered yet — auto-register on first login
      const newToken = await registerDevice(
        user.id,
        hwSignature,
        deviceInfo?.browser || null,
        deviceInfo?.os || null,
        user.role,
        ip,
        userAgent,
      );
      deviceToken = newToken;
      deviceRegistered = true;
    }
  }

  // Reset failed attempts on success
  await db.update(users).set({ failedAttempts: 0, lockedUntil: null }).where(eq(users.id, user.id));

  // Revoke all existing sessions for this user (SIP - Single session constraint)
  await db.delete(sessions).where(eq(sessions.userId, user.id));

  // Generate tokens
  const tokenFamily = nanoid();
  const pair = await generateTokenPair(user.id, user.role, user.username, tokenFamily, ip, userAgent);

  const fingerprint = hwSignature ? `hw-${hwSignature.cpuCores}-${hwSignature.platform || 'unknown'}-${hwSignature.timezone || 'unknown'}` : null;
  await logActivity(user.id, user.role, 'LOGIN', `user:${user.id}`, {
    deviceRegistered,
    browser: deviceInfo?.browser || null,
    os: deviceInfo?.os || null,
    fingerprint,
    deviceInfo: { browser: deviceInfo?.browser || null, os: deviceInfo?.os || null },
    hwInfo: hwSignature || null
  }, ip, userAgent);

  return {
    ...pair,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      avatarUrl: user.avatarUrl,
      employeeId: user.employeeId,
    },
    ...(deviceRegistered ? { deviceRegistered: true, _deviceToken: deviceToken } : {}),
  } as LoginResult & { _deviceToken?: string };
}

export async function refresh(
  refreshToken: string,
  ip: string,
  userAgent: string,
): Promise<TokenPair> {
  const [session] = await db.select().from(sessions).where(eq(sessions.refreshToken, refreshToken)).limit(1);

  if (!session || session.revoked || session.expiresAt < new Date()) {
    // Reuse detection — revoke entire family
    if (session) {
      await db.delete(sessions).where(eq(sessions.tokenFamily, session.tokenFamily));
    }
    throw new AuthError('Invalid refresh token', 401);
  }

  // Mark old session as revoked (used)
  await db.update(sessions).set({ revoked: true }).where(eq(sessions.id, session.id));

  // Fetch user
  const [user] = await db.select().from(users).where(eq(users.id, session.userId)).limit(1);
  if (!user) throw new AuthError('User not found', 401);

  return generateTokenPair(user.id, user.role, user.username, session.tokenFamily, ip, userAgent);
}

export async function logout(refreshToken: string, userId: string, ip: string, userAgent: string): Promise<void> {
  const [session] = await db.select().from(sessions)
    .where(and(eq(sessions.refreshToken, refreshToken), eq(sessions.userId, userId)))
    .limit(1);

  if (session) {
    await db.delete(sessions).where(eq(sessions.tokenFamily, session.tokenFamily));
  }

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  await logActivity(userId, user?.role || 'solar_operator', 'LOGOUT', `user:${userId}`, null, ip, userAgent);
}

export async function verifyAccessToken(token: string): Promise<JWTPayload> {
  try {
    const { payload } = await jose.jwtVerify(token, JWT_SECRET, { algorithms: ['HS256'] });
    return {
      sub: payload.sub as string,
      role: payload['role'] as 'admin' | 'solar_operator' | 'security_engineer',
      username: payload['username'] as string,
    };
  } catch {
    throw new AuthError('Invalid or expired token', 401);
  }
}

export async function getUserById(id: string) {
  const [user] = await db.select({
    id: users.id,
    employeeId: users.employeeId,
    username: users.username,
    email: users.email,
    displayName: users.displayName,
    role: users.role,
    avatarUrl: users.avatarUrl,
    createdAt: users.createdAt,
  }).from(users).where(eq(users.id, id)).limit(1);
  return user || null;
}

// ─── Internal helpers ───────────────────────────────────────────────

async function generateTokenPair(
  userId: string,
  role: string,
  username: string,
  tokenFamily: string,
  ip: string,
  userAgent: string,
): Promise<TokenPair> {
  const accessToken = await new jose.SignJWT({ role, username })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(ACCESS_TOKEN_TTL)
    .sign(JWT_SECRET);

  const refreshTokenValue = nanoid(48);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

  await db.insert(sessions).values({
    id: nanoid(),
    userId,
    refreshToken: refreshTokenValue,
    tokenFamily,
    ip,
    userAgent,
    expiresAt,
  });

  return {
    accessToken,
    refreshToken: refreshTokenValue,
    expiresIn: 15 * 60, // 15m in seconds
  };
}

async function logActivity(
  actorId: string | null,
  actorRole: 'admin' | 'solar_operator' | 'security_engineer' | 'system',
  action: string,
  target: string | null,
  details: unknown,
  ip: string,
  userAgent: string,
) {
  await db.insert(activityLog).values({
    actorId,
    actorRole,
    action: action as 'LOGIN',
    target,
    details: details as Record<string, unknown> | null,
    ip,
    userAgent,
  });
}

// ─── Verify current password and change to new one ──────────────────
export async function verifyAndChangePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new AuthError('User not found', 404);

  const valid = await argon2.verify(user.passwordHash, currentPassword);
  if (!valid) throw new AuthError('Current password is incorrect', 400);

  const newHash = await argon2.hash(newPassword, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });

  await db.update(users).set({ passwordHash: newHash, updatedAt: new Date() }).where(eq(users.id, userId));
}

export class AuthError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

// ─── Cleanup expired sessions ───────────────────────────────────────
export async function cleanupExpiredSessions(): Promise<number> {
  const result = await db.delete(sessions)
    .where(lte(sessions.expiresAt, new Date()))
    .returning();
  return result.length;
}
