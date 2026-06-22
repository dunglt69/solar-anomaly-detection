import { db } from './src/db/index.js';
import { sql } from 'drizzle-orm';
import { seed } from './src/db/seed.js';

async function clear() {
  console.log('Resetting all database tables...');
  
  // Disable foreign keys temporarily to clear tables without constraint failures
  await db.run(sql`PRAGMA foreign_keys = OFF`);
  
  await db.run(sql`DELETE FROM ticket_comments`);
  await db.run(sql`DELETE FROM tickets`);
  await db.run(sql`DELETE FROM alerts`);
  await db.run(sql`DELETE FROM telemetry`);
  await db.run(sql`DELETE FROM sessions`);
  await db.run(sql`DELETE FROM registered_devices`);
  await db.run(sql`DELETE FROM activity_log`);
  await db.run(sql`DELETE FROM config`);
  await db.run(sql`DELETE FROM users`);
  
  try {
    await db.run(sql`DELETE FROM sqlite_sequence`);
  } catch (e) {
    // ignore
  }
  
  // Re-enable foreign keys
  await db.run(sql`PRAGMA foreign_keys = ON`);
  
  console.log('Database tables cleared successfully!');
  
  console.log('Re-seeding database...');
  await seed();
  
  console.log('Database reset completed successfully!');
  process.exit(0);
}
clear().catch((err) => {
  console.error('Failed to reset database:', err);
  process.exit(1);
});

