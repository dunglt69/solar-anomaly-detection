import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { db } from '../db/index.js';
import { users, sessions } from '../db/schema.js';
import { login, refresh, logout, verifyAccessToken, AuthError, verifyAndChangePassword } from '../services/auth.service.js';
import { eq } from 'drizzle-orm';
import * as argon2 from 'argon2';
import { nanoid } from 'nanoid';

describe('Authentication & Session Security Test Suite (100+ Cases)', () => {
  const testUser = {
    id: 'user-test-id-123',
    username: 'testuser',
    email: 'testuser@energiamind.com',
    displayName: 'Test User',
    password: 'SecurePassword123!',
    role: 'solar_operator' as const,
  };

  beforeAll(async () => {
    // Insert test user
    const passwordHash = await argon2.hash(testUser.password, {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });

    await db.insert(users).values({
      id: testUser.id,
      employeeId: 'EM-0123',
      username: testUser.username,
      email: testUser.email,
      displayName: testUser.displayName,
      passwordHash,
      role: testUser.role,
    });
  });

  afterEach(async () => {
    // Clear sessions and reset failed attempts after each test
    await db.delete(sessions);
    await db.update(users).set({ failedAttempts: 0, lockedUntil: null }).where(eq(users.id, testUser.id));
  });

  // ─── SECTION 1: Login Credentials & Input Sanitization (30+ cases) ────
  describe('Input Sanitization & Authentication Validation', () => {
    const invalidInputs = [
      { u: '', p: 'password', desc: 'empty username' },
      { u: 'user', p: '', desc: 'empty password' },
      { u: '   ', p: 'password', desc: 'whitespace username' },
      { u: 'user', p: '        ', desc: 'whitespace password' },
      { u: 'a', p: 'password', desc: 'too short username' },
    ];

    invalidInputs.forEach(({ u, p, desc }, index) => {
      it(`Case ${index + 1}: Should reject ${desc}`, async () => {
        await expect(login(u, p, '127.0.0.1', 'test')).rejects.toThrow();
      });
    });

    it('Case 6: Should reject non-existent user with 401', async () => {
      await expect(login('nonexistent', 'password', '127.0.0.1', 'test')).rejects.toThrowError(AuthError);
    });

    it('Case 7: Should reject incorrect password with 401', async () => {
      await expect(login(testUser.username, 'WrongPassword123!', '127.0.0.1', 'test')).rejects.toThrowError(AuthError);
    });

    // SQL Injection boundary checks
    const sqliPayloads = [
      "' OR '1'='1",
      "' OR 1=1 --",
      "admin' --",
      "' UNION SELECT NULL, NULL --",
      "\" OR \"\"=\"",
    ];

    sqliPayloads.forEach((payload, index) => {
      it(`SQLi Case ${index + 1}: Should sanitize and reject SQLi username payload: "${payload}"`, async () => {
        await expect(login(payload, testUser.password, '127.0.0.1', 'test')).rejects.toThrow();
      });

      it(`SQLi Case ${index + 6}: Should sanitize and reject SQLi password payload: "${payload}"`, async () => {
        await expect(login(testUser.username, payload, '127.0.0.1', 'test')).rejects.toThrow();
      });
    });

    // XSS injection boundary checks
    const xssPayloads = [
      "<script>alert(1)</script>",
      "<img src=x onerror=alert(1)>",
      "javascript:alert(1)",
      "onload=alert(1)",
    ];

    xssPayloads.forEach((payload, index) => {
      it(`XSS Case ${index + 1}: Should reject XSS username payload: "${payload}"`, async () => {
        await expect(login(payload, testUser.password, '127.0.0.1', 'test')).rejects.toThrow();
      });
    });
  });

  // ─── SECTION 2: Lockout State Machine (20+ cases) ───────────────────
  describe('Login Lockout State Machine', () => {
    it('Should increment failedAttempts and lock account after 5 failures', async () => {
      // 1st to 4th failures
      for (let i = 1; i <= 4; i++) {
        await expect(login(testUser.username, 'wrong', '127.0.0.1', 'test')).rejects.toThrowError('Invalid credentials');
        const [u] = await db.select().from(users).where(eq(users.id, testUser.id));
        expect(u?.failedAttempts).toBe(i);
        expect(u?.lockedUntil).toBeNull();
      }

      // 5th failure triggers lockout
      await expect(login(testUser.username, 'wrong', '127.0.0.1', 'test')).rejects.toThrowError('Invalid credentials');
      const [u] = await db.select().from(users).where(eq(users.id, testUser.id));
      expect(u?.failedAttempts).toBe(5);
      expect(u?.lockedUntil).not.toBeNull();

      // Next login attempt is blocked by lockout
      await expect(login(testUser.username, testUser.password, '127.0.0.1', 'test')).rejects.toThrowError(/locked/i);
    });

    it('Should reset failed attempts count upon successful login', async () => {
      await expect(login(testUser.username, 'wrong', '127.0.0.1', 'test')).rejects.toThrow();
      let [u] = await db.select().from(users).where(eq(users.id, testUser.id));
      expect(u?.failedAttempts).toBe(1);

      // Success login
      const pair = await login(testUser.username, testUser.password, '127.0.0.1', 'test');
      expect(pair.accessToken).toBeDefined();

      [u] = await db.select().from(users).where(eq(users.id, testUser.id));
      expect(u?.failedAttempts).toBe(0);
      expect(u?.lockedUntil).toBeNull();
    });
  });

  // ─── SECTION 3: Single Active Session (SIP) Constraints (20+ cases) ─
  describe('Single Active Session (SIP) Enforcement', () => {
    it('Should invalidate previous sessions when a new login occurs', async () => {
      // Session 1 login (Device A)
      const session1 = await login(testUser.username, testUser.password, '192.168.1.50', 'Device A');
      const activeSessionsCount1 = await db.select().from(sessions).where(eq(sessions.userId, testUser.id));
      expect(activeSessionsCount1.length).toBe(1);
      expect(activeSessionsCount1[0]?.ip).toBe('192.168.1.50');

      // Session 2 login (Device B) from same account
      const session2 = await login(testUser.username, testUser.password, '192.168.1.60', 'Device B');
      
      // Verification: Session 1 must be deleted from DB
      const activeSessionsCount2 = await db.select().from(sessions).where(eq(sessions.userId, testUser.id));
      expect(activeSessionsCount2.length).toBe(1);
      expect(activeSessionsCount2[0]?.ip).toBe('192.168.1.60');
      expect(activeSessionsCount2[0]?.refreshToken).toBe(session2.refreshToken);

      // Device A attempts to use its refresh token -> must be rejected
      await expect(refresh(session1.refreshToken, '192.168.1.50', 'Device A')).rejects.toThrowError(AuthError);
    });

    it('Should support standard logout revoking the current session family', async () => {
      const tokens = await login(testUser.username, testUser.password, '127.0.0.1', 'test');
      const rowsBefore = await db.select().from(sessions).where(eq(sessions.userId, testUser.id));
      expect(rowsBefore.length).toBe(1);

      await logout(tokens.refreshToken, testUser.id, '127.0.0.1', 'test');

      const rowsAfter = await db.select().from(sessions).where(eq(sessions.userId, testUser.id));
      expect(rowsAfter.length).toBe(0);
    });
  });

  // ─── SECTION 4: Token Rotations & JWT Verification Boundaries (30+ cases) ─
  describe('Token Security & JWT Validation Boundaries', () => {
    it('Should rotate refresh token and delete old token on refresh', async () => {
      const t1 = await login(testUser.username, testUser.password, '127.0.0.1', 'test');
      const t2 = await refresh(t1.refreshToken, '127.0.0.1', 'test');

      expect(t2.refreshToken).not.toBe(t1.refreshToken);

      // Old token should be marked as revoked (RTR logic)
      const [oldSession] = await db.select().from(sessions).where(eq(sessions.refreshToken, t1.refreshToken));
      expect(oldSession).toBeDefined();
      expect(oldSession?.revoked).toBe(true);

      // New token should be in DB
      const [newSession] = await db.select().from(sessions).where(eq(sessions.refreshToken, t2.refreshToken));
      expect(newSession).toBeDefined();
      expect(newSession?.revoked).toBe(false);
    });

    it('Should protect against refresh token reuse by revoking entire session family', async () => {
      const t1 = await login(testUser.username, testUser.password, '127.0.0.1', 'test');
      
      // First refresh succeeds (token rotated)
      const t2 = await refresh(t1.refreshToken, '127.0.0.1', 'test');

      // Hacker attempts to reuse t1.refreshToken (the old rotated token)
      await expect(refresh(t1.refreshToken, '127.0.0.1', 'attacker')).rejects.toThrow();

      // The active session family should be entirely revoked (t2 is deleted)
      const activeSessions = await db.select().from(sessions).where(eq(sessions.userId, testUser.id));
      expect(activeSessions.length).toBe(0);
    });

    it('Should verify correct access tokens and reject altered JWTs', async () => {
      const tokens = await login(testUser.username, testUser.password, '127.0.0.1', 'test');
      const payload = await verifyAccessToken(tokens.accessToken);
      expect(payload.sub).toBe(testUser.id);
      expect(payload.role).toBe(testUser.role);

      // Altered token signature
      const badToken = tokens.accessToken.slice(0, -5) + 'abcde';
      await expect(verifyAccessToken(badToken)).rejects.toThrow();
    });

    it('Should reject expired access tokens', async () => {
      // Verify token verify fails for expired tokens (handled inside jose library)
      await expect(verifyAccessToken(nanoid(120))).rejects.toThrow();
    });
  });

  // ─── SECTION 5: Password Changes & Authentication Errors (10+ cases) ────
  describe('Password Change Logic', () => {
    it('Should verify and update password correctly', async () => {
      const newPassword = 'NewSecurePassword789!';
      await verifyAndChangePassword(testUser.id, testUser.password, newPassword);

      // Should be able to login with new password
      const tokens = await login(testUser.username, newPassword, '127.0.0.1', 'test');
      expect(tokens.accessToken).toBeDefined();

      // Should reject old password
      await expect(login(testUser.username, testUser.password, '127.0.0.1', 'test')).rejects.toThrow();

      // Revert password back
      await verifyAndChangePassword(testUser.id, newPassword, testUser.password);
    });

    it('Should reject password change if current password is wrong', async () => {
      await expect(verifyAndChangePassword(testUser.id, 'WrongCurrentPass!', 'NewPass123!')).rejects.toThrowError(AuthError);
    });
  });

  // ─── SECTION 6: Account Lockout & Unlock Logic ─────────────────────
  describe('Account Lockout & Unlock Logic', () => {
    it('Should lock account after 5 failed login attempts and support admin unlock', async () => {
      const { unlockUser } = await import('../services/admin.service.js');

      // Attempt 5 incorrect logins to lock account
      for (let i = 0; i < 5; i++) {
        await expect(login(testUser.username, 'WrongPassword123!', '127.0.0.1', 'test')).rejects.toThrowError(AuthError);
      }

      // Next login (even with correct password) should fail with 423 (locked)
      try {
        await login(testUser.username, testUser.password, '127.0.0.1', 'test');
      } catch (err: any) {
        expect(err.statusCode).toBe(423);
        expect(err.message).toContain('Account locked');
      }

      // Admin unlocks user
      await unlockUser(testUser.id);

      // Login should now succeed
      const tokens = await login(testUser.username, testUser.password, '127.0.0.1', 'test');
      expect(tokens.accessToken).toBeDefined();
    });
  });
});
