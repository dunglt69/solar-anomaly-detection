import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    env: {
      DB_PATH: resolve(__dirname, 'data', 'energiamind_test.db'),
      NODE_ENV: 'test',
      JWT_SECRET: 'test-jwt-secret-key-at-least-32-characters-long',
      COOKIE_SECRET: 'test-cookie-secret-key-at-least-32-characters-long',
    },
    setupFiles: ['./src/tests/setup.ts'],
    testTimeout: 10000,
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    sequence: {
      concurrent: false,
    },
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/cypress/**',
      '**/.{idea,git,cache,output,temp}/**',
    ],
  },
});
