/**
 * Unit tests for EXP-SUM synthesize-only periodic consolidation.
 *
 * Critical assertions:
 *   - flag-off → no-op (no synthesis, no soft-delete)
 *   - triggers exactly at multiples of summarySynthesisTurnInterval
 *   - originals are NEVER soft-deleted (this is the whole point vs EXP-08)
 *   - summary memory carries fact_role: 'summary' AND summary_of: [ids]
 *   - retrieval down-weight: summary score < non-summary for non-SUM queries
 *   - retrieval no down-weight: summary unchanged for "summarize" queries
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applySummaryDownweight,
  isSummarizationStyleQuery,
} from '../summary-downweight.js';
import { createSearchResult } from './test-fixtures.js';

const {
  mockFindConsolidationCandidates,
  mockSynthesizeCluster,
  mockEmbedText,
} = vi.hoisted(() => ({
  mockFindConsolidationCandidates: vi.fn(),
  mockSynthesizeCluster: vi.fn(),
  mockEmbedText: vi.fn(),
}));

vi.mock('../consolidation-service.js', () => ({
  findConsolidationCandidates: mockFindConsolidationCandidates,
  synthesizeCluster: mockSynthesizeCluster,
}));
vi.mock('../embedding.js', () => ({
  embedText: mockEmbedText,
}));

const {
  synthesizeSummariesForUser,
  __resetSummaryTurnCountsForTest,
  __peekSummaryTurnCountForTest,
} = await import('../summary-synthesis.js');

type DepsLike = Parameters<typeof synthesizeSummariesForUser>[0];

interface FakeMemoryStore {
  storeMemory: ReturnType<typeof vi.fn>;
  getMemory: ReturnType<typeof vi.fn>;
  softDeleteMemory: ReturnType<typeof vi.fn>;
}

function makeFakeMemoryStore(): FakeMemoryStore {
  return {
    storeMemory: vi.fn().mockResolvedValue('summary-id'),
    getMemory: vi.fn(),
    softDeleteMemory: vi.fn().mockResolvedValue(undefined),
  };
}

function makeDeps(
  memory: FakeMemoryStore,
  overrides: Partial<{ enabled: boolean; interval: number }> = {},
): DepsLike {
  return {
    config: {
      summarySynthesisEnabled: overrides.enabled ?? true,
      summarySynthesisTurnInterval: overrides.interval ?? 30,
      llmModel: 'gpt-test',
    },
    stores: { memory },
  } as unknown as DepsLike;
}

function makeMember(id: string, importance = 0.5) {
  return {
    id,
    user_id: 'u1',
    content: `fact ${id}`,
    embedding: [0.1, 0.2],
    memory_type: 'semantic',
    importance,
    source_site: 'site',
    source_url: '',
    episode_id: null,
    status: 'active',
    metadata: {},
    keywords: '',
    namespace: null,
    summary: '',
    overview: '',
    trust_score: 1,
    observed_at: new Date(),
    created_at: new Date(),
    last_accessed_at: new Date(),
    access_count: 0,
    expired_at: null,
    deleted_at: null,
    network: 'episodic',
    opinion_confidence: null,
    observation_subject: null,
  };
}

describe('synthesizeSummariesForUser', () => {
  beforeEach(() => {
    __resetSummaryTurnCountsForTest();
    mockFindConsolidationCandidates.mockReset();
    mockSynthesizeCluster.mockReset();
    mockEmbedText.mockReset();
    mockEmbedText.mockResolvedValue([0.9, 0.1]);
    mockFindConsolidationCandidates.mockResolvedValue({
      memoriesScanned: 3,
      clustersFound: 1,
      memoriesInClusters: 3,
      clusters: [
        {
          memberIds: ['m1', 'm2', 'm3'],
          memberContents: ['fact 1', 'fact 2', 'fact 3'],
          avgAffinity: 0.92,
          memberCount: 3,
        },
      ],
    });
    mockSynthesizeCluster.mockResolvedValue('Synthesized summary text.');
  });

  afterEach(() => {
    __resetSummaryTurnCountsForTest();
  });

  it('flag-off → strict no-op: no clustering, no synthesis, no store, no soft-delete', async () => {
    const memory = makeFakeMemoryStore();
    memory.getMemory.mockResolvedValue(makeMember('m1'));
    const deps = makeDeps(memory, { enabled: false });

    for (let i = 0; i < 100; i++) {
      const ids = await synthesizeSummariesForUser(deps, 'u1');
      expect(ids).toEqual([]);
    }

    expect(mockFindConsolidationCandidates).not.toHaveBeenCalled();
    expect(mockSynthesizeCluster).not.toHaveBeenCalled();
    expect(memory.storeMemory).not.toHaveBeenCalled();
    expect(memory.softDeleteMemory).not.toHaveBeenCalled();
    expect(__peekSummaryTurnCountForTest('u1')).toBe(0);
  });

  it('triggers exactly twice across 60 turns at interval 30', async () => {
    const memory = makeFakeMemoryStore();
    memory.getMemory.mockImplementation(async (id: string) => makeMember(id));
    const deps = makeDeps(memory, { enabled: true, interval: 30 });

    let triggered = 0;
    for (let i = 0; i < 60; i++) {
      const ids = await synthesizeSummariesForUser(deps, 'u1');
      if (ids.length > 0) triggered++;
    }

    expect(mockFindConsolidationCandidates).toHaveBeenCalledTimes(2);
    expect(triggered).toBe(2);
    expect(__peekSummaryTurnCountForTest('u1')).toBe(60);
  });

  it('does NOT soft-delete cluster members (the whole point vs EXP-08)', async () => {
    const memory = makeFakeMemoryStore();
    memory.getMemory.mockImplementation(async (id: string) => makeMember(id, 0.7));
    const deps = makeDeps(memory, { enabled: true, interval: 1 });

    const ids = await synthesizeSummariesForUser(deps, 'u1');
    expect(ids).toHaveLength(1);

    // Members were looked up — confirms we DID see them — but never deleted.
    expect(memory.getMemory).toHaveBeenCalledTimes(3);
    expect(memory.softDeleteMemory).not.toHaveBeenCalled();
  });

  it('summary memory carries fact_role: "summary" and summary_of: [member ids]', async () => {
    const memory = makeFakeMemoryStore();
    memory.getMemory.mockImplementation(async (id: string) => makeMember(id, 0.6));
    const deps = makeDeps(memory, { enabled: true, interval: 1 });

    await synthesizeSummariesForUser(deps, 'u1');

    expect(memory.storeMemory).toHaveBeenCalledOnce();
    const writeInput = memory.storeMemory.mock.calls[0][0];
    expect(writeInput.metadata.fact_role).toBe('summary');
    expect(writeInput.metadata.summary_of).toEqual(['m1', 'm2', 'm3']);
    expect(writeInput.content).toBe('Synthesized summary text.');
    expect(writeInput.userId).toBe('u1');
  });

  it('per-user counter is independent', async () => {
    const memory = makeFakeMemoryStore();
    memory.getMemory.mockImplementation(async (id: string) => makeMember(id));
    const deps = makeDeps(memory, { enabled: true, interval: 5 });

    for (let i = 0; i < 5; i++) await synthesizeSummariesForUser(deps, 'user-a');
    for (let i = 0; i < 4; i++) await synthesizeSummariesForUser(deps, 'user-b');

    expect(mockFindConsolidationCandidates).toHaveBeenCalledTimes(1);
  });

  it('logs and swallows errors thrown by synthesis (no propagation)', async () => {
    const memory = makeFakeMemoryStore();
    memory.getMemory.mockImplementation(async (id: string) => makeMember(id));
    mockFindConsolidationCandidates.mockRejectedValueOnce(new Error('boom'));

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps = makeDeps(memory, { enabled: true, interval: 1 });

    await expect(synthesizeSummariesForUser(deps, 'u1')).resolves.toEqual([]);
    expect(errSpy).toHaveBeenCalledOnce();
    expect(errSpy.mock.calls[0]?.[0]).toContain('summary-synthesis');
    expect(errSpy.mock.calls[0]?.[0]).toContain('boom');
    expect(memory.softDeleteMemory).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('skips clusters whose synthesized text is null (LLM error or too short)', async () => {
    const memory = makeFakeMemoryStore();
    memory.getMemory.mockImplementation(async (id: string) => makeMember(id));
    mockSynthesizeCluster.mockResolvedValueOnce(null);
    const deps = makeDeps(memory, { enabled: true, interval: 1 });

    const ids = await synthesizeSummariesForUser(deps, 'u1');
    expect(ids).toEqual([]);
    expect(memory.storeMemory).not.toHaveBeenCalled();
    expect(memory.softDeleteMemory).not.toHaveBeenCalled();
  });

  it('does nothing for non-positive intervals', async () => {
    const memory = makeFakeMemoryStore();
    const deps = makeDeps(memory, { enabled: true, interval: 0 });
    for (let i = 0; i < 10; i++) await synthesizeSummariesForUser(deps, 'u1');
    expect(mockFindConsolidationCandidates).not.toHaveBeenCalled();
  });
});

describe('isSummarizationStyleQuery', () => {
  it.each([
    ['summarize my recent notes', true],
    ['give me a summary of last week', true],
    ['what did we discuss yesterday?', true],
    ['give me an overview of project X', true],
    ['recap the design meeting', true],
    ['tl;dr of the doc', true],
    ['where did I park my car?', false],
    ['what is the capital of France?', false],
    ['who won the game?', false],
  ])('classifies %s → %s', (query, expected) => {
    expect(isSummarizationStyleQuery(query)).toBe(expected);
  });
});

describe('applySummaryDownweight', () => {
  function summary(id: string, score: number) {
    return createSearchResult({
      id,
      score,
      similarity: score,
      metadata: { fact_role: 'summary' },
    });
  }
  function regular(id: string, score: number) {
    return createSearchResult({ id, score, similarity: score, metadata: {} });
  }

  it('summary score is reduced below a non-summary peer for non-SUM queries', () => {
    const results = [summary('s1', 0.9), regular('r1', 0.5)];
    const out = applySummaryDownweight(results, 'where did I park?', {
      summaryDownweightFactor: 0.5,
    });
    const s = out.find((r) => r.id === 's1');
    const r = out.find((r) => r.id === 'r1');
    expect(s?.score).toBeCloseTo(0.45, 10);
    expect(r?.score).toBe(0.5);
    // After down-weight, regular outranks summary.
    expect(out[0].id).toBe('r1');
  });

  it('summary score is NOT penalized for summarize-style queries', () => {
    const results = [summary('s1', 0.9), regular('r1', 0.5)];
    const out = applySummaryDownweight(results, 'summarize my notes', {
      summaryDownweightFactor: 0.5,
    });
    expect(out).toBe(results);
    expect(out.find((r) => r.id === 's1')?.score).toBe(0.9);
  });

  it('returns the input reference when factor >= 1 (effective off)', () => {
    const results = [summary('s1', 0.9), regular('r1', 0.5)];
    const out = applySummaryDownweight(results, 'unrelated query', {
      summaryDownweightFactor: 1,
    });
    expect(out).toBe(results);
  });

  it('returns the input reference when no summary results are present', () => {
    const results = [regular('a', 0.6), regular('b', 0.5)];
    const out = applySummaryDownweight(results, 'unrelated query', {
      summaryDownweightFactor: 0.5,
    });
    expect(out).toBe(results);
  });
});
