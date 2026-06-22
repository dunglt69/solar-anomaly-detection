import { spawn, ChildProcess } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, client as dbClient } from '../src/db/index.js';
import { users } from '../src/db/schema.js';
import * as argon2 from 'argon2';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = 3333;
const BASE_URL = `http://127.0.0.1:${PORT}`;

async function seedTestUser() {
  console.log('🌱 Seeding load test user into database...');
  // Ensure table exists (tests setup should have run, but clean database is also fine)
  const passwordHash = await argon2.hash('LoadTestPassword123!', {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });

  try {
    await db.insert(users).values({
      id: 'load-test-user-id',
      username: 'loadtestuser',
      email: 'loadtestuser@energiamind.com',
      displayName: 'Load Test User',
      passwordHash,
      role: 'staff',
    }).onConflictDoNothing();
    console.log('✅ Load test user seeded.');
  } catch (err: any) {
    console.warn('⚠️ Seeding user warned (might already exist):', err.message);
  }
}

function startServer(): Promise<ChildProcess> {
  return new Promise((resolveSpawn, reject) => {
    console.log(`🚀 Starting Fastify API Server in background on port ${PORT}...`);
    const serverProcess = spawn('npx', ['tsx', 'src/index.ts'], {
      env: {
        ...process.env,
        PORT: String(PORT),
        NODE_ENV: 'test',
        DB_PATH: resolve(__dirname, '..', 'data', 'energiamind_test.db'),
        JWT_SECRET: 'test-jwt-secret-key-at-least-32-characters-long',
        COOKIE_SECRET: 'test-cookie-secret-key-at-least-32-characters-long',
        LOG_LEVEL: 'warn', // suppress verbose logs
      },
      shell: true,
      stdio: 'ignore', // run completely in background silently
    });

    serverProcess.on('error', (err) => {
      reject(err);
    });

    // Poll health check endpoint until active (max 10s)
    let attempts = 0;
    const interval = setInterval(async () => {
      attempts++;
      try {
        const res = await fetch(`${BASE_URL}/api/health`);
        if (res.status === 200) {
          clearInterval(interval);
          console.log(`✅ Server is alive and listening at ${BASE_URL}`);
          resolveSpawn(serverProcess);
        }
      } catch {
        if (attempts >= 40) {
          clearInterval(interval);
          serverProcess.kill();
          reject(new Error('Server failed to start within 10 seconds.'));
        }
      }
    }, 250);
  });
}

interface RunResult {
  latencies: number[];
  status2xx: number;
  status429: number;
  status503: number;
  other: number;
}

async function runVU(vuId: number, url: string, reqsPerVU: number, method = 'GET', body?: any): Promise<RunResult> {
  const latencies: number[] = [];
  let status2xx = 0;
  let status429 = 0;
  let status503 = 0;
  let other = 0;

  for (let i = 0; i < reqsPerVU; i++) {
    const start = performance.now();
    try {
      const res = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const latency = performance.now() - start;
      latencies.push(latency);

      if (res.status >= 200 && res.status < 300) {
        status2xx++;
      } else if (res.status === 429) {
        status429++;
      } else if (res.status === 503) {
        status503++;
      } else {
        other++;
      }
    } catch {
      other++;
    }
  }

  return { latencies, status2xx, status429, status503, other };
}

function processResults(results: RunResult[], totalDurationMs: number) {
  let totalRequests = 0;
  let success = 0;
  let rateLimited = 0;
  let serverOverload = 0;
  let failed = 0;
  const allLatencies: number[] = [];

  for (const r of results) {
    success += r.status2xx;
    rateLimited += r.status429;
    serverOverload += r.status503;
    failed += r.other;
    allLatencies.push(...r.latencies);
  }

  totalRequests = success + rateLimited + serverOverload + failed;
  allLatencies.sort((a, b) => a - b);

  const p50 = allLatencies[Math.floor(allLatencies.length * 0.50)] || 0;
  const p90 = allLatencies[Math.floor(allLatencies.length * 0.90)] || 0;
  const p99 = allLatencies[Math.floor(allLatencies.length * 0.99)] || 0;
  const rps = (totalRequests / (totalDurationMs / 1000)).toFixed(1);

  return {
    totalRequests,
    success,
    rateLimited,
    serverOverload,
    failed,
    p50,
    p90,
    p99,
    rps,
  };
}

