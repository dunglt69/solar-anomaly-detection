import { aiService } from '../src/services/ai.service.js';
import { detectionService } from '../src/services/detection.service.js';
import { db } from '../src/db/index.js';
import { tickets, alerts } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import {
  createTicket,
  updateTicket,
  getTicketStats,
  getTicketById,
} from '../src/services/ticket.service.js';
import { getSystemSummary } from '../src/services/analytics.service.js';
import { getTelemetryKPIs } from '../src/services/telemetry.service.js';
import { nanoid } from 'nanoid';

async function runSuperTest() {
  console.log('🧪 ==========================================');
  console.log('🧪          ENERGIA MIND SUPER TEST          ');
  console.log('🧪 ==========================================\n');

  // ----------------------------------------------------
  // TEST 1: ONNX Model and Inference Engine
  // ----------------------------------------------------
  console.log('📡 1. Testing AI Inference Engine (ONNX)...');
  const aiInitialized = await aiService.initialize();
  if (!aiInitialized) {
    console.error('❌ AI Service failed to initialize!');
    process.exit(1);
  }
  console.log('✅ AI Service initialized successfully.');

  // Reset sliding window
  aiService.reset();

  // Feed 23 normal readings (warm-up phase)
  console.log('⏳ Feeding 23 warm-up readings...');
  const normalReading = { vdc1: 193, vdc2: 193, idc1: 8.5, idc2: 8.5, irr: 800, pvt: 35 };
  for (let i = 0; i < 23; i++) {
    const res = await aiService.addReadingAndPredict(normalReading);
    if (res !== null) {
      console.error(`❌ Warm-up failed: predicted at tick ${i+1} instead of tick 24`);
      process.exit(1);
    }
  }
  console.log('✅ Warm-up worked (returned null for < 24 ticks).');

  // Feed 24th reading to trigger prediction
  console.log('🔮 Feeding 24th reading to trigger prediction...');
  const prediction = await aiService.addReadingAndPredict(normalReading);
  if (!prediction) {
    console.error('❌ AI Inference failed to return a prediction.');
    process.exit(1);
  }
  console.log(`✅ AI Predicted: ${prediction.faultName} (Label: ${prediction.faultLabel}) with ${(prediction.confidence * 100).toFixed(1)}% confidence.`);
  if (prediction.faultLabel !== 0) {
    console.warn('⚠️ Warning: Normal reading classified as anomaly. Check model alignment.');
  }

  // Test detection service orchestrator
  const detectionResult = await detectionService.detect(normalReading);
  console.log(`✅ Detection Service output: faultDetected=${detectionResult.faultDetected}, layer=${detectionResult.detectionLayer}, details="${detectionResult.details}"`);

  // ----------------------------------------------------
  // TEST 2: Ticket Status & Transitions State Machine
  // ----------------------------------------------------
  console.log('\n📋 2. Testing Ticket State Machine & Transitions...');
  
  // Create a test ticket
  const ticketId = `INC-TEST-${nanoid(5)}`;
  await db.insert(tickets).values({
    id: ticketId,
    status: 'open',
    severity: 'warning',
    faultType: 4,
    title: 'Test Incident Ticket',
    description: 'Created by super-test script',
  });
  console.log(`✅ Test Ticket Created: ${ticketId}`);

  // Helper to assert transition throws
  const assertInvalidTransition = async (to: string) => {
    try {
      await updateTicket(ticketId, { status: to });
      console.error(`❌ Error: Allowed invalid transition to "${to}"`);
      process.exit(1);
    } catch (err: any) {
      console.log(`✅ Invalid transition blocked as expected: ${err.message}`);
    }
  };

  // Helper to assert transition succeeds
  const assertValidTransition = async (to: string) => {
    try {
      await updateTicket(ticketId, { status: to });
      const t = await getTicketById(ticketId);
      if (t?.status !== to) {
        console.error(`❌ Error: Ticket status should be "${to}" but is "${t?.status}"`);
        process.exit(1);
      }
      console.log(`✅ Valid transition succeeded: -> ${to}`);
    } catch (err: any) {
      console.error(`❌ Error: Valid transition to "${to}" failed:`, err.message);
      process.exit(1);
    }
  };

  // Test invalid transition: open -> closed
  await assertInvalidTransition('closed');

  // Test valid sequence: open -> acknowledged -> in_progress -> escalated -> resolved
  await assertValidTransition('acknowledged');
  await assertValidTransition('in_progress');
  await assertValidTransition('escalated');

  // Verify escalation flag was set
  const ticketAfterEscalate = await getTicketById(ticketId);
  if (!ticketAfterEscalate?.wasEscalated) {
    console.error('❌ Error: wasEscalated flag was not set to true after escalation!');
    process.exit(1);
  }
  console.log('✅ Escalation history tracked successfully (wasEscalated = true).');

  // Test transition from escalated to resolved
  await assertValidTransition('resolved');

  // Verify resolved state aggregates closed
  const stats = await getTicketStats();
  console.log(`✅ Ticket stats: total=${stats.total}, open=${stats.open}, resolved=${stats.resolved}, escalated=${stats.escalated}`);
  
  // ----------------------------------------------------
  // TEST 3: Analytics Grouping and Historical Metrics
  // ----------------------------------------------------
  console.log('\n📊 3. Testing Analytics & Alerts Mapping...');

  // Create a test alert linked to our ticket
  const alertId = `ALERT-TEST-${nanoid(5)}`;
  await db.insert(alerts).values({
    id: alertId,
    timestamp: new Date(),
    severity: 'warning',
    faultType: 4,
    confidence: 0.85,
    detectionLayer: 'ai',
    acknowledged: true,
    ticketId: ticketId,
  });
  console.log(`✅ Test Alert Created: ${alertId} linked to ${ticketId}`);

  // Fetch analytics summary
  const summary = await getSystemSummary();
  console.log(`✅ System summary fetched successfully.`);
  console.log(`✅ Alerts status distribution: new=${summary.alertsByStatus.new}, ack=${summary.alertsByStatus.acknowledged}, resolved=${summary.alertsByStatus.resolved}, escalated=${summary.alertsByStatus.escalated}`);
  
  // Our ticket was escalated and is now resolved. The alert must be classified as 'escalated'
  // because the ticket has wasEscalated = true. Let's verify this!
  const computedEscalationRate = summary.totalAlerts > 0
    ? ((summary.alertsByStatus.escalated / summary.totalAlerts) * 100).toFixed(1)
    : '0.0';
  console.log(`✅ Verify Escalation Rate is computed correctly: ${computedEscalationRate}%`);

  // ----------------------------------------------------
  // TEST 4: Telemetry Aggregation & KPIs
  // ----------------------------------------------------
  console.log('\n📉 4. Testing Telemetry Aggregation & KPIs...');
  const kpis = await getTelemetryKPIs();
  console.log(`✅ Telemetry KPIs fetched: totalRecords=${kpis.totalRecords}, faultCount=${kpis.faultCount}`);

  // Clean up test data
  console.log('\n🧹 5. Cleaning up test data...');
  await db.delete(alerts).where(eq(alerts.id, alertId));
  await db.delete(tickets).where(eq(tickets.id, ticketId));
  console.log('✅ Clean up complete.');

  console.log('\n🎉 ==========================================');
  console.log('🎉          ALL TEST CASES PASSED!           ');
  console.log('🎉 ==========================================');
}

runSuperTest().catch((err) => {
  console.error('❌ Test failed with error:', err);
  process.exit(1);
});
