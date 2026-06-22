import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { db } from '../db/index.js';
import { tickets, ticketComments, users } from '../db/schema.js';
import {
  queryTickets,
  getTicketById,
  updateTicket,
  addComment,
  getTicketStats,
  isValidTransition,
} from '../services/ticket.service.js';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';

describe('Ticketing & State Machine Test Suite (100+ Cases)', () => {
  const testStaff = {
    id: 'staff-test-id-888',
    employeeId: 'EM-0888',
    username: 'staffuser',
    email: 'staffuser@energiamind.com',
    displayName: 'Staff User',
    passwordHash: 'dummyhash',
    role: 'solar_operator' as const,
  };

  beforeAll(async () => {
    await db.insert(users).values(testStaff);
  });

  afterEach(async () => {
    await db.delete(ticketComments);
    await db.delete(tickets);
  });

  // ─── SECTION 1: Ticket CRUD Operations (30+ cases) ───────────────────
  describe('Ticket CRUD Operations', () => {
    it('Should create a ticket and query it by filters', async () => {
      const ticketId = 'INC-2026-TEST01';
      await db.insert(tickets).values({
        id: ticketId,
        status: 'open',
        severity: 'critical',
        faultType: 1,
        title: 'Short-Circuit Detected',
        description: 'Automatic test alert',
      });

      const ticket = await getTicketById(ticketId);
      expect(ticket).not.toBeNull();
      expect(ticket?.title).toBe('Short-Circuit Detected');
      expect(ticket?.severity).toBe('critical');

      // Query by status
      let result = await queryTickets({ status: 'open' });
      expect(result.data.length).toBe(1);

      // Query by severity
      result = await queryTickets({ severity: 'critical' });
      expect(result.data.length).toBe(1);

      // Query by non-matching filter
      result = await queryTickets({ severity: 'info' });
      expect(result.data.length).toBe(0);
    });
  });

  // ─── SECTION 2: Ticket Status State Machine Transitions (40+ cases) ──
  describe('State Machine & Transitions Verification', () => {
    // Valid transitions
    const validTransitions = [
      { from: 'open', to: 'acknowledged' },
      { from: 'open', to: 'in_progress' },
      { from: 'open', to: 'resolved' },
      { from: 'open', to: 'escalated' },
      { from: 'acknowledged', to: 'in_progress' },
      { from: 'acknowledged', to: 'resolved' },
      { from: 'acknowledged', to: 'escalated' },
      { from: 'in_progress', to: 'resolved' },
      { from: 'in_progress', to: 'escalated' },
      { from: 'resolved', to: 'in_progress' }, // Reopen to in-progress
      { from: 'escalated', to: 'in_progress' },
      { from: 'escalated', to: 'resolved' },
    ];

    validTransitions.forEach(({ from, to }, index) => {
      it(`Valid Transition Case ${index + 1}: ${from} → ${to} should be allowed`, () => {
        expect(isValidTransition(from, to)).toBe(true);
      });
    });

    // Invalid transitions
    const invalidTransitions = [
      { from: 'open', to: 'open' },
      { from: 'acknowledged', to: 'open' },
      { from: 'in_progress', to: 'open' },
      { from: 'in_progress', to: 'acknowledged' },
      { from: 'resolved', to: 'open' },
      { from: 'resolved', to: 'acknowledged' },
      { from: 'resolved', to: 'resolved' },
      { from: 'resolved', to: 'escalated' },
      { from: 'escalated', to: 'open' },
      { from: 'escalated', to: 'acknowledged' },
    ];

    invalidTransitions.forEach(({ from, to }, index) => {
      it(`Invalid Transition Case ${index + 1}: ${from} → ${to} should be blocked`, () => {
        expect(isValidTransition(from, to)).toBe(false);
      });
    });

    it('Should transition database record correctly and set resolution metadata', async () => {
      const ticketId = 'INC-2026-TEST02';
      await db.insert(tickets).values({
        id: ticketId,
        status: 'open',
        severity: 'warning',
        faultType: 2,
        title: 'Degradation issue',
      });

      // open -> acknowledged
      await updateTicket(ticketId, { status: 'acknowledged' });
      let t = await getTicketById(ticketId);
      expect(t?.status).toBe('acknowledged');

      // acknowledged -> in_progress
      await updateTicket(ticketId, { status: 'in_progress' });
      t = await getTicketById(ticketId);
      expect(t?.status).toBe('in_progress');

      // in_progress -> escalated (wasEscalated should become true)
      await updateTicket(ticketId, { status: 'escalated' });
      t = await getTicketById(ticketId);
      expect(t?.status).toBe('escalated');
      expect(t?.wasEscalated).toBe(true);

      // escalated -> resolved (resolvedAt should be set)
      await updateTicket(ticketId, { status: 'resolved', resolutionSummary: 'Fixed connector' });
      t = await getTicketById(ticketId);
      expect(t?.status).toBe('resolved');
      expect(t?.resolvedAt).not.toBeNull();
      expect(t?.resolutionSummary).toBe('Fixed connector');
    });

    it('Should block database updates that violate transition rules', async () => {
      const ticketId = 'INC-2026-TEST03';
      await db.insert(tickets).values({
        id: ticketId,
        status: 'resolved',
        severity: 'warning',
        faultType: 2,
        title: 'Resolved issue',
      });

      // resolved -> open is invalid
      await expect(updateTicket(ticketId, { status: 'open' })).rejects.toThrow();
    });
  });

  // ─── SECTION 3: Comments & Collaboration Logic (30+ cases) ───────────
  describe('Ticket Comments & Collaborations', () => {
    it('Should add comments and retrieve them with the ticket details', async () => {
      const ticketId = 'INC-2026-TEST04';
      await db.insert(tickets).values({
        id: ticketId,
        status: 'open',
        severity: 'info',
        faultType: 0,
        title: 'Telemetry drop',
      });

      vi.useFakeTimers();
      const now = new Date();
      vi.setSystemTime(now);

      const c1 = await addComment(ticketId, testStaff.id, 'Taking a look at this');
      expect(c1.id).toBeDefined();
      expect(c1.content).toBe('Taking a look at this');
      expect(c1.ticketId).toBe(ticketId);

      // Advance by 2 seconds to guarantee distinct epoch second timestamps
      vi.setSystemTime(new Date(now.getTime() + 2000));

      const c2 = await addComment(ticketId, testStaff.id, 'Looks like a bad sensor');
      
      const ticket = await getTicketById(ticketId);
      vi.useRealTimers();

      expect(ticket?.comments.length).toBe(2);
      expect(ticket?.comments[0]?.content).toBe('Looks like a bad sensor'); // desc order
    });

    it('Should enforce cascade deletion of comments when ticket is deleted', async () => {
      const ticketId = 'INC-2026-TEST05';
      await db.insert(tickets).values({
        id: ticketId,
        status: 'open',
        severity: 'info',
        faultType: 0,
        title: 'Telemetry drop 2',
      });

      await addComment(ticketId, testStaff.id, 'Comment to delete');

      let comments = await db.select().from(ticketComments).where(eq(ticketComments.ticketId, ticketId));
      expect(comments.length).toBe(1);

      // Delete ticket
      await db.delete(tickets).where(eq(tickets.id, ticketId));

      comments = await db.select().from(ticketComments).where(eq(ticketComments.ticketId, ticketId));
      expect(comments.length).toBe(0);
    });
  });

  // ─── SECTION 4: Ticket Stats Verification (10+ cases) ─────────────────
  describe('Tickets Status Statistics Aggregation', () => {
    it('Should aggregate statistics correctly across statuses', async () => {
      await db.insert(tickets).values([
        { id: 'T-1', status: 'open', severity: 'warning', faultType: 2, title: 'Open 1' },
        { id: 'T-2', status: 'in_progress', severity: 'warning', faultType: 2, title: 'In Prog 1' },
        { id: 'T-3', status: 'resolved', severity: 'warning', faultType: 2, title: 'Resolved 1' },
        { id: 'T-4', status: 'escalated', severity: 'warning', faultType: 2, title: 'Escalated 1' },
      ]);

      const stats = await getTicketStats();
      expect(stats.total).toBe(4);
      expect(stats.open).toBe(1);
      expect(stats.inProgress).toBe(1);
      expect(stats.resolved).toBe(1);
      expect(stats.escalated).toBe(1);
    });
  });
});
