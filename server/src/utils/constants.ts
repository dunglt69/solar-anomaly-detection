/**
 * Shared constants for EnergiaMind server.
 * Single source of truth for fault labels (SMELL-004).
 */

// ─── Fault label mapping (CORRECT per dataset README) ───────────────
export const FAULT_LABELS: Record<number, string> = {
  0: 'Normal',
  1: 'Short-Circuit',   // 1 = Short-Circuit
  2: 'Degradation',
  3: 'Open Circuit',    // 3 = Open Circuit
  4: 'Shadowing',
};
