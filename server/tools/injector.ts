/**
 * EnergiaMind — Data Injector
 * Reads pv_fault_dataset.csv and POSTs telemetry to the API in real-time simulation.
 *
 * Usage:
 *   npx tsx tools/injector.ts                    # Default: 50 rows/sec, 500 per batch
 *   npx tsx tools/injector.ts --speed 100        # 100 rows/sec
 *   npx tsx tools/injector.ts --batch 200        # 200 rows per batch
 *   npx tsx tools/injector.ts --rows 5000        # Only inject 5000 rows
 *   npx tsx tools/injector.ts --fast             # As fast as possible (no delay)
 */

import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';

const API_URL = process.env['API_URL'] || 'http://localhost:3000';

// Try multiple CSV locations
const CSV_CANDIDATES = [
  resolve(process.cwd(), '..', 'pv_fault_dataset.csv'),
  resolve(process.cwd(), '..', 'data', 'pv_fault_dataset.csv'),
  'G:\\DA1\\data\\pv_fault_dataset.csv',
];
const CSV_PATH = CSV_CANDIDATES.find(p => existsSync(p)) || CSV_CANDIDATES[0]!;

// Parse CLI args
const args = process.argv.slice(2);
function getArg(name: string, def: number): number {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 ? Number(args[idx + 1]) : def;
}
const SPEED = getArg('speed', 50);       // rows per second
const BATCH_SIZE = getArg('batch', 500); // rows per API call
const MAX_ROWS = getArg('rows', Infinity);
const FAST = args.includes('--fast');

interface CSVRow {
  timestamp: string;
  vdc1: number;
  vdc2: number;
  idc1: number;
  idc2: number;
  irr: number;
  pvt: number;
  faultLabel: number;
}

async function main() {
  console.log('╔════════════════════════════════════════════╗');
  console.log('║   EnergiaMind — Data Injector              ║');
  console.log('╠════════════════════════════════════════════╣');
  console.log(`║  CSV:   ${CSV_PATH}`);
  console.log(`║  API:   ${API_URL}/api/v1/telemetry`);
  console.log(`║  Speed: ${FAST ? 'MAX' : `${SPEED} rows/sec`}`);
  console.log(`║  Batch: ${BATCH_SIZE}`);
  console.log(`║  Limit: ${MAX_ROWS === Infinity ? 'ALL' : MAX_ROWS}`);
  console.log('╚════════════════════════════════════════════╝');
  console.log();

  const rl = createInterface({
    input: createReadStream(CSV_PATH, 'utf-8'),
  });

  const buffer: CSVRow[] = [];
  let totalSent = 0;
  let totalRows = 0;
  let isFirstLine = true;
  const startTime = Date.now();

  // Generate timestamps: start from current time, 1 second intervals
  const baseTimestamp = Date.now();

  // Dataset columns: vdc1,vdc2,idc1,idc2,irr,pvt,f_nv
  // Values are normalized (0-1 range for most), we need to scale them
  // Typical real-world ranges from the paper (Lazzaretti et al.):
  //   Vdc: 0-600V, Idc: 0-10A, Irr: 0-1100 W/m², Temp: 15-75°C
  const SCALE = {
    vdc: 550,   // Scale factor for voltage
    idc: 9.5,   // Scale factor for current
    irr: 1100,  // Scale factor for irradiance
    pvt: 60,    // Scale factor for temperature (offset by 15)
    pvtOffset: 15,
  };

  for await (const line of rl) {
    if (isFirstLine) {
      isFirstLine = false;
      continue; // Skip header
    }

    if (totalRows >= MAX_ROWS) break;

    const values = line.split(',').map(v => Number(v.trim()));
    if (values.length < 7 || values.some(v => isNaN(v))) continue;

    // Scale normalized values to real-world units
    const row: CSVRow = {
      timestamp: new Date(baseTimestamp + totalRows * 1000).toISOString(),
      vdc1: Math.round(values[0]! * SCALE.vdc * 100) / 100,
      vdc2: Math.round(values[1]! * SCALE.vdc * 100) / 100,
      idc1: Math.round(values[2]! * SCALE.idc * 100) / 100,
      idc2: Math.round(values[3]! * SCALE.idc * 100) / 100,
      irr: Math.round(values[4]! * SCALE.irr * 100) / 100,
      pvt: Math.round((values[5]! * SCALE.pvt + SCALE.pvtOffset) * 100) / 100,
      faultLabel: Math.round(values[6]!),
    };

    buffer.push(row);
    totalRows++;

    if (buffer.length >= BATCH_SIZE) {
      await sendBatch(buffer.splice(0));
      totalSent += BATCH_SIZE;

      // Speed control
      if (!FAST) {
        const elapsed = (Date.now() - startTime) / 1000;
        const expectedTime = totalSent / SPEED;
        const delay = (expectedTime - elapsed) * 1000;
        if (delay > 0) {
          await sleep(delay);
        }
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const rate = Math.round(totalSent / Number(elapsed));
      process.stdout.write(`\r  Injected: ${totalSent.toLocaleString()} rows | ${elapsed}s | ${rate} rows/s`);
    }
  }

  // Flush remaining
  if (buffer.length > 0) {
    await sendBatch(buffer);
    totalSent += buffer.length;
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n\n✅ Done! Injected ${totalSent.toLocaleString()} rows in ${elapsed}s`);
}

async function sendBatch(rows: CSVRow[]) {
  const res = await fetch(`${API_URL}/api/v1/telemetry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(rows),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`\n❌ API error (${res.status}): ${text}`);
    process.exit(1);
  }
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
