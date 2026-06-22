import type { FastifyInstance } from 'fastify';
import { detectionService } from '../services/detection.service.js';

export default async function healthRoutes(fastify: FastifyInstance) {
  fastify.get('/api/health', async () => {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  });

  // AI Detection status
  fastify.get('/api/v1/detection-status', {
    preHandler: [fastify.authenticate],
  }, async () => {
    return detectionService.getStatus();
  });
}
