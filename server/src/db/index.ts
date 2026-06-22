import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from './schema.js';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

const DB_DIR = resolve(process.cwd(), 'data');
mkdirSync(DB_DIR, { recursive: true });

const DB_PATH = process.env['DB_PATH'] || resolve(DB_DIR, 'energiamind.db');

const client = createClient({
  url: `file:${DB_PATH}`,
});

// Enable WAL mode and foreign keys
await client.execute('PRAGMA journal_mode = WAL');
await client.execute('PRAGMA foreign_keys = ON');
await client.execute('PRAGMA busy_timeout = 5000');

export const db = drizzle(client, { schema });
export { client };
