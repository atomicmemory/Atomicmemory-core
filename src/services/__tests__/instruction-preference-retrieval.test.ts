/**
 * Unit tests for instruction-preference two-stage retrieval (EXP-IF).
 *
 * Covers:
 * - flag-off: no-op (returns the input results reference unchanged).
 * - flag-on + non-instruction query: no-op (detector returns false).
 * - flag-on + instruction-style query + instruction-tagged corpus exists:
 *   instruction-tagged results surface at the top of the merged pool.
 * - mixed corpus: instruction memories surface even when their cosine
 *   similarity (and base score) is lower than non-instruction memories.
 *
 * The vector-search SQL does NOT support metadata filters today, so the
 * implementation oversamples via `searchSimilar` and post-filters by
 * `metadata.fact_role === 'instruction'`. These tests exercise that path
 * via a fake `SearchStore`.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  applyInstructionPreferenceRetrieval,
  type InstructionPreferenceRetrievalConfig,
} from '../instruction-preference-retrieval.js';
import { isInstructionStyleQuery } from '../instruction-query-detector.js';
import { createSearchResult } from './test-fixtures.js';
import type { SearchResult } from '../../db/repository-types.js';
import type { SearchStore } from '../../db/stores.js';

const USER_ID = 'user-1';
const QUERY_EMBEDDING = [0.1, 0.2, 0.3];

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

function fakeSearchStore(oversampledResults: SearchResult[]): SearchStore {
  return {
    searchSimilar: vi.fn().mockResolvedValue(oversampledResults),
    searchHybrid: vi.fn(),
    searchKeyword: vi.fn(),
    searchAtomicFactsHybrid: vi.fn(),
    findNearDuplicates: vi.fn(),
    findKeywordCandidates: vi.fn(),
    findTemporalNeighbors: vi.fn(),
    fetchMemoriesByIds: vi.fn(),
    searchSimilarInWorkspace: vi.fn(),
    findNearDuplicatesInWorkspace: vi.fn(),
  } as unknown as SearchStore;
}

describe('isInstructionStyleQuery', () => {
  it('detects instruction-style phrasings', () => {
    expect(isInstructionStyleQuery('What did I tell you to always do?')).toBe(true);
    expect(isInstructionStyleQuery("What's my preference for code style?")).toBe(true);
    expect(isInstructionStyleQuery('How should I format dates?')).toBe(true);
    expect(isInstructionStyleQuery('Remember to never use tabs')).toBe(true);
    expect(isInstructionStyleQuery('From now on, prefer arrow functions')).toBe(true);
    expect(isInstructionStyleQuery('What are my instructions?')).toBe(true);
  });

  it('returns false for non-instruction queries', () => {
    expect(isInstructionStyleQuery('Who is John?')).toBe(false);
    expect(isInstructionStyleQuery('Where did we go yesterday?')).toBe(false);
    expect(isInstructionStyleQuery('Summarize the meeting notes')).toBe(false);
  });

  it('handles empty and non-string defensively', () => {
    expect(isInstructionStyleQuery('')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isInstructionStyleQuery('ALWAYS use semicolons')).toBe(true);
    expect(isInstructionStyleQuery('What Is My Preference?')).toBe(true);
  });
});

describe('applyInstructionPreferenceRetrieval', () => {
  const baseArgs = (
    initialResults: SearchResult[],
    oversampled: SearchResult[],
    query: string,
  ) => ({
    search: fakeSearchStore(oversampled),
    userId: USER_ID,
    query,
    queryEmbedding: QUERY_EMBEDDING,
    initialResults,
    candidateDepth: 10,
  });

  it('is a no-op when the flag is off (returns input reference unchanged)', async () => {
    const initial = [makeRegularResult('a', 0.6), makeInstructionResult('b', 0.4)];
    const config: InstructionPreferenceRetrievalConfig = {
      instructionPreferenceRetrievalEnabled: false,
      instructionPreferenceTopK: 5,
    };

    const args = baseArgs(initial, [makeInstructionResult('x', 0.9)], 'how should I format X?');
    const out = await applyInstructionPreferenceRetrieval(args, config);

    expect(out.applied).toBe(false);
    expect(out.results).toBe(initial);
    expect(out.instructionCount).toBe(0);
    expect(args.search.searchSimilar).not.toHaveBeenCalled();
  });

  it('is a no-op when flag is on but the query is not instruction-style', async () => {
    const initial = [makeRegularResult('a', 0.6), makeInstructionResult('b', 0.4)];
    const config: InstructionPreferenceRetrievalConfig = {
      instructionPreferenceRetrievalEnabled: true,
      instructionPreferenceTopK: 5,
    };

    const args = baseArgs(initial, [makeInstructionResult('x', 0.9)], 'Who is John Doe?');
    const out = await applyInstructionPreferenceRetrieval(args, config);

    expect(out.applied).toBe(false);
    expect(out.results).toBe(initial);
    expect(args.search.searchSimilar).not.toHaveBeenCalled();
  });

  it('surfaces instruction-tagged results at the top when query is instruction-style', async () => {
    const initial = [
      makeRegularResult('reg-1', 0.70),
      makeRegularResult('reg-2', 0.65),
      makeRegularResult('reg-3', 0.60),
    ];
    const oversampled = [
      makeRegularResult('reg-1', 0.70),
      makeRegularResult('reg-2', 0.65),
      makeInstructionResult('instr-1', 0.50),
      makeInstructionResult('instr-2', 0.45),
      makeRegularResult('reg-3', 0.60),
    ];
    const config: InstructionPreferenceRetrievalConfig = {
      instructionPreferenceRetrievalEnabled: true,
      instructionPreferenceTopK: 2,
    };

    const args = baseArgs(initial, oversampled, 'What did I tell you about formatting?');
    const out = await applyInstructionPreferenceRetrieval(args, config);

    expect(out.applied).toBe(true);
    expect(out.instructionCount).toBe(2);
    expect(out.results.slice(0, 2).map((r) => r.id)).toEqual(['instr-1', 'instr-2']);
    // General results follow, deduped (none of reg-1..reg-3 collide with instr-*).
    expect(out.results.map((r) => r.id)).toEqual([
      'instr-1', 'instr-2', 'reg-1', 'reg-2', 'reg-3',
    ]);
  });

  it('surfaces instruction memories even when their similarity is lower than general results', async () => {
    // Mixed corpus: regular memory has higher cosine similarity (0.85), but
    // instruction memory (0.45) is what the IF query actually wants.
    const initial = [
      makeRegularResult('high-sim-reg', 0.85),
      makeRegularResult('mid-sim-reg', 0.70),
    ];
    const oversampled = [
      makeRegularResult('high-sim-reg', 0.85),
      makeRegularResult('mid-sim-reg', 0.70),
      makeInstructionResult('low-sim-instr', 0.45),
    ];
    const config: InstructionPreferenceRetrievalConfig = {
      instructionPreferenceRetrievalEnabled: true,
      instructionPreferenceTopK: 5,
    };

    const args = baseArgs(initial, oversampled, "What's my preference for date format?");
    const out = await applyInstructionPreferenceRetrieval(args, config);

    expect(out.applied).toBe(true);
    expect(out.instructionCount).toBe(1);
    // The lower-scored instruction memory must surface ahead of the higher-
    // scored regular memories — that's the whole point of the routing.
    expect(out.results[0]?.id).toBe('low-sim-instr');
    expect(out.results.map((r) => r.id)).toEqual(['low-sim-instr', 'high-sim-reg', 'mid-sim-reg']);
  });

  it('returns initialResults when instruction-style query has zero instruction-tagged matches', async () => {
    const initial = [makeRegularResult('reg-1', 0.7)];
    const oversampled = [makeRegularResult('reg-1', 0.7), makeRegularResult('reg-2', 0.5)];
    const config: InstructionPreferenceRetrievalConfig = {
      instructionPreferenceRetrievalEnabled: true,
      instructionPreferenceTopK: 5,
    };

    const args = baseArgs(initial, oversampled, 'how should I do X?');
    const out = await applyInstructionPreferenceRetrieval(args, config);

    expect(out.applied).toBe(true);
    expect(out.instructionCount).toBe(0);
    expect(out.results).toBe(initial);
  });

  it('dedupes ids that already appear in the general stage', async () => {
    const shared = makeInstructionResult('shared-1', 0.55);
    const initial = [makeRegularResult('reg-1', 0.8), shared];
    const oversampled = [
      makeRegularResult('reg-1', 0.8),
      shared,
      makeInstructionResult('instr-only', 0.4),
    ];
    const config: InstructionPreferenceRetrievalConfig = {
      instructionPreferenceRetrievalEnabled: true,
      instructionPreferenceTopK: 3,
    };

    const args = baseArgs(initial, oversampled, 'always do X');
    const out = await applyInstructionPreferenceRetrieval(args, config);

    expect(out.applied).toBe(true);
    expect(out.instructionCount).toBe(2);
    const ids = out.results.map((r) => r.id);
    // No duplicate ids in the merged pool.
    expect(new Set(ids).size).toBe(ids.length);
    // Instruction stage leads.
    expect(ids[0]).toBe('shared-1');
    expect(ids[1]).toBe('instr-only');
    // General stage follows; shared-1 already consumed and not re-added.
    expect(ids).toContain('reg-1');
  });

  it('respects topK=0 by short-circuiting to the input', async () => {
    const initial = [makeRegularResult('reg-1', 0.7)];
    const oversampled = [makeInstructionResult('instr-1', 0.6)];
    const config: InstructionPreferenceRetrievalConfig = {
      instructionPreferenceRetrievalEnabled: true,
      instructionPreferenceTopK: 0,
    };

    const args = baseArgs(initial, oversampled, 'always X');
    const out = await applyInstructionPreferenceRetrieval(args, config);

    expect(out.applied).toBe(false);
    expect(out.results).toBe(initial);
    expect(args.search.searchSimilar).not.toHaveBeenCalled();
  });

  it('passes sourceSite and referenceTime through to searchSimilar', async () => {
    const initial = [makeRegularResult('reg-1', 0.7)];
    const oversampled = [makeInstructionResult('instr-1', 0.6)];
    const config: InstructionPreferenceRetrievalConfig = {
      instructionPreferenceRetrievalEnabled: true,
      instructionPreferenceTopK: 3,
    };
    const referenceTime = new Date('2026-04-01T00:00:00Z');

    const search = fakeSearchStore(oversampled);
    const out = await applyInstructionPreferenceRetrieval(
      {
        search,
        userId: USER_ID,
        query: 'how should I format Y?',
        queryEmbedding: QUERY_EMBEDDING,
        initialResults: initial,
        candidateDepth: 10,
        sourceSite: 'example.com',
        referenceTime,
      },
      config,
    );

    expect(out.applied).toBe(true);
    expect(search.searchSimilar).toHaveBeenCalledWith(
      USER_ID,
      QUERY_EMBEDDING,
      expect.any(Number),
      'example.com',
      referenceTime,
    );
  });
});
