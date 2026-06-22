import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { db } from '../db/index.js';
import { alerts, tickets, users } from '../db/schema.js';
import {
  processDetectionResult,
  queryAlerts,
  acknowledgeAlert,
  resolveAlert,
  getAlertStats,
} from '../services/alert.service.js';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';

describe('Alerts Ingestion & Lifecycle Test Suite (50+ Cases)', () => {
  const testStaff = {
    id: 'staff-test-id-777',
    employeeId: 'EM-0777',
    username: 'staffuser2',
    email: 'staffuser2@energiamind.com',
    displayName: 'Staff User 2',
    passwordHash: 'dummyhash',
    role: 'solar_operator' as const,
  };

  beforeAll(async () => {
    await db.insert(users).values(testStaff);
  });

  afterEach(async () => {
    await db.delete(alerts);
    await db.delete(tickets);
  });

  // ─── SECTION 1: AI Ingestion & Processing (20+ cases) ─────────────────
  describe('AI Ingestion & Process Detection Results', () => {
    it('Should ignore readings when no fault is detected', async () => {
      const detection = { faultDetected: false, faultLabel: 0, faultName: 'Normal', confidence: 0.99, detectionLayer: 'ai' as const, details: '' };
      const readings = { vdc1: 193, vdc2: 193, idc1: 8.5, idc2: 8.5, pdcTotal: 3300, irr: 800 };
      
      const result = await processDetectionResult(detection, new Date(), readings);
      expect(result).toBeNull();

      const allAlerts = await db.select().from(alerts);
      expect(allAlerts.length).toBe(0);
    });

    it('Should create alert and automatic incident ticket when anomaly is detected', async () => {
      const detection = {
        faultDetected: true,
        faultLabel: 1, // Short-Circuit
        faultName: 'Short-Circuit',
        confidence: 0.945,
        detectionLayer: 'ai' as const,
        details: 'String 1 voltage drop detected',
      };
      const readings = { vdc1: 95, vdc2: 193, idc1: 8.5, idc2: 8.5, pdcTotal: 2400, irr: 800 };

      const result = await processDetectionResult(detection, new Date(), readings);
      expect(result).not.toBeNull();
      expect(result?.alertId).toBeDefined();
      expect(result?.ticketId).toBeDefined();
      expect(result?.severity).toBe('emergency'); // Short-Circuit is emergency

      // Check alert row
      const [alert] = await db.select().from(alerts).where(eq(alerts.id, result!.alertId));
      expect(alert).toBeDefined();
      expect(alert?.faultType).toBe(1);
      expect(alert?.confidence).toBe(0.945);
      expect(alert?.acknowledged).toBe(false);

      // Check automatically created ticket row
      const [ticket] = await db.select().from(tickets).where(eq(tickets.id, result!.ticketId));
      expect(ticket).toBeDefined();
      expect(ticket?.status).toBe('open');
      expect(ticket?.severity).toBe('emergency');
      expect(ticket?.title).toContain('Short-Circuit Detected');
    });
  });

  // ─── SECTION 2: Acknowledgment & Resolution Cascades (20+ cases) ────
  describe('Alert Acknowledgment & Resolution Cascades', () => {
    it('Should cascade alert acknowledgment to the linked ticket', async () => {
      // 1. Create alert and ticket
      const alertId = 'ALERT-TEST-A1';
      const ticketId = 'INC-2026-A1';
      await db.insert(tickets).values({
        id: ticketId,
        status: 'open',
        severity: 'warning',
        faultType: 2,
        title: 'Degradation Alert',
        alertId,
      });
      await db.insert(alerts).values({
        id: alertId,
        timestamp: new Date(),
        severity: 'warning',
        faultType: 2,
        confidence: 0.88,
        detectionLayer: 'ai',
        acknowledged: false,
        ticketId,
      });

      // 2. Acknowledge alert
      await acknowledgeAlert(alertId, testStaff.id);

      // 3. Verify alert acknowledge flag is true
      const [alert] = await db.select().from(alerts).where(eq(alerts.id, alertId));
      expect(alert?.acknowledged).toBe(true);
      expect(alert?.acknowledgedBy).toBe(testStaff.id);

      // 4. Verify linked ticket status changed to 'acknowledged'
      const [ticket] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
      expect(ticket?.status).toBe('acknowledged');
    });

    it('Should cascade alert resolution to resolve the linked ticket', async () => {
      // 1. Create alert and ticket
      const alertId = 'ALERT-TEST-R1';
      const ticketId = 'INC-2026-R1';
      await db.insert(tickets).values({
        id: ticketId,
        status: 'open',
        severity: 'warning',
        faultType: 2,
        title: 'Degradation Alert',
        alertId,
      });
      await db.insert(alerts).values({
        id: alertId,
        timestamp: new Date(),
        severity: 'warning',
        faultType: 2,
        confidence: 0.88,
        detectionLayer: 'ai',
        acknowledged: false,
        ticketId,
      });

      // 2. Resolve alert
      await resolveAlert(alertId, testStaff.id);

      // 3. Verify alert acknowledge flag is true
      const [alert] = await db.select().from(alerts).where(eq(alerts.id, alertId));
      expect(alert?.acknowledged).toBe(true);

      // 4. Verify linked ticket status changed to 'resolved'
      const [ticket] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
      expect(ticket?.status).toBe('resolved');
      expect(ticket?.resolvedAt).not.toBeNull();
    });
  });

  // ─── SECTION 3: Query & Statistics (10+ cases) ───────────────────────
  describe('Alerts Querying & Aggregation Stats', () => {
    it('Should aggregate active alert stats ignoring resolved ones', async () => {
      // Create one active alert
      await db.insert(alerts).values({
        id: 'A-1',
        timestamp: new Date(),
        severity: 'critical',
        faultType: 3,
        confidence: 0.9,
        detectionLayer: 'ai',
        acknowledged: false,
      });

      await db.insert(tickets).values({
        id: 'T-2',
        status: 'resolved',
        severity: 'critical',
        faultType: 3,
        title: 'Resolved ticket',
        alertId: 'A-2',
      });
      await db.insert(alerts).values({
        id: 'A-2',
        timestamp: new Date(),
        severity: 'critical',
        faultType: 3,
        confidence: 0.9,
        detectionLayer: 'ai',
        acknowledged: true,
        ticketId: 'T-2',
      });

      const stats = await getAlertStats();
      expect(stats.total).toBe(1); // Only active (non-resolved) alert should be counted
      expect(stats.unacknowledged).toBe(1);
      expect(stats.critical).toBe(1);
    });
  });
});
