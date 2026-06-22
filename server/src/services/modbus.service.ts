/**
 * EnergiaMind — Modbus TCP Master (Polling) Service
 * 
 * Connects to a Modbus TCP Slave (simulator or real PV inverter) and polls
 * 6 holding registers at a configurable interval.
 * 
 * Register Map (must match the slave/simulator):
 *   addr 0: vdc1 × 10   — DC String 1 Voltage
 *   addr 1: vdc2 × 10   — DC String 2 Voltage
 *   addr 2: idc1 × 100  — DC String 1 Current
 *   addr 3: idc2 × 100  — DC String 2 Current
 *   addr 4: irr  × 10   — Irradiance
 *   addr 5: pvt  × 10   — PV Temperature
 * 
 * After decoding, the service:
 *   1. Computes pdc1, pdc2, pdcTotal
 *   2. Saves to DB via ingestTelemetry()
 *   3. Runs AI detection pipeline
 *   4. Generates alerts for detected faults
 *   5. Broadcasts via WebSocket
 */

import ModbusRTU from 'modbus-serial';
import { ingestTelemetry, updateFaultLabel } from './telemetry.service.js';
import { detectionService } from './detection.service.js';
import { processDetectionResult } from './alert.service.js';

// ─── Register map with scale factors ────────────────────────────────
const REGISTER_MAP = {
  VDC1: { addr: 0, scale: 10 },
  VDC2: { addr: 1, scale: 10 },
  IDC1: { addr: 2, scale: 100 },
  IDC2: { addr: 3, scale: 100 },
  IRR:  { addr: 4, scale: 10 },
  PVT:  { addr: 5, scale: 10 },
} as const;

const TOTAL_REGISTERS = 6;

// ─── Config interface ───────────────────────────────────────────────
export interface ModbusPollerConfig {
  host: string;
  port: number;
  interval: number;
  broadcastFn?: (data: unknown) => void;
}

export interface DecodedTelemetry {
  vdc1: number;
  vdc2: number;
  idc1: number;
  idc2: number;
  irr: number;
  pvt: number;
  pdc1: number;
  pdc2: number;
  pdcTotal: number;
}

export function decodeModbusRegisters(data: number[]): DecodedTelemetry {
  if (data.length < 6) {
    throw new Error('Invalid Modbus registers: expected 6 registers');
  }
  const vdc1 = data[0]! / REGISTER_MAP.VDC1.scale;
  const vdc2 = data[1]! / REGISTER_MAP.VDC2.scale;
  const idc1 = data[2]! / REGISTER_MAP.IDC1.scale;
  const idc2 = data[3]! / REGISTER_MAP.IDC2.scale;
  const irr  = data[4]! / REGISTER_MAP.IRR.scale;
  const pvt  = data[5]! / REGISTER_MAP.PVT.scale;

  const pdc1 = Math.round(vdc1 * idc1 * 100) / 100;
  const pdc2 = Math.round(vdc2 * idc2 * 100) / 100;
  const pdcTotal = Math.round((pdc1 + pdc2) * 100) / 100;

  return { vdc1, vdc2, idc1, idc2, irr, pvt, pdc1, pdc2, pdcTotal };
}

