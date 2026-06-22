import { db } from './src/db/index.js';
import { telemetry } from './src/db/schema.js';
import { desc, sql } from 'drizzle-orm';

async function check() {
  const rows = await db.select({
    id: telemetry.id,
    timestamp: telemetry.timestamp,
  }).from(telemetry).orderBy(desc(telemetry.timestamp)).limit(3);
  console.log(rows);
  process.exit(0);
}
check();
