import type { FastifyInstance } from 'fastify';
import {
  queryTickets,
  getTicketById,
  updateTicket,
  addComment,
  getTicketStats,
  type TicketQuery,
} from '../services/ticket.service.js';
import { writeActivityLog } from '../services/admin.service.js';

export default async function ticketRoutes(fastify: FastifyInstance) {
  // ─── GET /api/v1/tickets — List tickets ───────────────────────
  fastify.get<{ Querystring: TicketQuery }>('/api/v1/tickets', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    const result = await queryTickets(request.query);
    return reply.send(result);
  });

  // ─── GET /api/v1/tickets/stats — Ticket statistics ────────────
  fastify.get('/api/v1/tickets/stats', {
    preHandler: [fastify.authenticate],
  }, async (_request, reply) => {
    const stats = await getTicketStats();
    return reply.send(stats);
  });

  // ─── GET /api/v1/tickets/:id — Ticket detail ─────────────────
  fastify.get<{ Params: { id: string } }>('/api/v1/tickets/:id', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    const ticket = await getTicketById(request.params.id);
    if (!ticket) return reply.status(404).send({ error: 'Ticket not found' });
    return reply.send(ticket);
  });

  // ─── PATCH /api/v1/tickets/:id — Update ticket ───────────────
  fastify.patch<{
    Params: { id: string };
    Body: { status?: string; assigneeId?: string; resolutionSummary?: string };
  }>('/api/v1/tickets/:id', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    try {
      const updated = await updateTicket(request.params.id, request.body);
      await writeActivityLog({
        actorId: request.user!.sub,
        actorRole: request.user!.role,
        action: 'UPDATE',
        target: `ticket:${request.params.id}`,
        details: { updates: request.body },
        ip: request.ip,
        userAgent: request.headers['user-agent'] || 'unknown',
      });
      return reply.send(updated);
    } catch (err: any) {
      if (err.isConflict) {
        return reply.status(409).send({ error: err.message });
      }
      return reply.status(400).send({ error: err.message });
    }
  });

  // ─── POST /api/v1/tickets/:id/comments — Add comment ─────────
  fastify.post<{
    Params: { id: string };
    Body: { content: string };
  }>('/api/v1/tickets/:id/comments', {
    preHandler: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['content'],
        properties: { content: { type: 'string', minLength: 1 } },
      },
    },
  }, async (request, reply) => {
    const userId = request.user?.sub || 'system';
    const comment = await addComment(request.params.id, userId, request.body.content);
    await writeActivityLog({
      actorId: request.user!.sub,
      actorRole: request.user!.role,
      action: 'CREATE',
      target: `comment:${comment.id}`,
      details: { ticketId: request.params.id },
      ip: request.ip,
      userAgent: request.headers['user-agent'] || 'unknown',
    });
    return reply.status(201).send(comment);
  });
}