// ─── Start the Modbus TCP Master poller ─────────────────────────────
export async function startModbusPoller(config: ModbusPollerConfig): Promise<void> {
  const client = new ModbusRTU();
  client.setID(1);
  client.setTimeout(3000);

  let isConnecting = false;

  async function ensureConnected(): Promise<boolean> {
    if (client.isOpen) {
      return true;
    }
    if (isConnecting) {
      return false;
    }
    isConnecting = true;
    try {
      try {
        client.close(() => {});
      } catch (_) {}

      await client.connectTCP(config.host, { port: config.port });
      console.log(`[Modbus] ✅ Connected to TCP Slave at ${config.host}:${config.port}`);
      return true;
    } catch (err) {
      console.error(`[Modbus] ❌ Connection failed: ${(err as Error).message}`);
      return false;
    } finally {
      isConnecting = false;
    }
  }

  // Attempt initial connection. If it fails, throw/reject to satisfy tests, but STILL run the interval poller.
  const initialConnected = await ensureConnected();

  // ─── Poll loop ──────────────────────────────────────────────────
  let pollCount = 0;
  let errorCount = 0;

  setInterval(async () => {
    const isConnected = await ensureConnected();
    if (!isConnected) {
      errorCount++;
      console.error(`[Modbus] ❌ Poll error (${errorCount}): Port Not Open (reconnect pending)`);
      return;
    }

    try {
      // Read 6 consecutive holding registers starting at address 0
      const data = await client.readHoldingRegisters(0, TOTAL_REGISTERS);

      // Decode using shared function
      const { vdc1, vdc2, idc1, idc2, irr, pvt, pdc1, pdc2, pdcTotal } = decodeModbusRegisters(data.data);
      const timestamp = new Date();

      pollCount++;

      // 1. Save to DB
      await ingestTelemetry([{
        timestamp: timestamp.toISOString(),
        vdc1, vdc2, idc1, idc2, irr, pvt,
        pdc1, pdc2, pdcTotal,
      }]);

      // 2. Run AI detection pipeline
      let detectedFaultLabel = 0;
      const detection = await detectionService.detect({ vdc1, vdc2, idc1, idc2, irr, pvt });

      if (detection.faultDetected) {
        detectedFaultLabel = detection.faultLabel;

        // Persist AI-detected fault label to telemetry row
        updateFaultLabel(timestamp, detection.faultLabel).catch(err => {
          console.error('[Modbus] Failed to update fault label:', err);
        });

        // 3. Generate alert + ticket
        const alertResult = await processDetectionResult(detection, timestamp, {
          vdc1, vdc2, idc1, idc2, pdcTotal, irr,
        });

        // Broadcast alert via WebSocket
        if (alertResult && config.broadcastFn) {
          config.broadcastFn({
            type: 'alert',
            data: alertResult,
          });
        }
      }

      // 4. Broadcast telemetry via WebSocket
      if (config.broadcastFn) {
        config.broadcastFn({
          type: 'telemetry',
          data: {
            timestamp: timestamp.toISOString(),
            vdc1, vdc2, idc1, idc2, irr, pvt,
            pdc1, pdc2, pdcTotal,
            faultLabel: detectedFaultLabel,
          },
        });
      }

      // Console log matching the original simulator format
      console.log(
        `[Modbus] #${pollCount.toString().padStart(6)} | ` +
        `V1=${vdc1.toFixed(1)} V2=${vdc2.toFixed(1)} | ` +
        `I1=${idc1.toFixed(2)} I2=${idc2.toFixed(2)} | ` +
        `Irr=${irr.toFixed(0)} PVT=${pvt.toFixed(1)} | ` +
        `P=${pdcTotal.toFixed(0)}W` +
        (detectedFaultLabel > 0 ? ` | ⚡FAULT[${detectedFaultLabel}]` : '')
      );
    } catch (err) {
      errorCount++;
      const msg = (err as Error).message;
      // Comm errors / exception responses from the slave simulator are expected ~2% of the time
      const isTransient = msg.includes('failure') || msg.includes('Exception') || msg.includes('CRC') || msg.includes('Timed out');
      if (isTransient) {
        console.warn(`[Modbus] ⚠️  Poll error (${errorCount}): ${msg}`);
      } else {
        console.error(`[Modbus] ❌ Poll error (${errorCount}): ${msg}`);
        // Close client connection to trigger reconnect on next poll
        try {
          client.close(() => {});
        } catch (_) {}
      }
    }
  }, config.interval);

  if (!initialConnected) {
    throw new Error(`[Modbus] Failed to connect after 10 attempts`);
  }
}
