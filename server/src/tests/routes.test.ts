import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import authPlugin from '../plugins/auth.js';
import authRoutes from '../routes/auth.js';
import configRoutes from '../routes/config.js';
import ticketRoutes from '../routes/tickets.js';
import { db } from '../db/index.js';
import { users, sessions, config, tickets } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import * as argon2 from 'argon2';
import { login } from '../services/auth.service.js';

describe('Fastify Routes & Middleware Security Integration Suite', () => {
  let app: ReturnType<typeof Fastify>;
  let adminToken: string;
  let operatorToken: string;
  let secondOperatorToken: string;

  const adminUser = {
    id: 'route-admin-001',
    employeeId: 'EM-R-ADM',
    username: 'routeadmin',
    email: 'routeadmin@energiamind.com',
    displayName: 'Route Admin',
    password: 'SecurePassword123!',
    role: 'admin' as const,
  };

  const operatorUser = {
    id: 'route-operator-001',
    employeeId: 'EM-R-OP1',
    username: 'routeop1',
    email: 'routeop1@energiamind.com',
    displayName: 'Route Operator 1',
    password: 'SecurePassword123!',
    role: 'solar_operator' as const,
  };

  const secondOperator = {
    id: 'route-operator-002',
    employeeId: 'EM-R-OP2',
    username: 'routeop2',
    email: 'routeop2@energiamind.com',
    displayName: 'Route Operator 2',
    password: 'SecurePassword123!',
    role: 'solar_operator' as const,
  };

  beforeAll(async () => {
    // Set up test database users
    const hash = await argon2.hash('SecurePassword123!', {
      type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1,
    });

    await db.delete(users);
    await db.insert(users).values([
      { id: adminUser.id, employeeId: adminUser.employeeId, username: adminUser.username, email: adminUser.email, displayName: adminUser.displayName, passwordHash: hash, role: adminUser.role },
      { id: operatorUser.id, employeeId: operatorUser.employeeId, username: operatorUser.username, email: operatorUser.email, displayName: operatorUser.displayName, passwordHash: hash, role: operatorUser.role },
      { id: secondOperator.id, employeeId: secondOperator.employeeId, username: secondOperator.username, email: secondOperator.email, displayName: secondOperator.displayName, passwordHash: hash, role: secondOperator.role },
    ]);

    // Generate valid JWT tokens for API calls
    const adminLogin = await login(adminUser.username, adminUser.password, '127.0.0.1', 'test');
    adminToken = adminLogin.accessToken;

    const opLogin = await login(operatorUser.username, operatorUser.password, '127.0.0.1', 'test');
    operatorToken = opLogin.accessToken;

    const op2Login = await login(secondOperator.username, secondOperator.password, '127.0.0.1', 'test');
    secondOperatorToken = op2Login.accessToken;

    app = Fastify({
      logger: false,
      ajv: {
        customOptions: {
          removeAdditional: false,
        },
      },
    });
    await app.register(cookie, { secret: 'test-cookie-secret-key-at-least-32-characters-long' });
    await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
    await app.register(authPlugin);
    await app.register(authRoutes);
    await app.register(configRoutes);
    await app.register(ticketRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await db.delete(config);
    await db.delete(tickets);
    await db.delete(sessions);
  });

  // ─── SECTION 1: Turnstile CAPTCHA (SEC-008 verification) ────────────
  describe('POST /api/v1/auth/login — Turnstile CAPTCHA Validation', () => {
    it('Should bypass Turnstile if TURNSTILE_SECRET_KEY is not configured', async () => {
      const originalSecret = process.env.TURNSTILE_SECRET_KEY;
      delete process.env.TURNSTILE_SECRET_KEY;

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          username: operatorUser.username,
          password: operatorUser.password,
        },
      });

      process.env.TURNSTILE_SECRET_KEY = originalSecret;

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.accessToken).toBeDefined();
    });

    it('Should reject login if TURNSTILE_SECRET_KEY is set but no token is provided', async () => {
      const originalSecret = process.env.TURNSTILE_SECRET_KEY;
      process.env.TURNSTILE_SECRET_KEY = 'mock-secret-key';
      
      const originalBypass = process.env.TURNSTILE_BYPASS_IPS;
      delete process.env.TURNSTILE_BYPASS_IPS;

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          username: operatorUser.username,
          password: operatorUser.password,
        },
        // Call from outside whitelisted IP
        remoteAddress: '192.168.1.100',
      });

      process.env.TURNSTILE_SECRET_KEY = originalSecret;
      process.env.TURNSTILE_BYPASS_IPS = originalBypass;

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error).toContain('CAPTCHA verification token required');
    });

    it('Should bypass Turnstile if client IP is whitelisted in TURNSTILE_BYPASS_IPS', async () => {
      const originalSecret = process.env.TURNSTILE_SECRET_KEY;
      process.env.TURNSTILE_SECRET_KEY = 'mock-secret-key';

      const originalBypass = process.env.TURNSTILE_BYPASS_IPS;
      process.env.TURNSTILE_BYPASS_IPS = '127.0.0.1,::1,10.0.0.5';

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          username: operatorUser.username,
          password: operatorUser.password,
        },
        // Spoofing connection from whitelisted IP
        remoteAddress: '10.0.0.5',
      });

      process.env.TURNSTILE_SECRET_KEY = originalSecret;
      process.env.TURNSTILE_BYPASS_IPS = originalBypass;

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.accessToken).toBeDefined();
    });
  });

  // ─── SECTION 2: Config Key Whitelist (additionalProperties: false) ────
  describe('PATCH /api/v1/config — Key Allowlist Schema Enforcement', () => {
    it('Should allow updating valid config keys', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/config',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          detection_sensitivity: 0.8,
          maintenance_mode: false,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(true);
      expect(body.data.detection_sensitivity).toBe(0.8);
    });

    it('Should reject PATCH requests containing unlisted config keys', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/config',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          detection_sensitivity: 0.8,
          unauthorized_secret_key: 'hacked_value',
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error).toBe('Bad Request');
      expect(body.message).toContain('must NOT have additional properties');
    });

    it('Should reject notification_email exceeding maxLength limit', async () => {
      const longEmail = 'a'.repeat(250) + '@test.com'; // 259 chars
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/config',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          notification_email: longEmail,
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.message).toContain('notification_email');
    });
  });

  // ─── SECTION 3: Ticket IDOR / Authorization Check ──────────────────
  describe('PATCH /api/v1/tickets/:id — Authorization & IDOR Control', () => {
    const ticketId = 'INC-2026-ROUTE01';

    beforeEach(async () => {
      await db.insert(tickets).values({
        id: ticketId,
        status: 'open',
        severity: 'warning',
        faultType: 2,
        title: 'Test IDOR Ticket',
        assigneeId: operatorUser.id,
      });
    });

    it('Should allow admin to update any ticket', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/tickets/${ticketId}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          status: 'acknowledged',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.status).toBe('acknowledged');
    });

    it('Should allow the assigned operator to update their ticket', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/tickets/${ticketId}`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: {
          status: 'in_progress',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.status).toBe('in_progress');
    });

    it('Should REJECT updates from an operator who is NOT assigned to the ticket', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/tickets/${ticketId}`,
        headers: { authorization: `Bearer ${secondOperatorToken}` },
        payload: {
          status: 'resolved',
        },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.payload);
      expect(body.error).toContain('Not authorized to update this ticket');
    });
  });

  // ─── SECTION 4: Input Length Validations & Rate Limits ─────────────
  describe('POST /api/v1/tickets/:id/comments — Content Length Limits', () => {
    const ticketId = 'INC-2026-ROUTE02';

    beforeEach(async () => {
      await db.insert(tickets).values({
        id: ticketId,
        status: 'open',
        severity: 'warning',
        faultType: 2,
        title: 'Test Comment Ticket',
        assigneeId: operatorUser.id,
      });
    });

    it('Should reject ticket comments exceeding maxLength (5000 chars)', async () => {
      const longComment = 'a'.repeat(5001);
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/tickets/${ticketId}/comments`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: {
          content: longComment,
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.message).toContain('content');
    });

    it('Should accept valid comments (<= 5000 chars)', async () => {
      const validComment = 'a'.repeat(100);
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/tickets/${ticketId}/comments`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: {
          content: validComment,
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.content).toBe(validComment);
    });
  });
});
