import { db } from '../db/index.js';
import { users, activityLog, registeredDevices, sessions } from '../db/schema.js';
import { eq, desc, count, and, gte, lte, inArray, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import * as argon2 from 'argon2';

// ─── Employee ID generation ─────────────────────────────────────────

/**
 * Generate the next sequential employee ID (EM-0001, EM-0002, etc.)
 */
export async function generateEmployeeId(): Promise<string> {
  const [lastUser] = await db.select({ employeeId: users.employeeId })
    .from(users)
    .orderBy(desc(users.employeeId))
    .limit(1);

  if (!lastUser || !lastUser.employeeId) {
    return 'EM-0001';
  }

  const match = lastUser.employeeId.match(/^EM-(\d+)$/);
  if (!match) {
    return 'EM-0001';
  }

  const nextNum = parseInt(match[1]!, 10) + 1;
  return `EM-${String(nextNum).padStart(4, '0')}`;
}

// ─── List users ─────────────────────────────────────────────────────
export async function listUsers() {
  const rows = await db.select({
    id: users.id,
    employeeId: users.employeeId,
    username: users.username,
    email: users.email,
    personalEmail: users.personalEmail,
    dob: users.dob,
    displayName: users.displayName,
    role: users.role,
    avatarUrl: users.avatarUrl,
    createdAt: users.createdAt,
    updatedAt: users.updatedAt,
    failedAttempts: users.failedAttempts,
    lockedUntil: users.lockedUntil,
    deviceBrowser: registeredDevices.browser,
    deviceOs: registeredDevices.os,
    lastSeenAt: registeredDevices.lastSeenAt,
  })
  .from(users)
  .leftJoin(registeredDevices, eq(users.id, registeredDevices.userId))
  .orderBy(desc(users.createdAt));

  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

  return rows.map(r => ({
    ...r,
    isOnline: r.lastSeenAt ? r.lastSeenAt >= fiveMinutesAgo : false,
  }));
}

// ─── Create user ────────────────────────────────────────────────────
export async function createUser(data: {
  username: string;
  email: string;
  personalEmail: string;
  dob: string;
  displayName: string;
  password: string;
  role: 'admin' | 'solar_operator' | 'security_engineer';
}) {
  const passwordHash = await argon2.hash(data.password, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });

  const id = nanoid();
  const employeeId = await generateEmployeeId();

  await db.insert(users).values({
    id,
    employeeId,
    username: data.username,
    email: data.email,
    personalEmail: data.personalEmail,
    dob: data.dob,
    displayName: data.displayName,
    passwordHash,
    role: data.role,
  });

  return { id, employeeId, username: data.username, email: data.email, personalEmail: data.personalEmail, dob: data.dob, displayName: data.displayName, role: data.role };
}

// ─── Update user ────────────────────────────────────────────────────
export async function updateUser(id: string, data: {
  displayName?: string;
  email?: string;
  personalEmail?: string;
  dob?: string;
  role?: 'admin' | 'solar_operator' | 'security_engineer';
  password?: string;
}) {
  const setData: Record<string, any> = { updatedAt: new Date() };
  if (data.displayName) setData.displayName = data.displayName;
  if (data.email) setData.email = data.email;
  if (data.personalEmail) setData.personalEmail = data.personalEmail;
  if (data.dob) setData.dob = data.dob;
  if (data.role) setData.role = data.role;
  if (data.password) {
    setData.passwordHash = await argon2.hash(data.password, {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });
  }

  await db.update(users).set(setData).where(eq(users.id, id));
}

// ─── Delete user ────────────────────────────────────────────────────
export async function deleteUser(id: string) {
  await db.delete(users).where(eq(users.id, id));
}

// ─── Unlock user ────────────────────────────────────────────────────
export async function unlockUser(userId: string) {
  await db.update(users).set({
    failedAttempts: 0,
    lockedUntil: null,
    updatedAt: new Date(),
  }).where(eq(users.id, userId));
}

// ─── Activity log ───────────────────────────────────────────────────
export interface ActivityLogQuery {
  from?: string;
  to?: string;
  actorId?: string;
  action?: string;
  limit?: number;
  offset?: number;
}

export async function queryActivityLog(q: ActivityLogQuery) {
  const conditions = [];
  if (q.from) conditions.push(gte(activityLog.timestamp, new Date(q.from)));
  if (q.to) conditions.push(lte(activityLog.timestamp, new Date(q.to)));
  if (q.actorId) conditions.push(eq(activityLog.actorId, q.actorId));
  if (q.action) conditions.push(eq(activityLog.action, q.action as any));

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const limit = Math.min(q.limit || 50, 200);
  const offset = q.offset || 0;

  // Join with users to resolve actor display names
  const actorUser = db.select({
    id: users.id,
    displayName: users.displayName,
    username: users.username,
  }).from(users).as('actorUser');

  const rows = await db.select({
    id: activityLog.id,
    timestamp: activityLog.timestamp,
    actorId: activityLog.actorId,
    actorRole: activityLog.actorRole,
    action: activityLog.action,
    target: activityLog.target,
    details: activityLog.details,
    ip: activityLog.ip,
    userAgent: activityLog.userAgent,
    actorName: actorUser.displayName,
    actorUsername: actorUser.username,
  }).from(activityLog)
    .leftJoin(actorUser, eq(activityLog.actorId, actorUser.id))
    .where(where)
    .orderBy(desc(activityLog.timestamp))
    .limit(limit)
    .offset(offset);

  // Resolve target references (e.g., "user:abc123" → "user:Admin")
  // Collect all user IDs referenced in targets
  const targetUserIds = new Set<string>();
  for (const row of rows) {
    if (row.target?.startsWith('user:')) {
      targetUserIds.add(row.target.replace('user:', ''));
    }
  }

  let targetUserMap: Record<string, string> = {};
  if (targetUserIds.size > 0) {
    const targetUsers = await db.select({
      id: users.id,
      displayName: users.displayName,
    }).from(users).where(inArray(users.id, [...targetUserIds]));
    for (const u of targetUsers) {
      targetUserMap[u.id] = u.displayName;
    }
  }

  // Map results with resolved names
  const data = rows.map(row => ({
    id: row.id,
    timestamp: row.timestamp,
    actorId: row.actorId,
    actorRole: row.actorRole,
    action: row.action,
    target: row.target,
    details: row.details,
    ip: row.ip,
    // Resolved fields
    actorName: row.actorName || (row.actorId ? row.actorId : 'SYSTEM'),
    targetDisplay: row.target?.startsWith('user:')
      ? `user:${targetUserMap[row.target.replace('user:', '')] || row.target.replace('user:', '')}`
      : (row.target || '—'),
  }));

  const [total] = await db.select({ count: count() }).from(activityLog).where(where);

  return { data, total: total?.count || 0 };
}

// ─── Write activity log ─────────────────────────────────────────────
export async function writeActivityLog(entry: {
  actorId?: string | null;
  actorRole: 'admin' | 'solar_operator' | 'security_engineer' | 'system';
  action: string;
  target?: string;
  details?: any;
  ip?: string;
  userAgent?: string;
}) {
  await db.insert(activityLog).values({
    actorId: entry.actorId || null,
    actorRole: entry.actorRole,
    action: entry.action as any,
    target: entry.target || null,
    details: entry.details || null,
    ip: entry.ip || null,
    userAgent: entry.userAgent || null,
  });
}
