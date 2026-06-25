import 'dotenv/config';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import Fastify, { FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import underPressure from '@fastify/under-pressure';
import authPlugin from './plugins/auth.js';
import wsPlugin from './plugins/websocket.js';
import authRoutes from './routes/auth.js';
import healthRoutes from './routes/health.js';
import telemetryRoutes from './routes/telemetry.js';
import alertRoutes from './routes/alerts.js';
import ticketRoutes from './routes/tickets.js';
import adminRoutes from './routes/admin.js';
import analyticsRoutes from './routes/analytics.js';
import configRoutes from './routes/config.js';
import { aiService } from './services/ai.service.js';
import { client as dbClient } from './db/index.js';

const PORT = Number(process.env['PORT'] || 3000);
const HOST = process.env['HOST'] || '127.0.0.1';

async function main() {
  const app = Fastify({
    trustProxy: true, // Parse proxy headers like CF-Connecting-IP / X-Forwarded-For
    logger: {
      level: process.env['LOG_LEVEL'] || 'info',
      redact: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-csrf-token"]',
        'body.password',
        'body.newPassword',
        'body.currentPassword',
        'body.refreshToken',
      ],
      transport: process.env['NODE_ENV'] !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
    },
  });

  // Production Gatekeeper Checks
  const isProd = process.env['NODE_ENV'] === 'production';
  if (isProd) {
    const jwtSec = process.env['JWT_SECRET'];
    const cookieSec = process.env['COOKIE_SECRET'];
    // Reject missing, too-short, or default-pattern secrets without revealing actual values
    if (!jwtSec || jwtSec.length < 32 || jwtSec.startsWith('energiamind-')) {
      app.log.error('CRITICAL SECURITY ERROR: JWT_SECRET is missing, too short (<32 chars), or uses a default value. Server shutting down.');
      process.exit(1);
    }
    if (!cookieSec || cookieSec.length < 16 || cookieSec.startsWith('energiamind-')) {
      app.log.error('CRITICAL SECURITY ERROR: COOKIE_SECRET is missing, too short (<16 chars), or uses a default value. Server shutting down.');
      process.exit(1);
    }

    // CORS Check
    const corsOrigin = process.env['CORS_ORIGIN'] || '';
    if (corsOrigin.includes('localhost') || corsOrigin.includes('127.0.0.1')) {
      app.log.warn('SECURITY WARNING: CORS_ORIGIN is configured to localhost in production mode.');
    }
  }

  // Security Plugins
  await app.register(helmet, {
    contentSecurityPolicy: isProd ? {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "https://challenges.cloudflare.com", "https://static.cloudflareinsights.com"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        imgSrc: ["'self'", "data:", "blob:"],
        fontSrc: ["'self'", "data:", "https://fonts.gstatic.com"],
        connectSrc: ["'self'", "ws:", "wss:", "https://challenges.cloudflare.com"], // Allow websockets & Turnstile verify
        frameSrc: ["'self'", "https://challenges.cloudflare.com"], // Allow Turnstile iframe
        objectSrc: ["'none'"],
      }
    } : false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: isProd ? { policy: 'same-origin' } : false,
  });

  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
    allowList: (req: FastifyRequest) => {
      // Allow bypass for local requests (development/local scanning)
      const ip = req.ip;
      if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') {
        return true;
      }
      const bypassKey = process.env['RATE_LIMIT_BYPASS_KEY'];
      if (bypassKey && req.headers['x-bypass-rate-limit'] === bypassKey) {
        return true;
      }
      return false;
    },
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Try again in ${context.after}.`,
    }),
  });

  // DDoS & Resource exhaustion protection
  await app.register(underPressure, {
    maxEventLoopDelay: 5000,
    maxHeapUsedBytes: 2 * 1024 * 1024 * 1024, // 2GB
    maxRssBytes: 3.0 * 1024 * 1024 * 1024, // 3GB
  });

  await app.register(cors, {
    origin: process.env['CORS_ORIGIN'] || 'http://localhost:5173',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  await app.register(cookie, {
    secret: process.env['COOKIE_SECRET'] || 'dev-cookie-secret-' + Date.now(),
  });

  await app.register(authPlugin);
  await app.register(wsPlugin);

  app.addHook('onReady', async () => {
    const { cleanupExpiredSessions } = await import('./services/auth.service.js');
    const cleanup = async () => {
      try {
        const count = await cleanupExpiredSessions();
        if (count > 0) app.log.info(`Cleaned up ${count} expired session(s)`);
      } catch (err) {
        app.log.error(err, 'Session cleanup failed');
      }
    };
    await cleanup();
    setInterval(cleanup, 60 * 60 * 1000);
  });

  // Routes
  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(telemetryRoutes);
  await app.register(alertRoutes);
  await app.register(ticketRoutes);
  await app.register(adminRoutes);
  await app.register(analyticsRoutes);
  await app.register(configRoutes);

  // Serve React SPA client static files
  const clientDistPath = join(__dirname, '..', '..', 'client', 'dist');
  
  // Serve assets from client/dist/assets with wildcard: true
  await app.register(fastifyStatic, {
    root: join(clientDistPath, 'assets'),
    prefix: '/assets/',
    wildcard: true,
    decorateReply: false,
  });

  // Serve root static files (favicon, manifest, etc.) from client/dist with wildcard: false
  await app.register(fastifyStatic, {
    root: clientDistPath,
    prefix: '/',
    wildcard: false,
    decorateReply: true, // keep decorateReply on the main one or default
  });

  // Client SPA fallback
  app.get('/*', async (request, reply) => {
    const url = request.url.split('?')[0] || '';
    if (
      url.startsWith('/api') || 
      url.startsWith('/ws') || 
      (url.includes('.') && !url.endsWith('/index.html'))
    ) {
      reply.code(404).send({ error: 'Not Found' });
      return;
    }
    return reply.sendFile('index.html');
  });

  // Graceful shutdown
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  for (const signal of signals) {
    process.on(signal, async () => {
      app.log.info(`Received ${signal}, shutting down...`);
      await app.close();
      process.exit(0);
    });
  }

  // Start
  try {
    // Initialize AI model (InceptionTime)
    const aiLoaded = await aiService.initialize();
    if (aiLoaded) {
      app.log.info('InceptionTime ONNX model loaded — AI detection active (99.8% accuracy)');
    } else {
      app.log.warn('AI model not found — running with domain rules only');
    }

    // Migrate old 'lstm' detection layer values to 'ai'
    try {
      const result = await dbClient.execute("UPDATE alerts SET detection_layer = 'ai' WHERE detection_layer = 'lstm'");
      if (result.rowsAffected > 0) {
        app.log.info(`Migrated ${result.rowsAffected} alert(s): detection_layer 'lstm' → 'ai'`);
      }
    } catch { /* table may not exist yet */ }

    // Sync open tickets whose alerts are already acknowledged
    try {
      const result = await dbClient.execute(`
        UPDATE tickets 
        SET status = 'acknowledged', updated_at = ? 
        WHERE status = 'open' 
          AND alert_id IN (SELECT id FROM alerts WHERE acknowledged = 1)
      `, [Date.now()]);
      if (result.rowsAffected > 0) {
        app.log.info(`Synchronized ${result.rowsAffected} open ticket(s) to 'acknowledged' state`);
      }
    } catch (err) {
      app.log.error(err, 'Failed to sync open tickets');
    }

    await app.listen({ port: PORT, host: HOST });
    app.log.info(`EnergiaMind API running at ${HOST}:${PORT}`);

    // ─── Optional Modbus TCP Master ──────────────────────────────────
    if (process.env['MODBUS_ENABLED'] === '1') {
      const { startModbusPoller } = await import('./services/modbus.service.js');
      const { wsBroadcast } = await import('./plugins/websocket.js');
      startModbusPoller({
        host: process.env['MODBUS_HOST'] || '127.0.0.1',
        port: Number(process.env['MODBUS_PORT'] || 5020),
        interval: Number(process.env['MODBUS_POLL_MS'] || 5000),
        broadcastFn: wsBroadcast,
      }).catch(err => app.log.error(err, '[Modbus] Failed to start poller'));
    }
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
