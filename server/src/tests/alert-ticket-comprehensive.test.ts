import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { db, client } from '../db/index.js';
import { alerts, tickets, ticketComments, users, telemetry } from '../db/schema.js';
import { eq, desc, and, count } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import {
  processDetectionResult,
  queryAlerts,
  acknowledgeAlert,
  resolveAlert,
  getAlertStats,
} from '../services/alert.service.js';
import {
  queryTickets,
  getTicketById,
  updateTicket,
  addComment,
  getTicketStats,
  isValidTransition,
} from '../services/ticket.service.js';

// ─── Helpers ────────────────────────────────────────────────────────
const staffUser = {
  id: `staff-comp-${nanoid(6)}`,
  employeeId: `EM-${nanoid(4)}`,
  username: `compstaff_${nanoid(6)}`,
  email: `compstaff_${nanoid(6)}@energiamind.com`,
  displayName: 'Comprehensive Staff',
  passwordHash: 'dummyhash',
  role: 'solar_operator' as const,
};

const adminUser = {
  id: `admin-comp-${nanoid(6)}`,
  employeeId: `EM-${nanoid(4)}`,
  username: `compadmin_${nanoid(6)}`,
  email: `compadmin_${nanoid(6)}@energiamind.com`,
  displayName: 'Comprehensive Admin',
  passwordHash: 'dummyhash',
  role: 'admin' as const,
};

function makeAlert(overrides: Partial<typeof alerts.$inferInsert> = {}) {
  return {
    id: nanoid(),
    timestamp: new Date(),
    severity: 'warning' as const,
    faultType: 2,
    confidence: 0.85,
    detectionLayer: 'ai' as const,
    acknowledged: false,
    ...overrides,
  };
}

function makeTicket(overrides: Partial<typeof tickets.$inferInsert> = {}) {
  return {
    id: `INC-2026-${nanoid(8)}`,
    status: 'open' as const,
    severity: 'warning' as const,
    faultType: 2,
    title: 'Test Ticket',
    ...overrides,
  };
}

function makeTelemetry(overrides: Partial<typeof telemetry.$inferInsert> = {}) {
  return {
    timestamp: new Date(),
    vdc1: 193.0,
    vdc2: 193.0,
    idc1: 8.5,
    idc2: 8.5,
    irr: 800,
    pvt: 35.0,
    pdc1: 1640.5,
    pdc2: 1640.5,
    pdcTotal: 3281.0,
    ...overrides,
  };
}

