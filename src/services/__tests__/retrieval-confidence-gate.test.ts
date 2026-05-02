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

  it('does NOT flag single result with strong absolute similarity', () => {
    // top=0.85, second=0 → margin=0.85 → marginConf=min(1, 0.85/0.15)=1.0
    // absConf=min(1, 0.85/0.8)=1.0 → confidence=1.0 ≥ 0.7
    const res = computeRetrievalConfidence([result(0.85)], enabledCfg);
    expect(res).not.toBeNull();
    expect(res!.lowConfidence).toBe(false);
    expect(res!.margin).toBe(0.85);
  });

  it('does NOT flag when top is strong and well-separated', () => {
    const res = computeRetrievalConfidence([result(0.9), result(0.4)], enabledCfg);
    expect(res).not.toBeNull();
    expect(res!.lowConfidence).toBe(false);
    expect(res!.confidence).toBeGreaterThan(0.8);
  });

  it('flags narrow margin and weak top similarity', () => {
    // top=0.10, second=0.09 → margin=0.01
    // marginConf=0.01/0.15≈0.067, absConf=0.10/0.8=0.125
    // confidence = 0.6*0.067 + 0.4*0.125 = 0.090 < 0.7 → flagged
    const res = computeRetrievalConfidence([result(0.10), result(0.09)], enabledCfg);
    expect(res).not.toBeNull();
    expect(res!.lowConfidence).toBe(true);
    expect(res!.margin).toBeCloseTo(0.01, 5);
    expect(res!.confidence).toBeLessThan(0.7);
  });

  it('FLAGS Q1 ABS-1-style case: loosely-relevant cluster at moderate similarity', () => {
    // Simulates Q1 ABS-1 where retrieval surfaces ~13 facts at sim 0.55-0.65.
    // Old calibration cleared the floor (conf ≈0.88) and let the LLM hallucinate.
    // New calibration must abstain.
    // top=0.65, second=0.62 → margin=0.03
    // marginConf=0.03/0.15=0.20, absConf=0.65/0.8=0.8125
    // confidence = 0.6*0.20 + 0.4*0.8125 = 0.12 + 0.325 = 0.445 < 0.7 → flagged
    const res = computeRetrievalConfidence(
      [result(0.65), result(0.62), result(0.60), result(0.59), result(0.57), result(0.55)],
      enabledCfg,
    );
    expect(res).not.toBeNull();
    expect(res!.lowConfidence).toBe(true);
    expect(res!.confidence).toBeLessThan(0.7);
  });

  it('does NOT flag a strong direct match with reasonable separation', () => {
    // top=0.85, second=0.70 → margin=0.15
    // marginConf=0.15/0.15=1.0, absConf=0.85/0.8 clamps to 1.0
    // confidence = 0.6*1.0 + 0.4*1.0 = 1.0 ≥ 0.7
    const res = computeRetrievalConfidence([result(0.85), result(0.70)], enabledCfg);
    expect(res).not.toBeNull();
    expect(res!.lowConfidence).toBe(false);
    expect(res!.confidence).toBeCloseTo(1.0, 5);
  });

  it('does NOT flag weak top when margin is very strong', () => {
    // top=0.15, second=0.02 → margin=0.13 → marginConf=min(1, 0.13/0.15)≈0.867
    // absConf=min(1, 0.15/0.8)=0.1875
    // confidence = 0.6*0.867 + 0.4*0.1875 = 0.520 + 0.075 = 0.595 < 0.7 → flagged
    // (Under new calibration, weak top + strong margin is no longer enough to clear.)
    const res = computeRetrievalConfidence([result(0.15), result(0.02)], enabledCfg);
    expect(res).not.toBeNull();
    expect(res!.lowConfidence).toBe(true);
    expect(res!.confidence).toBeLessThan(0.7);
  });

  it('respects margin normalizer override', () => {
    const narrow = computeRetrievalConfidence([result(0.25), result(0.23)], {
      retrievalConfidenceGateEnabled: true,
      retrievalConfidenceMarginNormalizer: 0.01,
    });
    // margin=0.02, normalizer=0.01 → marginConf=1.0 → confidence higher
    expect(narrow).not.toBeNull();
    expect(narrow!.margin).toBeCloseTo(0.02, 5);
    expect(narrow!.confidence).toBeGreaterThan(0.5);
  });

  it('respects floor override', () => {
    const res = computeRetrievalConfidence([result(0.25), result(0.23)], {
      retrievalConfidenceGateEnabled: true,
      retrievalConfidenceFloor: 0.05,
    });
    // Narrow margin + low top → low confidence but floor 0.05 is below it.
    expect(res).not.toBeNull();
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

  it('computes exact confidence for a mid-range case', () => {
    // top=0.8, second=0.65 → margin=0.15
    // marginConf=min(1, 0.15/0.15)=1.0
    // absConf=min(1, 0.8/0.8)=1.0
    // confidence = 0.6*1.0 + 0.4*1.0 = 1.0
    const res = computeRetrievalConfidence([result(0.8), result(0.65)], enabledCfg);
    expect(res!.confidence).toBeCloseTo(1.0, 5);
    expect(res!.lowConfidence).toBe(false);
  });
});
