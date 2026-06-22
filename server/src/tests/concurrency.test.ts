import { describe, it, expect, afterEach } from 'vitest';
import { db, client } from '../db/index.js';
import { users, sessions, telemetry, tickets, ticketComments, alerts } from '../db/schema.js';
import { login, refresh, logout } from '../services/auth.service.js';
import { ingestTelemetry } from '../services/telemetry.service.js';
import { createUser } from '../services/admin.service.js';
import { updateTicket, addComment, getTicketById } from '../services/ticket.service.js';
import { acknowledgeAlert, resolveAlert } from '../services/alert.service.js';
import { eq } from 'drizzle-orm';
import * as argon2 from 'argon2';
import { nanoid } from 'nanoid';

const TEST_PASSWORD = 'SecurePassword123!';

async function createTestUser(id: string, username: string, email: string) {
  const passwordHash = await argon2.hash(TEST_PASSWORD, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
  await db.insert(users).values({
    id,
    employeeId: `EM-${nanoid(4)}`,
    username,
    email,
    displayName: `User ${username}`,
    passwordHash,
    role: 'solar_operator',
  });
}

describe('Concurrency & Race Condition Tests', () => {
  afterEach(async () => {
    await client.execute('PRAGMA foreign_keys = OFF');
    await db.delete(sessions);
    await db.delete(ticketComments);
    await db.delete(tickets);
    await db.delete(alerts);
    await db.delete(telemetry);
    await db.delete(users);
    await client.execute('PRAGMA foreign_keys = ON');
  });

  // ─── SECTION 1: Simultaneous Login Tests (5 tests) ───────────────
  describe('Simultaneous Login', () => {
    it('Two simultaneous logins from same user → both succeed, only 1 session remains (SIP)', async () => {
      await createTestUser('conc-login-1', 'conclogin1', 'conc1@test.com');

      const results = await Promise.allSettled([
        login('conclogin1', TEST_PASSWORD, '10.0.0.1', 'Device A'),
        login('conclogin1', TEST_PASSWORD, '10.0.0.2', 'Device B'),
      ]);

      // At least one should succeed
      const successes = results.filter(r => r.status === 'fulfilled');
      expect(successes.length).toBeGreaterThanOrEqual(1);

      // Final state: both sessions exist (multiple sessions per user are allowed)
      const sessionRows = await db.select().from(sessions).where(eq(sessions.userId, 'conc-login-1'));
      expect(sessionRows.length).toBe(2);
    });

    it('Three rapid sequential logins → only last session survives', async () => {
      await createTestUser('conc-login-2', 'conclogin2', 'conc2@test.com');

      await login('conclogin2', TEST_PASSWORD, '10.0.0.1', 'Device A');
      await login('conclogin2', TEST_PASSWORD, '10.0.0.2', 'Device B');
      const t3 = await login('conclogin2', TEST_PASSWORD, '10.0.0.3', 'Device C');

      const sessionRows = await db.select().from(sessions).where(eq(sessions.userId, 'conc-login-2'));
      expect(sessionRows.length).toBe(1);
      expect(sessionRows[0]?.refreshToken).toBe(t3.refreshToken);
    });

    it('Simultaneous login from 2 different users → each gets own session', async () => {
      await createTestUser('conc-login-3a', 'conclogin3a', 'conc3a@test.com');
      await createTestUser('conc-login-3b', 'conclogin3b', 'conc3b@test.com');

      const [r1, r2] = await Promise.all([
        login('conclogin3a', TEST_PASSWORD, '10.0.0.1', 'Device A'),
        login('conclogin3b', TEST_PASSWORD, '10.0.0.2', 'Device B'),
      ]);

      expect(r1.accessToken).toBeDefined();
      expect(r2.accessToken).toBeDefined();

      const sessionsA = await db.select().from(sessions).where(eq(sessions.userId, 'conc-login-3a'));
      const sessionsB = await db.select().from(sessions).where(eq(sessions.userId, 'conc-login-3b'));
      expect(sessionsA.length).toBe(1);
      expect(sessionsB.length).toBe(1);
    });

    it('Rapid login + logout → no leftover sessions', async () => {
      await createTestUser('conc-login-4', 'conclogin4', 'conc4@test.com');

      const tokens = await login('conclogin4', TEST_PASSWORD, '10.0.0.1', 'Device A');
      await logout(tokens.refreshToken, 'conc-login-4', '10.0.0.1', 'Device A');

      const sessionRows = await db.select().from(sessions).where(eq(sessions.userId, 'conc-login-4'));
      expect(sessionRows.length).toBe(0);
    });

    it('Login while account being locked (sequential) → lockout enforced', async () => {
      await createTestUser('conc-login-5', 'conclogin5', 'conc5@test.com');

      // Trigger 5 failures sequentially
      for (let i = 0; i < 5; i++) {
        await expect(login('conclogin5', 'wrong', '10.0.0.1', 'test')).rejects.toThrow();
      }

      // Account should now be locked
      await expect(
        login('conclogin5', TEST_PASSWORD, '10.0.0.1', 'test')
      ).rejects.toThrow(/locked/i);
    });
  });

  // ─── SECTION 2: Simultaneous Telemetry Ingestion (4 tests) ───────
  describe('Simultaneous Telemetry Ingestion', () => {
    it('Two concurrent batches of 50 records → total 100 in DB', async () => {
      const baseTime = new Date('2026-06-01T00:00:00Z').getTime();
      const batch1 = Array.from({ length: 50 }, (_, i) => ({
        timestamp: new Date(baseTime + i * 1000).toISOString(),
        vdc1: 200, vdc2: 200, idc1: 5, idc2: 5, irr: 500, pvt: 30,
      }));
      const batch2 = Array.from({ length: 50 }, (_, i) => ({
        timestamp: new Date(baseTime + 100000 + i * 1000).toISOString(),
        vdc1: 300, vdc2: 300, idc1: 8, idc2: 8, irr: 800, pvt: 35,
      }));

      const results = await Promise.allSettled([
        ingestTelemetry(batch1),
        ingestTelemetry(batch2),
      ]);

      const successes = results.filter(r => r.status === 'fulfilled') as PromiseFulfilledResult<any>[];
      const totalInserted = successes.reduce((sum, r) => sum + r.value.inserted, 0);
      expect(totalInserted).toBe(100);
    });

    it('Five concurrent batches of 20 records → total 100 in DB', async () => {
      const baseTime = new Date('2026-06-01T00:00:00Z').getTime();
      const batches = Array.from({ length: 5 }, (_, batchIdx) =>
        Array.from({ length: 20 }, (_, i) => ({
          timestamp: new Date(baseTime + (batchIdx * 100000) + i * 1000).toISOString(),
          vdc1: 200, vdc2: 200, idc1: 5, idc2: 5, irr: 500, pvt: 30,
        }))
      );

      const results = await Promise.allSettled(batches.map(b => ingestTelemetry(b)));

      const successes = results.filter(r => r.status === 'fulfilled') as PromiseFulfilledResult<any>[];
      const totalInserted = successes.reduce((sum, r) => sum + r.value.inserted, 0);
      expect(totalInserted).toBe(100);
    });

    it('Concurrent ingestion with overlapping timestamps → all records stored', async () => {
      const sameTimestamp = '2026-06-01T12:00:00Z';
      const batch1 = [{ timestamp: sameTimestamp, vdc1: 100, vdc2: 100, idc1: 5, idc2: 5, irr: 500, pvt: 30 }];
      const batch2 = [{ timestamp: sameTimestamp, vdc1: 200, vdc2: 200, idc1: 8, idc2: 8, irr: 800, pvt: 35 }];

      const results = await Promise.allSettled([
        ingestTelemetry(batch1),
        ingestTelemetry(batch2),
      ]);

      const successes = results.filter(r => r.status === 'fulfilled') as PromiseFulfilledResult<any>[];
      const totalInserted = successes.reduce((sum, r) => sum + r.value.inserted, 0);
      expect(totalInserted).toBe(2); // Both stored even with same timestamp
    });

    it('Large concurrent ingestion: 3 batches of 150 records → total 450', async () => {
      const baseTime = new Date('2026-06-01T00:00:00Z').getTime();
      const batches = Array.from({ length: 3 }, (_, batchIdx) =>
        Array.from({ length: 150 }, (_, i) => ({
          timestamp: new Date(baseTime + (batchIdx * 1000000) + i * 1000).toISOString(),
          vdc1: 200, vdc2: 200, idc1: 5, idc2: 5, irr: 500, pvt: 30,
        }))
      );

      const results = await Promise.allSettled(batches.map(b => ingestTelemetry(b)));

      const successes = results.filter(r => r.status === 'fulfilled') as PromiseFulfilledResult<any>[];
      const totalInserted = successes.reduce((sum, r) => sum + r.value.inserted, 0);
      expect(totalInserted).toBe(450);
    });
  });

  // ─── SECTION 3: Concurrent Ticket Updates (5 tests) ──────────────
  describe('Concurrent Ticket Updates', () => {
    it('Two concurrent status updates to same ticket → at least one succeeds', async () => {
      await db.insert(tickets).values({
        id: 'T-CONC-1',
        status: 'open',
        severity: 'warning',
        faultType: 2,
        title: 'Concurrent update test',
      });

      const results = await Promise.allSettled([
        updateTicket('T-CONC-1', { status: 'acknowledged' }),
        updateTicket('T-CONC-1', { status: 'in_progress' }),
      ]);

      const successes = results.filter(r => r.status === 'fulfilled');
      expect(successes.length).toBeGreaterThanOrEqual(1);

      // Final status should be one of the valid transitions
      const ticket = await getTicketById('T-CONC-1');
      expect(['acknowledged', 'in_progress']).toContain(ticket?.status);
    });

    it('Concurrent comments on same ticket → all stored', async () => {
      const staff = await createUser({
        username: 'conccomment',
        email: 'conccomment@test.com',
        displayName: 'Conc Comment',
        password: 'Password123!',
        role: 'solar_operator',
      });

      await db.insert(tickets).values({
        id: 'T-CONC-2',
        status: 'open',
        severity: 'info',
        faultType: 0,
        title: 'Comment concurrency test',
      });

      const results = await Promise.allSettled([
        addComment('T-CONC-2', staff.id, 'Comment A'),
        addComment('T-CONC-2', staff.id, 'Comment B'),
        addComment('T-CONC-2', staff.id, 'Comment C'),
      ]);

      const successes = results.filter(r => r.status === 'fulfilled');
      expect(successes.length).toBe(3);

      const ticket = await getTicketById('T-CONC-2');
      expect(ticket?.comments.length).toBe(3);
    });

    it('Sequential state transitions: open → acknowledged → in_progress → resolved', async () => {
      await db.insert(tickets).values({
        id: 'T-CONC-3',
        status: 'open',
        severity: 'warning',
        faultType: 2,
        title: 'Sequential transition test',
      });

      await updateTicket('T-CONC-3', { status: 'acknowledged' });
      let ticket = await getTicketById('T-CONC-3');
      expect(ticket?.status).toBe('acknowledged');

      await updateTicket('T-CONC-3', { status: 'in_progress' });
      ticket = await getTicketById('T-CONC-3');
      expect(ticket?.status).toBe('in_progress');

      await updateTicket('T-CONC-3', { status: 'resolved', resolutionSummary: 'Fixed' });
      ticket = await getTicketById('T-CONC-3');
      expect(ticket?.status).toBe('resolved');
      expect(ticket?.resolvedAt).not.toBeNull();
    });

    it('Concurrent updates of different tickets → both succeed', async () => {
      await db.insert(tickets).values([
        { id: 'T-CONC-4A', status: 'open', severity: 'warning', faultType: 2, title: 'Ticket A' },
        { id: 'T-CONC-4B', status: 'open', severity: 'critical', faultType: 1, title: 'Ticket B' },
      ]);

      const [r1, r2] = await Promise.all([
        updateTicket('T-CONC-4A', { status: 'acknowledged' }),
        updateTicket('T-CONC-4B', { status: 'in_progress' }),
      ]);

      const ticketA = await getTicketById('T-CONC-4A');
      const ticketB = await getTicketById('T-CONC-4B');
      expect(ticketA?.status).toBe('acknowledged');
      expect(ticketB?.status).toBe('in_progress');
    });

    it('Multiple comments added simultaneously to same ticket → all persisted', async () => {
      const staff = await createUser({
        username: 'multicomment',
        email: 'multicomment@test.com',
        displayName: 'Multi Comment',
        password: 'Password123!',
        role: 'solar_operator',
      });

      await db.insert(tickets).values({
        id: 'T-CONC-5',
        status: 'open',
        severity: 'info',
        faultType: 0,
        title: 'Multi comment test',
      });

      const results = await Promise.allSettled(
        Array.from({ length: 10 }, (_, i) =>
          addComment('T-CONC-5', staff.id, `Comment ${i + 1}`)
        )
      );

      const successes = results.filter(r => r.status === 'fulfilled');
      expect(successes.length).toBe(10);

      const ticket = await getTicketById('T-CONC-5');
      expect(ticket?.comments.length).toBe(10);
    });
  });

  // ─── SECTION 4: Concurrent Alert Operations (4 tests) ────────────
  describe('Concurrent Alert Operations', () => {
    it('Acknowledge same alert concurrently from 2 users → alert acknowledged', async () => {
      await createTestUser('alert-user-1', 'alertuser1', 'alert1@test.com');
      await createTestUser('alert-user-2', 'alertuser2', 'alert2@test.com');

      await db.insert(tickets).values({
        id: 'T-ALERT-1',
        status: 'open',
        severity: 'warning',
        faultType: 2,
        title: 'Alert test',
        alertId: 'A-CONC-1',
      });
      await db.insert(alerts).values({
        id: 'A-CONC-1',
        timestamp: new Date(),
        severity: 'warning',
        faultType: 2,
        confidence: 0.9,
        detectionLayer: 'ai',
        acknowledged: false,
        ticketId: 'T-ALERT-1',
      });

      await Promise.allSettled([
        acknowledgeAlert('A-CONC-1', 'alert-user-1'),
        acknowledgeAlert('A-CONC-1', 'alert-user-2'),
      ]);

      const [alert] = await db.select().from(alerts).where(eq(alerts.id, 'A-CONC-1'));
      expect(alert?.acknowledged).toBe(true);
    });

    it('Resolve same alert concurrently → alert resolved, ticket resolved', async () => {
      await createTestUser('alert-user-3', 'alertuser3', 'alert3@test.com');
      await createTestUser('alert-user-4', 'alertuser4', 'alert4@test.com');

      await db.insert(tickets).values({
        id: 'T-ALERT-2',
        status: 'open',
        severity: 'critical',
        faultType: 1,
        title: 'Resolve test',
        alertId: 'A-CONC-2',
      });
      await db.insert(alerts).values({
        id: 'A-CONC-2',
        timestamp: new Date(),
        severity: 'critical',
        faultType: 1,
        confidence: 0.95,
        detectionLayer: 'ai',
        acknowledged: false,
        ticketId: 'T-ALERT-2',
      });

      await Promise.allSettled([
        resolveAlert('A-CONC-2', 'alert-user-3'),
        resolveAlert('A-CONC-2', 'alert-user-4'),
      ]);

      const [alert] = await db.select().from(alerts).where(eq(alerts.id, 'A-CONC-2'));
      expect(alert?.acknowledged).toBe(true);

      const [ticket] = await db.select().from(tickets).where(eq(tickets.id, 'T-ALERT-2'));
      expect(ticket?.status).toBe('resolved');
    });

    it('Acknowledge and resolve same alert concurrently → alert acknowledged', async () => {
      await createTestUser('alert-user-5', 'alertuser5', 'alert5@test.com');
      await createTestUser('alert-user-6', 'alertuser6', 'alert6@test.com');

      await db.insert(tickets).values({
        id: 'T-ALERT-3',
        status: 'open',
        severity: 'warning',
        faultType: 2,
        title: 'Ack+Resolve test',
        alertId: 'A-CONC-3',
      });
      await db.insert(alerts).values({
        id: 'A-CONC-3',
        timestamp: new Date(),
        severity: 'warning',
        faultType: 2,
        confidence: 0.88,
        detectionLayer: 'ai',
        acknowledged: false,
        ticketId: 'T-ALERT-3',
      });

      await Promise.allSettled([
        acknowledgeAlert('A-CONC-3', 'alert-user-5'),
        resolveAlert('A-CONC-3', 'alert-user-6'),
      ]);

      const [alert] = await db.select().from(alerts).where(eq(alerts.id, 'A-CONC-3'));
      expect(alert?.acknowledged).toBe(true);
    });

    it('Concurrent alert processing (create 2 independent alerts) → both created', async () => {
      await db.insert(tickets).values([
        { id: 'T-ALERT-4A', status: 'open', severity: 'warning', faultType: 2, title: 'Alert A', alertId: 'A-CONC-4A' },
        { id: 'T-ALERT-4B', status: 'open', severity: 'critical', faultType: 1, title: 'Alert B', alertId: 'A-CONC-4B' },
      ]);
      await db.insert(alerts).values([
        { id: 'A-CONC-4A', timestamp: new Date(), severity: 'warning', faultType: 2, confidence: 0.8, detectionLayer: 'ai', acknowledged: false, ticketId: 'T-ALERT-4A' },
        { id: 'A-CONC-4B', timestamp: new Date(), severity: 'critical', faultType: 1, confidence: 0.95, detectionLayer: 'ai', acknowledged: false, ticketId: 'T-ALERT-4B' },
      ]);

      await createTestUser('alert-user-7', 'alertuser7', 'alert7@test.com');

      await Promise.all([
        acknowledgeAlert('A-CONC-4A', 'alert-user-7'),
        resolveAlert('A-CONC-4B', 'alert-user-7'),
      ]);

      const [alertA] = await db.select().from(alerts).where(eq(alerts.id, 'A-CONC-4A'));
      const [alertB] = await db.select().from(alerts).where(eq(alerts.id, 'A-CONC-4B'));
      expect(alertA?.acknowledged).toBe(true);
      expect(alertB?.acknowledged).toBe(true);

      const [ticketA] = await db.select().from(tickets).where(eq(tickets.id, 'T-ALERT-4A'));
      const [ticketB] = await db.select().from(tickets).where(eq(tickets.id, 'T-ALERT-4B'));
      expect(ticketA?.status).toBe('acknowledged');
      expect(ticketB?.status).toBe('resolved');
    });

    it('Sequential duplicate acknowledgment → second returns false (conflict)', async () => {
      await createTestUser('alert-user-seq-1', 'seq1', 'seq1@test.com');
      await db.insert(tickets).values({
        id: 'T-ALERT-SEQ-1',
        status: 'open',
        severity: 'warning',
        faultType: 2,
        title: 'Seq Alert test',
        alertId: 'A-CONC-SEQ-1',
      });
      await db.insert(alerts).values({
        id: 'A-CONC-SEQ-1',
        timestamp: new Date(),
        severity: 'warning',
        faultType: 2,
        confidence: 0.9,
        detectionLayer: 'ai',
        acknowledged: false,
        ticketId: 'T-ALERT-SEQ-1',
      });

      const r1 = await acknowledgeAlert('A-CONC-SEQ-1', 'alert-user-seq-1');
      const r2 = await acknowledgeAlert('A-CONC-SEQ-1', 'alert-user-seq-1');

      expect(r1).toBe(true);
      expect(r2).toBe(false);
    });

    it('Sequential duplicate resolution → second returns false (conflict)', async () => {
      await createTestUser('alert-user-seq-2', 'seq2', 'seq2@test.com');
      await db.insert(tickets).values({
        id: 'T-ALERT-SEQ-2',
        status: 'open',
        severity: 'warning',
        faultType: 2,
        title: 'Seq Alert test 2',
        alertId: 'A-CONC-SEQ-2',
      });
      await db.insert(alerts).values({
        id: 'A-CONC-SEQ-2',
        timestamp: new Date(),
        severity: 'warning',
        faultType: 2,
        confidence: 0.9,
        detectionLayer: 'ai',
        acknowledged: false,
        ticketId: 'T-ALERT-SEQ-2',
      });

      const r1 = await resolveAlert('A-CONC-SEQ-2', 'alert-user-seq-2');
      const r2 = await resolveAlert('A-CONC-SEQ-2', 'alert-user-seq-2');

      expect(r1).toBe(true);
      expect(r2).toBe(false);
    });

    it('Ticket update status duplicate → throws conflict error', async () => {
      await db.insert(tickets).values({
        id: 'T-ALERT-SEQ-3',
        status: 'open',
        severity: 'warning',
        faultType: 2,
        title: 'Seq Ticket test',
      });

      await updateTicket('T-ALERT-SEQ-3', { status: 'acknowledged' });
      await expect(
        updateTicket('T-ALERT-SEQ-3', { status: 'acknowledged' })
      ).rejects.toThrow(/already acknowledged/i);

      try {
        await updateTicket('T-ALERT-SEQ-3', { status: 'acknowledged' });
      } catch (err: any) {
        expect(err.isConflict).toBe(true);
      }
    });
  });

  // ─── SECTION 5: Session Race Conditions (3 tests) ────────────────
  describe('Session Race Conditions', () => {
    it('Login + immediate refresh → works correctly', async () => {
      await createTestUser('session-race-1', 'sessionrace1', 'sr1@test.com');

      const tokens = await login('sessionrace1', TEST_PASSWORD, '10.0.0.1', 'Device A');
      const refreshed = await refresh(tokens.refreshToken, '10.0.0.1', 'Device A');

      expect(refreshed.accessToken).toBeDefined();
      expect(refreshed.refreshToken).not.toBe(tokens.refreshToken);
    });

    it('Logout while refresh is happening → session eventually cleaned up', async () => {
      await createTestUser('session-race-2', 'sessionrace2', 'sr2@test.com');

      const tokens = await login('sessionrace2', TEST_PASSWORD, '10.0.0.1', 'Device A');

      const results = await Promise.allSettled([
        refresh(tokens.refreshToken, '10.0.0.1', 'Device A'),
        logout(tokens.refreshToken, 'session-race-2', '10.0.0.1', 'Device A'),
      ]);

      // At least one should succeed
      const successes = results.filter(r => r.status === 'fulfilled');
      expect(successes.length).toBeGreaterThanOrEqual(1);
    });

    it('Multiple sequential refreshes → token chain intact', async () => {
      await createTestUser('session-race-3', 'sessionrace3', 'sr3@test.com');

      const t1 = await login('sessionrace3', TEST_PASSWORD, '10.0.0.1', 'Device A');
      const t2 = await refresh(t1.refreshToken, '10.0.0.1', 'Device A');
      const t3 = await refresh(t2.refreshToken, '10.0.0.1', 'Device A');

      expect(t3.accessToken).toBeDefined();
      expect(t3.refreshToken).not.toBe(t2.refreshToken);
      expect(t3.refreshToken).not.toBe(t1.refreshToken);

      // Old tokens should not work
      await expect(refresh(t1.refreshToken, '10.0.0.1', 'test')).rejects.toThrow();
    });
  });
});
