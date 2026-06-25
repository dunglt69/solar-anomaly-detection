import crypto from 'node:crypto';
import { db } from './index.js';
import { users, config } from './schema.js';
import * as argon2 from 'argon2';
import { nanoid } from 'nanoid';
import { eq } from 'drizzle-orm';

const ADMIN_USERNAME = process.env['ADMIN_USERNAME'] || 'admin';
const ADMIN_PASSWORD = process.env['ADMIN_PASSWORD'];
if (!ADMIN_PASSWORD) {
  console.warn('⚠️  ADMIN_PASSWORD not set in environment. Generating random password...');
}
const finalPassword = ADMIN_PASSWORD || crypto.randomUUID().slice(0, 16) + '!A1';
const ADMIN_EMAIL = process.env['ADMIN_EMAIL'] || 'admin@energiamind.local';

export async function seed() {
  console.log('Seeding database...');

  // Check if admin already exists using select
  const existing = await db.select({ id: users.id })
    .from(users)
    .where(eq(users.username, ADMIN_USERNAME))
    .limit(1);

  if (existing.length > 0) {
    console.log('Admin user already exists. Skipping seed.');
    return;
  }

  // Create admin user
  const passwordHash = await argon2.hash(finalPassword, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });

  await db.insert(users).values({
    id: nanoid(),
    employeeId: 'EM-0001',
    username: ADMIN_USERNAME,
    email: ADMIN_EMAIL,
    personalEmail: 'admin.personal@energiamind.local',
    dob: '1990-01-01',
    displayName: 'System Administrator',
    passwordHash,
    role: 'admin',
  });

  // Seed default system config
  const defaultConfig = [
    { key: 'alert_threshold_voltage', value: { sigma: 3, minDelta: 50 } },
    { key: 'alert_threshold_current', value: { sigma: 3, minDelta: 2 } },
    { key: 'alert_threshold_power', value: { dropPercent: 20 } },
    { key: 'ai_confidence_threshold', value: { min: 0.7 } },
    { key: 'data_retention_days', value: { days: 365 } },
    { key: 'session_timeout_minutes', value: { minutes: 480 } },
    { key: 'ingestion_rate_limit', value: { maxPerSecond: 100 } },
  ];

  for (const c of defaultConfig) {
    await db.insert(config).values({
      key: c.key,
      value: c.value,
      updatedAt: new Date(),
    }).onConflictDoNothing();
  }

  if (!ADMIN_PASSWORD) {
    if (process.env['NODE_ENV'] === 'production') {
      throw new Error('ADMIN_PASSWORD environment variable is required in production');
    }
    const fs = await import('node:fs');
    const path = await import('node:path');
    const credsPath = path.resolve(process.cwd(), '.admin_credentials.tmp');
    fs.writeFileSync(credsPath, `Username: ${ADMIN_USERNAME}\nPassword: ${finalPassword}\n`, 'utf-8');
    console.log(`⚠️  Generated admin password has been written to: ${credsPath}`);
    console.log('   Please check this file and delete it after logging in.');
  }
  console.log('Seeded admin user: EM-0001');
  console.log('Seeded default system config.');
}

// Run seed if executed directly
seed().catch(console.error);
