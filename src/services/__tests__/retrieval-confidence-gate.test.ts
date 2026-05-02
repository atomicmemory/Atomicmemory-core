/**
 * Tests for retrieval-confidence-gate.ts
 *
 * Validates the confidence computation used by EXP-14 (retrieval-side
 * abstention gate). After Fix A v2:
 *   - Inputs are sorted by similarity inside the gate; ranking by score is
 *     not assumed.
 *   - Absolute signal is mean(top-K), not top-1.
 *   - Weights: 0.2 margin, 0.8 absolute.
 *   - Defaults: margin_norm=0.15, sim_norm=0.85, floor=0.6, top_k_window=3.
 */

import { describe, it, expect } from 'vitest';
import { computeRetrievalConfidence } from '../retrieval-confidence-gate.js';

function result(similarity: number): { similarity: number } {
  return { similarity };
}

const enabledCfg = {
  retrievalConfidenceGateEnabled: true,
} as const;

const disabledCfg = {
  retrievalConfidenceGateEnabled: false,
} as const;

describe('computeRetrievalConfidence', () => {
  it('returns null when the gate is disabled', () => {
    const res = computeRetrievalConfidence([result(0.9), result(0.8)], disabledCfg);
    expect(res).toBeNull();
  });

  it('flags low confidence on empty results', () => {
    const res = computeRetrievalConfidence([], enabledCfg);
    expect(res).not.toBeNull();
    expect(res!.lowConfidence).toBe(true);
    expect(res!.confidence).toBe(0);
    expect(res!.topSimilarity).toBe(0);
    expect(res!.margin).toBe(0);
    expect(res!.topKMean).toBe(0);
  });

  it('sorts by similarity even when input is unordered (margin must be >= 0)', () => {
    // Input is in score-rank order with similarities NOT monotonic.
    // top-1 by score has lower similarity than top-2 — gate must sort.
    const res = computeRetrievalConfidence(
      [result(0.4), result(0.7), result(0.5)],
      enabledCfg,
    );
    expect(res).not.toBeNull();
    // After sort: [0.7, 0.5, 0.4]
    expect(res!.topSimilarity).toBe(0.7);
    expect(res!.margin).toBeCloseTo(0.2, 5);
    expect(res!.topKMean).toBeCloseTo((0.7 + 0.5 + 0.4) / 3, 5);
  });

  it('FLAGS ABS-1-style case: cluster at sim 0.5–0.57 (calibrated on conv-1)', () => {
    // Empirical conv-1 ABS-1: sorted top-3 = [0.566, 0.543, 0.496].
    // mean = 0.535; absConf = 0.535/0.85 = 0.629
    // margin = 0.023; marginConf = 0.023/0.15 = 0.153
    // confidence = 0.2*0.153 + 0.8*0.629 = 0.534 < 0.6 → flag
    const res = computeRetrievalConfidence(
      [result(0.566), result(0.543), result(0.496), result(0.485), result(0.480)],
      enabledCfg,
    );
    expect(res).not.toBeNull();
    expect(res!.lowConfidence).toBe(true);
    expect(res!.confidence).toBeLessThan(0.6);
    expect(res!.confidence).toBeCloseTo(0.534, 2);
  });

  it('FLAGS ABS-2-style case: cluster at sim 0.5–0.59 (calibrated on conv-1)', () => {
    // Empirical conv-1 ABS-2: sorted top-3 = [0.589, 0.566, 0.496].
    // mean = 0.550; absConf = 0.550/0.85 = 0.647
    // margin = 0.023; marginConf = 0.023/0.15 = 0.153
    // confidence = 0.2*0.153 + 0.8*0.647 = 0.548 < 0.6 → flag
    const res = computeRetrievalConfidence(
      [result(0.589), result(0.566), result(0.496), result(0.496), result(0.496)],
      enabledCfg,
    );
    expect(res).not.toBeNull();
    expect(res!.lowConfidence).toBe(true);
    expect(res!.confidence).toBeLessThan(0.6);
    expect(res!.confidence).toBeCloseTo(0.548, 2);
  });

  it('does NOT flag PF-1-style case: tight cluster at sim 0.639', () => {
    // Empirical conv-1 PF-1: top-5 all sim = 0.639.
    // mean = 0.639; absConf = 0.639/0.85 = 0.752
    // margin = 0; marginConf = 0
    // confidence = 0.2*0 + 0.8*0.752 = 0.601 ≥ 0.6 → pass
    const res = computeRetrievalConfidence(
      [result(0.639), result(0.639), result(0.639), result(0.639), result(0.639)],
      enabledCfg,
    );
    expect(res).not.toBeNull();
    expect(res!.lowConfidence).toBe(false);
    expect(res!.confidence).toBeGreaterThanOrEqual(0.6);
    expect(res!.margin).toBe(0);
  });

  it('does NOT flag KU-1-style case: top sim ~0.73 with thin margin', () => {
    // Empirical conv-1 KU-1: sorted top-5 = [0.733, 0.670, 0.670, 0.669, 0.639].
    // mean(top-3) = 0.691; absConf = 0.691/0.85 = 0.813
    // margin = 0.063; marginConf = 0.063/0.15 = 0.42
    // confidence = 0.2*0.42 + 0.8*0.813 = 0.734 ≥ 0.6 → pass
    const res = computeRetrievalConfidence(
      [result(0.733), result(0.670), result(0.670), result(0.669), result(0.639)],
      enabledCfg,
    );
    expect(res).not.toBeNull();
    expect(res!.lowConfidence).toBe(false);
    expect(res!.confidence).toBeCloseTo(0.734, 2);
  });

  it('does NOT flag TR-1-style case: strong top with moderate dropoff', () => {
    // Empirical conv-1 TR-1: sorted top-5 = [0.743, 0.685, 0.655, 0.626, 0.567].
    // mean(top-3) = 0.694; absConf = 0.694/0.85 = 0.816
    // margin = 0.058; marginConf = 0.058/0.15 = 0.387
    // confidence = 0.2*0.387 + 0.8*0.816 = 0.730 ≥ 0.6 → pass
    const res = computeRetrievalConfidence(
      [result(0.743), result(0.685), result(0.655), result(0.626), result(0.567)],
      enabledCfg,
    );
    expect(res).not.toBeNull();
    expect(res!.lowConfidence).toBe(false);
    expect(res!.confidence).toBeCloseTo(0.730, 2);
  });

  it('does NOT flag a strong direct match', () => {
    // top-3 = [0.9, 0.85, 0.8]; mean = 0.85; absConf = 1.0 (clamped)
    // margin = 0.05; marginConf = 0.333
    // confidence = 0.2*0.333 + 0.8*1.0 = 0.867 ≥ 0.6 → pass
    const res = computeRetrievalConfidence(
      [result(0.9), result(0.85), result(0.8)],
      enabledCfg,
    );
    expect(res).not.toBeNull();
    expect(res!.lowConfidence).toBe(false);
    expect(res!.confidence).toBeGreaterThan(0.8);
  });

  it('flags weak retrieval at sim ~0.1 (clear abstention case)', () => {
    // top-3 = [0.10, 0.09, 0.08]; mean = 0.09; absConf = 0.106
    // margin = 0.01; marginConf = 0.067
    // confidence = 0.2*0.067 + 0.8*0.106 = 0.098 < 0.6 → flag
    const res = computeRetrievalConfidence(
      [result(0.10), result(0.09), result(0.08)],
      enabledCfg,
    );
    expect(res).not.toBeNull();
    expect(res!.lowConfidence).toBe(true);
    expect(res!.confidence).toBeLessThan(0.2);
  });

  it('respects margin normalizer override', () => {
    const narrow = computeRetrievalConfidence([result(0.25), result(0.23)], {
      retrievalConfidenceGateEnabled: true,
      retrievalConfidenceMarginNormalizer: 0.01,
    });
    expect(narrow).not.toBeNull();
    expect(narrow!.margin).toBeCloseTo(0.02, 5);
    // With margin_norm=0.01, marginConf saturates → bigger composite.
    expect(narrow!.confidence).toBeGreaterThan(0.2);
  });

  it('respects floor override', () => {
    const res = computeRetrievalConfidence([result(0.5), result(0.49), result(0.48)], {
      retrievalConfidenceGateEnabled: true,
      retrievalConfidenceFloor: 0.05,
    });
    // Confidence is moderate; floor 0.05 is well below it → pass.
    expect(res).not.toBeNull();
    expect(res!.lowConfidence).toBe(false);
  });

  it('respects topKWindow override (window=1 reduces to top-1 absolute)', () => {
    // Sorted: [0.9, 0.5, 0.5]; with topKWindow=1, mean = 0.9
    // absConf = 0.9/0.85 = clamp 1.0; margin = 0.4; marginConf = 1.0
    // confidence = 0.2*1.0 + 0.8*1.0 = 1.0
    const res = computeRetrievalConfidence([result(0.9), result(0.5), result(0.5)], {
      retrievalConfidenceGateEnabled: true,
      retrievalConfidenceTopKWindow: 1,
    });
    expect(res).not.toBeNull();
    expect(res!.topKMean).toBeCloseTo(0.9, 5);
    expect(res!.lowConfidence).toBe(false);
  });

  it('uses similarity, not score, for computation', () => {
    const res = computeRetrievalConfidence(
      [{ similarity: 0.85 }, { similarity: 0.3 }],
      enabledCfg,
    );
    expect(res).not.toBeNull();
    expect(res!.topSimilarity).toBe(0.85);
    expect(res!.margin).toBeCloseTo(0.55, 5);
    expect(res!.lowConfidence).toBe(false);
  });
});
