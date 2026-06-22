import { db } from '../src/db/index.js';
import { sql } from 'drizzle-orm';

async function main() {
  console.time('1d-drizzle');
  const rows = await db.all(sql`
    SELECT 
      ("timestamp" / 86400) * 86400 as bucket,
      ROUND(AVG(pdc), 2) as avgPdc,
      ROUND(MAX(pdc), 2) as maxPdc,
      COUNT(*) as dataPoints
    FROM telemetry
    GROUP BY ("timestamp" / 86400) * 86400
    ORDER BY bucket ASC
  `);
  console.timeEnd('1d-drizzle');
  console.log(`Total 1d buckets: ${rows.length}`);
  if (rows.length > 0) {
    console.log('First:', rows[0]);
    console.log('Last:', rows[rows.length - 1]);
  }

  console.time('1h-drizzle');
  const rows2 = await db.all(sql`
    SELECT 
      ("timestamp" / 3600) * 3600 as bucket,
      ROUND(AVG(pdc), 2) as avgPdc,
      COUNT(*) as dataPoints
    FROM telemetry
    GROUP BY ("timestamp" / 3600) * 3600
    ORDER BY bucket ASC
  `);
  console.timeEnd('1h-drizzle');
  console.log(`Total 1h buckets: ${rows2.length}`);

  process.exit(0);
}

main().catch(console.error);
