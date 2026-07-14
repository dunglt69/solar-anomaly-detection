/**
 * EnergiaMind — AI Inference Service v3 (InceptionTime)
 * 
 * Loads ONNX model and provides fault classification via InceptionTime.
 * Maintains a sliding window buffer of 24 readings × 13 features.
 * 
 * Base features (9): vdc1, vdc2, idc1, idc2, irr, pvt, pdc1, pdc2, pdc_total
 * Ratio features (4): vdc_ratio, idc_ratio, vdc_diff, idc_diff
 * Total: 13 features
 * 
 * Input tensor: [1, 13, 24] (batch, channels, seq_len) — Conv1d format
 * Classes (5): 0=Normal, 1=Short-Circuit, 2=Degradation, 3=Open Circuit, 4=Shadowing
 * 
 * Architecture: InceptionTime (depth=6, filters=32, kernels=5/11/23)
 * Accuracy: 99.80%, Macro F1: 0.9975
 */

import * as ort from 'onnxruntime-node';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = join(__dirname, '..', '..', 'models');

// Expected SHA-256 checksums for model integrity verification
const EXPECTED_CHECKSUMS: Record<string, string> = {
  'inception_fault_classifier.onnx': '90bf37a30138ebf53998a53cf27f79ca3aef5de5c766a85e369707ba4882ce18',
  'scaler_params.json': '513cc410d533916c044304a2d4ac73bb44083896218fa4adb43224e6c345cf71',
};

// Physical limits for sensor readings
const READING_BOUNDS = {
  vdc1: { min: 0, max: 1000 },
  vdc2: { min: 0, max: 1000 },
  idc1: { min: -50, max: 50 },
  idc2: { min: -50, max: 50 },
  irr:  { min: 0, max: 1500 },
  pvt:  { min: -40, max: 100 },
} as const;

// ─── Types ──────────────────────────────────────────────────────────
interface ScalerParams {
  features: string[];
  params: Record<string, { min: number; max: number; range: number }>;
  scaler_type: string;
  window_size: number;
  num_classes: number;
  num_features: number;
  class_names: Record<string, string>;
}

export interface AIPrediction {
  faultLabel: number;
  faultName: string;
  confidence: number;
  probabilities: number[];
}

export interface RawReading {
  vdc1: number;
  vdc2: number;
  idc1: number;
  idc2: number;
  irr: number;
  pvt: number;
}

// ─── Correct fault label names (per dataset README) ─────────────────
const CLASS_NAMES: Record<number, string> = {
  0: 'Normal',
  1: 'Short-Circuit',
  2: 'Degradation',
  3: 'Open Circuit',
  4: 'Shadowing',
};

const NUM_BASE_FEATURES = 9;
const NUM_RATIO_FEATURES = 4;
const NUM_TOTAL_FEATURES = NUM_BASE_FEATURES + NUM_RATIO_FEATURES; // 13

// ─── Feature computation ────────────────────────────────────────────
/**
 * Validate that a reading's values are within physical sensor limits.
 * Returns null if valid, or a description of the violation.
 */
export function validateReadingBounds(reading: RawReading): string | null {
  for (const [key, bounds] of Object.entries(READING_BOUNDS)) {
    const value = reading[key as keyof RawReading];
    if (!isFinite(value)) return `${key} is not finite (${value})`;
    if (value < bounds.min || value > bounds.max) {
      return `${key}=${value} outside physical range [${bounds.min}, ${bounds.max}]`;
    }
  }
  return null;
}

function computeBaseFeatures(reading: RawReading): number[] {
  const pdc1 = reading.vdc1 * reading.idc1;
  const pdc2 = reading.vdc2 * reading.idc2;
  const pdcTotal = pdc1 + pdc2;

  // 9 base features in same order as training
  return [
    reading.vdc1, reading.vdc2,
    reading.idc1, reading.idc2,
    reading.irr, reading.pvt,
    pdc1, pdc2, pdcTotal,
  ];
}

