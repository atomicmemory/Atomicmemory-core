/**
 * Tests for topic-aware-retrieval.ts (EXP-23).
 *
 * Validates the gating contract — the stage is a strict no-op unless
 * (a) the flag is on, AND (b) a topic noun is extractable, AND (c) the
 * topic-search returns at least one fact. When applied, results are
 * sorted chronologically by `created_at`.
 *
 * The DB layer is mocked; no postgres required.
 */

import { describe, it, expect, vi } from 'vitest';
import { applyTopicAwareRetrieval } from '../topic-aware-retrieval.js';

vi.mock('../embedding.js', () => ({
  embedText: vi.fn(async () => Array(8).fill(0)),
}));

function fact(id: string, content: string, createdAt: string, similarity = 0.5) {
  return {
    id,
    content,
    similarity,
    score: similarity,
    namespace: 'global',
    user_id: 'u',
    created_at: new Date(createdAt),
    metadata: {},
    source_site: undefined,
  } as unknown as Parameters<typeof applyTopicAwareRetrieval>[3] extends never ? never : any;
}

const enabledCfg = { topicAwareRetrievalEnabled: true, topicRetrievalK: 30 };
const disabledCfg = { topicAwareRetrievalEnabled: false, topicRetrievalK: 30 };

describe('applyTopicAwareRetrieval', () => {
  it('is a strict no-op when the flag is off', async () => {
    const search = { searchSimilar: vi.fn() } as unknown as Parameters<typeof applyTopicAwareRetrieval>[0]['search'];
    const candidate = [fact('a', 'something', '2026-04-01')];

    const out = await applyTopicAwareRetrieval(
      { search },
      'user-x',
      'List the order in which I brought up Bootstrap',
      candidate,
      disabledCfg,
    );

    expect(out.applied).toBe(false);
    expect(out.results).toBe(candidate);
    expect(search.searchSimilar).not.toHaveBeenCalled();
  });

  it('returns input unchanged when no topic noun is extractable', async () => {
    const search = { searchSimilar: vi.fn() } as unknown as Parameters<typeof applyTopicAwareRetrieval>[0]['search'];
    const candidate = [fact('a', 'something', '2026-04-01')];

    const out = await applyTopicAwareRetrieval(
      { search },
      'user-x',
      'Can you tell me about my background and previous development projects?',
      candidate,
      enabledCfg,
    );

    expect(out.applied).toBe(false);
    expect(out.topic).toBeNull();
    expect(out.results).toBe(candidate);
    expect(search.searchSimilar).not.toHaveBeenCalled();
  });

  it('returns input unchanged when topic-search returns empty', async () => {
    const search = {
      searchSimilar: vi.fn(async () => []),
    } as unknown as Parameters<typeof applyTopicAwareRetrieval>[0]['search'];
    const candidate = [fact('a', 'something', '2026-04-01')];

    const out = await applyTopicAwareRetrieval(
      { search },
      'user-x',
      'List the order in which I brought up Bootstrap',
      candidate,
      enabledCfg,
    );

    expect(out.applied).toBe(false);
    expect(out.topic).toBe('Bootstrap');
    expect(out.results).toBe(candidate);
  });

  it('replaces the candidate set with chronologically-ordered topic results', async () => {
    const topicResults = [
      fact('c3', 'configured Bootstrap theme', '2026-04-15'),
      fact('c1', 'installed Bootstrap', '2026-04-01'),
      fact('c2', 'customized Bootstrap navbar', '2026-04-08'),
    ];
    const search = {
      searchSimilar: vi.fn(async () => topicResults),
    } as unknown as Parameters<typeof applyTopicAwareRetrieval>[0]['search'];

    const out = await applyTopicAwareRetrieval(
      { search },
      'user-x',
      'List the order in which I brought up Bootstrap',
      [],
      enabledCfg,
    );

    expect(out.applied).toBe(true);
    expect(out.topic).toBe('Bootstrap');
    expect(out.results.map((r) => r.id)).toEqual(['c1', 'c2', 'c3']);
  });

  it('clamps non-positive topicRetrievalK to at least 1', async () => {
    const search = {
      searchSimilar: vi.fn(async () => [fact('a', 'x', '2026-04-01')]),
    } as unknown as Parameters<typeof applyTopicAwareRetrieval>[0]['search'];

    await applyTopicAwareRetrieval(
      { search },
      'user-x',
      'List the order in which I brought up Bootstrap',
      [],
      { topicAwareRetrievalEnabled: true, topicRetrievalK: 0 },
    );

    expect(search.searchSimilar).toHaveBeenCalled();
    const call = (search.searchSimilar as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[2]).toBeGreaterThanOrEqual(1);
  });
});
