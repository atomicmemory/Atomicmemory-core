/**
 * Unit tests for the EXP-05 instruction-type retrieval boost.
 *
 * Covers:
 * - feature-flag off → no-op (returns input reference, no reorder).
 * - feature-flag on → instruction-tagged results gain `boostWeight`.
 * - feature-flag on → reorders results when boost overtakes a higher base score.
 * - non-instruction results are untouched in score and identity.
 * - empty input returns the empty reference unchanged.
 * - weight is taken verbatim from config (additive, not multiplicative).
 */

import { describe, expect, it } from 'vitest';
import { applyInstructionBoost, type InstructionBoostConfig } from '../instruction-boost.js';
import { createSearchResult } from './test-fixtures.js';
import type { SearchResult } from '../../db/repository-types.js';

const QUERY = 'how should I respond?';

function makeInstructionResult(id: string, score: number): SearchResult {
  return createSearchResult({
    id,
    content: `instruction memory ${id}`,
    score,
    similarity: score,
    metadata: { fact_role: 'instruction' },
  });
}

function makeRegularResult(id: string, score: number): SearchResult {
  return createSearchResult({
    id,
    content: `regular memory ${id}`,
    score,
    similarity: score,
    metadata: {},
  });
}

describe('applyInstructionBoost', () => {
  it('returns the input reference unchanged when the flag is off', () => {
    const results = [makeInstructionResult('a', 0.4), makeRegularResult('b', 0.6)];
    const config: InstructionBoostConfig = {
      instructionBoostEnabled: false,
      instructionBoostWeight: 0.15,
    };

    const out = applyInstructionBoost(results, QUERY, config);

    expect(out).toBe(results);
    expect(out.map((r) => r.id)).toEqual(['a', 'b']);
    expect(out.map((r) => r.score)).toEqual([0.4, 0.6]);
  });

  it('adds the configured weight to instruction-tagged results', () => {
    const results = [makeInstructionResult('a', 0.50), makeRegularResult('b', 0.40)];
    const config: InstructionBoostConfig = {
      instructionBoostEnabled: true,
      instructionBoostWeight: 0.15,
    };

    const out = applyInstructionBoost(results, QUERY, config);

    const a = out.find((r) => r.id === 'a');
    const b = out.find((r) => r.id === 'b');
    expect(a?.score).toBeCloseTo(0.65, 10);
    expect(b?.score).toBe(0.40);
  });

  it('reorders results when the boost lifts an instruction past a higher-scored peer', () => {
    const results = [makeRegularResult('regular', 0.60), makeInstructionResult('instr', 0.50)];
    const config: InstructionBoostConfig = {
      instructionBoostEnabled: true,
      instructionBoostWeight: 0.15,
    };

    const out = applyInstructionBoost(results, QUERY, config);

    expect(out.map((r) => r.id)).toEqual(['instr', 'regular']);
  });

  it('does not mutate the input array or its elements', () => {
    const original = [makeInstructionResult('a', 0.5), makeRegularResult('b', 0.6)];
    const snapshot = original.map((r) => ({ id: r.id, score: r.score }));
    const config: InstructionBoostConfig = {
      instructionBoostEnabled: true,
      instructionBoostWeight: 0.2,
    };

    applyInstructionBoost(original, QUERY, config);

    expect(original.map((r) => ({ id: r.id, score: r.score }))).toEqual(snapshot);
  });

  it('is a no-op for an empty input list', () => {
    const empty: SearchResult[] = [];
    const config: InstructionBoostConfig = {
      instructionBoostEnabled: true,
      instructionBoostWeight: 0.15,
    };

    const out = applyInstructionBoost(empty, QUERY, config);

    expect(out).toBe(empty);
  });

  it('respects a weight of 0 (no effective change in scores)', () => {
    const results = [makeInstructionResult('a', 0.5), makeRegularResult('b', 0.4)];
    const config: InstructionBoostConfig = {
      instructionBoostEnabled: true,
      instructionBoostWeight: 0,
    };

    const out = applyInstructionBoost(results, QUERY, config);

    expect(out.find((r) => r.id === 'a')?.score).toBe(0.5);
    expect(out.find((r) => r.id === 'b')?.score).toBe(0.4);
    expect(out.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('skips results whose metadata.fact_role is not "instruction"', () => {
    const results = [
      createSearchResult({ id: 'other-role', score: 0.5, metadata: { fact_role: 'observation' } }),
      makeRegularResult('plain', 0.6),
    ];
    const config: InstructionBoostConfig = {
      instructionBoostEnabled: true,
      instructionBoostWeight: 0.5,
    };

    const out = applyInstructionBoost(results, QUERY, config);

    expect(out.find((r) => r.id === 'other-role')?.score).toBe(0.5);
    expect(out.find((r) => r.id === 'plain')?.score).toBe(0.6);
  });

  it('boosts every instruction-tagged result, not just the first', () => {
    const results = [
      makeInstructionResult('i1', 0.30),
      makeInstructionResult('i2', 0.20),
      makeRegularResult('r1', 0.50),
    ];
    const config: InstructionBoostConfig = {
      instructionBoostEnabled: true,
      instructionBoostWeight: 0.10,
    };

    const out = applyInstructionBoost(results, QUERY, config);

    expect(out.find((r) => r.id === 'i1')?.score).toBeCloseTo(0.40, 10);
    expect(out.find((r) => r.id === 'i2')?.score).toBeCloseTo(0.30, 10);
    expect(out.find((r) => r.id === 'r1')?.score).toBe(0.50);
    // r1 still wins (0.50 > 0.40), but both instructions retain new scores.
    expect(out.map((r) => r.id)).toEqual(['r1', 'i1', 'i2']);
  });
});
