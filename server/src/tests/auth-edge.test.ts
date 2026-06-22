import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { db } from '../db/index.js';
import { users, sessions } from '../db/schema.js';
import {
  login,
  refresh,
  logout,
  verifyAccessToken,
  AuthError,
  verifyAndChangePassword,
  cleanupExpiredSessions,
  getUserById,
} from '../services/auth.service.js';
import { eq } from 'drizzle-orm';
import * as argon2 from 'argon2';
import { nanoid } from 'nanoid';

// Replicate the route-level password validation function for testing
function validatePassword(password: string): string | null {
  if (password.length < 8) return 'Password must be at least 8 characters';
  if (!/[A-Z]/.test(password)) return 'Password must contain at least one uppercase letter';
  if (!/[a-z]/.test(password)) return 'Password must contain at least one lowercase letter';
  if (!/[0-9]/.test(password)) return 'Password must contain at least one digit';
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>/?]/.test(password)) return 'Password must contain at least one special character';
  return null;
}

describe('Auth Edge Cases — Extended Test Suite', () => {
  const testUser = {
    id: 'auth-edge-user-001',
    username: 'authedgeuser',
    email: 'authedge@energiamind.com',
    displayName: 'Auth Edge User',
    password: 'SecurePassword123!',
    role: 'solar_operator' as const,
  };

  beforeAll(async () => {
    const passwordHash = await argon2.hash(testUser.password, {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });
    await db.insert(users).values({
      id: testUser.id,
      employeeId: 'EM-0010',
      username: testUser.username,
      email: testUser.email,
      displayName: testUser.displayName,
      passwordHash,
      role: testUser.role,
    });
  });

  afterEach(async () => {
    await db.delete(sessions);
    await db.update(users).set({ failedAttempts: 0, lockedUntil: null }).where(eq(users.id, testUser.id));
  });

  // ─── SECTION 1: Password Complexity Validation (8 tests) ─────────
  describe('Password Complexity Validation (Route-Level Logic)', () => {
    it('Should reject password shorter than 8 chars', () => {
      expect(validatePassword('Abcd1!x')).toBe('Password must be at least 8 characters');
    });

    it('Should reject password without uppercase letter', () => {
      expect(validatePassword('abcdefg1!')).toBe('Password must contain at least one uppercase letter');
    });

    it('Should reject password without lowercase letter', () => {
      expect(validatePassword('ABCDEFG1!')).toBe('Password must contain at least one lowercase letter');
    });

    it('Should reject password without digit', () => {
      expect(validatePassword('Abcdefgh!')).toBe('Password must contain at least one digit');
    });

    it('Should reject password without special character', () => {
      expect(validatePassword('Abcdefgh1')).toBe('Password must contain at least one special character');
    });

    it('Should accept password with exactly 8 chars meeting all requirements', () => {
      expect(validatePassword('Abcdef1!')).toBeNull();
    });

    it('Should accept password at max length (128 chars) with all requirements', () => {
      const longPass = 'A' + 'b'.repeat(124) + '1!x';
      expect(validatePassword(longPass)).toBeNull();
    });

    it('Should accept a strong password with all requirements met', () => {
      expect(validatePassword('MyStr0ng!Pass')).toBeNull();
    });
  });

  // ─── SECTION 2: Username Validation Edge Cases (5 tests) ──────────
  describe('Username Validation Edge Cases', () => {
    it('Should reject empty username (user not found)', async () => {
      await expect(login('', testUser.password, '127.0.0.1', 'test')).rejects.toThrow();
    });

    it('Should reject very long username (200 chars)', async () => {
      const longUser = 'a'.repeat(200);
      await expect(login(longUser, testUser.password, '127.0.0.1', 'test')).rejects.toThrowError(AuthError);
    });

    it('Should reject username with exactly 50 chars that does not exist', async () => {
      const user50 = 'u'.repeat(50);
      await expect(login(user50, testUser.password, '127.0.0.1', 'test')).rejects.toThrowError('Invalid credentials');
    });

    it('Should handle username with special characters safely', async () => {
      await expect(login('user@#$%^&*()', testUser.password, '127.0.0.1', 'test')).rejects.toThrowError('Invalid credentials');
    });

    it('Should handle whitespace-only username', async () => {
      await expect(login('   ', testUser.password, '127.0.0.1', 'test')).rejects.toThrow();
    });
  });

  // ─── SECTION 3: SQL Injection in Auth (6 tests) ───────────────────
  describe('SQL Injection Resistance', () => {
    const sqliPayloads = [
      "admin'; DROP TABLE users;--",
      "' OR '1'='1",
      "' UNION SELECT * FROM users --",
    ];

    sqliPayloads.forEach((payload, idx) => {
      it(`SQLi in username #${idx + 1}: "${payload}" → should fail as user not found`, async () => {
        await expect(login(payload, testUser.password, '127.0.0.1', 'test')).rejects.toThrowError('Invalid credentials');
      });
    });

    sqliPayloads.forEach((payload, idx) => {
      it(`SQLi in password #${idx + 1}: "${payload}" → should not bypass auth`, async () => {
        await expect(login(testUser.username, payload, '127.0.0.1', 'test')).rejects.toThrowError('Invalid credentials');
      });
    });
  });

  // ─── SECTION 4: XSS Payloads (3 tests) ───────────────────────────
  describe('XSS Payload Handling', () => {
    const xssPayloads = [
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      'javascript:alert(document.cookie)',
    ];

    xssPayloads.forEach((payload, idx) => {
      it(`XSS payload #${idx + 1}: "${payload}" → should fail as user not found`, async () => {
        await expect(login(payload, testUser.password, '127.0.0.1', 'test')).rejects.toThrowError('Invalid credentials');
      });
    });
  });

  // ─── SECTION 5: JWT Token Manipulation (5 tests) ──────────────────
  describe('JWT Token Manipulation & Verification', () => {
    it('Should reject a completely random string as token', async () => {
      await expect(verifyAccessToken('this-is-not-a-jwt')).rejects.toThrowError(AuthError);
    });

    it('Should reject an empty string as token', async () => {
      await expect(verifyAccessToken('')).rejects.toThrowError(AuthError);
    });

    it('Should reject a token with manipulated signature', async () => {
      const tokens = await login(testUser.username, testUser.password, '127.0.0.1', 'test');
      const badToken = tokens.accessToken.slice(0, -5) + 'XXXXX';
      await expect(verifyAccessToken(badToken)).rejects.toThrowError(AuthError);
    });

    it('Should reject a nanoid-generated fake token', async () => {
      await expect(verifyAccessToken(nanoid(120))).rejects.toThrowError(AuthError);
    });

    it('Should verify a valid access token and return correct payload', async () => {
      const tokens = await login(testUser.username, testUser.password, '127.0.0.1', 'test');
      const payload = await verifyAccessToken(tokens.accessToken);
      expect(payload.sub).toBe(testUser.id);
      expect(payload.role).toBe(testUser.role);
      expect(payload.username).toBe(testUser.username);
    });
  });

  // ─── SECTION 6: Session Management Edge Cases (6 tests) ───────────
  describe('Session Management Edge Cases', () => {
    it('Login creates exactly 1 session in DB', async () => {
      await login(testUser.username, testUser.password, '127.0.0.1', 'test');
      const sessionRows = await db.select().from(sessions).where(eq(sessions.userId, testUser.id));
      expect(sessionRows.length).toBe(1);
      expect(sessionRows[0]?.userId).toBe(testUser.id);
      expect(sessionRows[0]?.ip).toBe('127.0.0.1');
      expect(sessionRows[0]?.revoked).toBe(false);
    });

    it('Logout deletes session family from DB', async () => {
      const tokens = await login(testUser.username, testUser.password, '127.0.0.1', 'test');
      await logout(tokens.refreshToken, testUser.id, '127.0.0.1', 'test');
      const sessionRows = await db.select().from(sessions).where(eq(sessions.userId, testUser.id));
      expect(sessionRows.length).toBe(0);
    });

    it('Multiple sequential logins enforce SIP (only 1 session)', async () => {
      await login(testUser.username, testUser.password, '10.0.0.1', 'Device A');
      await login(testUser.username, testUser.password, '10.0.0.2', 'Device B');
      await login(testUser.username, testUser.password, '10.0.0.3', 'Device C');

      const sessionRows = await db.select().from(sessions).where(eq(sessions.userId, testUser.id));
      expect(sessionRows.length).toBe(1);
      expect(sessionRows[0]?.ip).toBe('10.0.0.3');
    });

    it('Refresh token rotation creates new session and marks old as revoked', async () => {
      const t1 = await login(testUser.username, testUser.password, '127.0.0.1', 'test');
      const t2 = await refresh(t1.refreshToken, '127.0.0.1', 'test');

      expect(t2.refreshToken).not.toBe(t1.refreshToken);

      const [oldSession] = await db.select().from(sessions).where(eq(sessions.refreshToken, t1.refreshToken));
      expect(oldSession?.revoked).toBe(true);

      const [newSession] = await db.select().from(sessions).where(eq(sessions.refreshToken, t2.refreshToken));
      expect(newSession?.revoked).toBe(false);
    });

    it('Double refresh token reuse revokes entire family (0 active sessions)', async () => {
      const t1 = await login(testUser.username, testUser.password, '127.0.0.1', 'test');
      await refresh(t1.refreshToken, '127.0.0.1', 'test');

      // Attempt reuse of t1 (already rotated)
      await expect(refresh(t1.refreshToken, '127.0.0.1', 'attacker')).rejects.toThrow();

      const sessionRows = await db.select().from(sessions).where(eq(sessions.userId, testUser.id));
      expect(sessionRows.length).toBe(0);
    });

    it('Refresh with non-existent token throws AuthError', async () => {
      await expect(refresh('non-existent-token-abc', '127.0.0.1', 'test')).rejects.toThrowError(AuthError);
    });
  });

  // ─── SECTION 7: Account Lockout Edge Cases (3 tests) ──────────────
  describe('Account Lockout Edge Cases', () => {
    it('Exactly 4 failures should NOT lock, 5th failure locks', async () => {
      for (let i = 1; i <= 4; i++) {
        await expect(login(testUser.username, 'wrong', '127.0.0.1', 'test')).rejects.toThrowError('Invalid credentials');
        const [u] = await db.select().from(users).where(eq(users.id, testUser.id));
        expect(u?.failedAttempts).toBe(i);
        expect(u?.lockedUntil).toBeNull();
      }

      // 5th attempt triggers lockout
      await expect(login(testUser.username, 'wrong', '127.0.0.1', 'test')).rejects.toThrowError('Invalid credentials');
      const [u] = await db.select().from(users).where(eq(users.id, testUser.id));
      expect(u?.failedAttempts).toBe(5);
      expect(u?.lockedUntil).not.toBeNull();
    });

    it('Correct password during lockout still throws 423', async () => {
      // Trigger lockout
      for (let i = 0; i < 5; i++) {
        await expect(login(testUser.username, 'wrong', '127.0.0.1', 'test')).rejects.toThrow();
      }

      // Correct password during lockout should still fail
      await expect(login(testUser.username, testUser.password, '127.0.0.1', 'test')).rejects.toThrowError(/locked/i);
    });

    it('Login succeeds if lockedUntil is in the past', async () => {
      // Set lockedUntil to the past manually
      const pastDate = new Date(Date.now() - 60000);
      await db.update(users).set({
        failedAttempts: 5,
        lockedUntil: pastDate,
      }).where(eq(users.id, testUser.id));

      // Login should succeed now since lockout expired
      const tokens = await login(testUser.username, testUser.password, '127.0.0.1', 'test');
      expect(tokens.accessToken).toBeDefined();

      const [u] = await db.select().from(users).where(eq(users.id, testUser.id));
      expect(u?.failedAttempts).toBe(0);
      expect(u?.lockedUntil).toBeNull();
    });
  });

  // ─── SECTION 8: Password Change Edge Cases (3 tests) ──────────────
  describe('Password Change Edge Cases', () => {
    it('Should reject password change with wrong current password', async () => {
      await expect(verifyAndChangePassword(testUser.id, 'WrongCurrent!1', 'NewPass123!')).rejects.toThrowError(AuthError);
    });

    it('Should reject password change for non-existent user', async () => {
      await expect(verifyAndChangePassword('non-existent-id', 'any', 'NewPass123!')).rejects.toThrowError(AuthError);
    });

    it('Should change password successfully and verify old fails', async () => {
      const newPass = 'BrandNew987!';
      await verifyAndChangePassword(testUser.id, testUser.password, newPass);

      // New password works
      const tokens = await login(testUser.username, newPass, '127.0.0.1', 'test');
      expect(tokens.accessToken).toBeDefined();

      // Old password fails
      await expect(login(testUser.username, testUser.password, '127.0.0.1', 'test')).rejects.toThrowError('Invalid credentials');

      // Revert
      await verifyAndChangePassword(testUser.id, newPass, testUser.password);
    });
  });

  // ─── SECTION 9: Cleanup Expired Sessions (2 tests) ────────────────
  describe('Cleanup Expired Sessions', () => {
    it('Should delete expired sessions', async () => {
      // Insert expired session
      const pastDate = new Date(Date.now() - 60000);
      await db.insert(sessions).values({
        id: 'expired-session-1',
        userId: testUser.id,
        refreshToken: 'expired-rt-001',
        tokenFamily: 'expired-family-001',
        ip: '127.0.0.1',
        userAgent: 'test',
        expiresAt: pastDate,
      });

      const deleted = await cleanupExpiredSessions();
      expect(deleted).toBeGreaterThanOrEqual(1);

      const remaining = await db.select().from(sessions).where(eq(sessions.refreshToken, 'expired-rt-001'));
      expect(remaining.length).toBe(0);
    });

    it('Should NOT delete non-expired sessions', async () => {
      const futureDate = new Date(Date.now() + 3600000);
      await db.insert(sessions).values({
        id: 'active-session-1',
        userId: testUser.id,
        refreshToken: 'active-rt-001',
        tokenFamily: 'active-family-001',
        ip: '127.0.0.1',
        userAgent: 'test',
        expiresAt: futureDate,
      });

      await cleanupExpiredSessions();

      const remaining = await db.select().from(sessions).where(eq(sessions.refreshToken, 'active-rt-001'));
      expect(remaining.length).toBe(1);
    });
  });

  // ─── SECTION 10: getUserById Edge Cases (2 tests) ─────────────────
  describe('getUserById Edge Cases', () => {
    it('Should return user data for existing user', async () => {
      const user = await getUserById(testUser.id);
      expect(user).not.toBeNull();
      expect(user?.username).toBe(testUser.username);
      expect(user?.email).toBe(testUser.email);
      expect(user?.role).toBe(testUser.role);
    });

    it('Should return null for non-existent user', async () => {
      const user = await getUserById('does-not-exist-xyz');
      expect(user).toBeNull();
    });
  });
});
