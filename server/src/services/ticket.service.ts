import { db } from '../db/index.js';
import { tickets, ticketComments, alerts } from '../db/schema.js';
import { eq, desc, sql, count, and, inArray } from 'drizzle-orm';
import { nanoid } from 'nanoid';

// ─── Ticket status transitions (state machine) ─────────────────────
const VALID_TRANSITIONS: Record<string, string[]> = {
  open: ['acknowledged', 'in_progress', 'resolved', 'escalated'],
  acknowledged: ['in_progress', 'resolved', 'escalated'],
  in_progress: ['resolved', 'escalated'],
  resolved: ['in_progress'], // Can reopen
  escalated: ['in_progress', 'resolved'],
};

export function isValidTransition(from: string, to: string): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

// ─── Query tickets ──────────────────────────────────────────────────
export interface TicketQuery {
  status?: string;
  severity?: string;
  assigneeId?: string;
  alertId?: string;
  limit?: number;
  offset?: number;
}

export async function queryTickets(q: TicketQuery) {
  const conditions = [];
  if (q.status) {
    const statuses = q.status.split(',');
    conditions.push(inArray(tickets.status, statuses as any));
  }
  if (q.severity) conditions.push(eq(tickets.severity, q.severity as any));
  if (q.assigneeId) conditions.push(eq(tickets.assigneeId, q.assigneeId));
  if (q.alertId) conditions.push(eq(tickets.alertId, q.alertId));

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const limit = Math.min(q.limit || 50, 200);
  const offset = q.offset || 0;

  const rows = await db.select().from(tickets)
    .where(where)
    .orderBy(desc(tickets.createdAt))
    .limit(limit)
    .offset(offset);

  const [total] = await db.select({ count: count() }).from(tickets).where(where);

  return { data: rows, total: total?.count || 0 };
}

// ─── Get single ticket ──────────────────────────────────────────────
export async function getTicketById(id: string) {
  const [ticket] = await db.select().from(tickets).where(eq(tickets.id, id));
  if (!ticket) return null;

  const comments = await db.select().from(ticketComments)
    .where(eq(ticketComments.ticketId, id))
    .orderBy(desc(ticketComments.createdAt));

  return { ...ticket, comments };
}

// ─── Update ticket status ───────────────────────────────────────────
export async function updateTicket(
  id: string,
  updates: {
    status?: string;
    assigneeId?: string;
    resolutionSummary?: string;
  }
) {
  const [existing] = await db.select().from(tickets).where(eq(tickets.id, id));
  if (!existing) throw new Error('Ticket not found');

  const setData: Record<string, any> = { updatedAt: new Date() };

  if (updates.status) {
    if (existing.status === updates.status) {
      const err = new Error(`Ticket is already ${updates.status}`);
      (err as any).isConflict = true;
      throw err;
    }
    if (!isValidTransition(existing.status, updates.status)) {
      const err = new Error(`Invalid transition: ${existing.status} → ${updates.status}`);
      if (['resolved', 'closed', 'escalated'].includes(existing.status)) {
        (err as any).isConflict = true;
      }
      throw err;
    }
    setData.status = updates.status;
    if (updates.status === 'resolved') {
      setData.resolvedAt = new Date();
    }
    if (updates.status === 'escalated') {
      setData.wasEscalated = true;
    }

    // Sync alert acknowledgment status
    if (existing.alertId && updates.status !== 'open') {
      await db.update(alerts)
        .set({
          acknowledged: true,
          acknowledgedAt: new Date(),
        })
        .where(eq(alerts.id, existing.alertId));
    }
  }

  if (updates.assigneeId !== undefined) setData.assigneeId = updates.assigneeId;
  if (updates.resolutionSummary !== undefined) setData.resolutionSummary = updates.resolutionSummary;

  await db.update(tickets).set(setData).where(eq(tickets.id, id));

  return getTicketById(id);
}

// ─── Add comment ────────────────────────────────────────────────────
export async function addComment(ticketId: string, authorId: string, content: string) {
  const commentId = nanoid();
  await db.insert(ticketComments).values({
    id: commentId,
    ticketId,
    authorId,
    content,
  });
  return { id: commentId, ticketId, authorId, content, createdAt: new Date() };
}

// ─── Ticket stats ───────────────────────────────────────────────────
export async function getTicketStats() {
  const [stats] = await db.select({
    total: count(),
    open: sql<number>`SUM(CASE WHEN ${tickets.status} = 'open' THEN 1 ELSE 0 END)`,
    inProgress: sql<number>`SUM(CASE WHEN ${tickets.status} = 'in_progress' THEN 1 ELSE 0 END)`,
    resolved: sql<number>`SUM(CASE WHEN ${tickets.status} IN ('resolved', 'closed') THEN 1 ELSE 0 END)`,
    escalated: sql<number>`SUM(CASE WHEN ${tickets.status} = 'escalated' THEN 1 ELSE 0 END)`,
  }).from(tickets);

  return {
    total: stats?.total || 0,
    open: Number(stats?.open) || 0,
    inProgress: Number(stats?.inProgress) || 0,
    resolved: Number(stats?.resolved) || 0,
    closed: 0,
    escalated: Number(stats?.escalated) || 0,
  };
}
