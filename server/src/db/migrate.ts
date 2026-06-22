import { migrate } from 'drizzle-orm/libsql/migrator';
import { db } from './index.js';
import { resolve } from 'node:path';

const migrationsFolder = resolve(process.cwd(), 'drizzle');

console.log('Running migrations...');
await migrate(db, { migrationsFolder });
console.log('Migrations complete.');
