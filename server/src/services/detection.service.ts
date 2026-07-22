/**
 * EnergiaMind — AI-Only Anomaly Detection Service v3
 * 
 * Orchestrates the fault detection pipeline using the trained InceptionTime ONNX model.
 * 
 * Fault labels (per dataset README):
 *   0 = Normal, 1 = Short-Circuit, 2 = Degradation, 3 = Open Circuit, 4 = Shadowing
 */

import { aiService, type RawReading, type AIPrediction } from './ai.service.js';
import { db } from '../db/index.js';
import { config } from '../db/schema.js';
import { eq } from 'drizzle-orm';

// ─── Types ──────────────────────────────────────────────────────────
export interface DetectionResult {
  faultDetected: boolean;
  faultLabel: number;
  faultName: string;
  confidence: number;
  detectionLayer: 'ai' | 'rule' | 'none';
  probabilities?: number[];
  details: string;
}

const FAULT_NAMES: Record<number, string> = {
  0: 'Normal',
  1: 'Short-Circuit',
  2: 'Degradation',
  3: 'Open Circuit',
  4: 'Shadowing',
};

const DEFAULT_CONFIDENCE_THRESHOLD = 0.70;

// ─── Detection Pipeline Orchestrator ────────────────────────────────
class DetectionService {
  private confidenceThreshold = DEFAULT_CONFIDENCE_THRESHOLD;
  private lastConfigFetch = 0;
  private readonly CONFIG_CACHE_MS = 60_000;

  private async getConfidenceThreshold(): Promise<number> {
    if (Date.now() - this.lastConfigFetch < this.CONFIG_CACHE_MS) {
      return this.confidenceThreshold;
    }
    try {
      const [dsRow] = await db.select({ value: config.value })
        .from(config)
        .where(eq(config.key, 'detection_sensitivity'))
        .limit(1);
      
      let sensitivityVal: number | null = null;
      if (dsRow?.value !== undefined && dsRow?.value !== null) {
        const val = typeof dsRow.value === 'object' ? NaN : Number(dsRow.value);
        if (isFinite(val) && val >= 0.1 && val <= 1.0) {
          sensitivityVal = val;
        }
      }

      if (sensitivityVal !== null) {
        this.confidenceThreshold = sensitivityVal;
      } else {
        const [row] = await db.select({ value: config.value })
          .from(config)
          .where(eq(config.key, 'ai_confidence_threshold'))
          .limit(1);
        if (row?.value && typeof row.value === 'object' && 'min' in row.value) {
          const v = Number((row.value as Record<string, unknown>).min);
          if (isFinite(v) && v > 0 && v < 1) this.confidenceThreshold = v;
        }
      }
    } catch {
      // DB unavailable — use cached value
    }
    this.lastConfigFetch = Date.now();
    return this.confidenceThreshold;
  }

  /**
   * Rule-based fallback for warm-up period or when AI is offline.
   * Catches obvious faults using simple physical heuristics.
   */
  private ruleBasedDetect(reading: RawReading): DetectionResult {
    const pdc1 = reading.vdc1 * reading.idc1;
    const pdc2 = reading.vdc2 * reading.idc2;

    // Short-circuit: voltage near zero but irradiance high
    if (reading.irr > 100 && (reading.vdc1 < 5 || reading.vdc2 < 5) && (reading.idc1 > 5 || reading.idc2 > 5)) {
      return {
        faultDetected: true, faultLabel: 1, faultName: 'Short-Circuit',
        confidence: 0.60, detectionLayer: 'rule',
        details: 'Rule-based: near-zero voltage with high current under irradiance',
      };
    }

    // Open circuit: current near zero but irradiance high and voltage present
    if (reading.irr > 100 && (reading.idc1 < 0.1 && reading.idc2 < 0.1) && (reading.vdc1 > 20 || reading.vdc2 > 20)) {
      return {
        faultDetected: true, faultLabel: 3, faultName: 'Open Circuit',
        confidence: 0.55, detectionLayer: 'rule',
        details: 'Rule-based: near-zero current with voltage present under irradiance',
      };
    }

    return {
      faultDetected: false, faultLabel: 0, faultName: 'Normal',
      confidence: 0.0, detectionLayer: 'none',
      details: 'Normal operation (AI warming up — rule-based fallback active)',
    };
  }

  /**
   * Run the AI detection pipeline on a single reading.
   */
  async detect(reading: RawReading, streamId: string = 'default'): Promise<DetectionResult> {
    const threshold = await this.getConfidenceThreshold();

    // Call AI (InceptionTime ONNX Classifier)
    const aiResult = await aiService.addReadingAndPredict(reading, streamId);

    if (aiResult) {
      const faultDetected = aiResult.faultLabel !== 0 && aiResult.confidence > threshold;
      let details: string;
      if (aiResult.faultLabel === 0) {
        details = `AI Classifier: Normal (${(aiResult.confidence * 100).toFixed(1)}%)`;
      } else if (faultDetected) {
        details = `AI Classifier: ${aiResult.faultName} (${(aiResult.confidence * 100).toFixed(1)}%)`;
      } else {
        // Predicted fault class but below confidence gate — do not mislabel as Normal
        details =
          `AI Classifier: ${aiResult.faultName} below threshold ` +
          `(${(aiResult.confidence * 100).toFixed(1)}% ≤ ${(threshold * 100).toFixed(0)}%)`;
      }
      return {
        faultDetected,
        faultLabel: faultDetected ? aiResult.faultLabel : 0,
        faultName: faultDetected ? aiResult.faultName : 'Normal',
        confidence: aiResult.confidence,
        detectionLayer: 'ai',
        probabilities: aiResult.probabilities,
        details,
      };
    }

    // AI not warmed up or offline — use rule-based fallback
    if (aiService.isLoaded) {
      return this.ruleBasedDetect(reading);
    }

    return {
      faultDetected: false,
      faultLabel: 0,
      faultName: 'Normal',
      confidence: 0.0,
      detectionLayer: 'none',
      details: 'Normal operation (AI offline)',
    };
  }

  /**
   * Get current AI status.
   */
  getStatus() {
    return {
      aiLoaded: aiService.isLoaded,
      layers: [
        { name: 'AI (InceptionTime)', status: aiService.isLoaded ? 'active' : 'unavailable' },
        { name: 'Rule-based (fallback)', status: 'standby' },
      ],
    };
  }
}

// Singleton
export const detectionService = new DetectionService();
