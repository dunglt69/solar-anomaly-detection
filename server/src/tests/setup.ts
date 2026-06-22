import { migrate } from 'drizzle-orm/libsql/migrator';
import { db, client } from '../db/index.js';
import { resolve } from 'path';
import { unlinkSync, existsSync } from 'fs';
import { beforeAll, afterAll } from 'vitest';
import {
  users,
  sessions,
  telemetry,
  alerts,
  tickets,
  ticketComments,
  activityLog,
  config,
  registeredDevices,
} from '../db/schema.js';

beforeAll(async () => {
  const dbPath = process.env.DB_PATH;
  
  // Clean start: delete test database files if they exist
  if (dbPath) {
    const files = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
    for (const file of files) {
      if (existsSync(file)) {
        try {
          unlinkSync(file);
        } catch {
          // ignore
        }
      }
    }
  }

  // Run migrations
  const migrationsFolder = resolve(process.cwd(), 'drizzle');
  await migrate(db, { migrationsFolder });

  // Clean all tables to prevent leftovers
  await client.execute('PRAGMA foreign_keys = OFF');
  const tables = [
    sessions,
    registeredDevices,
    ticketComments,
    tickets,
    alerts,
    users,
    telemetry,
    activityLog,
    config
  ];
  for (const table of tables) {
    try {
      await db.delete(table);
    } catch {
      // ignore
    }
  }
  await client.execute('PRAGMA foreign_keys = ON');
});

// No afterAll hook to prevent premature client closing in shared worker process
