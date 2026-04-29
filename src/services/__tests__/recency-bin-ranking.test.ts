/**
 * Unit tests for the recency-bin boost stage (EXP-12).
 */

import { describe, expect, it } from 'vitest';
import { applyRecencyBinBoost } from '../recency-bin-ranking.js';
import { createSearchResult } from './test-fixtures.js';

const NOW = new Date('2026-04-29T12:00:00.000Z');

function aged(id: string, ageMs: number, score: number) {
  return createSearchResult({
    id,
    score,
    similarity: score,
    created_at: new Date(NOW.getTime() - ageMs),
    observed_at: new Date(NOW.getTime() - ageMs),
  });
}

describe('applyRecencyBinBoost', () => {
  it('boosts the matching bin and re-sorts ties', () => {
    const candidates = [
      aged('old',     100 * 86_400_000, 1.0),
      aged('hours',   2 * 3_600_000,    0.95),
      aged('minutes', 5 * 60_000,       0.9),
    ];

    const result = applyRecencyBinBoost({
      query: 'what did I do recently',
      candidates,
      weight: 0.5,
      referenceTime: NOW,
      currentStateTriggered: false,
    });

    expect(result.applied).toBe(true);
    expect(result.queryBin).toBe('1d');
    expect(result.results[0]?.id).toBe('hours');
  });

  it('is a no-op when the flag is off (caller skips by not calling)', () => {
    // The pipeline gates on `recencyBinBoostEnabled` before calling. This
    // test asserts the function still preserves order when called with
    // weight 0, which the pipeline can use as a defense-in-depth fallback.
    const candidates = [
      aged('a', 5 * 60_000,        0.9),
      aged('b', 100 * 86_400_000,  0.8),
    ];
    const result = applyRecencyBinBoost({
      query: 'recently',
      candidates,
      weight: 0,
      referenceTime: NOW,
      currentStateTriggered: false,
    });
    expect(result.applied).toBe(false);
    expect(result.results.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('returns no-op when the query bin is not inferable', () => {
    const candidates = [
      aged('a', 5 * 60_000, 0.9),
      aged('b', 5 * 86_400_000, 0.8),
    ];
    const result = applyRecencyBinBoost({
      query: 'what database does the project use',
      candidates,
      weight: 0.5,
      referenceTime: NOW,
      currentStateTriggered: false,
    });
    expect(result.applied).toBe(false);
    expect(result.queryBin).toBe(null);
    expect(result.results.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('short-circuits when current-state-ranking already triggered', () => {
    const candidates = [
      aged('a', 5 * 60_000, 0.9),
      aged('b', 5 * 86_400_000, 0.8),
    ];
    const result = applyRecencyBinBoost({
      query: 'recently',
      candidates,
      weight: 0.5,
      referenceTime: NOW,
      currentStateTriggered: true,
    });
    expect(result.applied).toBe(false);
    expect(result.results.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('applies configured weight on exact match and adjacent bins', () => {
    const candidates = [
      aged('exact',    12 * 3_600_000, 1.0),  // 12h ⇒ 1d bin (adjacent to 10h? 10h max=36M ms; 12*3.6M=43.2M ⇒ 1d)
      aged('adjacent', 5 * 3_600_000,  1.0),  // 5h ⇒ 10h bin (adjacent to 1d)
      aged('far',      1 * 60_000,     1.0),  // 1m bin (non-adjacent)
    ];
    const result = applyRecencyBinBoost({
      query: 'yesterday',
      candidates,
      weight: 0.4,
      referenceTime: NOW,
      currentStateTriggered: false,
    });

    expect(result.applied).toBe(true);
    expect(result.queryBin).toBe('1d');
    const byId = new Map(result.results.map((r) => [r.id, r.score]));
    // Exact-match (1d) gets full weight; adjacent (10h) gets half; far (1m) gets nothing.
    expect(byId.get('exact')).toBeCloseTo(1.4, 5);
    expect(byId.get('adjacent')).toBeCloseTo(1.2, 5);
    expect(byId.get('far')).toBeCloseTo(1.0, 5);
  });

  it('recomputes bins from created_at, ignoring stale persisted hints', () => {
    // Fact stored with metadata.recency_bin='1m' but actually 5 days old.
    const stale = createSearchResult({
      id: 'stale',
      score: 1.0,
      created_at: new Date(NOW.getTime() - 5 * 86_400_000),
      metadata: { recency_bin: '1m' },
    });
    const result = applyRecencyBinBoost({
      query: 'last week',
      candidates: [stale],
      weight: 1.0,
      referenceTime: NOW,
      currentStateTriggered: false,
    });
    expect(result.applied).toBe(true);
    expect(result.queryBin).toBe('10d');
    // 5 days ⇒ '10d' bin ⇒ exact match ⇒ +1.0.
    expect(result.results[0]?.score).toBeCloseTo(2.0, 5);
  });

  it('handles empty candidates without throwing', () => {
    const result = applyRecencyBinBoost({
      query: 'recently',
      candidates: [],
      weight: 0.5,
      referenceTime: NOW,
      currentStateTriggered: false,
    });
    expect(result.applied).toBe(false);
    expect(result.results).toEqual([]);
  });
});
