import { describe, it, expect, afterEach, vi } from 'vitest';
import { db, client } from '../db/index.js';
import { telemetry, users, tickets, ticketComments, activityLog } from '../db/schema.js';
import { ingestTelemetry, queryTelemetry, getLatestTelemetry } from '../services/telemetry.service.js';
import { createUser, updateUser, deleteUser, listUsers } from '../services/admin.service.js';
import { addComment, updateTicket, getTicketById, queryTickets } from '../services/ticket.service.js';
import { eq } from 'drizzle-orm';

describe('Input Validation — Extended Test Suite', () => {
  afterEach(async () => {
    await client.execute('PRAGMA foreign_keys = OFF');
    await db.delete(ticketComments);
    await db.delete(tickets);
    await db.delete(telemetry);
    await db.delete(activityLog);
    await db.delete(users);
    await client.execute('PRAGMA foreign_keys = ON');
  });

  // ─── SECTION 1: Telemetry Ingestion Validation (12 tests) ────────
  describe('Telemetry Ingestion Edge Cases', () => {
    it('Empty array → { inserted: 0 }', async () => {
      const result = await ingestTelemetry([]);
      expect(result.inserted).toBe(0);
    });

    it('Single valid record → { inserted: 1 }', async () => {
      const result = await ingestTelemetry([{
        timestamp: '2026-06-01T12:00:00Z',
        vdc1: 200, vdc2: 200, idc1: 5, idc2: 5, irr: 500, pvt: 30,
      }]);
      expect(result.inserted).toBe(1);

      const latest = await getLatestTelemetry(1);
      expect(latest.length).toBe(1);
      expect(latest[0]?.vdc1).toBe(200);
    });

    it('Negative voltage values → accepted (stores negative power)', async () => {
      const result = await ingestTelemetry([{
        timestamp: '2026-06-01T12:00:00Z',
        vdc1: -100, vdc2: -50, idc1: 5, idc2: 5, irr: 500, pvt: 30,
      }]);
      expect(result.inserted).toBe(1);

      const latest = await getLatestTelemetry(1);
      expect(latest[0]?.pdc1).toBe(-500); // -100 * 5
      expect(latest[0]?.pdc2).toBe(-250); // -50 * 5
    });

    it('Zero values for all fields → accepted', async () => {
      const result = await ingestTelemetry([{
        timestamp: '2026-06-01T12:00:00Z',
        vdc1: 0, vdc2: 0, idc1: 0, idc2: 0, irr: 0, pvt: 0,
      }]);
      expect(result.inserted).toBe(1);

      const latest = await getLatestTelemetry(1);
      expect(latest[0]?.pdc1).toBe(0);
      expect(latest[0]?.pdcTotal).toBe(0);
    });

    it('Very large voltage (999999) → accepted with large power', async () => {
      const result = await ingestTelemetry([{
        timestamp: '2026-06-01T12:00:00Z',
        vdc1: 999999, vdc2: 1, idc1: 1, idc2: 1, irr: 500, pvt: 30,
      }]);
      expect(result.inserted).toBe(1);

      const latest = await getLatestTelemetry(1);
      expect(latest[0]?.pdc1).toBe(999999);
    });

    it('Batch of exactly 100 (chunk boundary) → { inserted: 100 }', async () => {
      const baseTime = new Date('2026-06-01T00:00:00Z').getTime();
      const batch = Array.from({ length: 100 }, (_, i) => ({
        timestamp: new Date(baseTime + i * 1000).toISOString(),
        vdc1: 200, vdc2: 200, idc1: 5, idc2: 5, irr: 500, pvt: 30,
      }));
      const result = await ingestTelemetry(batch);
      expect(result.inserted).toBe(100);
    });

    it('Batch of 101 (crosses chunk boundary) → { inserted: 101 }', async () => {
      const baseTime = new Date('2026-06-01T00:00:00Z').getTime();
      const batch = Array.from({ length: 101 }, (_, i) => ({
        timestamp: new Date(baseTime + i * 1000).toISOString(),
        vdc1: 200, vdc2: 200, idc1: 5, idc2: 5, irr: 500, pvt: 30,
      }));
      const result = await ingestTelemetry(batch);
      expect(result.inserted).toBe(101);
    });

    it('Record with explicit pdc1/pdc2/pdcTotal → uses provided values', async () => {
      const result = await ingestTelemetry([{
        timestamp: '2026-06-01T12:00:00Z',
        vdc1: 200, vdc2: 200, idc1: 5, idc2: 5, irr: 500, pvt: 30,
        pdc1: 9999, pdc2: 8888, pdcTotal: 7777,
      }]);
      expect(result.inserted).toBe(1);

      const latest = await getLatestTelemetry(1);
      expect(latest[0]?.pdc1).toBe(9999);
      expect(latest[0]?.pdc2).toBe(8888);
      expect(latest[0]?.pdcTotal).toBe(7777);
    });

    it('Record with faultLabel=4 → stores faultLabel 4', async () => {
      await ingestTelemetry([{
        timestamp: '2026-06-01T12:00:00Z',
        vdc1: 200, vdc2: 200, idc1: 5, idc2: 5, irr: 500, pvt: 30,
        faultLabel: 4,
      }]);

      const latest = await getLatestTelemetry(1);
      expect(latest[0]?.faultLabel).toBe(4);
    });

    it('Record with faultLabel=0 → stores faultLabel 0', async () => {
      await ingestTelemetry([{
        timestamp: '2026-06-01T12:00:00Z',
        vdc1: 200, vdc2: 200, idc1: 5, idc2: 5, irr: 500, pvt: 30,
        faultLabel: 0,
      }]);

      const latest = await getLatestTelemetry(1);
      expect(latest[0]?.faultLabel).toBe(0);
    });

    it('Timestamp as ISO string → valid', async () => {
      const result = await ingestTelemetry([{
        timestamp: '2026-06-15T10:30:00.000Z',
        vdc1: 200, vdc2: 200, idc1: 5, idc2: 5, irr: 500, pvt: 30,
      }]);
      expect(result.inserted).toBe(1);
    });

    it('Timestamp as epoch number → valid', async () => {
      const epoch = new Date('2026-06-15T10:30:00Z').getTime();
      const result = await ingestTelemetry([{
        timestamp: epoch,
        vdc1: 200, vdc2: 200, idc1: 5, idc2: 5, irr: 500, pvt: 30,
      }]);
      expect(result.inserted).toBe(1);
    });
  });

  // ─── SECTION 2: Admin User Creation Validation (8 tests) ─────────
  describe('Admin User Creation & Management Edge Cases', () => {
    it('Create user with all valid fields → success', async () => {
      const user = await createUser({
        username: 'validuser',
        email: 'valid@test.com',
        displayName: 'Valid User',
        password: 'Password123!',
        role: 'solar_operator',
      });

      expect(user.id).toBeDefined();
      expect(user.username).toBe('validuser');
      expect(user.role).toBe('solar_operator');
    });

    it('Duplicate username → throws UNIQUE constraint error', async () => {
      await createUser({
        username: 'dupeuser',
        email: 'dupe1@test.com',
        displayName: 'Dupe 1',
        password: 'Password123!',
        role: 'solar_operator',
      });

      await expect(createUser({
        username: 'dupeuser',
        email: 'dupe2@test.com',
        displayName: 'Dupe 2',
        password: 'Password123!',
        role: 'solar_operator',
      })).rejects.toThrow(/Failed query|UNIQUE/);
    });

    it('Duplicate email → throws UNIQUE constraint error', async () => {
      await createUser({
        username: 'emaildupe1',
        email: 'sameemail@test.com',
        displayName: 'Email Dupe 1',
        password: 'Password123!',
        role: 'solar_operator',
      });

      await expect(createUser({
        username: 'emaildupe2',
        email: 'sameemail@test.com',
        displayName: 'Email Dupe 2',
        password: 'Password123!',
        role: 'solar_operator',
      })).rejects.toThrow(/Failed query|UNIQUE/);
    });

    it('Created user password is hashed with argon2id', async () => {
      const user = await createUser({
        username: 'hasheduser',
        email: 'hashed@test.com',
        displayName: 'Hashed User',
        password: 'Password123!',
        role: 'solar_operator',
      });

      const [dbUser] = await db.select().from(users).where(eq(users.id, user.id));
      expect(dbUser?.passwordHash).not.toBe('Password123!');
      expect(dbUser?.passwordHash.startsWith('$argon2id$')).toBe(true);
    });

    it('Create multiple users → listUsers returns all ordered by creation desc', async () => {
      vi.useFakeTimers();
      const now = new Date();
      vi.setSystemTime(now);

      await createUser({
        username: 'first_user',
        email: 'first@test.com',
        displayName: 'First',
        password: 'Password123!',
        role: 'solar_operator',
      });

      vi.setSystemTime(new Date(now.getTime() + 2000));

      await createUser({
        username: 'second_user',
        email: 'second@test.com',
        displayName: 'Second',
        password: 'Password123!',
        role: 'admin',
      });

      const list = await listUsers();
      vi.useRealTimers();

      expect(list.length).toBe(2);
      expect(list[0]?.username).toBe('second_user');
      expect(list[1]?.username).toBe('first_user');
    });

    it('Update user displayName → persisted', async () => {
      const user = await createUser({
        username: 'updatedn',
        email: 'updatedn@test.com',
        displayName: 'Old Name',
        password: 'Password123!',
        role: 'solar_operator',
      });

      await updateUser(user.id, { displayName: 'New Name' });

      const [dbUser] = await db.select().from(users).where(eq(users.id, user.id));
      expect(dbUser?.displayName).toBe('New Name');
    });

    it('Update user password → new hash different from old', async () => {
      const user = await createUser({
        username: 'updatepw',
        email: 'updatepw@test.com',
        displayName: 'PW Update',
        password: 'Password123!',
        role: 'solar_operator',
      });

      const [before] = await db.select().from(users).where(eq(users.id, user.id));
      const oldHash = before?.passwordHash;

      await updateUser(user.id, { password: 'NewPassword456!' });

      const [after] = await db.select().from(users).where(eq(users.id, user.id));
      expect(after?.passwordHash).not.toBe(oldHash);
      expect(after?.passwordHash.startsWith('$argon2id$')).toBe(true);
    });

    it('Delete user → user removed from DB', async () => {
      const user = await createUser({
        username: 'deleteme',
        email: 'deleteme@test.com',
        displayName: 'Delete Me',
        password: 'Password123!',
        role: 'solar_operator',
      });

      await deleteUser(user.id);

      const [dbUser] = await db.select().from(users).where(eq(users.id, user.id));
      expect(dbUser).toBeUndefined();
    });
  });

  // ─── SECTION 3: Ticket Validation (5 tests) ──────────────────────
  describe('Ticket Validation Edge Cases', () => {
    it('getTicketById with non-existent ID → returns null', async () => {
      const result = await getTicketById('NON-EXISTENT-TICKET');
      expect(result).toBeNull();
    });

    it('queryTickets with no matching filters → { data: [], total: 0 }', async () => {
      const result = await queryTickets({ severity: 'emergency' });
      expect(result.data).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('updateTicket on non-existent ticket → throws "Ticket not found"', async () => {
      await expect(
        updateTicket('NON-EXISTENT-TICKET', { status: 'acknowledged' })
      ).rejects.toThrow('Ticket not found');
    });

    it('addComment to ticket → comment stored and retrievable', async () => {
      const staff = await createUser({
        username: 'commentuser',
        email: 'comment@test.com',
        displayName: 'Comment User',
        password: 'Password123!',
        role: 'solar_operator',
      });

      await db.insert(tickets).values({
        id: 'T-COMMENT-1',
        status: 'open',
        severity: 'info',
        faultType: 0,
        title: 'Test ticket for comments',
      });

      const comment = await addComment('T-COMMENT-1', staff.id, 'This is a test comment');
      expect(comment.id).toBeDefined();
      expect(comment.content).toBe('This is a test comment');

      const ticket = await getTicketById('T-COMMENT-1');
      expect(ticket?.comments.length).toBe(1);
      expect(ticket?.comments[0]?.content).toBe('This is a test comment');
    });

    it('queryTickets with comma-separated status filter → works correctly', async () => {
      await db.insert(tickets).values([
        { id: 'T-QF-1', status: 'open', severity: 'info', faultType: 0, title: 'Open' },
        { id: 'T-QF-2', status: 'resolved', severity: 'info', faultType: 0, title: 'Resolved' },
        { id: 'T-QF-3', status: 'in_progress', severity: 'info', faultType: 0, title: 'In Progress' },
      ]);

      const result = await queryTickets({ status: 'open,in_progress' });
      expect(result.total).toBe(2);
      expect(result.data.length).toBe(2);
    });
  });

  // ─── SECTION 4: Query Edge Cases (3 tests) ───────────────────────
  describe('Telemetry Query Edge Cases', () => {
    it('queryTelemetry with limit=0 → uses default (500)', async () => {
      const baseTime = new Date('2026-06-01T00:00:00Z').getTime();
      const batch = Array.from({ length: 5 }, (_, i) => ({
        timestamp: new Date(baseTime + i * 1000).toISOString(),
        vdc1: 200, vdc2: 200, idc1: 5, idc2: 5, irr: 500, pvt: 30,
      }));
      await ingestTelemetry(batch);

      // limit=0 is falsy, so it defaults to 500
      const result = await queryTelemetry({ limit: 0 });
      expect(result.length).toBe(5);
    });

    it('queryTelemetry with very large limit → clamped to 10000', async () => {
      await ingestTelemetry([{
        timestamp: '2026-06-01T12:00:00Z',
        vdc1: 200, vdc2: 200, idc1: 5, idc2: 5, irr: 500, pvt: 30,
      }]);

      const result = await queryTelemetry({ limit: 999999 });
      // Should not throw; limit is clamped internally
      expect(result.length).toBe(1);
    });

    it('getLatestTelemetry with n=5 when only 3 records exist → returns 3', async () => {
      const baseTime = new Date('2026-06-01T00:00:00Z').getTime();
      const batch = Array.from({ length: 3 }, (_, i) => ({
        timestamp: new Date(baseTime + i * 60000).toISOString(),
        vdc1: 200, vdc2: 200, idc1: 5, idc2: 5, irr: 500, pvt: 30,
      }));
      await ingestTelemetry(batch);

      const result = await getLatestTelemetry(5);
      expect(result.length).toBe(3);
    });
  });
});
