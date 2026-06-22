import type { FastifyInstance } from 'fastify';
import { db } from '../db/index.js';
import { config } from '../db/schema.js';
import { eq } from 'drizzle-orm';

export default async function configRoutes(fastify: FastifyInstance) {
  // ─── GET /api/v1/config — Read all config entries ─────────────
  fastify.get('/api/v1/config', {
    preHandler: [fastify.authenticate, fastify.requireAdmin],
  }, async (_request, reply) => {
    const rows = await db.select().from(config);
    const data: Record<string, unknown> = {};
    for (const row of rows) {
      data[row.key] = row.value;
    }
    return reply.send({ data });
  });

  // ─── PATCH /api/v1/config — Update config entries ─────────────
  fastify.patch<{ Body: Record<string, unknown> }>('/api/v1/config', {
    preHandler: [fastify.authenticate, fastify.requireAdmin],
    schema: {
      body: {
        type: 'object',
        additionalProperties: true,
      },
    },
  }, async (request, reply) => {
    const userId = request.user!.sub;
    const entries = request.body;

    for (const [key, value] of Object.entries(entries)) {
      const existing = await db.select().from(config).where(eq(config.key, key));

      if (existing.length > 0) {
        await db.update(config).set({
          value: value as any,
          updatedBy: userId,
          updatedAt: new Date(),
        }).where(eq(config.key, key));
      } else {
        await db.insert(config).values({
          key,
          value: value as any,
          updatedBy: userId,
        });
      }
    }

    // Return updated config
    const rows = await db.select().from(config);
    const data: Record<string, unknown> = {};
    for (const row of rows) {
      data[row.key] = row.value;
    }
    return reply.send({ success: true, data });
  });
}
