import type { FastifyInstance } from 'fastify';
import {
  queryAlerts,
  acknowledgeAlert,
  resolveAlert,
  getAlertStats,
  type AlertQuery,
} from '../services/alert.service.js';
import { writeActivityLog } from '../services/admin.service.js';

export default async function alertRoutes(fastify: FastifyInstance) {
  // ─── GET /api/v1/alerts — List alerts ─────────────────────────
  fastify.get<{ Querystring: AlertQuery }>('/api/v1/alerts', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    const result = await queryAlerts(request.query);
    return reply.send(result);
  });

  // ─── GET /api/v1/alerts/stats — Alert statistics ──────────────
  fastify.get('/api/v1/alerts/stats', {
    preHandler: [fastify.authenticate],
  }, async (_request, reply) => {
    const stats = await getAlertStats();
    return reply.send(stats);
  });

  // ─── PATCH /api/v1/alerts/:id — Acknowledge or Resolve alert ──
  fastify.patch<{
    Params: { id: string };
    Body: { action?: 'acknowledge' | 'resolve' };
  }>('/api/v1/alerts/:id', {
    preHandler: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['acknowledge', 'resolve'] },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const userId = request.user?.sub || 'system';
    const action = request.body?.action || 'acknowledge';

    if (action === 'resolve') {
      const success = await resolveAlert(request.params.id, userId);
      if (!success) {
        return reply.status(409).send({ error: 'Alert has already been resolved or processed by another operator' });
      }
      await writeActivityLog({
        actorId: request.user!.sub,
        actorRole: request.user!.role,
        action: 'UPDATE',
        target: `alert:${request.params.id}`,
        details: { action: 'resolve' },
        ip: request.ip,
        userAgent: request.headers['user-agent'] || 'unknown',
      });
    } else {
      const success = await acknowledgeAlert(request.params.id, userId);
      if (!success) {
        return reply.status(409).send({ error: 'Alert has already been acknowledged or processed by another operator' });
      }
      await writeActivityLog({
        actorId: request.user!.sub,
        actorRole: request.user!.role,
        action: 'UPDATE',
        target: `alert:${request.params.id}`,
        details: { action: 'acknowledge' },
        ip: request.ip,
        userAgent: request.headers['user-agent'] || 'unknown',
      });
    }

    return reply.send({ success: true, action });
  });
}
