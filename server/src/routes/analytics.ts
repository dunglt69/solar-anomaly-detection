import type { FastifyInstance } from 'fastify';
import {
  getDailyEnergy,
  getHourlyProfile,
  getFaultTrend,
  getSystemSummary,
} from '../services/analytics.service.js';

export default async function analyticsRoutes(fastify: FastifyInstance) {
  // ─── GET /api/v1/analytics/daily-energy ───────────────────────────
  fastify.get<{ Querystring: { from?: string; to?: string } }>('/api/v1/analytics/daily-energy', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    const data = await getDailyEnergy(request.query.from, request.query.to);
    return reply.send({ data });
  });

  // ─── GET /api/v1/analytics/hourly-profile ─────────────────────────
  fastify.get<{ Querystring: { date: string } }>('/api/v1/analytics/hourly-profile', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    const date = request.query.date || new Date().toISOString().split('T')[0]!;
    const data = await getHourlyProfile(date);
    return reply.send({ data, date });
  });

  // ─── GET /api/v1/analytics/fault-trend ────────────────────────────
  fastify.get<{ Querystring: { from?: string; to?: string } }>('/api/v1/analytics/fault-trend', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    const data = await getFaultTrend(request.query.from, request.query.to);
    return reply.send({ data });
  });

  // ─── GET /api/v1/analytics/summary ────────────────────────────────
  fastify.get<{ Querystring: { from?: string; to?: string } }>('/api/v1/analytics/summary', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    const data = await getSystemSummary(request.query.from, request.query.to);
    return reply.send(data);
  });
}
