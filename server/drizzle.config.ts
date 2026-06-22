import { defineConfig } from 'drizzle-kit';
import { resolve } from 'node:path';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: `file:${resolve('data', 'energiamind.db')}`,
  },
});
