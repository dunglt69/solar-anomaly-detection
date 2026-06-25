/**
 * EnergiaMind AI-Driven Telemetry Simulator
 * 
 * Reads from the held-out 10% simulation dataset (tools/data/simulation.csv)
 * and injects readings one-by-one, simulating real sensor data collection.
 * 
 * Simulates the real-world data path:
 *   Solar Panel → Modbus RS485 → Edge Gateway Buffer → HTTP POST → Server
 * 
 * The server's 3-layer AI pipeline (Z-score -> Domain Rules -> InceptionTime)
 * detects faults from raw readings. Ground-truth labels are kept locally
 * for validation comparison only.
 * 
 * Usage: npx tsx tools/simulator.ts
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const API_URL = process.env.API_URL || 'http://localhost:3000';
const FAST_MODE = process.argv.includes('--fast') || process.env.FAST_MODE === '1';
const MIX_FAULTS = false;
const INTERVAL_MS = FAST_MODE ? 200 : Number(process.env.INTERVAL_MS || 1000);
const BATCH_SIZE = FAST_MODE ? 5 : Number(process.env.BATCH_SIZE || 1);
const AUTH_USER = process.env.AUTH_USER || 'admin';
const AUTH_PASS = process.env.AUTH_PASS;

// ─── Correct fault names per dataset README ─────────────────────────
const FAULT_NAMES: Record<number, string> = {
  0: 'Normal',
  1: 'Short-Circuit',   // CORRECT: 1 = Short-Circuit
  2: 'Degradation',
  3: 'Open Circuit',    // CORRECT: 3 = Open Circuit
  4: 'Shadowing',
};

// ─── Simulation CSV columns: original_index, vdc1, vdc2, idc1, idc2, irr, pvt, f_nv ─
interface SimReading {
  originalIndex: number;
  vdc1: number; vdc2: number;
  idc1: number; idc2: number;
  irr: number; pvt: number;
  faultLabel: number;
}

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

// ─── Modbus RS485 Register Abstraction ──────────────────────────────
// Simulates reading from Modbus holding registers of inverter/sensors
class ModbusDevice {
  private readings: SimReading[];
  private lastIndex = 0;

  constructor(readings: SimReading[]) {
    this.readings = readings;
  }

  /** Read holding registers — simulates actual Modbus read (addr, count) */
  readRegisters(): SimReading | null {
    // Simulate ~2% comms failure rate
    if (Math.random() < 0.02) {
      console.log('  ⚠️  [Modbus] Communication failure — retrying...');
      return null;
    }

    const { reading, index } = getReadingForTimeAndIndex(this.readings);
    this.lastIndex = index;
    return reading;
  }

  get position() { return this.lastIndex; }
  get total() { return this.readings.length; }
}

// ─── Edge Gateway Buffer ────────────────────────────────────────────
// Collects readings from Modbus and flushes to server in batches
class EdgeGateway {
  private buffer: Array<{
    timestamp: string;
    vdc1: number; vdc2: number;
    idc1: number; idc2: number;
    irr: number; pvt: number;
    pdc1: number; pdc2: number; pdcTotal: number;
  }> = [];
  private readonly batchSize: number;

  constructor(batchSize: number) {
    this.batchSize = batchSize;
  }

  /** Add a reading to the edge buffer */
  addReading(reading: SimReading): void {
    const pdc1 = reading.vdc1 * reading.idc1;
    const pdc2 = reading.vdc2 * reading.idc2;

    this.buffer.push({
      timestamp: new Date().toISOString(),
      vdc1: reading.vdc1,
      vdc2: reading.vdc2,
      idc1: reading.idc1,
      idc2: reading.idc2,
      irr: reading.irr,
      pvt: reading.pvt,
      pdc1: Math.round(pdc1 * 100) / 100,
      pdc2: Math.round(pdc2 * 100) / 100,
      pdcTotal: Math.round((pdc1 + pdc2) * 100) / 100,
      // faultLabel intentionally NOT sent — AI detects from raw data
    });
  }

  /** Flush buffer if batch is full */
  flush(): typeof this.buffer | null {
    if (this.buffer.length >= this.batchSize) {
      const batch = [...this.buffer];
      this.buffer = [];
      return batch;
    }
    return null;
  }

  /** Force flush regardless of batch size */
  forceFlush(): typeof this.buffer {
    const batch = [...this.buffer];
    this.buffer = [];
    return batch;
  }
}

