import { parseArgs } from 'node:util';

const args = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:3000/api/v1/telemetry' },
  },
});

const url = args.values.url as string;
const loginUrl = url.replace('/v1/telemetry', '/v1/auth/login');

async function run() {
  console.log('🔑 Authenticating as Admin...');
  let token = '';
  try {
    const loginRes = await fetch(loginUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'Admin@123' }),
    });
    if (loginRes.ok) {
      const data = (await loginRes.json()) as any;
      token = data.accessToken;
      console.log('✅ Successfully authenticated');
    } else {
      console.error(`❌ Login failed: ${loginRes.status} ${loginRes.statusText}`);
      process.exit(1);
    }
  } catch (err: any) {
    console.error(`❌ Connection error: ${err.message}`);
    process.exit(1);
  }

  console.log('📦 Generating anomaly batch telemetry data...');
  const baseTime = Date.now() - 30 * 60 * 1000; // Start 30 mins ago
  const batch = [];

  // Helper to construct point
  const makePoint = (offsetMin: number, v1: number, v2: number, i1: number, i2: number, irr: number, pvt: number, label: number) => {
    const ts = new Date(baseTime + offsetMin * 60 * 1000);
    const pdc1 = v1 * i1;
    const pdc2 = v2 * i2;
    return {
      timestamp: ts.toISOString(),
      vdc1: Math.round(v1 * 100) / 100,
      vdc2: Math.round(v2 * 100) / 100,
      idc1: Math.round(i1 * 1000) / 1000,
      idc2: Math.round(i2 * 1000) / 1000,
      pdc1: Math.round(pdc1 * 10) / 10,
      pdc2: Math.round(pdc2 * 10) / 10,
      pdcTotal: Math.round((pdc1 + pdc2) * 10) / 10,
      irr,
      pvt,
      faultLabel: label,
    };
  };

  // Generate 30 points (1 point per minute) with transitions to faults
  let min = 0;

  // 1. Normal points (0-5 mins)
  for (let i = 0; i < 5; i++, min++) {
    batch.push(makePoint(min, 192, 191, 8.2, 8.3, 800, 32, 0));
  }

  // 2. Short-Circuit (6-10 mins)
  for (let i = 0; i < 5; i++, min++) {
    batch.push(makePoint(min, 48, 191, 9.4, 8.3, 800, 34, 1));
  }

  // 3. Normal points (11-15 mins)
  for (let i = 0; i < 5; i++, min++) {
    batch.push(makePoint(min, 192, 191, 8.2, 8.3, 800, 32, 0));
  }

  // 4. Open Circuit (16-20 mins)
  for (let i = 0; i < 5; i++, min++) {
    batch.push(makePoint(min, 6, 191, 0.01, 8.3, 800, 31, 3));
  }

  // 5. Normal points (21-25 mins)
  for (let i = 0; i < 5; i++, min++) {
    batch.push(makePoint(min, 192, 191, 8.2, 8.3, 800, 32, 0));
  }

  // 6. Shadowing (26-30 mins)
  for (let i = 0; i < 5; i++, min++) {
    batch.push(makePoint(min, 183, 172, 5.2, 4.3, 800, 33, 4));
  }

  console.log(`📤 Sending ${batch.length} telemetry points (3 fault transitions) to API...`);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(batch),
    });

    if (res.ok) {
      console.log('✅ Ingestion successful! Alerts and Tickets generated automatically.');
    } else {
      const text = await res.text();
      console.error(`❌ Ingestion failed: ${res.status} ${res.statusText} - ${text}`);
    }
  } catch (err: any) {
    console.error(`❌ Fetch error: ${err.message}`);
  }
}

run();
