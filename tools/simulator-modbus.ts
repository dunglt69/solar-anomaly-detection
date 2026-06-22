/**
 * EnergiaMind — Modbus TCP Slave Simulator
 * 
 * Acts as a real PV inverter by running a Modbus TCP Server (Slave) on port 5020.
 * Reads sensor data from the simulation CSV and maps values to Modbus holding registers.
 * 
 * The server (Modbus Master) polls these registers just like a real edge gateway
 * would poll a real inverter over Modbus TCP/RTU.
 * 
 * Register Map (Holding Registers):
 *   40001 (addr 0): vdc1 × 10   — DC String 1 Voltage
 *   40002 (addr 1): vdc2 × 10   — DC String 2 Voltage
 *   40003 (addr 2): idc1 × 100  — DC String 1 Current
 *   40004 (addr 3): idc2 × 100  — DC String 2 Current
 *   40005 (addr 4): irr  × 10   — Irradiance
 *   40006 (addr 5): pvt  × 10   — PV Temperature
 * 
 * Usage:
 *   npx tsx tools/simulator-modbus.ts
 *   npx tsx tools/simulator-modbus.ts --fast
 *   npx tsx tools/simulator-modbus.ts --fast --mix-faults
 * 
 * Env vars:
 *   MODBUS_PORT   — TCP port (default: 5020)
 *   INTERVAL_MS   — Row advance interval (default: 5000)
 *   FAST_MODE     — Set to '1' for 200ms interval
 *   MIX_FAULTS    — Set to '1' to interleave faults
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import ModbusRTU from 'modbus-serial';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Config ─────────────────────────────────────────────────────────
const MODBUS_PORT = Number(process.env.MODBUS_PORT || 5020);
const FAST_MODE = process.argv.includes('--fast') || process.env.FAST_MODE === '1';
const MIX_FAULTS = false;
const INTERVAL_MS = FAST_MODE ? 200 : Number(process.env.INTERVAL_MS || 5000);

// ─── Fault label names (per dataset README) ─────────────────────────
const FAULT_NAMES: Record<number, string> = {
  0: 'Normal',
  1: 'Short-Circuit',
  2: 'Degradation',
  3: 'Open Circuit',
  4: 'Shadowing',
};

// ─── Data types ─────────────────────────────────────────────────────
interface SimReading {
  originalIndex: number;
  vdc1: number; vdc2: number;
  idc1: number; idc2: number;
  irr: number; pvt: number;
  faultLabel: number;
}

// ─── Current register values (updated by CSV stepper) ───────────────
const registers: number[] = new Array(6).fill(0);
let currentReading: SimReading | null = null;

// ─── Load simulation CSV ────────────────────────────────────────────
function loadSimulationData(): SimReading[] {
  const csvPath = join(__dirname, 'data', 'simulation.csv');
  console.log(`📂 Loading simulation data from ${csvPath}`);

  const raw = readFileSync(csvPath, 'utf-8');
  const lines = raw.trim().split('\n');
  const headers = lines[0]!.split(',').map(h => h.trim());

  const expected = ['vdc1', 'vdc2', 'idc1', 'idc2', 'irr', 'pvt', 'f_nv', 'original_index'];
  const missing = expected.filter(h => !headers.includes(h));
  if (missing.length > 0) {
    console.error(`Missing CSV columns: ${missing.join(', ')}. Found: ${headers.join(', ')}`);
    process.exit(1);
  }

  const colIdx = Object.fromEntries(headers.map((h, i) => [h, i]));
  const data: SimReading[] = [];

  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i]!.split(',').map(Number);
    data.push({
      originalIndex: vals[colIdx['original_index']!]!,
      vdc1: vals[colIdx['vdc1']!]!,
      vdc2: vals[colIdx['vdc2']!]!,
      idc1: vals[colIdx['idc1']!]!,
      idc2: vals[colIdx['idc2']!]!,
      irr: vals[colIdx['irr']!]!,
      pvt: vals[colIdx['pvt']!]!,
      faultLabel: vals[colIdx['f_nv']!]!,
    });
  }

  console.log(`   Loaded ${data.length.toLocaleString()} readings`);

  // Distribution
  const dist: Record<number, number> = {};
  for (const row of data) {
    dist[row.faultLabel] = (dist[row.faultLabel] || 0) + 1;
  }
  for (const [label, count] of Object.entries(dist).sort(([a], [b]) => Number(a) - Number(b))) {
    const pct = ((count / data.length) * 100).toFixed(2);
    console.log(`   ${FAULT_NAMES[Number(label)] || label}: ${count.toLocaleString()} (${pct}%)`);
  }

  return data;
}

// ─── Main ───────────────────────────────────────────────────────────
async function main() {
  console.log(`
==================================================
  EnergiaMind — Modbus TCP Slave Simulator
--------------------------------------------------
  Protocol:  Modbus TCP (Slave / Server)
  Port:      ${MODBUS_PORT}
  Rate:      Every ${INTERVAL_MS / 1000}s${FAST_MODE ? ' (FAST MODE)' : ''}
  Faults:    Realtime synchronized (as in dataset)
  Registers: 6 holding registers (40001–40006)
==================================================
`);

  const readings = loadSimulationData();
  // ─── Simulate ~2% Modbus Exception Response ─────────────────────
  let simulateModbusException = false;

  let boundaryIndex = -1;

  function getReadingForTimeAndIndex(readings: SimReading[], date: Date = new Date()): { reading: SimReading; index: number } {
    if (boundaryIndex === -1) {
      boundaryIndex = readings.findIndex(r => r.originalIndex >= 1288619);
      if (boundaryIndex === -1) {
        boundaryIndex = Math.floor(readings.length / 2);
      }
    }

    const virtualDayIndex = (date.getDate() - 1) % 2; // 0 for Day 15, 1 for Day 16
    const hours = date.getHours();
    const minutes = date.getMinutes();
    const seconds = date.getSeconds();
    const secondOfDay = hours * 3600 + minutes * 60 + seconds;

    let finalIndex: number;
    if (virtualDayIndex === 0) {
      // Day 15
      finalIndex = Math.min(secondOfDay, boundaryIndex - 1);
    } else {
      // Day 16
      finalIndex = boundaryIndex + Math.min(secondOfDay, readings.length - boundaryIndex - 1);
    }

    finalIndex = Math.max(0, Math.min(readings.length - 1, finalIndex));
    return {
      reading: readings[finalIndex]!,
      index: finalIndex,
    };
  }

  // ─── Modbus TCP Server (Slave) using vector API ─────────────────
  const vector = {
    getHoldingRegister: (addr: number, unitID: number, callback: (err: any, value: number) => void) => {
      // Simulate ~2% Modbus Exception / comms error
      if (simulateModbusException) {
        callback(new Error('Slave device failure (0x04)'), 0);
        return;
      }
      callback(null, registers[addr] ?? 0);
    },
  };

  const server = new ModbusRTU.ServerTCP(vector, {
    host: '0.0.0.0',
    port: MODBUS_PORT,
    debug: false,
    unitID: 1,
  });

  server.on('socketError', (err: Error) => {
    if ((err as any).code === 'ECONNRESET') return; // Ignore client disconnects
    console.error('  ⚠️  [Modbus Server] Socket error:', err.message);
  });

  console.log(`\n📡 Modbus TCP Slave listening on 0.0.0.0:${MODBUS_PORT}`);
  console.log(`   Waiting for Master to connect...\n`);

  // ─── CSV stepper — advance registers every INTERVAL_MS ──────────
  let stats = { total: 0, faults: 0, exceptionErrors: 0 };

  setInterval(() => {
    // ~2% Modbus Exception response simulation
    if (Math.random() < 0.02) {
      simulateModbusException = true;
      stats.exceptionErrors++;
      console.log('  ⚠️  [Modbus] Exception response (0x04) — next poll will receive error response');

      // Clear exception error after a short delay (before next poll)
      setTimeout(() => { simulateModbusException = false; }, Math.min(INTERVAL_MS / 2, 2000));
      return;
    }
    simulateModbusException = false;

    const { reading, index } = getReadingForTimeAndIndex(readings);
    currentReading = reading;

    // Map sensor values to registers with scale factors
    registers[0] = Math.round(reading.vdc1 * 10);   // vdc1 × 10
    registers[1] = Math.round(reading.vdc2 * 10);   // vdc2 × 10
    registers[2] = Math.round(reading.idc1 * 100);  // idc1 × 100
    registers[3] = Math.round(reading.idc2 * 100);  // idc2 × 100
    registers[4] = Math.round(reading.irr * 10);    // irr × 10
    registers[5] = Math.round(reading.pvt * 10);    // pvt × 10

    stats.total++;
    if (reading.faultLabel > 0) stats.faults++;

    const pdc = reading.vdc1 * reading.idc1 + reading.vdc2 * reading.idc2;
    const groundTruth = FAULT_NAMES[reading.faultLabel] || `Unknown(${reading.faultLabel})`;
    
    const isNight = reading.irr === 0 && reading.vdc1 === 0;
    const marker = isNight ? '🌙 NIGHT' : (reading.faultLabel > 0 ? `⚡FAULT[${reading.faultLabel}]` : '✅ OK');

    console.log(
      `[${new Date().toLocaleTimeString('en-US', { hour12: false })}] ` +
      `#${index.toString().padStart(6)}/${readings.length} | ` +
      `${marker.padEnd(14)} | ` +
      `${pdc.toFixed(0).padStart(6)}W | ` +
      `V1=${reading.vdc1.toFixed(1)} V2=${reading.vdc2.toFixed(1)} | ` +
      `I1=${reading.idc1.toFixed(2)} I2=${reading.idc2.toFixed(2)} | ` +
      `Irr=${reading.irr.toFixed(0)} PVT=${reading.pvt.toFixed(1)} | ` +
      `Regs=[${registers.join(',')}] | ` +
      `GT: ${groundTruth}`
    );
  }, INTERVAL_MS);

  // ─── Graceful shutdown ──────────────────────────────────────────
  process.on('SIGINT', () => {
    console.log(`\n⏹️  Modbus Slave stopped. Total=${stats.total}, Faults=${stats.faults}, Exceptions=${stats.exceptionErrors}`);
    server.close(() => process.exit(0));
  });
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
