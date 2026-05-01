/**
 * Unit tests for the prediction-error unified signal (EXP-15).
 *
 * Covers both halves of the feature:
 *   - `computePredictionErrorScore` — score derivation from AUDN action +
 *     top-K cosine similarity to the existing memory neighborhood.
 *   - `applyPredictionErrorBoost` — retrieval-time boost stage that lifts
 *     high-error facts when the query carries a transition cue.
 */

import { describe, expect, it } from 'vitest';
import { computePredictionErrorScore } from '../prediction-error-scoring.js';
import { applyPredictionErrorBoost } from '../prediction-error-boost.js';
import { createSearchResult } from './test-fixtures.js';

const ENABLED = { predictionErrorEnabled: true, predictionErrorBoostWeight: 0.10 };
const DISABLED = { predictionErrorEnabled: false, predictionErrorBoostWeight: 0.10 };

describe('computePredictionErrorScore', () => {
  it('SUPERSEDE → 0.9 regardless of similarity', () => {
    expect(
      computePredictionErrorScore({ audnAction: 'SUPERSEDE', existingMemoryHits: [{ similarity: 0.99 }] }),
    ).toBe(0.9);
    expect(
      computePredictionErrorScore({ audnAction: 'SUPERSEDE', existingMemoryHits: [] }),
    ).toBe(0.9);
  });

  it('DELETE → 0.9 regardless of similarity', () => {
    expect(
      computePredictionErrorScore({ audnAction: 'DELETE', existingMemoryHits: [{ similarity: 0.05 }] }),
    ).toBe(0.9);
  });

  it('UPDATE with low similarity → score > 0.5 (uses surprise term)', () => {
    const score = computePredictionErrorScore({
      audnAction: 'UPDATE',
      existingMemoryHits: [{ similarity: 0.2 }],
    });
    // 1 - 0.2 = 0.8 → above the 0.5 floor.
    expect(score).toBeCloseTo(0.8, 5);
    expect(score).toBeGreaterThan(0.5);
  });

  it('UPDATE with high similarity → score = 0.5 floor', () => {
    const score = computePredictionErrorScore({
      audnAction: 'UPDATE',
      existingMemoryHits: [{ similarity: 0.9 }],
    });
    // 1 - 0.9 = 0.1 → clamped up to 0.5.
    expect(score).toBe(0.5);
  });

  it('ADD with high similarity → score near 0 (no surprise)', () => {
    const score = computePredictionErrorScore({
      audnAction: 'ADD',
      existingMemoryHits: [{ similarity: 0.95 }],
    });
    expect(score).toBeCloseTo(0.05, 5);
    expect(score).toBeLessThan(0.1);
  });

  it('ADD with low similarity → score > 0 (surprising)', () => {
    const score = computePredictionErrorScore({
      audnAction: 'ADD',
      existingMemoryHits: [{ similarity: 0.1 }],
    });
    expect(score).toBeCloseTo(0.9, 5);
    expect(score).toBeGreaterThan(0);
  });

  it('ADD with empty neighborhood → score 1.0 (fully novel)', () => {
    const score = computePredictionErrorScore({ audnAction: 'ADD', existingMemoryHits: [] });
    expect(score).toBe(1);
  });

  it('NOOP → score 0', () => {
    expect(
      computePredictionErrorScore({ audnAction: 'NOOP', existingMemoryHits: [{ similarity: 0.3 }] }),
    ).toBe(0);
  });

  it('CLARIFY → score 0', () => {
    expect(
      computePredictionErrorScore({ audnAction: 'CLARIFY', existingMemoryHits: [{ similarity: 0.4 }] }),
    ).toBe(0);
  });

  it('takes the max similarity across hits as topK', () => {
    const score = computePredictionErrorScore({
      audnAction: 'ADD',
      existingMemoryHits: [{ similarity: 0.1 }, { similarity: 0.7 }, { similarity: 0.4 }],
    });
    // topK = 0.7 → 1 - 0.7 = 0.3.
    expect(score).toBeCloseTo(0.3, 5);
  });
});

describe('applyPredictionErrorBoost', () => {
  function tagged(id: string, score: number, predictionError: number) {
    return createSearchResult({
      id,
      score,
      similarity: score,
      metadata: predictionError > 0
        ? { prediction_error_score: predictionError }
        : {},
    });
  }

  it('boosts high-error fact above similar low-error fact on transition query', () => {
    const candidates = [
      tagged('low-error', 0.85, 0.0),
      tagged('high-error', 0.80, 0.9),
    ];
    const result = applyPredictionErrorBoost({
      query: 'what does the user actually use now',
      candidates,
      config: ENABLED,
    });
    expect(result.applied).toBe(true);
    expect(result.boostedCount).toBe(1);
    // Adjusted: high-error = 0.80 + 0.10 * 0.9 = 0.89; low-error = 0.85.
    expect(result.results[0]?.id).toBe('high-error');
  });

  it('is a strict no-op when the master flag is off', () => {
    const candidates = [
      tagged('a', 0.85, 0.0),
      tagged('b', 0.80, 0.9),
    ];
    const result = applyPredictionErrorBoost({
      query: 'what does the user actually use now',
      candidates,
      config: DISABLED,
    });
    expect(result.applied).toBe(false);
    expect(result.results).toBe(candidates);
    expect(result.results.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('no-ops when the query carries no transition cue', () => {
    const candidates = [
      tagged('a', 0.85, 0.0),
      tagged('b', 0.80, 0.9),
    ];
    const result = applyPredictionErrorBoost({
      query: 'what database does the user prefer',
      candidates,
      config: ENABLED,
    });
    expect(result.applied).toBe(false);
    expect(result.results.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('no-ops when no candidate carries a prediction_error_score', () => {
    const candidates = [
      tagged('a', 0.85, 0.0),
      tagged('b', 0.80, 0.0),
    ];
    const result = applyPredictionErrorBoost({
      query: 'what is the user using now',
      candidates,
      config: ENABLED,
    });
    expect(result.applied).toBe(false);
    expect(result.results.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('no-ops on empty candidates without throwing', () => {
    const result = applyPredictionErrorBoost({
      query: 'now actually',
      candidates: [],
      config: ENABLED,
    });
    expect(result.applied).toBe(false);
    expect(result.results).toEqual([]);
  });

  it('no-ops when weight is non-positive', () => {
    const candidates = [
      tagged('a', 0.85, 0.0),
      tagged('b', 0.80, 0.9),
    ];
    const result = applyPredictionErrorBoost({
      query: 'now actually',
      candidates,
      config: { predictionErrorEnabled: true, predictionErrorBoostWeight: 0 },
    });
    expect(result.applied).toBe(false);
    expect(result.results.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('triggers on each transition keyword', () => {
    const candidates = [tagged('high-error', 0.5, 0.9)];
    for (const cue of ['actually', 'now', 'currently', 'instead', 'switch', 'change', 'contradict', 'anymore']) {
      const result = applyPredictionErrorBoost({
        query: `the user ${cue} likes coffee`,
        candidates,
        config: ENABLED,
      });
      expect(result.applied, `cue="${cue}"`).toBe(true);
    }
  });
});
