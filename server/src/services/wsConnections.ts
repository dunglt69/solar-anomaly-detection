import type { WebSocket } from 'ws';

/**
 * Shared WebSocket connection tracker.
 * Decoupled from websocket.ts and auth.service.ts to avoid circular dependencies.
 */
const userConnections = new Map<string, Set<WebSocket>>();

/** Track a WebSocket connection for a user */
export function trackUserConnection(userId: string, socket: WebSocket): void {
  if (!userConnections.has(userId)) {
    userConnections.set(userId, new Set());
  }
  userConnections.get(userId)!.add(socket);
}

/** Remove a WebSocket connection for a user */
export function untrackUserConnection(userId: string, socket: WebSocket): void {
  const sockets = userConnections.get(userId);
  if (sockets) {
    sockets.delete(socket);
    if (sockets.size === 0) userConnections.delete(userId);
  }
}

/**
 * Close all WebSocket connections for a specific user.
 * Called by auth.service on logout/session revocation.
 */
export function closeUserConnections(userId: string): void {
  const sockets = userConnections.get(userId);
  if (sockets) {
    for (const socket of sockets) {
      try {
        socket.send(JSON.stringify({ type: 'error', message: 'Session terminated' }));
        socket.close(1008, 'Session terminated');
      } catch {
        // Socket may already be closed
      }
    }
    userConnections.delete(userId);
  }
}