function addRatioFeatures(baseFeatures: number[]): number[] {
  const vdc1 = baseFeatures[0]!;
  const vdc2 = baseFeatures[1]!;
  const idc1 = baseFeatures[2]!;
  const idc2 = baseFeatures[3]!;

  const thresh = 1e-6;

  // Safe ratio: only compute where denominator > threshold, else 1.0
  let vdcRatio = vdc2 > thresh ? vdc1 / vdc2 : 1.0;
  let idcRatio = idc2 > thresh ? idc1 / idc2 : 1.0;

  // Clamp to [0, 5]
  vdcRatio = Math.max(0, Math.min(5, vdcRatio));
  idcRatio = Math.max(0, Math.min(5, idcRatio));

  const vdcDiff = Math.abs(vdc1 - vdc2);
  const idcDiff = Math.abs(idc1 - idc2);

  return [...baseFeatures, vdcRatio, idcRatio, vdcDiff, idcDiff];
}

// ─── AI Inference Service ───────────────────────────────────────────
class AIInferenceService {
  private session: ort.InferenceSession | null = null;
  private scaler: ScalerParams | null = null;
  private windowBuffer: number[][] = [];
  private loaded = false;

  get isLoaded(): boolean {
    return this.loaded;
  }

  async initialize(): Promise<boolean> {
    const inceptionPath = join(MODELS_DIR, 'inception_fault_classifier.onnx');
    const scalerPath = join(MODELS_DIR, 'scaler_params.json');

    if (!existsSync(inceptionPath)) {
      console.warn(`[AI] InceptionTime model not found at ${inceptionPath} — running in rules-only mode`);
      return false;
    }

    if (!existsSync(scalerPath)) {
      console.warn(`[AI] Scaler not found at ${scalerPath} — running in rules-only mode`);
      return false;
    }

    try {
      // Verify file integrity before loading (CRIT-002)
      if (!this.verifyChecksum(inceptionPath, 'inception_fault_classifier.onnx')) return false;
      if (!this.verifyChecksum(scalerPath, 'scaler_params.json')) return false;

      const rawScaler = JSON.parse(readFileSync(scalerPath, 'utf-8'));

      // Schema validation for scaler_params.json (HIGH-004)
      if (!rawScaler.features || !Array.isArray(rawScaler.features) || rawScaler.features.length === 0) {
        console.error('[AI] Invalid scaler: missing or empty features array');
        return false;
      }
      if (!rawScaler.params || typeof rawScaler.params !== 'object') {
        console.error('[AI] Invalid scaler: missing params object');
        return false;
      }
      if (typeof rawScaler.window_size !== 'number' || rawScaler.window_size < 1) {
        console.error('[AI] Invalid scaler: invalid window_size');
        return false;
      }
      for (const feat of rawScaler.features) {
        const p = rawScaler.params[feat];
        if (!p || typeof p.min !== 'number' || typeof p.max !== 'number') {
          console.error(`[AI] Invalid scaler: missing or invalid params for feature "${feat}"`);
          return false;
        }
      }

      this.scaler = rawScaler;
      console.log(`[AI] Scaler loaded: ${this.scaler!.features.length} features, ` +
        `window=${this.scaler!.window_size}, type=${this.scaler!.scaler_type || 'zscore'}`);

      this.session = await ort.InferenceSession.create(inceptionPath, {
        executionProviders: ['cpu'],
      });
      console.log(`[AI] InceptionTime ONNX model loaded successfully`);

      this.loaded = true;
      return true;
    } catch (err) {
      console.error('[AI] Failed to load model:', err);
      return false;
    }
  }