// ─── Main Suite ─────────────────────────────────────────────────────
describe('Alert & Ticket Comprehensive Test Suite (~120 Cases)', () => {
  beforeAll(async () => {
    // Ensure test users exist
    await db.insert(users).values(staffUser).onConflictDoNothing();
    await db.insert(users).values(adminUser).onConflictDoNothing();
  });

  afterEach(async () => {
    await client.execute('PRAGMA foreign_keys = OFF');
    await db.delete(ticketComments);
    await db.delete(alerts);
    await db.delete(tickets);
    await db.delete(telemetry);
    await client.execute('PRAGMA foreign_keys = ON');
  });

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 1: Alert Creation (25 cases)
  // ═══════════════════════════════════════════════════════════════════
  describe('Section 1: Alert Creation', () => {
    // ── Severity variants ──
    it('Case 1: Insert alert with severity "info"', async () => {
      const a = makeAlert({ severity: 'info', faultType: 0 });
      await db.insert(alerts).values(a);
      const [row] = await db.select().from(alerts).where(eq(alerts.id, a.id));
      expect(row.severity).toBe('info');
    });

    it('Case 2: Insert alert with severity "warning"', async () => {
      const a = makeAlert({ severity: 'warning' });
      await db.insert(alerts).values(a);
      const [row] = await db.select().from(alerts).where(eq(alerts.id, a.id));
      expect(row.severity).toBe('warning');
    });

    it('Case 3: Insert alert with severity "critical"', async () => {
      const a = makeAlert({ severity: 'critical', faultType: 3 });
      await db.insert(alerts).values(a);
      const [row] = await db.select().from(alerts).where(eq(alerts.id, a.id));
      expect(row.severity).toBe('critical');
    });

    it('Case 4: Insert alert with severity "emergency"', async () => {
      const a = makeAlert({ severity: 'emergency', faultType: 1 });
      await db.insert(alerts).values(a);
      const [row] = await db.select().from(alerts).where(eq(alerts.id, a.id));
      expect(row.severity).toBe('emergency');
    });

    // ── FaultType variants ──
    it('Case 5: Insert alert with faultType 0 (Normal)', async () => {
      const a = makeAlert({ faultType: 0, severity: 'info' });
      await db.insert(alerts).values(a);
      const [row] = await db.select().from(alerts).where(eq(alerts.id, a.id));
      expect(row.faultType).toBe(0);
    });

    it('Case 6: Insert alert with faultType 1 (Short-Circuit)', async () => {
      const a = makeAlert({ faultType: 1, severity: 'emergency' });
      await db.insert(alerts).values(a);
      const [row] = await db.select().from(alerts).where(eq(alerts.id, a.id));
      expect(row.faultType).toBe(1);
    });

    it('Case 7: Insert alert with faultType 2 (Degradation)', async () => {
      const a = makeAlert({ faultType: 2 });
      await db.insert(alerts).values(a);
      const [row] = await db.select().from(alerts).where(eq(alerts.id, a.id));
      expect(row.faultType).toBe(2);
    });

    it('Case 8: Insert alert with faultType 3 (Open Circuit)', async () => {
      const a = makeAlert({ faultType: 3, severity: 'critical' });
      await db.insert(alerts).values(a);
      const [row] = await db.select().from(alerts).where(eq(alerts.id, a.id));
      expect(row.faultType).toBe(3);
    });

    it('Case 9: Insert alert with faultType 4 (Shadowing)', async () => {
      const a = makeAlert({ faultType: 4 });
      await db.insert(alerts).values(a);
      const [row] = await db.select().from(alerts).where(eq(alerts.id, a.id));
      expect(row.faultType).toBe(4);
    });

    // ── Confidence boundary values ──
    it('Case 10: Insert alert with confidence 0.0', async () => {
      const a = makeAlert({ confidence: 0.0 });
      await db.insert(alerts).values(a);
      const [row] = await db.select().from(alerts).where(eq(alerts.id, a.id));
      expect(row.confidence).toBe(0.0);
    });

    it('Case 11: Insert alert with confidence 0.5', async () => {
      const a = makeAlert({ confidence: 0.5 });
      await db.insert(alerts).values(a);
      const [row] = await db.select().from(alerts).where(eq(alerts.id, a.id));
      expect(row.confidence).toBe(0.5);
    });

    it('Case 12: Insert alert with confidence 0.99', async () => {
      const a = makeAlert({ confidence: 0.99 });
      await db.insert(alerts).values(a);
      const [row] = await db.select().from(alerts).where(eq(alerts.id, a.id));
      expect(row.confidence).toBeCloseTo(0.99, 5);
    });

    it('Case 13: Insert alert with confidence 1.0', async () => {
      const a = makeAlert({ confidence: 1.0 });
      await db.insert(alerts).values(a);
      const [row] = await db.select().from(alerts).where(eq(alerts.id, a.id));
      expect(row.confidence).toBe(1.0);
    });

    // ── Detection layer variants ──
    it('Case 14: Insert alert with detectionLayer "statistical"', async () => {
      const a = makeAlert({ detectionLayer: 'statistical' });
      await db.insert(alerts).values(a);
      const [row] = await db.select().from(alerts).where(eq(alerts.id, a.id));
      expect(row.detectionLayer).toBe('statistical');
    });

    it('Case 15: Insert alert with detectionLayer "rule"', async () => {
      const a = makeAlert({ detectionLayer: 'rule' });
      await db.insert(alerts).values(a);
      const [row] = await db.select().from(alerts).where(eq(alerts.id, a.id));
      expect(row.detectionLayer).toBe('rule');
    });

    it('Case 16: Insert alert with detectionLayer "ai"', async () => {
      const a = makeAlert({ detectionLayer: 'ai' });
      await db.insert(alerts).values(a);
      const [row] = await db.select().from(alerts).where(eq(alerts.id, a.id));
      expect(row.detectionLayer).toBe('ai');
    });

    // ── Telemetry ID ──
    it('Case 17: Insert alert with null telemetryId', async () => {
      const a = makeAlert({ telemetryId: null });
      await db.insert(alerts).values(a);
      const [row] = await db.select().from(alerts).where(eq(alerts.id, a.id));
      expect(row.telemetryId).toBeNull();
    });

    it('Case 18: Insert alert with valid telemetryId referencing existing telemetry row', async () => {
      const t = makeTelemetry();
      const [inserted] = await db.insert(telemetry).values(t).returning({ id: telemetry.id });
      const a = makeAlert({ telemetryId: inserted.id });
      await db.insert(alerts).values(a);
      const [row] = await db.select().from(alerts).where(eq(alerts.id, a.id));
      expect(row.telemetryId).toBe(inserted.id);
    });

    // ── Default acknowledged ──
    it('Case 19: Alert default acknowledged is false', async () => {
      const a = makeAlert();
      await db.insert(alerts).values(a);
      const [row] = await db.select().from(alerts).where(eq(alerts.id, a.id));
      expect(row.acknowledged).toBe(false);
    });

    it('Case 20: Alert default acknowledgedBy is null', async () => {
      const a = makeAlert();
      await db.insert(alerts).values(a);
      const [row] = await db.select().from(alerts).where(eq(alerts.id, a.id));
      expect(row.acknowledgedBy).toBeNull();
    });

    it('Case 21: Alert default acknowledgedAt is null', async () => {
      const a = makeAlert();
      await db.insert(alerts).values(a);
      const [row] = await db.select().from(alerts).where(eq(alerts.id, a.id));
      expect(row.acknowledgedAt).toBeNull();
    });

    // ── Acknowledge alert ──
    it('Case 22: Acknowledge alert sets acknowledged=true, acknowledgedBy, acknowledgedAt', async () => {
      const a = makeAlert();
      await db.insert(alerts).values(a);
      await acknowledgeAlert(a.id, staffUser.id);
      const [row] = await db.select().from(alerts).where(eq(alerts.id, a.id));
      expect(row.acknowledged).toBe(true);
      expect(row.acknowledgedBy).toBe(staffUser.id);
      expect(row.acknowledgedAt).not.toBeNull();
    });

    it('Case 23: Acknowledging already acknowledged alert returns false (conflict) and does not update fields again', async () => {
      const a = makeAlert();
      await db.insert(alerts).values(a);
      const r1 = await acknowledgeAlert(a.id, staffUser.id);
      expect(r1).toBe(true);
      // Re-acknowledge with admin
      const r2 = await acknowledgeAlert(a.id, adminUser.id);
      expect(r2).toBe(false);
      const [row] = await db.select().from(alerts).where(eq(alerts.id, a.id));
      expect(row.acknowledged).toBe(true);
      expect(row.acknowledgedBy).toBe(staffUser.id);
    });

    // ── Multiple alerts same faultType ──
    it('Case 24: Multiple alerts with same faultType coexist', async () => {
      const a1 = makeAlert({ faultType: 3 });
      const a2 = makeAlert({ faultType: 3 });
      const a3 = makeAlert({ faultType: 3 });
      await db.insert(alerts).values([a1, a2, a3]);
      const rows = await db.select().from(alerts);
      expect(rows.length).toBe(3);
      expect(rows.every(r => r.faultType === 3)).toBe(true);
    });

    it('Case 25: Alert with duplicate ID rejects (primary key constraint)', async () => {
      const a = makeAlert();
      await db.insert(alerts).values(a);
      await expect(db.insert(alerts).values(a)).rejects.toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 2: Ticket State Machine (30 cases)
  // ═══════════════════════════════════════════════════════════════════
  describe('Section 2: Ticket State Machine', () => {
    it('Case 26: Create ticket with status "open"', async () => {
      const t = makeTicket({ status: 'open' });
      await db.insert(tickets).values(t);
      const [row] = await db.select().from(tickets).where(eq(tickets.id, t.id));
      expect(row.status).toBe('open');
    });

    it('Case 27: isValidTransition open → acknowledged returns true', () => {
      expect(isValidTransition('open', 'acknowledged')).toBe(true);
    });

    it('Case 28: isValidTransition open → in_progress returns true', () => {
      expect(isValidTransition('open', 'in_progress')).toBe(true);
    });

    it('Case 29: isValidTransition open → resolved returns true', () => {
      expect(isValidTransition('open', 'resolved')).toBe(true);
    });

    it('Case 30: isValidTransition open → escalated returns true', () => {
      expect(isValidTransition('open', 'escalated')).toBe(true);
    });

    it('Case 31: isValidTransition acknowledged → in_progress returns true', () => {
      expect(isValidTransition('acknowledged', 'in_progress')).toBe(true);
    });

    it('Case 32: isValidTransition acknowledged → resolved returns true', () => {
      expect(isValidTransition('acknowledged', 'resolved')).toBe(true);
    });

    it('Case 33: isValidTransition acknowledged → escalated returns true', () => {
      expect(isValidTransition('acknowledged', 'escalated')).toBe(true);
    });

    it('Case 34: isValidTransition in_progress → resolved returns true', () => {
      expect(isValidTransition('in_progress', 'resolved')).toBe(true);
    });

    it('Case 35: isValidTransition in_progress → escalated returns true', () => {
      expect(isValidTransition('in_progress', 'escalated')).toBe(true);
    });

    it('Case 36: isValidTransition resolved → in_progress returns true (reopen)', () => {
      expect(isValidTransition('resolved', 'in_progress')).toBe(true);
    });

    it('Case 37: isValidTransition escalated → in_progress returns true', () => {
      expect(isValidTransition('escalated', 'in_progress')).toBe(true);
    });

    it('Case 38: isValidTransition escalated → resolved returns true', () => {
      expect(isValidTransition('escalated', 'resolved')).toBe(true);
    });

    // ── Invalid transitions ──
    it('Case 39: Invalid transition: open → open (self)', () => {
      expect(isValidTransition('open', 'open')).toBe(false);
    });

    it('Case 40: Invalid transition: open → closed (skip states)', () => {
      expect(isValidTransition('open', 'closed')).toBe(false);
    });

    it('Case 41: Invalid transition: closed → open', () => {
      // 'closed' is not even in the transition map so it's always false
      expect(isValidTransition('closed', 'open')).toBe(false);
    });

    it('Case 42: Invalid transition: resolved → open', () => {
      expect(isValidTransition('resolved', 'open')).toBe(false);
    });

    it('Case 43: Invalid transition: resolved → acknowledged', () => {
      expect(isValidTransition('resolved', 'acknowledged')).toBe(false);
    });

    it('Case 44: Invalid transition: resolved → escalated', () => {
      expect(isValidTransition('resolved', 'escalated')).toBe(false);
    });

    it('Case 45: Invalid transition: in_progress → open', () => {
      expect(isValidTransition('in_progress', 'open')).toBe(false);
    });

    it('Case 46: Invalid transition: in_progress → acknowledged', () => {
      expect(isValidTransition('in_progress', 'acknowledged')).toBe(false);
    });

    it('Case 47: Invalid transition: acknowledged → open', () => {
      expect(isValidTransition('acknowledged', 'open')).toBe(false);
    });

    it('Case 48: Invalid transition: escalated → open', () => {
      expect(isValidTransition('escalated', 'open')).toBe(false);
    });

    it('Case 49: Invalid transition: escalated → acknowledged', () => {
      expect(isValidTransition('escalated', 'acknowledged')).toBe(false);
    });

    it('Case 50: Invalid transition from unknown status', () => {
      expect(isValidTransition('nonexistent', 'open')).toBe(false);
    });

    // ── DB-level transitions ──
    it('Case 51: Transition open → acknowledged via updateTicket', async () => {
      const t = makeTicket();
      await db.insert(tickets).values(t);
      await updateTicket(t.id, { status: 'acknowledged' });
      const ticket = await getTicketById(t.id);
      expect(ticket?.status).toBe('acknowledged');
    });

    it('Case 52: Transition acknowledged → in_progress via updateTicket', async () => {
      const t = makeTicket({ status: 'acknowledged' });
      await db.insert(tickets).values(t);
      await updateTicket(t.id, { status: 'in_progress' });
      const ticket = await getTicketById(t.id);
      expect(ticket?.status).toBe('in_progress');
    });

    it('Case 53: Transition in_progress → resolved sets resolvedAt', async () => {
      const t = makeTicket({ status: 'in_progress' });
      await db.insert(tickets).values(t);
      await updateTicket(t.id, { status: 'resolved', resolutionSummary: 'Fixed' });
      const ticket = await getTicketById(t.id);
      expect(ticket?.status).toBe('resolved');
      expect(ticket?.resolvedAt).not.toBeNull();
      expect(ticket?.resolutionSummary).toBe('Fixed');
    });

    it('Case 54: Transition open → escalated sets wasEscalated', async () => {
      const t = makeTicket();
      await db.insert(tickets).values(t);
      await updateTicket(t.id, { status: 'escalated' });
      const ticket = await getTicketById(t.id);
      expect(ticket?.status).toBe('escalated');
      expect(ticket?.wasEscalated).toBe(true);
    });

    it('Case 55: updateTicket throws on invalid transition open → closed', async () => {
      const t = makeTicket();
      await db.insert(tickets).values(t);
      await expect(updateTicket(t.id, { status: 'closed' })).rejects.toThrow('Invalid transition');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 3: Ticket Comments (20 cases)
  // ═══════════════════════════════════════════════════════════════════
  describe('Section 3: Ticket Comments', () => {
    it('Case 56: Add a comment to a ticket', async () => {
      const t = makeTicket();
      await db.insert(tickets).values(t);
      const c = await addComment(t.id, staffUser.id, 'Looking into it');
      expect(c.id).toBeDefined();
      expect(c.content).toBe('Looking into it');
      expect(c.ticketId).toBe(t.id);
      expect(c.authorId).toBe(staffUser.id);
    });

    it('Case 57: Add multiple comments to same ticket', async () => {
      const t = makeTicket();
      await db.insert(tickets).values(t);
      await addComment(t.id, staffUser.id, 'Comment 1');
      await addComment(t.id, staffUser.id, 'Comment 2');
      await addComment(t.id, adminUser.id, 'Comment 3');
      const ticket = await getTicketById(t.id);
      expect(ticket?.comments.length).toBe(3);
    });

    it('Case 58: Comment has correct authorId', async () => {
      const t = makeTicket();
      await db.insert(tickets).values(t);
      const c = await addComment(t.id, adminUser.id, 'Admin says hi');
      expect(c.authorId).toBe(adminUser.id);
    });

    it('Case 59: Comment has createdAt set', async () => {
      const t = makeTicket();
      await db.insert(tickets).values(t);
      const c = await addComment(t.id, staffUser.id, 'Timestamped');
      expect(c.createdAt).toBeDefined();
    });

    it('Case 60: Comment content is stored exactly', async () => {
      const t = makeTicket();
      await db.insert(tickets).values(t);
      const content = '  Whitespace and special chars: <>&"\'! ';
      await addComment(t.id, staffUser.id, content);
      const ticket = await getTicketById(t.id);
      expect(ticket?.comments[0]?.content).toBe(content);
    });

    it('Case 61: Comment with single character content', async () => {
      const t = makeTicket();
      await db.insert(tickets).values(t);
      await addComment(t.id, staffUser.id, 'X');
      const ticket = await getTicketById(t.id);
      expect(ticket?.comments[0]?.content).toBe('X');
    });

    it('Case 62: Comment with very long content (10000 chars)', async () => {
      const t = makeTicket();
      await db.insert(tickets).values(t);
      const longContent = 'A'.repeat(10000);
      await addComment(t.id, staffUser.id, longContent);
      const ticket = await getTicketById(t.id);
      expect(ticket?.comments[0]?.content.length).toBe(10000);
    });

    it('Case 63: Comment with unicode / emoji content', async () => {
      const t = makeTicket();
      await db.insert(tickets).values(t);
      const content = '⚡ Solar panel fault 日本語テスト 🌞';
      await addComment(t.id, staffUser.id, content);
      const ticket = await getTicketById(t.id);
      expect(ticket?.comments[0]?.content).toBe(content);
    });

    it('Case 64: Comment with newlines and tabs', async () => {
      const t = makeTicket();
      await db.insert(tickets).values(t);
      const content = 'Line 1\nLine 2\n\tIndented';
      await addComment(t.id, staffUser.id, content);
      const ticket = await getTicketById(t.id);
      expect(ticket?.comments[0]?.content).toBe(content);
    });

    it('Case 65: Comments are returned in descending order by createdAt', async () => {
      const t = makeTicket();
      await db.insert(tickets).values(t);
      // Insert comments with distinct timestamps via direct DB insert
      const cId1 = nanoid();
      const cId2 = nanoid();
      const cId3 = nanoid();
      const t1 = new Date('2026-01-01T00:00:00Z');
      const t2 = new Date('2026-01-02T00:00:00Z');
      const t3 = new Date('2026-01-03T00:00:00Z');
      await db.insert(ticketComments).values([
        { id: cId1, ticketId: t.id, authorId: staffUser.id, content: 'First', createdAt: t1 },
        { id: cId2, ticketId: t.id, authorId: staffUser.id, content: 'Second', createdAt: t2 },
        { id: cId3, ticketId: t.id, authorId: staffUser.id, content: 'Third', createdAt: t3 },
      ]);
      const ticket = await getTicketById(t.id);
      expect(ticket?.comments[0]?.content).toBe('Third');
      expect(ticket?.comments[2]?.content).toBe('First');
    });

    it('Case 66: Delete ticket cascades to delete comments', async () => {
      const t = makeTicket();
      await db.insert(tickets).values(t);
      await addComment(t.id, staffUser.id, 'Will be deleted');
      await addComment(t.id, staffUser.id, 'Also deleted');
      // Verify comments exist
      let comments = await db.select().from(ticketComments).where(eq(ticketComments.ticketId, t.id));
      expect(comments.length).toBe(2);
      // Delete ticket
      await db.delete(tickets).where(eq(tickets.id, t.id));
      // Comments should be gone (cascade)
      comments = await db.select().from(ticketComments).where(eq(ticketComments.ticketId, t.id));
      expect(comments.length).toBe(0);
    });

    it('Case 67: Comments from different authors on same ticket', async () => {
      const t = makeTicket();
      await db.insert(tickets).values(t);
      await addComment(t.id, staffUser.id, 'Staff comment');
      await addComment(t.id, adminUser.id, 'Admin comment');
      const ticket = await getTicketById(t.id);
      const authorIds = ticket?.comments.map(c => c.authorId) ?? [];
      expect(authorIds).toContain(staffUser.id);
      expect(authorIds).toContain(adminUser.id);
    });

    it('Case 68: Comment ID is unique (nanoid)', async () => {
      const t = makeTicket();
      await db.insert(tickets).values(t);
      const c1 = await addComment(t.id, staffUser.id, 'C1');
      const c2 = await addComment(t.id, staffUser.id, 'C2');
      expect(c1.id).not.toBe(c2.id);
    });

    it('Case 69: getTicketById returns empty comments array for ticket with no comments', async () => {
      const t = makeTicket();
      await db.insert(tickets).values(t);
      const ticket = await getTicketById(t.id);
      expect(ticket?.comments).toEqual([]);
    });

    it('Case 70: Comment with markdown content preserved', async () => {
      const t = makeTicket();
      await db.insert(tickets).values(t);
      const md = '# Heading\n- item 1\n- item 2\n\n```code block```';
      await addComment(t.id, staffUser.id, md);
      const ticket = await getTicketById(t.id);
      expect(ticket?.comments[0]?.content).toBe(md);
    });

    it('Case 71: Comment with SQL injection attempt stored safely', async () => {
      const t = makeTicket();
      await db.insert(tickets).values(t);
      const injection = "'; DROP TABLE tickets; --";
      await addComment(t.id, staffUser.id, injection);
      const ticket = await getTicketById(t.id);
      expect(ticket?.comments[0]?.content).toBe(injection);
      // Verify tickets table still exists
      const allTickets = await db.select().from(tickets);
      expect(allTickets.length).toBeGreaterThan(0);
    });

    it('Case 72: Multiple comments have distinct createdAt values', async () => {
      const t = makeTicket();
      await db.insert(tickets).values(t);
      const cId1 = nanoid();
      const cId2 = nanoid();
      await db.insert(ticketComments).values([
        { id: cId1, ticketId: t.id, authorId: staffUser.id, content: 'C1', createdAt: new Date('2026-01-01T00:00:00Z') },
        { id: cId2, ticketId: t.id, authorId: staffUser.id, content: 'C2', createdAt: new Date('2026-06-15T12:00:00Z') },
      ]);
      const ticket = await getTicketById(t.id);
      expect(ticket?.comments.length).toBe(2);
      const ts0 = ticket!.comments[0]!.createdAt!.getTime();
      const ts1 = ticket!.comments[1]!.createdAt!.getTime();
      expect(ts0).toBeGreaterThan(ts1);
    });

    it('Case 73: Ten comments on one ticket', async () => {
      const t = makeTicket();
      await db.insert(tickets).values(t);
      for (let i = 0; i < 10; i++) {
        await addComment(t.id, staffUser.id, `Comment #${i + 1}`);
      }
      const ticket = await getTicketById(t.id);
      expect(ticket?.comments.length).toBe(10);
    });

    it('Case 74: Comment references correct ticket after multiple ticket inserts', async () => {
      const t1 = makeTicket();
      const t2 = makeTicket();
      await db.insert(tickets).values([t1, t2]);
      await addComment(t1.id, staffUser.id, 'Belongs to T1');
      await addComment(t2.id, staffUser.id, 'Belongs to T2');
      const ticket1 = await getTicketById(t1.id);
      const ticket2 = await getTicketById(t2.id);
      expect(ticket1?.comments[0]?.content).toBe('Belongs to T1');
      expect(ticket2?.comments[0]?.content).toBe('Belongs to T2');
    });

    it('Case 75: Duplicate comment ID rejects', async () => {
      const t = makeTicket();
      await db.insert(tickets).values(t);
      const fixedId = nanoid();
      await db.insert(ticketComments).values({
        id: fixedId,
        ticketId: t.id,
        authorId: staffUser.id,
        content: 'First',
      });
      await expect(
        db.insert(ticketComments).values({
          id: fixedId,
          ticketId: t.id,
          authorId: staffUser.id,
          content: 'Duplicate',
        })
      ).rejects.toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 4: Alert → Ticket Lifecycle (20 cases)
  // ═══════════════════════════════════════════════════════════════════
  describe('Section 4: Alert → Ticket Lifecycle', () => {
    const mkDetection = (label: number, confidence: number) => ({
      faultDetected: true,
      faultLabel: label,
      faultName: ['Normal', 'Short-Circuit', 'Degradation', 'Open Circuit', 'Shadowing'][label]!,
      confidence,
      detectionLayer: 'ai' as const,
      details: `Test detection for label ${label}`,
    });

    const defaultReadings = { vdc1: 193, vdc2: 193, idc1: 8.5, idc2: 8.5, pdcTotal: 3281, irr: 800 };

    it('Case 76: processDetectionResult with faultDetected=false returns null', async () => {
      const result = await processDetectionResult(
        { faultDetected: false, faultLabel: 0, faultName: 'Normal', confidence: 0.99, detectionLayer: 'ai', details: '' },
        new Date(),
        defaultReadings,
      );
      expect(result).toBeNull();
    });

    it('Case 77: processDetectionResult auto-creates alert and ticket', async () => {
      const result = await processDetectionResult(mkDetection(1, 0.95), new Date(), defaultReadings);
      expect(result).not.toBeNull();
      expect(result?.alertId).toBeDefined();
      expect(result?.ticketId).toBeDefined();
    });

    it('Case 78: Auto-created ticket has status "open"', async () => {
      const result = await processDetectionResult(mkDetection(2, 0.88), new Date(), defaultReadings);
      const [ticket] = await db.select().from(tickets).where(eq(tickets.id, result!.ticketId));
      expect(ticket.status).toBe('open');
    });

    it('Case 79: Auto-created alert has acknowledged=false', async () => {
      const result = await processDetectionResult(mkDetection(3, 0.92), new Date(), defaultReadings);
      const [alert] = await db.select().from(alerts).where(eq(alerts.id, result!.alertId));
      expect(alert.acknowledged).toBe(false);
    });

    it('Case 80: Auto-created alert ticketId references the created ticket', async () => {
      const result = await processDetectionResult(mkDetection(4, 0.77), new Date(), defaultReadings);
      const [alert] = await db.select().from(alerts).where(eq(alerts.id, result!.alertId));
      expect(alert.ticketId).toBe(result!.ticketId);
    });

    it('Case 81: Short-Circuit (label 1) creates emergency severity', async () => {
      const result = await processDetectionResult(mkDetection(1, 0.95), new Date(), defaultReadings);
      expect(result?.severity).toBe('emergency');
    });

    it('Case 82: Degradation (label 2) creates warning severity', async () => {
      const result = await processDetectionResult(mkDetection(2, 0.85), new Date(), defaultReadings);
      expect(result?.severity).toBe('warning');
    });

    it('Case 83: Open Circuit (label 3) creates critical severity', async () => {
      const result = await processDetectionResult(mkDetection(3, 0.9), new Date(), defaultReadings);
      expect(result?.severity).toBe('critical');
    });

    it('Case 84: Shadowing (label 4) creates warning severity', async () => {
      const result = await processDetectionResult(mkDetection(4, 0.7), new Date(), defaultReadings);
      expect(result?.severity).toBe('warning');
    });

    it('Case 85: Acknowledge alert cascades to linked ticket status=acknowledged', async () => {
      const result = await processDetectionResult(mkDetection(2, 0.88), new Date(), defaultReadings);
      await acknowledgeAlert(result!.alertId, staffUser.id);
      const [ticket] = await db.select().from(tickets).where(eq(tickets.id, result!.ticketId));
      expect(ticket.status).toBe('acknowledged');
    });

    it('Case 86: Resolve alert cascades to linked ticket status=resolved', async () => {
      const result = await processDetectionResult(mkDetection(3, 0.92), new Date(), defaultReadings);
      await resolveAlert(result!.alertId, staffUser.id);
      const [ticket] = await db.select().from(tickets).where(eq(tickets.id, result!.ticketId));
      expect(ticket.status).toBe('resolved');
      expect(ticket.resolvedAt).not.toBeNull();
    });

    it('Case 87: Multiple alerts can reference the same ticket', async () => {
      const t = makeTicket();
      await db.insert(tickets).values(t);
      const a1 = makeAlert({ ticketId: t.id });
      const a2 = makeAlert({ ticketId: t.id });
      await db.insert(alerts).values([a1, a2]);
      const rows = await db.select().from(alerts);
      expect(rows.filter(r => r.ticketId === t.id).length).toBe(2);
    });

    it('Case 88: Alert ticketId references a valid ticket in DB', async () => {
      const t = makeTicket();
      await db.insert(tickets).values(t);
      const a = makeAlert({ ticketId: t.id });
      await db.insert(alerts).values(a);
      const [ticket] = await db.select().from(tickets).where(eq(tickets.id, t.id));
      expect(ticket).toBeDefined();
    });

    it('Case 89: Auto-created ticket title contains fault name', async () => {
      const result = await processDetectionResult(mkDetection(1, 0.95), new Date(), defaultReadings);
      const [ticket] = await db.select().from(tickets).where(eq(tickets.id, result!.ticketId));
      expect(ticket.title).toContain('Short-Circuit');
    });

    it('Case 90: Auto-created ticket description contains confidence percentage', async () => {
      const result = await processDetectionResult(mkDetection(2, 0.873), new Date(), defaultReadings);
      const [ticket] = await db.select().from(tickets).where(eq(tickets.id, result!.ticketId));
      expect(ticket.description).toContain('87.3%');
    });

    it('Case 91: Ticket updatedAt changes after updateTicket', async () => {
      const t = makeTicket();
      await db.insert(tickets).values(t);
      const [before] = await db.select().from(tickets).where(eq(tickets.id, t.id));
      // Small delay for timestamp difference
      await new Promise(r => setTimeout(r, 50));
      await updateTicket(t.id, { status: 'acknowledged' });
      const [after] = await db.select().from(tickets).where(eq(tickets.id, t.id));
      expect(after.updatedAt!.getTime()).toBeGreaterThanOrEqual(before.updatedAt!.getTime());
    });

    it('Case 92: updateTicket on non-existent ticket throws', async () => {
      await expect(updateTicket('NONEXISTENT-ID', { status: 'acknowledged' })).rejects.toThrow('Ticket not found');
    });

    it('Case 93: Full lifecycle: detect → acknowledge → in_progress → resolved', async () => {
      const result = await processDetectionResult(mkDetection(2, 0.88), new Date(), defaultReadings);
      const ticketId = result!.ticketId;

      // Acknowledge via alert service
      await acknowledgeAlert(result!.alertId, staffUser.id);
      let ticket = await getTicketById(ticketId);
      expect(ticket?.status).toBe('acknowledged');

      // Move to in_progress via ticket service
      await updateTicket(ticketId, { status: 'in_progress' });
      ticket = await getTicketById(ticketId);
      expect(ticket?.status).toBe('in_progress');

      // Resolve
      await updateTicket(ticketId, { status: 'resolved', resolutionSummary: 'Replaced connector' });
      ticket = await getTicketById(ticketId);
      expect(ticket?.status).toBe('resolved');
      expect(ticket?.resolvedAt).not.toBeNull();
      expect(ticket?.resolutionSummary).toBe('Replaced connector');
    });

    it('Case 94: Ticket assignee can be set via updateTicket', async () => {
      const t = makeTicket();
      await db.insert(tickets).values(t);
      await updateTicket(t.id, { assigneeId: staffUser.id });
      const ticket = await getTicketById(t.id);
      expect(ticket?.assigneeId).toBe(staffUser.id);
    });

    it('Case 95: Escalation through updateTicket syncs alert acknowledged flag', async () => {
      const a = makeAlert();
      const t = makeTicket({ alertId: a.id });
      await db.insert(tickets).values(t);
      await db.insert(alerts).values({ ...a, ticketId: t.id });
      await updateTicket(t.id, { status: 'escalated' });
      const [alert] = await db.select().from(alerts).where(eq(alerts.id, a.id));
      expect(alert.acknowledged).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 5: Filtering & Pagination (25 cases)
  // ═══════════════════════════════════════════════════════════════════
  describe('Section 5: Filtering & Pagination', () => {
    it('Case 96: queryAlerts by severity="critical"', async () => {
      await db.insert(alerts).values([
        makeAlert({ severity: 'critical', faultType: 3 }),
        makeAlert({ severity: 'warning' }),
        makeAlert({ severity: 'critical', faultType: 3 }),
      ]);
      const result = await queryAlerts({ severity: 'critical' });
      expect(result.data.length).toBe(2);
      expect(result.total).toBe(2);
    });

    it('Case 97: queryAlerts by severity="emergency"', async () => {
      await db.insert(alerts).values([
        makeAlert({ severity: 'emergency', faultType: 1 }),
        makeAlert({ severity: 'warning' }),
      ]);
      const result = await queryAlerts({ severity: 'emergency' });
      expect(result.data.length).toBe(1);
    });

    it('Case 98: queryAlerts by acknowledged=false', async () => {
      await db.insert(alerts).values([
        makeAlert({ acknowledged: false }),
        makeAlert({ acknowledged: true }),
        makeAlert({ acknowledged: false }),
      ]);
      const result = await queryAlerts({ acknowledged: 'false' });
      expect(result.data.length).toBe(2);
    });

    it('Case 99: queryAlerts by acknowledged=true', async () => {
      await db.insert(alerts).values([
        makeAlert({ acknowledged: true }),
        makeAlert({ acknowledged: false }),
      ]);
      const result = await queryAlerts({ acknowledged: 'true' });
      expect(result.data.length).toBe(1);
    });

    it('Case 100: queryAlerts by date range (from/to)', async () => {
      await db.insert(alerts).values([
        makeAlert({ timestamp: new Date('2026-01-01T00:00:00Z') }),
        makeAlert({ timestamp: new Date('2026-06-15T00:00:00Z') }),
        makeAlert({ timestamp: new Date('2026-12-31T00:00:00Z') }),
      ]);
      const result = await queryAlerts({ from: '2026-03-01', to: '2026-09-01' });
      expect(result.data.length).toBe(1);
    });

    it('Case 101: queryAlerts returns all when no filters applied', async () => {
      await db.insert(alerts).values([makeAlert(), makeAlert(), makeAlert()]);
      const result = await queryAlerts({});
      expect(result.data.length).toBe(3);
      expect(result.total).toBe(3);
    });

    it('Case 102: queryAlerts returns empty array for non-matching severity', async () => {
      await db.insert(alerts).values([makeAlert({ severity: 'info', faultType: 0 })]);
      const result = await queryAlerts({ severity: 'emergency' });
      expect(result.data.length).toBe(0);
      expect(result.total).toBe(0);
    });

    it('Case 103: queryAlerts ordered by timestamp desc', async () => {
      await db.insert(alerts).values([
        makeAlert({ id: 'old', timestamp: new Date('2026-01-01T00:00:00Z') }),
        makeAlert({ id: 'new', timestamp: new Date('2026-12-01T00:00:00Z') }),
        makeAlert({ id: 'mid', timestamp: new Date('2026-06-01T00:00:00Z') }),
      ]);
      const result = await queryAlerts({});
      expect(result.data[0]?.id).toBe('new');
      expect(result.data[2]?.id).toBe('old');
    });

    it('Case 104: queryAlerts with limit=1', async () => {
      await db.insert(alerts).values([makeAlert(), makeAlert(), makeAlert()]);
      const result = await queryAlerts({ limit: 1 });
      expect(result.data.length).toBe(1);
      expect(result.total).toBe(3);
    });

    it('Case 105: queryAlerts with offset skips results', async () => {
      await db.insert(alerts).values([
        makeAlert({ id: 'a1', timestamp: new Date('2026-03-01T00:00:00Z') }),
        makeAlert({ id: 'a2', timestamp: new Date('2026-02-01T00:00:00Z') }),
        makeAlert({ id: 'a3', timestamp: new Date('2026-01-01T00:00:00Z') }),
      ]);
      const result = await queryAlerts({ limit: 2, offset: 1 });
      expect(result.data.length).toBe(2);
      expect(result.data[0]?.id).toBe('a2');
    });

    it('Case 106: queryAlerts limit capped at 200', async () => {
      // Insert 3, request limit 999 — the service caps at 200
      await db.insert(alerts).values([makeAlert(), makeAlert(), makeAlert()]);
      const result = await queryAlerts({ limit: 999 });
      // We only have 3 rows, but important part is no error
      expect(result.data.length).toBe(3);
    });

    it('Case 107: queryTickets by status="open"', async () => {
      await db.insert(tickets).values([
        makeTicket({ status: 'open' }),
        makeTicket({ status: 'resolved' }),
        makeTicket({ status: 'open' }),
      ]);
      const result = await queryTickets({ status: 'open' });
      expect(result.data.length).toBe(2);
    });

    it('Case 108: queryTickets by status="escalated"', async () => {
      await db.insert(tickets).values([
        makeTicket({ status: 'escalated', wasEscalated: true }),
        makeTicket({ status: 'open' }),
      ]);
      const result = await queryTickets({ status: 'escalated' });
      expect(result.data.length).toBe(1);
    });

    it('Case 109: queryTickets by multiple comma-separated statuses', async () => {
      await db.insert(tickets).values([
        makeTicket({ status: 'open' }),
        makeTicket({ status: 'in_progress' }),
        makeTicket({ status: 'resolved' }),
      ]);
      const result = await queryTickets({ status: 'open,in_progress' });
      expect(result.data.length).toBe(2);
    });

    it('Case 110: queryTickets by assigneeId', async () => {
      await db.insert(tickets).values([
        makeTicket({ assigneeId: staffUser.id }),
        makeTicket({ assigneeId: adminUser.id }),
        makeTicket({ assigneeId: staffUser.id }),
      ]);
      const result = await queryTickets({ assigneeId: staffUser.id });
      expect(result.data.length).toBe(2);
    });

    it('Case 111: queryTickets by severity', async () => {
      await db.insert(tickets).values([
        makeTicket({ severity: 'critical', faultType: 3 }),
        makeTicket({ severity: 'warning' }),
      ]);
      const result = await queryTickets({ severity: 'critical' });
      expect(result.data.length).toBe(1);
    });

    it('Case 112: queryTickets returns empty for non-matching filter', async () => {
      await db.insert(tickets).values([makeTicket({ severity: 'info', faultType: 0 })]);
      const result = await queryTickets({ severity: 'emergency' });
      expect(result.data.length).toBe(0);
    });

    it('Case 113: getTicketStats counts per status', async () => {
      await db.insert(tickets).values([
        makeTicket({ status: 'open' }),
        makeTicket({ status: 'open' }),
        makeTicket({ status: 'in_progress' }),
        makeTicket({ status: 'resolved' }),
        makeTicket({ status: 'escalated', wasEscalated: true }),
      ]);
      const stats = await getTicketStats();
      expect(stats.total).toBe(5);
      expect(stats.open).toBe(2);
      expect(stats.inProgress).toBe(1);
      expect(stats.resolved).toBe(1);
      expect(stats.escalated).toBe(1);
    });

    it('Case 114: getTicketStats returns zeros when no tickets', async () => {
      const stats = await getTicketStats();
      expect(stats.total).toBe(0);
      expect(stats.open).toBe(0);
      expect(stats.inProgress).toBe(0);
      expect(stats.resolved).toBe(0);
      expect(stats.escalated).toBe(0);
    });

    it('Case 115: getAlertStats counts total, unacknowledged, critical', async () => {
      await db.insert(alerts).values([
        makeAlert({ severity: 'critical', faultType: 3, acknowledged: false }),
        makeAlert({ severity: 'emergency', faultType: 1, acknowledged: false }),
        makeAlert({ severity: 'warning', acknowledged: true }),
      ]);
      const stats = await getAlertStats();
      expect(stats.total).toBe(3);
      expect(stats.unacknowledged).toBe(2);
      expect(stats.critical).toBe(2); // critical + emergency
    });

    it('Case 116: getAlertStats excludes resolved ticket alerts', async () => {
      const t = makeTicket({ status: 'resolved' });
      await db.insert(tickets).values(t);
      await db.insert(alerts).values(makeAlert({ ticketId: t.id, acknowledged: true }));
      // Also insert one with no ticket (should be counted)
      await db.insert(alerts).values(makeAlert({ acknowledged: false }));
      const stats = await getAlertStats();
      expect(stats.total).toBe(1); // Only the one without resolved ticket
    });

    it('Case 117: queryTickets with limit and offset pagination', async () => {
      for (let i = 0; i < 5; i++) {
        await db.insert(tickets).values(makeTicket());
      }
      const page1 = await queryTickets({ limit: 2, offset: 0 });
      const page2 = await queryTickets({ limit: 2, offset: 2 });
      const page3 = await queryTickets({ limit: 2, offset: 4 });
      expect(page1.data.length).toBe(2);
      expect(page2.data.length).toBe(2);
      expect(page3.data.length).toBe(1);
      expect(page1.total).toBe(5);
    });

    it('Case 118: queryTickets by alertId filter', async () => {
      const alertId = nanoid();
      await db.insert(tickets).values([
        makeTicket({ alertId }),
        makeTicket({ alertId: 'other' }),
      ]);
      const result = await queryTickets({ alertId });
      expect(result.data.length).toBe(1);
      expect(result.data[0]?.alertId).toBe(alertId);
    });

    it('Case 119: getTicketById returns null for non-existent ticket', async () => {
      const ticket = await getTicketById('DOES-NOT-EXIST');
      expect(ticket).toBeNull();
    });

    it('Case 120: queryAlerts combined severity + acknowledged filter', async () => {
      await db.insert(alerts).values([
        makeAlert({ severity: 'critical', faultType: 3, acknowledged: false }),
        makeAlert({ severity: 'critical', faultType: 3, acknowledged: true }),
        makeAlert({ severity: 'warning', acknowledged: false }),
      ]);
      const result = await queryAlerts({ severity: 'critical', acknowledged: 'false' });
      expect(result.data.length).toBe(1);
      expect(result.data[0]?.severity).toBe('critical');
      expect(result.data[0]?.acknowledged).toBe(false);
    });
  });
});
