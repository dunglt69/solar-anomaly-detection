import { db } from '../src/db/index.js';
import { users } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';

async function main() {
  await db.update(users).set({ failedAttempts: 0, lockedUntil: null }).where(eq(users.username, 'admin'));
  console.log('✅ Admin account unlocked successfully');
  process.exit(0);
}

main().catch(console.error);
