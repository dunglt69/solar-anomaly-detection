import { db } from '../src/db/index.js';
import { sql } from 'drizzle-orm';

async function main() {
  // Check what timestamp column actually stores
  const [sample] = await db.all(sql`SELECT timestamp, typeof(timestamp) as ts_type FROM telemetry LIMIT 1`);
  console.log('Sample row:', sample);

  // Test the bucket expression
  const [bucket1d] = await db.all(sql`
    SELECT 
      (timestamp / 86400) * 86400 as bucket,
      COUNT(*) as cnt 
    FROM telemetry 
    GROUP BY (timestamp / 86400) * 86400 
    ORDER BY bucket ASC
    LIMIT 5
  `);
  console.log('Bucket 1d sample:', bucket1d);

  // Count total buckets for 1d
  const [totalBuckets] = await db.all(sql`
    SELECT COUNT(DISTINCT (timestamp / 86400) * 86400) as bucket_count 
    FROM telemetry
  `);
  console.log('Total 1d buckets:', totalBuckets);

  process.exit(0);
}

main().catch(console.error);
