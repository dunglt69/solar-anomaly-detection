import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { verifyAccessToken, AuthError } from '../services/auth.service.js';
import { db } from '../db/index.js';
import { registeredDevices } from '../db/schema.js';
import { eq } from 'drizzle-orm';

declare module 'fastify' {
  interface FastifyRequest {
    user?: {
      sub: string;
      role: 'admin' | 'solar_operator' | 'security_engineer';
      username: string;
    };
  }
}

async function authPlugin(fastify: FastifyInstance) {
  fastify.decorateRequest('user', undefined);

  fastify.decorate('authenticate', async function (request: FastifyRequest, reply: FastifyReply) {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Missing authorization header' });
    }
    const token = authHeader.slice(7);
    try {
      request.user = await verifyAccessToken(token);
      
      // Update lastSeenAt for the user's bound device asynchronously
      db.update(registeredDevices)
        .set({ lastSeenAt: new Date() })
        .where(eq(registeredDevices.userId, request.user.sub))
        .catch(err => {
          request.log.error(err, 'Failed to update lastSeenAt');
        });
    } catch (err) {
      if (err instanceof AuthError) {
        return reply.code(err.statusCode).send({ error: err.message });
      }
      return reply.code(401).send({ error: 'Invalid token' });
    }
  });

  fastify.decorate('requireAdmin', async function (request: FastifyRequest, reply: FastifyReply) {
    if (!request.user || request.user.role !== 'admin') {
      return reply.code(403).send({ error: 'Admin access required' });
    }
  });

  fastify.decorate('requireSecurityOrAdmin', async function (request: FastifyRequest, reply: FastifyReply) {
    if (!request.user || (request.user.role !== 'admin' && request.user.role !== 'security_engineer')) {
      return reply.code(403).send({ error: 'Security or admin access required' });
    }
  });
}

export default fp(authPlugin, {
  name: 'auth',
  fastify: '5.x',
});

// Augment Fastify instance type
declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireSecurityOrAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
