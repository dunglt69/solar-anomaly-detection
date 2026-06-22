/**
 * EnergiaMind — AI-Only Anomaly Detection Service v3
 * 
 * Orchestrates the fault detection pipeline using the trained InceptionTime ONNX model.
 * 
 * Fault labels (per dataset README):
 *   0 = Normal, 1 = Short-Circuit, 2 = Degradation, 3 = Open Circuit, 4 = Shadowing
 */

import { aiService, type RawReading, type AIPrediction } from './ai.service.js';

// ─── Types ──────────────────────────────────────────────────────────
export interface DetectionResult {
  faultDetected: boolean;
  faultLabel: number;
  faultName: string;
  confidence: number;
  detectionLayer: 'ai' | 'none';
  probabilities?: number[];
  details: string;
}

// ─── Detection Pipeline Orchestrator ────────────────────────────────
class DetectionService {
  /**
   * Run the AI detection pipeline on a single reading.
   */
  async detect(reading: RawReading): Promise<DetectionResult> {
    // Call AI (InceptionTime ONNX Classifier)
    const aiResult = await aiService.addReadingAndPredict(reading);

    if (aiResult) {
      const faultDetected = aiResult.faultLabel !== 0 && aiResult.confidence > 0.70;
      return {
        faultDetected,
        faultLabel: aiResult.faultLabel,
        faultName: aiResult.faultName,
        confidence: aiResult.confidence,
        detectionLayer: 'ai',
        probabilities: aiResult.probabilities,
        details: faultDetected
          ? `AI Classifier: ${aiResult.faultName} (${(aiResult.confidence * 100).toFixed(1)}%)`
          : `AI Classifier: Normal (${(aiResult.confidence * 100).toFixed(1)}%)`,
      };
    }

    // AI not warmed up (requires 24 sequence ticks) or model offline
    const statusText = aiService.isLoaded ? 'AI warming up' : 'AI offline';
    return {
      faultDetected: false,
      faultLabel: 0,
      faultName: 'Normal',
      confidence: 1.0,
      detectionLayer: 'ai',
      details: `Normal operation (${statusText})`,
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
      ],
    };
  }
}

// Singleton
export const detectionService = new DetectionService();
