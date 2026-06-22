import type { FastifyInstance } from 'fastify';
import { login, refresh, logout, getUserById, verifyAndChangePassword, AuthError } from '../services/auth.service.js';
import { updateUser } from '../services/admin.service.js';

interface LoginBody {
  username: string;
  password: string;
  turnstileToken?: string;
}

interface RefreshBody {
  refreshToken?: string;
}

import { validatePassword } from '../utils/validators.js';
import type { HardwareSignature } from '../services/deviceBinding.service.js';

export default async function authRoutes(fastify: FastifyInstance) {
  // ─── POST /api/v1/auth/login ──────────────────────────────────
  fastify.post<{ Body: LoginBody }>('/api/v1/auth/login', {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '1 minute',
      },
    },
    schema: {
      body: {
        type: 'object',
        required: ['username', 'password'],
        properties: {
          username: { type: 'string', minLength: 1 },
          password: { type: 'string', minLength: 1 },
          turnstileToken: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const { username, password, turnstileToken } = request.body;

      // Turnstile CAPTCHA validation (if secret key is configured)
      const turnstileSecret = process.env['TURNSTILE_SECRET_KEY'];

      // Check if current IP is whitelisted to bypass Turnstile
      const bypassIpsRaw = process.env['TURNSTILE_BYPASS_IPS'] || '';
      const bypassIps = bypassIpsRaw.split(',').map(ip => ip.trim()).filter(Boolean);
      const isWhitelisted = bypassIps.some(bypassIp => {
        return request.ip === bypassIp || request.ip.startsWith(bypassIp);
      });

      if (turnstileSecret && !isWhitelisted) {
        if (!turnstileToken) {
          return reply.status(400).send({ error: 'CAPTCHA verification token required' });
        }

        try {
          const verificationUrl = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
          const cfResponse = await fetch(verificationUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
              secret: turnstileSecret,
              response: turnstileToken,
              remoteip: request.ip,
            }),
          });

          const cfData = await cfResponse.json() as { success: boolean; 'error-codes'?: string[] };
          if (!cfData.success) {
            request.log.warn({ cfData, ip: request.ip }, 'Turnstile verification failed');
            return reply.status(400).send({ error: 'CAPTCHA verification failed. Please try again.' });
          }
        } catch (err) {
          request.log.error(err, 'Turnstile verification service error');
          return reply.status(500).send({ error: 'CAPTCHA verification service is currently unavailable.' });
        }
      }

      // Input length limits
      if (!username || username.length > 50) {
        return reply.status(400).send({ error: 'Username required (max 50 chars)' });
      }
      if (!password || password.length > 128) {
        return reply.status(400).send({ error: 'Password required (max 128 chars)' });
      }

      const ip = request.ip;
      const userAgent = request.headers['user-agent'] || 'unknown';

      // Parse hardware signature from header
      const hwSignatureRaw = request.headers['x-hw-signature'] as string | undefined;
      let hwSignature: HardwareSignature | undefined;
      if (hwSignatureRaw) {
        try { hwSignature = JSON.parse(hwSignatureRaw); } catch { /* ignore malformed */ }
      }

      // Parse device info from header
      const deviceInfoRaw = request.headers['x-device-info'] as string | undefined;
      let deviceInfo: { browser?: string; os?: string } | undefined;
      if (deviceInfoRaw) {
        try { deviceInfo = JSON.parse(deviceInfoRaw); } catch { /* ignore */ }
      }

      // Read device token from cookie
      const deviceToken = request.cookies?.['_em_device'] || undefined;

      const result = await login(username, password, ip, userAgent, hwSignature, deviceToken, deviceInfo);

      // Set refresh token cookie
      reply.setCookie('refreshToken', result.refreshToken, {
        httpOnly: true,
        secure: process.env['NODE_ENV'] === 'production',
        sameSite: 'strict',
        path: '/api/v1/auth',
        maxAge: 7 * 24 * 60 * 60,
      });

      // Set device token cookie if device was just registered
      const resultAny = result as any;
      if (resultAny._deviceToken) {
        reply.setCookie('_em_device', resultAny._deviceToken, {
          httpOnly: true,
          secure: process.env['NODE_ENV'] === 'production',
          sameSite: 'strict',
          path: '/',
          maxAge: 365 * 24 * 60 * 60, // 1 year
        });
      }

      return reply.send({
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresIn: result.expiresIn,
        user: result.user,
        deviceRegistered: result.deviceRegistered || false,
      });
    } catch (err) {
      if (err instanceof AuthError) {
        // Custom 460 status for device-not-registered
        if (err.statusCode === 460) {
          return reply.code(460).send({
            error: 'ACCESS_DENIED',
            reason: 'device_not_registered',
            message: 'This device is not authorized to access this system.',
          });
        }
        return reply.code(err.statusCode).send({ error: err.message });
      }
      throw err;
    }
  });

  // ─── POST /api/v1/auth/refresh ────────────────────────────────
  fastify.post<{ Body: RefreshBody }>('/api/v1/auth/refresh', async (request, reply) => {
    const refreshToken = request.body?.refreshToken || request.cookies?.['refreshToken'];
    if (!refreshToken) {
      return reply.code(400).send({ error: 'Refresh token required' });
    }

    try {
      const ip = request.ip;
      const userAgent = request.headers['user-agent'] || 'unknown';
      const tokens = await refresh(refreshToken, ip, userAgent);

      reply.setCookie('refreshToken', tokens.refreshToken, {
        httpOnly: true,
        secure: process.env['NODE_ENV'] === 'production',
        sameSite: 'strict',
        path: '/api/v1/auth',
        maxAge: 7 * 24 * 60 * 60,
      });

      return reply.send({
        accessToken: tokens.accessToken,
        expiresIn: tokens.expiresIn,
      });
    } catch (err) {
      if (err instanceof AuthError) {
        return reply.code(err.statusCode).send({ error: err.message });
      }
      throw err;
    }
  });

  // ─── POST /api/v1/auth/logout ─────────────────────────────────
  fastify.post<{ Body: RefreshBody }>('/api/v1/auth/logout', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    const refreshToken = request.body?.refreshToken || request.cookies?.['refreshToken'];
    if (refreshToken && request.user) {
      await logout(refreshToken, request.user.sub, request.ip, request.headers['user-agent'] || 'unknown');
    }
    reply.clearCookie('refreshToken', { path: '/api/v1/auth' });
    return reply.send({ message: 'Logged out' });
  });

  // ─── GET /api/v1/auth/me ──────────────────────────────────────
  fastify.get('/api/v1/auth/me', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    const user = await getUserById(request.user!.sub);
    if (!user) {
      return reply.code(404).send({ error: 'User not found' });
    }
    return reply.send({ user });
  });

  // ─── PATCH /api/v1/auth/profile — Update own profile ──────────
  fastify.patch<{ Body: { displayName?: string; email?: string } }>('/api/v1/auth/profile', {
    preHandler: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        properties: {
          displayName: { type: 'string', minLength: 1 },
          email: { type: 'string', format: 'email' },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const userId = request.user!.sub;
    const { displayName, email } = request.body;

    if (!displayName && !email) {
      return reply.code(400).send({ error: 'Nothing to update' });
    }

    await updateUser(userId, { displayName, email });
    const updated = await getUserById(userId);
    return reply.send({ success: true, user: updated });
  });

  // ─── PATCH /api/v1/auth/password — Change own password ────────
  fastify.patch<{ Body: { currentPassword: string; newPassword: string } }>('/api/v1/auth/password', {
    preHandler: [fastify.authenticate],
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '1 minute',
      },
    },
    schema: {
      body: {
        type: 'object',
        required: ['currentPassword', 'newPassword'],
        properties: {
          currentPassword: { type: 'string' },
          newPassword: { type: 'string', minLength: 8 },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    try {
      const userId = request.user!.sub;
      const { currentPassword, newPassword } = request.body;

      // Input length limits
      if (!newPassword || newPassword.length > 128) {
        return reply.status(400).send({ error: 'Password required (max 128 chars)' });
      }

      // Password complexity validation
      const passwordError = validatePassword(newPassword);
      if (passwordError) {
        return reply.status(400).send({ error: passwordError });
      }

      await verifyAndChangePassword(userId, currentPassword, newPassword);
      return reply.send({ success: true, message: 'Password changed successfully' });
    } catch (err) {
      if (err instanceof AuthError) {
        return reply.code(err.statusCode).send({ error: err.message });
      }
      throw err;
    }
  });
}
