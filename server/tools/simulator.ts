import 'dotenv/config';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const args = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:3000/api/v1/telemetry' },
    interval: { type: 'string', default: '1000' }, // ms between sends
    speed: { type: 'string', default: '1' }, // Time multiplier (ignored in wall-clock mode)
    'no-history': { type: 'boolean', default: true },
    'fault-rate': { type: 'string', default: '0.01' },
  },
});

const url = args.values.url as string;
const intervalMs = parseInt(args.values.interval as string, 10);

const __dirname = dirname(fileURLToPath(import.meta.url));

interface SimReading {
  originalIndex: number;
  vdc1: number;
  vdc2: number;
  idc1: number;
  idc2: number;
  irr: number;
  pvt: number;
  faultLabel: number;
}

// Find simulation.csv in candidate paths
function findCsvPath(): string {
  const candidates = [
    join(process.cwd(), '..', 'tools', 'data', 'simulation.csv'),
    join(process.cwd(), 'tools', 'data', 'simulation.csv'),
    join(__dirname, '..', '..', 'tools', 'data', 'simulation.csv'),
    join(__dirname, 'data', 'simulation.csv'),
    'g:/Solar/tools/data/simulation.csv',
  ];

  for (const c of candidates) {
    if (existsSync(c)) {
      return c;
    }
  }
  throw new Error('Could not find simulation.csv in any expected location');
}

let readings: SimReading[] = [];
try {
  const csvPath = findCsvPath();
  console.log(`📂 Loading simulation data from ${csvPath}`);
  const raw = readFileSync(csvPath, 'utf-8');
  const lines = raw.trim().split('\n');
  const headers = lines[0]!.split(',').map(h => h.trim());
  const colIdx = Object.fromEntries(headers.map((h, i) => [h, i]));

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const vals = lines[i]!.split(',').map(Number);
    readings.push({
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
  console.log(`✅ Loaded ${readings.length.toLocaleString()} readings from dataset.`);
} catch (err: any) {
  console.error(`❌ Failed to load simulation dataset: ${err.message}`);
  process.exit(1);
}

const FAULT_NAMES: Record<number, string> = {
  0: 'Normal',
  1: 'Short-Circuit',
  2: 'Degradation',
  3: 'Open Circuit',
  4: 'Shadowing',
};

// Find boundary index dynamically where Day 16 begins
let boundaryIndex = readings.findIndex(r => r.originalIndex >= 1288619);
if (boundaryIndex === -1) {
  boundaryIndex = Math.floor(readings.length / 2);
}

function getReadingForTime(date: Date = new Date()): SimReading {
  const virtualDayIndex = (date.getDate() - 1) % 2; // 0 for Day 15, 1 for Day 16
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = date.getSeconds();
  const secondOfDay = hours * 3600 + minutes * 60 + seconds;

  let finalIndex: number;
  if (virtualDayIndex === 0) {
    // Day 15 (Virtual Day 0)
    finalIndex = Math.min(secondOfDay, boundaryIndex - 1);
  } else {
    // Day 16 (Virtual Day 1)
    finalIndex = boundaryIndex + Math.min(secondOfDay, readings.length - boundaryIndex - 1);
  }

  finalIndex = Math.max(0, Math.min(readings.length - 1, finalIndex));
  return readings[finalIndex]!;
}

// ─── Auth helper: login and get access token ──────────────────────────
let token = '';
const loginUrl = url.replace('/v1/telemetry', '/v1/auth/login');

async function authenticate(): Promise<boolean> {
  try {
    const username = process.env.ADMIN_USERNAME || 'admin';
    const password = process.env.ADMIN_PASSWORD || process.env.AUTH_PASS || 'Admin@123';
    const loginRes = await fetch(loginUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (loginRes.ok) {
      const data = await loginRes.json() as any;
      token = data.accessToken;
      console.log('✅ Successfully authenticated as Admin');
      return true;
    } else {
      console.warn(`⚠️ Login failed (${loginRes.status}), attempting without token`);
      return false;
    }
  } catch (err) {
    console.error('❌ Could not connect to API server. Is it running?');
    return false;
  }
}

async function sendTelemetry(body: unknown): Promise<Response | null> {
  const doFetch = () => fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

  try {
    let res = await doFetch();
    if (res.status === 401) {
      console.log('🔄 Token expired, re-authenticating...');
      const ok = await authenticate();
      if (ok) {
        res = await doFetch();
      }
    }
    return res;
  } catch (err: any) {
    console.error(`❌ Connection error: ${err.message}`);
    return null;
  }
}

async function run() {
  console.log(`📡 Starting Realtime Dataset-synced Simulator (16 virtual days)`);
  console.log(`🎯 Target API: ${url}`);
  console.log(`⏱️  Interval: ${intervalMs}ms`);

  const authOk = await authenticate();
  if (!authOk) {
    console.warn('⚠️ Continuing without authentication (requests may fail with 401)');
  }

  console.log('🚀 Starting real-time simulation...');

  setInterval(async () => {
    const reading = getReadingForTime();
    const pdc1 = reading.vdc1 * reading.idc1;
    const pdc2 = reading.vdc2 * reading.idc2;
    const pdcTotal = pdc1 + pdc2;

    const payload = [{
      timestamp: new Date().toISOString(),
      vdc1: reading.vdc1,
      vdc2: reading.vdc2,
      idc1: reading.idc1,
      idc2: reading.idc2,
      irr: reading.irr,
      pvt: reading.pvt,
      pdc1: Math.round(pdc1 * 100) / 100,
      pdc2: Math.round(pdc2 * 100) / 100,
      pdcTotal: Math.round(pdcTotal * 100) / 100,
    }];

    const res = await sendTelemetry(payload);

    if (res && !res.ok) {
      const text = await res.text();
      console.error(`❌ HTTP Error: ${res.status} ${res.statusText} - ${text}`);
    } else if (res) {
      const isNight = reading.irr === 0 && reading.vdc1 === 0;
      const faultStr = isNight ? '🌙 NIGHT MODE' : (reading.faultLabel > 0 ? `🔥 FAULT ${reading.faultLabel} (${FAULT_NAMES[reading.faultLabel]})` : '✅ OK');
      const totalP = (pdcTotal).toFixed(0);
      console.log(`[${new Date().toLocaleTimeString('en-US', { hour12: false })}] ${faultStr.padEnd(14)} | P: ${totalP.padStart(5)}W | V1:${reading.vdc1.toFixed(1)} V2:${reading.vdc2.toFixed(1)} | Irr: ${reading.irr.toFixed(0)}W/m2`);
    }
  }, intervalMs);
}
run().catch(console.error);