async function runLoadTests() {
  console.log('🧪 ==========================================');
  console.log('🧪     ENERGIA MIND LOAD TEST & BENCHMARK    ');
  console.log('🧪 ==========================================\n');

  await seedTestUser();
  const serverProcess = await startServer();

  try {
    // ----------------------------------------------------
    // TEST PHASE 1: Public Health Endpoint (150 VUs, 5 requests each)
    // ----------------------------------------------------
    console.log('\n📈 PHASE 1: Benchmarking /api/health with 150 VUs...');
    const numVUsPhase1 = 150;
    const reqsPerVUPhase1 = 5;
    const startPhase1 = performance.now();

    const resultsPhase1 = await Promise.all(
      Array.from({ length: numVUsPhase1 }).map((_, i) =>
        runVU(i, `${BASE_URL}/api/health`, reqsPerVUPhase1)
      )
    );
    const durationPhase1 = performance.now() - startPhase1;
    const stats1 = processResults(resultsPhase1, durationPhase1);

    console.log('\n📊 PHASE 1 RESULTS:');
    console.log(`  - Total Requests: ${stats1.totalRequests}`);
    console.log(`  - Success (200 OK): ${stats1.success}`);
    console.log(`  - Rate Limited (429): ${stats1.rateLimited}`);
    console.log(`  - Pressure Overload (503): ${stats1.serverOverload}`);
    console.log(`  - Failed: ${stats1.failed}`);
    console.log(`  - Throughput: ${stats1.rps} req/sec`);
    console.log(`  - Latency: p50 = ${stats1.p50.toFixed(1)}ms, p90 = ${stats1.p90.toFixed(1)}ms, p99 = ${stats1.p99.toFixed(1)}ms`);

    // ----------------------------------------------------
    // TEST PHASE 2: Auth Login Endpoint with low Rate Limit (30 VUs, 5 requests each)
    // ----------------------------------------------------
    console.log('\n🔑 PHASE 2: Testing Auth Rate Limiting (/api/v1/auth/login) with 30 VUs...');
    const numVUsPhase2 = 30;
    const reqsPerVUPhase2 = 5;
    const startPhase2 = performance.now();

    const resultsPhase2 = await Promise.all(
      Array.from({ length: numVUsPhase2 }).map((_, i) =>
        runVU(i, `${BASE_URL}/api/v1/auth/login`, reqsPerVUPhase2, 'POST', {
          username: 'loadtestuser',
          password: 'wrongpassword', // will fail credential check, but rate limit will hit first
        })
      )
    );
    const durationPhase2 = performance.now() - startPhase2;
    const stats2 = processResults(resultsPhase2, durationPhase2);

    console.log('\n📊 PHASE 2 RESULTS:');
    console.log(`  - Total Requests: ${stats2.totalRequests}`);
    console.log(`  - Success / Authenticated (200/401): ${stats2.success}`);
    console.log(`  - Rate Limited (429): ${stats2.rateLimited}`);
    console.log(`  - Failed / Other: ${stats2.failed}`);
    console.log(`  - Throughput: ${stats2.rps} req/sec`);

    // Verify rate limit kicked in
    if (stats2.rateLimited > 0) {
      console.log('✅ SUCCESS: Rate limiting successfully intercepted excessive authentication requests.');
    } else {
      console.warn('⚠️ WARNING: Rate limiting did not trigger. Check rate-limit configuration.');
    }

  } finally {
    console.log('\n🧹 Cleaning up: Shutting down background server...');
    serverProcess.kill('SIGKILL');
    await dbClient.close();
    console.log('✅ Clean up complete.\n');
  }
}

runLoadTests().catch((err) => {
  console.error('❌ Load test runner encountered a critical error:', err);
  process.exit(1);
});
