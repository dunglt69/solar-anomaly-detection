import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import { setBroadcast } from '../routes/telemetry.js';
import { verifyAccessToken } from '../services/auth.service.js';

const clients = new Set<WebSocket>();

/** Module-level broadcast — usable by any service (e.g. Modbus poller) */
export function wsBroadcast(data: unknown) {
  const message = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(message);
    }
  }
}

async function wsPlugin(fastify: FastifyInstance) {
  await fastify.register(websocket, {
    options: {
      maxPayload: 1024 * 64,
      handleProtocols: () => false, // Do not reflect secret bearer subprotocol in response header
    }
  });

  // Register broadcast function with telemetry routes
  setBroadcast(wsBroadcast);

  // WebSocket route — authenticates via token query parameter or bearer subprotocol
  fastify.get('/ws/telemetry', { 
    websocket: true,
    config: {
      rateLimit: {
        max: 30,
        timeWindow: '1 minute'
      }
    }
  }, async (socket, request) => {
    // 1. Extract token from query parameter (recommended per OWASP WebSocket guidelines)
    const queryToken = (request.query as { token?: string })?.token;
    
    // 2. Fallback to Sec-WebSocket-Protocol header for backward compatibility
    const protocol = request.headers['sec-websocket-protocol'] as string | undefined;
    const headerToken = protocol?.startsWith('bearer-') ? protocol.slice(7) : null;

    const token = queryToken || headerToken;

    if (!token) {
      socket.send(JSON.stringify({ type: 'error', message: 'Missing authentication token' }));
      socket.close(1008, 'Missing authentication token');
      return;
    }

    try {
      await verifyAccessToken(token);
    } catch {
      socket.send(JSON.stringify({ type: 'error', message: 'Invalid or expired token' }));
      socket.close(1008, 'Invalid or expired token');
      return;
    }

    clients.add(socket);
    fastify.log.info(`WebSocket client connected (total: ${clients.size})`);

    // Periodic token re-validation (every 10 minutes)
    const revalidateInterval = setInterval(async () => {
      try {
        await verifyAccessToken(token);
      } catch {
        fastify.log.warn('WebSocket client token expired, closing connection');
        socket.close(1008, 'Token expired');
      }
    }, 10 * 60 * 1000);

    socket.on('close', () => {
      clearInterval(revalidateInterval);
      clients.delete(socket);
      fastify.log.info(`WebSocket client disconnected (total: ${clients.size})`);
    });

    socket.on('error', () => {
      clearInterval(revalidateInterval);
      clients.delete(socket);
    });

    // Send a welcome message
    socket.send(JSON.stringify({
      type: 'connected',
      clients: clients.size,
      timestamp: new Date().toISOString(),
    }));
  });
}

export default fp(wsPlugin, {
  name: 'websocket-telemetry',
  fastify: '5.x',
});

export { clients };
