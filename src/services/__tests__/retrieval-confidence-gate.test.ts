/**
 * Tests for retrieval-confidence-gate.ts
 *
 * Validates the confidence computation used by EXP-14 (retrieval-side
 * abstention gate). The gate must:
 * - Return null when disabled
 * - Flag low confidence on empty results
 * - Flag low confidence on narrow margin + weak top similarity
 * - NOT flag when separation is strong or top similarity is high
 * - Respect config overrides for normalizers and floor
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
  });

  it('does NOT flag single result with decent absolute similarity', () => {
    // top=0.4, second=0 → margin=0.4 → marginConf=1.0, absConf=0.8
    // confidence = 0.6*1.0 + 0.4*0.8 = 0.92 ≥ 0.3
    const res = computeRetrievalConfidence([result(0.4)], enabledCfg);
    expect(res).not.toBeNull();
    expect(res!.lowConfidence).toBe(false);
    expect(res!.margin).toBe(0.4);
  });

  it('does NOT flag when top is strong and well-separated', () => {
    const res = computeRetrievalConfidence([result(0.9), result(0.4)], enabledCfg);
    expect(res).not.toBeNull();
    expect(res!.lowConfidence).toBe(false);
    expect(res!.confidence).toBeGreaterThan(0.8);
  });

  it('flags narrow margin and weak top similarity', () => {
    // top=0.10, second=0.09 → margin=0.01
    // marginConf=0.01/0.05=0.2, absConf=0.10/0.5=0.2
    // confidence = 0.6*0.2 + 0.4*0.2 = 0.20 < 0.3
    const res = computeRetrievalConfidence([result(0.10), result(0.09)], enabledCfg);
    expect(res).not.toBeNull();
    expect(res!.lowConfidence).toBe(true);
    expect(res!.margin).toBeCloseTo(0.01, 5);
    expect(res!.confidence).toBeCloseTo(0.20, 2);
  });

  it('does NOT flag weak top when margin is strong', () => {
    // top=0.15, second=0.02 → margin=0.13 → marginConf=min(1, 0.13/0.05)=1.0
    // absConf=min(1, 0.15/0.5)=0.3
    // confidence = 0.6*1.0 + 0.4*0.3 = 0.72 ≥ 0.3
    const res = computeRetrievalConfidence([result(0.15), result(0.02)], enabledCfg);
    expect(res).not.toBeNull();
    expect(res!.lowConfidence).toBe(false);
    expect(res!.confidence).toBeCloseTo(0.72, 2);
  });

  it('respects margin normalizer override', () => {
    const narrow = computeRetrievalConfidence([result(0.25), result(0.23)], {
      retrievalConfidenceGateEnabled: true,
      retrievalConfidenceMarginNormalizer: 0.01,
    });
    // margin=0.02, normalizer=0.01 → marginConf=1.0 → confidence much higher
    expect(narrow).not.toBeNull();
    expect(narrow!.margin).toBeCloseTo(0.02, 5);
    expect(narrow!.confidence).toBeGreaterThan(0.5);
  });

  it('respects floor override', () => {
    const res = computeRetrievalConfidence([result(0.25), result(0.23)], {
      retrievalConfidenceGateEnabled: true,
      retrievalConfidenceFloor: 0.05,
    });
    // Same narrow margin, but floor is 0.05 → confidence ≈0.24 < 0.05? No, 0.24 > 0.05
    expect(res).not.toBeNull();
    expect(res!.lowConfidence).toBe(false);
  });

  it('uses similarity, not score, for computation', () => {
    // The gate reads `similarity` directly; it does not depend on `score`.
    const res = computeRetrievalConfidence(
      [{ similarity: 0.8 }, { similarity: 0.3 }],
      enabledCfg,
    );
    expect(res).not.toBeNull();
    expect(res!.topSimilarity).toBe(0.8);
    expect(res!.margin).toBe(0.5);
    expect(res!.lowConfidence).toBe(false);
  });

  it('computes exact confidence for a mid-range case', () => {
    // top=0.5, second=0.4 → margin=0.1
    // marginConf=min(1, 0.1/0.05)=1.0
    // absConf=min(1, 0.5/0.5)=1.0
    // confidence = 0.6*1.0 + 0.4*1.0 = 1.0
    const res = computeRetrievalConfidence([result(0.5), result(0.4)], enabledCfg);
    expect(res!.confidence).toBeCloseTo(1.0, 5);
    expect(res!.lowConfidence).toBe(false);
  });
});