  private verifyChecksum(filePath: string, fileName: string): boolean {
    const expected = EXPECTED_CHECKSUMS[fileName];
    if (!expected) {
      console.warn(`[AI] No checksum registered for ${fileName} — skipping integrity check`);
      return true;
    }
    const fileBuffer = readFileSync(filePath);
    const actual = createHash('sha256').update(fileBuffer).digest('hex');
    if (actual !== expected) {
      console.error(`[AI] INTEGRITY CHECK FAILED for ${fileName}!`);
      console.error(`[AI]   Expected: ${expected}`);
      console.error(`[AI]   Actual:   ${actual}`);
      console.error(`[AI]   The file may have been tampered with. Refusing to load.`);
      return false;
    }
    console.log(`[AI] Integrity verified for ${fileName}`);
    return true;
  }

  /**
   * Add a reading to the sliding window and predict if window is full.
   */
  async addReadingAndPredict(reading: RawReading): Promise<AIPrediction | null> {
    if (!this.loaded || !this.session || !this.scaler) return null;

    // Validate input bounds (HIGH-001)
    const boundsError = validateReadingBounds(reading);
    if (boundsError) {
      console.warn(`[AI] Reading rejected — out of physical bounds: ${boundsError}`);
      return null;
    }

    const windowSize = this.scaler.window_size;

    // Compute 9 base features (raw)
    const baseFeatures = computeBaseFeatures(reading);

    // Add ratio features on RAW values (before normalization) — matches training pipeline
    const allRawFeatures = addRatioFeatures(baseFeatures);

    // Normalize ALL 13 features using MinMax scaler
    const fullFeatures = allRawFeatures.map((val, i) => {
      const col = this.scaler!.features[i]!;
      const p = this.scaler!.params[col]!;

      if (this.scaler!.scaler_type === 'minmax') {
        return p.range > 0 ? (val - p.min) / p.range : 0;
      }
      return (val - (p as any).mean) / (p as any).std;
    });

    // Sanitize: replace NaN/Inf with 0, but log a warning (MED-002)
    for (let i = 0; i < fullFeatures.length; i++) {
      if (!isFinite(fullFeatures[i]!)) {
        console.warn(`[AI] NaN/Inf detected at feature index ${i} (${this.scaler.features[i]}), replacing with 0`);
        fullFeatures[i] = 0;
      }
    }

    // Add to window buffer
    this.windowBuffer.push(fullFeatures);
    if (this.windowBuffer.length > windowSize) {
      this.windowBuffer.shift();
    }

    // Need full window for prediction
    if (this.windowBuffer.length < windowSize) {
      return null;
    }

    return this.predict(this.windowBuffer, windowSize);
  }

  private async predict(window: number[][], windowSize: number): Promise<AIPrediction> {
    const numFeatures = window[0]!.length; // 13 for InceptionTime, 9 for legacy

    // InceptionTime expects Conv1d format: [batch, channels, seq_len]
    // Transpose from [seq_len, features] to [features, seq_len]
    const flat = new Float32Array(numFeatures * windowSize);
    for (let ch = 0; ch < numFeatures; ch++) {
      for (let t = 0; t < windowSize; t++) {
        flat[ch * windowSize + t] = window[t]![ch]!;
      }
    }

    const inputTensor = new ort.Tensor('float32', flat, [1, numFeatures, windowSize]);
    const results = await this.session!.run({ input: inputTensor });
    const output = results['output']!;
    const logits = Array.from(output.data as Float32Array);

    // Softmax
    const maxLogit = Math.max(...logits);
    const exps = logits.map(l => Math.exp(l - maxLogit));
    const sumExp = exps.reduce((a, b) => a + b, 0);
    const probabilities = exps.map(e => e / sumExp);

    const faultLabel = probabilities.indexOf(Math.max(...probabilities));
    const confidence = probabilities[faultLabel]!;

    return {
      faultLabel,
      faultName: CLASS_NAMES[faultLabel] || `Unknown(${faultLabel})`,
      confidence,
      probabilities,
    };
  }

  /**
   * Reset the sliding window (e.g., on new session).
   */
  reset(): void {
    this.windowBuffer = [];
  }
}

// Singleton instance
export const aiService = new AIInferenceService();
