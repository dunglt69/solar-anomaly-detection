import type { FastifyInstance } from 'fastify';
import {
  ingestTelemetry,
  queryTelemetry,
  getLatestTelemetry,
  getTelemetryKPIs,
  getDailyYieldToday,
  getAggregatedTelemetry,
  getDataRange,
  updateFaultLabel,
  FAULT_LABELS,
  type TelemetryInput,
  type TelemetryQuery,
} from '../services/telemetry.service.js';
import { processDetectionResult } from '../services/alert.service.js';
import { detectionService } from '../services/detection.service.js';

// Broadcast callback — set by WebSocket plugin
let broadcastFn: ((data: unknown) => void) | null = null;
export function setBroadcast(fn: (data: unknown) => void) {
  broadcastFn = fn;
}

export default async function telemetryRoutes(fastify: FastifyInstance) {
  // ─── POST /api/v1/telemetry — Batch ingest ─────────────────────
  fastify.post<{ Body: TelemetryInput[] }>('/api/v1/telemetry', {
    preHandler: [fastify.authenticate],
    schema: {
      body: {
        type: 'array',
        minItems: 1,
        maxItems: 1000,
        items: {
          type: 'object',
          required: ['timestamp', 'vdc1', 'vdc2', 'idc1', 'idc2', 'irr', 'pvt'],
          properties: {
            timestamp: { oneOf: [{ type: 'string' }, { type: 'number' }] },
            vdc1: { type: 'number' },
            vdc2: { type: 'number' },
            idc1: { type: 'number' },
            idc2: { type: 'number' },
            irr: { type: 'number' },
            pvt: { type: 'number' },
            pdc1: { type: 'number' },
            pdc2: { type: 'number' },
            pdcTotal: { type: 'number' },
            faultLabel: { type: 'number' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const result = await ingestTelemetry(request.body);
    console.log(`[Telemetry Ingest] body length: ${request.body.length}, broadcastFn exists: ${!!broadcastFn}`);


    // ─── Run AI Detection Pipeline for EVERY reading ────────────────
    // Whether batch (many readings) or single, each reading goes through
    // the 3-layer AI detection pipeline (Z-score → Rules → InceptionTime).
    // This ensures confidence scores are always real, never faked.
    for (const point of request.body) {
      const pdc1 = point.pdc1 ?? point.vdc1 * point.idc1;
      const pdc2 = point.pdc2 ?? point.vdc2 * point.idc2;
      const pdcT = pdc1 + pdc2;

      let detectedFaultLabel = 0;
      try {
        const detection = await detectionService.detect({
          vdc1: point.vdc1,
          vdc2: point.vdc2,
          idc1: point.idc1,
          idc2: point.idc2,
          irr: point.irr,
          pvt: point.pvt,
        });

        if (detection.faultDetected) {
          detectedFaultLabel = detection.faultLabel;
          // Persist AI-detected fault label back to telemetry row
          const ts = new Date(point.timestamp);
          updateFaultLabel(ts, detection.faultLabel).catch(err => fastify.log.error(err, 'Failed to update fault label'));

          const alertResult = await processDetectionResult(
            detection,
            ts,
            {
              vdc1: point.vdc1, vdc2: point.vdc2,
              idc1: point.idc1, idc2: point.idc2,
              pdcTotal: pdcT, irr: point.irr,
            }
          );
          if (alertResult && broadcastFn) {
            broadcastFn({
              type: 'alert',
              data: alertResult,
            });
          }
        }
      } catch (err) {
        fastify.log.error({ err }, 'Detection pipeline error');
      }

      // Broadcast real-time telemetry with AI-detected fault label
      if (broadcastFn) {
        broadcastFn({
          type: 'telemetry',
          data: {
            timestamp: point.timestamp,
            vdc1: point.vdc1, vdc2: point.vdc2,
            idc1: point.idc1, idc2: point.idc2,
            irr: point.irr, pvt: point.pvt,
            pdc1: Math.round(pdc1 * 100) / 100,
            pdc2: Math.round(pdc2 * 100) / 100,
            pdcTotal: Math.round(pdcT * 100) / 100,
            faultLabel: detectedFaultLabel,
          },
        });
      }
    }

    return reply.send(result);
  });

  // ─── GET /api/v1/telemetry — Query ────────────────────────────
  fastify.get<{ Querystring: TelemetryQuery }>('/api/v1/telemetry', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    const rows = await queryTelemetry(request.query);
    return reply.send({ data: rows, count: rows.length });
  });

  // ─── GET /api/v1/telemetry/latest ─────────────────────────────
  fastify.get<{ Querystring: { n?: string } }>('/api/v1/telemetry/latest', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    const n = Math.min(Number(request.query.n) || 200, 86400);
    const rows = await getLatestTelemetry(n);
    return reply.send({ data: rows.reverse(), count: rows.length });
  });

  // ─── GET /api/v1/telemetry/aggregated ─────────────────────────
  // Interval-based aggregation like TradingView/Grafana
  // ?interval=1h|6h|1d|3d|1w&from=ISO&to=ISO
  fastify.get<{ Querystring: { interval?: string; from?: string; to?: string } }>('/api/v1/telemetry/aggregated', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    const { interval = '1h', from, to } = request.query;
    const data = await getAggregatedTelemetry(interval, from, to);
    return reply.send({ data, count: data.length, interval });
  });

  // ─── GET /api/v1/telemetry/data-range ─────────────────────────
  // Returns the earliest and latest timestamp in the database
  fastify.get('/api/v1/telemetry/data-range', {
    preHandler: [fastify.authenticate],
  }, async (_request, reply) => {
    const range = await getDataRange();
    return reply.send(range);
  });

  // ─── GET /api/v1/telemetry/kpis ───────────────────────────────
  fastify.get<{ Querystring: { from?: string; to?: string } }>('/api/v1/telemetry/kpis', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    const kpis = await getTelemetryKPIs(request.query.from, request.query.to);
    return reply.send(kpis);
  });

  // ─── GET /api/v1/telemetry/daily-yield-today ──────────────────
  fastify.get('/api/v1/telemetry/daily-yield-today', {
    preHandler: [fastify.authenticate],
  }, async (_request, reply) => {
    const result = await getDailyYieldToday();
    return reply.send(result);
  });
}
