import { db } from '../src/db/index.js';
import { getAlertStats } from '../src/services/alert.service.js';

async function diagnose() {
  const stats = await getAlertStats();
  console.log("getAlertStats return value:", stats);
}

diagnose().catch(console.error);