function loadSimulationData(): SimReading[] {
  const csvPath = join(__dirname, 'data', 'simulation.csv');
  console.log(`📂 Loading simulation data from ${csvPath}`);
  
  const raw = readFileSync(csvPath, 'utf-8');
  const lines = raw.trim().split('\n');
  const headers = lines[0]!.split(',').map(h => h.trim());
  
  // Verify CSV headers match expected
  const expected = ['vdc1', 'vdc2', 'idc1', 'idc2', 'irr', 'pvt', 'f_nv', 'original_index'];
  const missing = expected.filter(h => !headers.includes(h));
  if (missing.length > 0) {
    console.error(`Missing CSV columns: ${missing.join(', ')}. Found: ${headers.join(', ')}`);
    process.exit(1);
  }

  // Map by header position
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

// ─── Auth ───────────────────────────────────────────────────────────
let accessToken = '';
let tokenExpiry = 0;

async function login(): Promise<void> {
  if (!AUTH_PASS) {
    throw new Error('AUTH_PASS environment variable is required');
  }
  console.log(`🔑 Authenticating as '${AUTH_USER}'...`);
  const res = await fetch(`${API_URL}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: AUTH_USER, password: AUTH_PASS }),
  });
  
  if (!res.ok) {
    throw new Error(`Login failed: ${res.status} ${await res.text()}`);
  }
  
  // Server returns: { accessToken, refreshToken, expiresIn, user }
  const data = await res.json() as { accessToken: string; expiresIn: number };
  accessToken = data.accessToken;
  // Refresh 60s before expiry
  tokenExpiry = Date.now() + (data.expiresIn - 60) * 1000;
  console.log(`   ✅ Authenticated. Token valid for ${data.expiresIn}s`);
}

async function ensureAuth(): Promise<void> {
  if (!accessToken || Date.now() > tokenExpiry) {
    await login();
  }
}

// ─── Main loop ──────────────────────────────────────────────────────
let running = true;

process.on('SIGINT', () => {
  console.log('\n⏹️  Simulator stopped.');
  running = false;
  process.exit(0);
});

async function main() {
  console.log(`
==================================================
  EnergiaMind — AI Telemetry Simulator v2
--------------------------------------------------
  Pipeline:  Modbus RS485 → Edge Gateway → HTTP
  API:       ${API_URL}
  Rate:      Every ${INTERVAL_MS / 1000}s${FAST_MODE ? ' (FAST MODE)' : ''}
  Batch:     ${BATCH_SIZE} readings/flush
  Auth:      ${AUTH_USER}
  Mode:      AI Detection (no faultLabel sent)
  Faults:    Realtime synchronized (as in dataset)
==================================================
`);
  
  const readings = loadSimulationData();
  await login();
  
  const modbus = new ModbusDevice(readings);
  const edge = new EdgeGateway(BATCH_SIZE);
  
  let stats = { total: 0, faults: 0, sent: 0, errors: 0 };
  
  while (running) {
    await ensureAuth();
    
    // Step 1: Read from Modbus device
    const reading = modbus.readRegisters();
    if (!reading) {
      // Comms error — wait and retry
      await new Promise(r => setTimeout(r, 500));
      continue;
    }
    
    const groundTruth = FAULT_NAMES[reading.faultLabel] || `Unknown(${reading.faultLabel})`;
    
    // Step 2: Edge gateway buffers the reading
    edge.addReading(reading);
    stats.total++;
    if (reading.faultLabel > 0) stats.faults++;
    
    // Step 3: Flush to server when batch is ready
    const batch = edge.flush();
    if (batch) {
      try {
        const res = await fetch(`${API_URL}/api/v1/telemetry`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`,
          },
          body: JSON.stringify(batch),
        });
        
        if (res.status === 401) {
          console.log('  🔑 Token expired, re-authenticating...');
          await login();
          // Re-add to edge buffer for retry
          for (const item of batch) edge.addReading({ ...item, faultLabel: 0 } as SimReading);
        } else if (res.ok) {
          stats.sent += batch.length;
          
          const pdc = reading.vdc1 * reading.idc1 + reading.vdc2 * reading.idc2;
          const marker = reading.faultLabel > 0 ? `⚡FAULT[${reading.faultLabel}]` : '✅ OK';
          
          console.log(
            `[${new Date().toLocaleTimeString('en-US', { hour12: false })}] ` +
            `#${modbus.position.toString().padStart(6)}/${modbus.total} | ` +
            `${marker.padEnd(14)} | ` +
            `${pdc.toFixed(0).padStart(6)}W | ` +
            `V1=${reading.vdc1.toFixed(1)} V2=${reading.vdc2.toFixed(1)} | ` +
            `I1=${reading.idc1.toFixed(2)} I2=${reading.idc2.toFixed(2)} | ` +
            `Irr=${reading.irr.toFixed(0)} PVT=${reading.pvt.toFixed(1)} | ` +
            `GT: ${groundTruth}`
          );
        } else {
          stats.errors++;
          console.error(`  ❌ Error: ${res.status} ${await res.text()}`);
        }
      } catch (err) {
        stats.errors++;
        console.error(`  ❌ Connection error:`, (err as Error).message);
      }
    }
    
    await new Promise(r => setTimeout(r, INTERVAL_MS));
  }
  
  console.log(`\n📊 Simulation stats: Total=${stats.total}, Faults=${stats.faults}, Sent=${stats.sent}, Errors=${stats.errors}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
