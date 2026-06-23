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
      handleProtocols: (protocols: Set<string> | string[]) => {
        const list = protocols instanceof Set ? [...protocols] : protocols;
        const bearer = list.find((p: string) => p.startsWith('bearer-'));
        return bearer || false;
      }
    }
  });

  // Register broadcast function with telemetry routes
  setBroadcast(wsBroadcast);

  // WebSocket route — requires ?token=<JWT> for authentication
  fastify.get('/ws/telemetry', { 
    websocket: true,
    config: {
      rateLimit: {
        max: 30,
        timeWindow: '1 minute'
      }
    }
  }, async (socket, request) => {
    // BUG-009: Support token via subprotocol (bearer-<token>) in addition to query param
    const url = new URL(request.url, `https://${request.headers.host || 'localhost'}`);
    const protocol = request.headers['sec-websocket-protocol'] as string | undefined;
    const token = url.searchParams.get('token') || (protocol?.startsWith('bearer-') ? protocol.slice(7) : null);

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

    socket.on('close', () => {
      clients.delete(socket);
      fastify.log.info(`WebSocket client disconnected (total: ${clients.size})`);
    });

    socket.on('error', () => {
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
