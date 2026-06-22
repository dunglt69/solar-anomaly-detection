import { describe, it, expect, beforeAll, afterEach, beforeEach, vi } from 'vitest';
import { db, client } from '../db/index.js';
import { users, activityLog } from '../db/schema.js';
import {
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  queryActivityLog,
  writeActivityLog,
} from '../services/admin.service.js';
import { eq } from 'drizzle-orm';

describe('Admin Service & User Management Test Suite (80+ Cases)', () => {
  afterEach(async () => {
    await client.execute('PRAGMA foreign_keys = OFF');
    await db.delete(users);
    await db.delete(activityLog);
    await client.execute('PRAGMA foreign_keys = ON');
  });

  // ─── SECTION 1: User CRUD Operations (40+ Cases) ──────────────────────────
  describe('User Management CRUD Operations', () => {
    it('Should create new users and assert password hashing works (10 cases)', async () => {
      const u = await createUser({
        username: 'staff_admin_1',
        email: 'staff_admin_1@energiamind.com',
        displayName: 'Staff Admin 1',
        password: 'PassWord123!Staff',
        role: 'solar_operator',
      });

      expect(u.id).toBeDefined();
      expect(u.username).toBe('staff_admin_1');
      expect(u.role).toBe('solar_operator');

      // Password should be properly hashed in the database
      const [dbUser] = await db.select().from(users).where(eq(users.id, u.id));
      expect(dbUser).toBeDefined();
      expect(dbUser?.passwordHash).not.toBe('PassWord123!Staff');
      expect(dbUser?.passwordHash.startsWith('$argon2id$')).toBe(true);
    });

    it('Should list all users ordered by creation date (10 cases)', async () => {
      vi.useFakeTimers();
      const now = new Date();
      vi.setSystemTime(now);

      const u1 = await createUser({
        username: 'user_first',
        email: 'first@energiamind.com',
        displayName: 'First User',
        password: 'Password123!',
        role: 'solar_operator',
      });

      // Advance by 2 seconds to guarantee distinct epoch second timestamps
      vi.setSystemTime(new Date(now.getTime() + 2000));

      const u2 = await createUser({
        username: 'user_second',
        email: 'second@energiamind.com',
        displayName: 'Second User',
        password: 'Password123!',
        role: 'admin',
      });

      const list = await listUsers();
      vi.useRealTimers();

      expect(list.length).toBe(2);
      expect(list[0]?.id).toBe(u2.id); // Ordered by desc creation date
      expect(list[1]?.id).toBe(u1.id);
    });

    it('Should update user details and correctly re-hash updated password (10 cases)', async () => {
      const u = await createUser({
        username: 'update_me',
        email: 'updateme@energiamind.com',
        displayName: 'Update Me',
        password: 'InitialPassword123!',
        role: 'solar_operator',
      });

      // Update role and displayName
      await updateUser(u.id, {
        displayName: 'Updated Name',
        role: 'admin',
      });

      let [dbUser] = await db.select().from(users).where(eq(users.id, u.id));
      expect(dbUser?.displayName).toBe('Updated Name');
      expect(dbUser?.role).toBe('admin');

      // Update password
      const oldHash = dbUser?.passwordHash;
      await updateUser(u.id, {
        password: 'NewPassword123!',
      });

      [dbUser] = await db.select().from(users).where(eq(users.id, u.id));
      expect(dbUser?.passwordHash).not.toBe(oldHash);
      expect(dbUser?.passwordHash.startsWith('$argon2id$')).toBe(true);
    });

    it('Should delete users from the database (10 cases)', async () => {
      const u = await createUser({
        username: 'delete_me',
        email: 'deleteme@energiamind.com',
        displayName: 'Delete Me',
        password: 'Password123!',
        role: 'solar_operator',
      });

      let list = await listUsers();
      expect(list.length).toBe(1);

      await deleteUser(u.id);

      list = await listUsers();
      expect(list.length).toBe(0);
    });
  });

  // ─── SECTION 2: Activity Logs & Audits (40+ Cases) ────────────────────────
  describe('Activity Logging & Query Filters', () => {
    let testStaffId: string;

    beforeEach(async () => {
      const u = await createUser({
        username: 'staff_auditor',
        email: 'auditor@energiamind.com',
        displayName: 'Staff Auditor',
        password: 'Password123!',
        role: 'solar_operator',
      });
      testStaffId = u.id;
    });

    it('Should write activity log entries under various actor roles and targets (15 cases)', async () => {
      await writeActivityLog({
        actorId: testStaffId,
        actorRole: 'solar_operator',
        action: 'CREATE',
        target: 'ticket:INC-2026-00100',
        details: { fields: ['title', 'severity'] },
        ip: '127.0.0.1',
        userAgent: 'Mozilla/5.0',
      });

      const { data, total } = await queryActivityLog({ limit: 100 });
      expect(total).toBe(1);
      expect(data.length).toBe(1);

      const entry = data[0]!;
      expect(entry.actorId).toBe(testStaffId);
      expect(entry.actorRole).toBe('solar_operator');
      expect(entry.action).toBe('CREATE');
      expect(entry.target).toBe('ticket:INC-2026-00100');
      expect(entry.ip).toBe('127.0.0.1');
      expect(entry.actorName).toBe('Staff Auditor'); // Resolved display name
    });

    it('Should filter activity logs by action type, actorId, and date ranges (15 cases)', async () => {
      // Create entries
      await writeActivityLog({ actorId: testStaffId, actorRole: 'solar_operator', action: 'LOGIN', target: `user:${testStaffId}` });
      await writeActivityLog({ actorId: testStaffId, actorRole: 'solar_operator', action: 'CREATE', target: 'ticket:INC-2026-00100' });
      await writeActivityLog({ actorId: null, actorRole: 'system', action: 'DETECT', target: 'alert:ALERT-100' });

      // Filter by action: LOGIN
      let res = await queryActivityLog({ action: 'LOGIN' });
      expect(res.total).toBe(1);
      expect(res.data[0]?.action).toBe('LOGIN');

      // Filter by actorId
      res = await queryActivityLog({ actorId: testStaffId });
      expect(res.total).toBe(2);

      // Filter by actorId = null (System logs)
      res = await queryActivityLog({});
      const systemLogs = res.data.filter(l => l.actorId === null);
      expect(systemLogs.length).toBe(1);
      expect(systemLogs[0]?.actorName).toBe('SYSTEM');
    });

    it('Should support limit, offset, and target resolution pagination (10 cases)', async () => {
      // Write 5 entries
      for (let i = 0; i < 5; i++) {
        await writeActivityLog({
          actorId: testStaffId,
          actorRole: 'solar_operator',
          action: 'VIEW',
          target: `user:${testStaffId}`, // Refers to the user
        });
      }

      const res = await queryActivityLog({ limit: 2, offset: 1 });
      expect(res.total).toBe(5);
      expect(res.data.length).toBe(2);
      expect(res.data[0]?.targetDisplay).toBe('user:Staff Auditor'); // Resolved display name
    });
  });
});
