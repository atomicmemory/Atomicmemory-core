/**
 * Tests for event-boundary-ranking.ts (EXP-13).
 *
 * Validates that the event-boundary boost correctly:
 * - Returns no-op when flag is off
 * - Boosts results with metadata.event_boundary === true
 * - Scales boost by boundary_strength when present
 * - Re-sorts results after boosting
 */

import { describe, it, expect } from 'vitest';
import { applyEventBoundaryBoost } from '../event-boundary-ranking.js';
import type { SearchResult } from '../../db/repository-types.js';

function makeResult(id: string, score: number, metadata?: Record<string, unknown>): SearchResult {
  return {
    id,
    content: `fact-${id}`,
    score,
    similarity: 0.5,
    importance: 0.5,
    user_id: 'u1',
    source_site: 'test',
    source_url: '',
    session_id: null,
    created_at: new Date(),
    metadata: metadata ?? {},
  } as unknown as SearchResult;
}

describe('applyEventBoundaryBoost', () => {
  it('returns no-op when flag is off', () => {
    const results = [makeResult('a', 1.0), makeResult('b', 0.9)];
    const res = applyEventBoundaryBoost(results, {
      eventBoundaryBoostEnabled: false,
      eventBoundaryBoostWeight: 0.4,
    });
    expect(res.applied).toBe(false);
    expect(res.boostedCount).toBe(0);
    expect(res.results).toBe(results);
  });

  it('returns no-op when no results have boundary marker', () => {
    const results = [makeResult('a', 1.0), makeResult('b', 0.9)];
    const res = applyEventBoundaryBoost(results, {
      eventBoundaryBoostEnabled: true,
      eventBoundaryBoostWeight: 0.4,
    });
    expect(res.applied).toBe(false);
    expect(res.boostedCount).toBe(0);
  });

  it('boosts boundary results and re-sorts', () => {
    const results = [
      makeResult('a', 0.9),
      makeResult('b', 0.8, { event_boundary: true }),
      makeResult('c', 0.7),
    ];
    const res = applyEventBoundaryBoost(results, {
      eventBoundaryBoostEnabled: true,
      eventBoundaryBoostWeight: 0.4,
    });
    expect(res.applied).toBe(true);
    expect(res.boostedCount).toBe(1);
    expect(res.results[0].id).toBe('b'); // boosted to 1.2
    expect(res.results[0].score).toBeCloseTo(1.2, 5);
  });

  it('scales boost by boundary_strength', () => {
    const results = [
      makeResult('a', 0.9),
      makeResult('b', 0.8, { event_boundary: true, boundary_strength: 0.5 }),
    ];
    const res = applyEventBoundaryBoost(results, {
      eventBoundaryBoostEnabled: true,
      eventBoundaryBoostWeight: 0.4,
    });
    expect(res.boostedCount).toBe(1);
    // 0.8 + 0.4 * 0.5 = 1.0
    expect(res.results[0].score).toBeCloseTo(1.0, 5);
  });

  it('defaults strength to 1.0 when not present', () => {
    const results = [
      makeResult('a', 0.9),
      makeResult('b', 0.8, { event_boundary: true }),
    ];
    const res = applyEventBoundaryBoost(results, {
      eventBoundaryBoostEnabled: true,
      eventBoundaryBoostWeight: 0.4,
    });
    expect(res.results[0].score).toBeCloseTo(1.2, 5);
  });

  it('ignores event_boundary: false', () => {
    const results = [
      makeResult('a', 0.9),
      makeResult('b', 0.8, { event_boundary: false }),
    ];
    const res = applyEventBoundaryBoost(results, {
      eventBoundaryBoostEnabled: true,
      eventBoundaryBoostWeight: 0.4,
    });
    expect(res.applied).toBe(false);
    expect(res.boostedCount).toBe(0);
  });

  it('clamps strength to [0,1]', () => {
    const results = [
      makeResult('a', 0.9),
      makeResult('b', 0.8, { event_boundary: true, boundary_strength: 2.0 }),
    ];
    const res = applyEventBoundaryBoost(results, {
      eventBoundaryBoostEnabled: true,
      eventBoundaryBoostWeight: 0.4,
    });
    // 0.8 + 0.4 * 1.0 = 1.2
    expect(res.results[0].score).toBeCloseTo(1.2, 5);
  });
});
