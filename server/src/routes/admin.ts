import type { FastifyInstance } from 'fastify';
import {
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  queryActivityLog,
  writeActivityLog,
  unlockUser,
  type ActivityLogQuery,
} from '../services/admin.service.js';
import {
  resetDeviceBinding,
  getDeviceBinding,
} from '../services/deviceBinding.service.js';
import { registeredDevices, users } from '../db/schema.js';
import { db } from '../db/index.js';
import { eq } from 'drizzle-orm';

import { validatePassword } from '../utils/validators.js';

export default async function adminRoutes(fastify: FastifyInstance) {
  // ─── GET /api/v1/users — List all users ───────────────────────
  fastify.get('/api/v1/users', {
    preHandler: [fastify.authenticate, fastify.requireAdmin],
  }, async (_request, reply) => {
    const userList = await listUsers();
    return reply.send({ data: userList });
  });

  // ─── POST /api/v1/users — Create user ────────────────────────
  fastify.post<{
    Body: { username: string; email: string; personalEmail: string; dob: string; displayName: string; password: string; role: 'admin' | 'solar_operator' | 'security_engineer' };
  }>('/api/v1/users', {
    preHandler: [fastify.authenticate, fastify.requireAdmin],
    schema: {
      body: {
        type: 'object',
        required: ['username', 'email', 'personalEmail', 'dob', 'displayName', 'password', 'role'],
        properties: {
          username: { type: 'string', minLength: 3 },
          email: { type: 'string', format: 'email' },
          personalEmail: { type: 'string', format: 'email' },
          dob: { type: 'string', minLength: 1 },
          displayName: { type: 'string', minLength: 1 },
          password: { type: 'string', minLength: 8 },
          role: { type: 'string', enum: ['admin', 'solar_operator', 'security_engineer'] },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const { username, password } = request.body;

      // Input length limits
      if (!username || username.length > 50) {
        return reply.status(400).send({ error: 'Username required (max 50 chars)' });
      }
      if (!password || password.length > 128) {
        return reply.status(400).send({ error: 'Password required (max 128 chars)' });
      }

      // Password complexity validation
      const passwordError = validatePassword(password);
      if (passwordError) {
        return reply.status(400).send({ error: passwordError });
      }

      const user = await createUser(request.body);
      await writeActivityLog({
        actorId: request.user!.sub,
        actorRole: request.user!.role,
        action: 'CREATE',
        target: `user:${user.id}`,
        details: { username: user.username, role: user.role, displayName: user.displayName, employeeId: user.employeeId, personalEmail: user.personalEmail, dob: user.dob },
        ip: request.ip,
        userAgent: request.headers['user-agent'] || 'unknown',
      });
      return reply.status(201).send(user);
    } catch (err: any) {
      if (err.code === 'SQLITE_CONSTRAINT' || err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.message?.includes('UNIQUE')) {
        return reply.status(409).send({ error: 'User already exists' });
      }
      fastify.log.error(err, 'Failed to create user');
      throw err;
    }
  });

  // ─── PATCH /api/v1/users/:id — Update user ───────────────────
  fastify.patch<{
    Params: { id: string };
    Body: { displayName?: string; email?: string; personalEmail?: string; dob?: string; role?: 'admin' | 'solar_operator' | 'security_engineer'; password?: string };
  }>('/api/v1/users/:id', {
    preHandler: [fastify.authenticate, fastify.requireAdmin],
    schema: {
      body: {
        type: 'object',
        properties: {
          displayName: { type: 'string', minLength: 1 },
          email: { type: 'string', format: 'email' },
          personalEmail: { type: 'string', format: 'email' },
          dob: { type: 'string', minLength: 1 },
          password: { type: 'string', minLength: 8 },
          role: { type: 'string', enum: ['admin', 'solar_operator', 'security_engineer'] },
        },
      },
    },
  }, async (request, reply) => {
    // Validate password if being updated
    if (request.body.password) {
      if (request.body.password.length > 128) {
        return reply.status(400).send({ error: 'Password required (max 128 chars)' });
      }
      const passwordError = validatePassword(request.body.password);
      if (passwordError) {
        return reply.status(400).send({ error: passwordError });
      }
    }

    await updateUser(request.params.id, request.body);
    await writeActivityLog({
      actorId: request.user!.sub,
      actorRole: request.user!.role,
      action: 'UPDATE',
      target: `user:${request.params.id}`,
      details: { fields: Object.keys(request.body).filter(k => k !== 'password') },
      ip: request.ip,
      userAgent: request.headers['user-agent'] || 'unknown',
    });
    return reply.send({ success: true });
  });

  // ─── DELETE /api/v1/users/:id — Delete user ──────────────────
  fastify.delete<{ Params: { id: string } }>('/api/v1/users/:id', {
    preHandler: [fastify.authenticate, fastify.requireAdmin],
  }, async (request, reply) => {
    if (request.user!.sub === request.params.id) {
      return reply.code(400).send({ error: 'Cannot delete your own account' });
    }
    await deleteUser(request.params.id);
    await writeActivityLog({
      actorId: request.user!.sub,
      actorRole: request.user!.role,
      action: 'DELETE',
      target: `user:${request.params.id}`,
      details: { deleted: true },
      ip: request.ip,
      userAgent: request.headers['user-agent'] || 'unknown',
    });
    return reply.send({ success: true });
  });

  // ─── GET /api/v1/activity-log — Query activity log ────────────
  fastify.get<{ Querystring: ActivityLogQuery }>('/api/v1/activity-log', {
    preHandler: [fastify.authenticate, fastify.requireSecurityOrAdmin],
  }, async (request, reply) => {
    const result = await queryActivityLog(request.query);
    return reply.send(result);
  });

  // ─── Device Bindings Management ─────────────────────────────────────

  // GET /api/v1/admin/device-bindings — List all device bindings
  fastify.get('/api/v1/admin/device-bindings', {
    preHandler: [fastify.authenticate, fastify.requireAdmin],
  }, async (_request, reply) => {
    const devices = await db.select({
      id: registeredDevices.id,
      userId: registeredDevices.userId,
      browser: registeredDevices.browser,
      os: registeredDevices.os,
      registeredAt: registeredDevices.registeredAt,
      lastSeenAt: registeredDevices.lastSeenAt,
      isActive: registeredDevices.isActive,
    }).from(registeredDevices);

    // Resolve user details
    const userIds = [...new Set(devices.map(d => d.userId))];
    const userRows = userIds.length > 0
      ? await db.select({
        id: users.id,
        employeeId: users.employeeId,
        displayName: users.displayName,
        username: users.username,
      }).from(users)
      : [];
    const userMap = Object.fromEntries(userRows.map(u => [u.id, u]));

    const data = devices.map(d => ({
      ...d,
      employeeId: userMap[d.userId]?.employeeId || '—',
      displayName: userMap[d.userId]?.displayName || '—',
      username: userMap[d.userId]?.username || '—',
    }));

    return reply.send({ data });
  });

  // POST /api/v1/admin/device-bindings/:userId/reset — Reset device binding
  fastify.post<{
    Params: { userId: string };
  }>('/api/v1/admin/device-bindings/:userId/reset', {
    preHandler: [fastify.authenticate, fastify.requireAdmin],
  }, async (request, reply) => {
    const { userId } = request.params;
    const adminId = request.user!.sub;
    const adminRole = request.user!.role;

    await resetDeviceBinding(
      userId,
      adminId,
      adminRole,
      request.ip,
      request.headers['user-agent'] || 'unknown',
    );

    return reply.send({ success: true, message: 'Device binding reset. User will register on next login.' });
  });

  // ─── User Unlock ───────────────────────────────────────────────────
  fastify.post<{
    Params: { id: string };
  }>('/api/v1/admin/users/:id/unlock', {
    preHandler: [fastify.authenticate, fastify.requireAdmin],
  }, async (request, reply) => {
    const adminId = request.user!.sub;
    const adminRole = request.user!.role;
    const { id } = request.params;

    await unlockUser(id);

    await writeActivityLog({
      actorId: adminId,
      actorRole: adminRole,
      action: 'UPDATE',
      target: `user:${id}`,
      details: { unlocked: true },
      ip: request.ip,
      userAgent: request.headers['user-agent'] || 'unknown',
    });

    return reply.send({ success: true, message: 'User account unlocked successfully.' });
  });
}
