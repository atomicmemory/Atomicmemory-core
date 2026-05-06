/**
 * Unit tests for TLL retrieval signal helpers.
 *
 * Covers:
 *   - shouldUseTLL query classification (positive + negative cases)
 *   - entitiesForMemories SQL shape and empty-input shortcut
 *   - expandViaTLL composition (entities lookup -> chain expansion),
 *     empty-input shortcut, and the 10-id slice cap on initial inputs.
 *
 * No DB required: pg.Pool and TllRepository are mocked via vi.fn().
 */

import { describe, it, expect, vi } from 'vitest';
import type pg from 'pg';
import {
  shouldUseTLL,
  entitiesForMemories,
  expandViaTLL,
  TLL_ENTITY_LOOKUP_SEED_LIMIT,
} from '../tll-retrieval.js';
import type { TllRepository } from '../../db/repository-tll.js';

interface QueryRow {
  entity_id: string;
}

interface QueryResult {
  rows: QueryRow[];
}

/** Build a minimal pg.Pool stub whose query() returns the supplied rows. */
function makePool(rows: QueryRow[]): {
  pool: pg.Pool;
  query: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn<(sql: string, params?: unknown[]) => Promise<QueryResult>>()
    .mockResolvedValue({ rows });
  const pool = { query } as unknown as pg.Pool;
  return { pool, query };
}

/** Build a minimal TllRepository stub exposing only chainsFor(). */
function makeTllRepo(chainResult: string[]): {
  repo: TllRepository;
  chainsFor: ReturnType<typeof vi.fn>;
} {
  const chainsFor = vi.fn<
    (userId: string, entityIds: string[]) => Promise<string[]>
  >().mockResolvedValue(chainResult);
  const repo = { chainsFor } as unknown as TllRepository;
  return { repo, chainsFor };
}

describe('shouldUseTLL', () => {
  const positiveQueries = [
    'in what order did the events happen',
    'what came first in the sequence',
    'what was the last meeting about',
    'what happened before the merger',
    'what changed after the launch',
    'when did the user move to Berlin',
    'show the evolution of the project',
    'list events in chronological order',
    'reconstruct the sequence',
    'build me a timeline of changes',
    'what is the history of this codebase',
    'how preferences shifted over time',
    'what did the user originally say',
    'what did they initially mention',
    'first this then that',
    'and later they switched',
    'when the topic was brought up',
    'track the progression of opinion',
    'show progression of editor choice',
  ];

  it.each(positiveQueries)('returns true for ordering query: %s', (q) => {
    expect(shouldUseTLL(q)).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(shouldUseTLL('What Is The HISTORY?')).toBe(true);
    expect(shouldUseTLL('TIMELINE please')).toBe(true);
  });

  const negativeQueries = [
    'what is X',
    'list all the entities',
    'explain why this is a tool',
    'who is the current owner',
    'tell me about the project',
    'summarize the discussion',
  ];

  it.each(negativeQueries)('returns false for non-temporal query: %s', (q) => {
    expect(shouldUseTLL(q)).toBe(false);
  });
});

describe('entitiesForMemories', () => {
  it('returns [] without touching the pool when memoryIds is empty', async () => {
    const { pool, query } = makePool([]);
    const result = await entitiesForMemories(pool, []);
    expect(result).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('issues a DISTINCT query against memory_entities and maps entity_ids', async () => {
    const { pool, query } = makePool([
      { entity_id: 'e-1' },
      { entity_id: 'e-2' },
    ]);

    const result = await entitiesForMemories(pool, ['m-1', 'm-2']);

    expect(result).toEqual(['e-1', 'e-2']);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/SELECT\s+DISTINCT\s+entity_id/i);
    expect(sql).toMatch(/FROM\s+memory_entities/i);
    expect(sql).toMatch(/memory_id\s*=\s*ANY\(\$1::uuid\[\]\)/i);
    expect(params).toEqual([['m-1', 'm-2']]);
  });

  it('returns an empty array when no rows match', async () => {
    const { pool } = makePool([]);
    const result = await entitiesForMemories(pool, ['m-1']);
    expect(result).toEqual([]);
  });
});

describe('expandViaTLL', () => {
  const USER = 'u-1';

  it('returns [] without any work when initialMemoryIds is empty', async () => {
    const { pool, query } = makePool([]);
    const { repo, chainsFor } = makeTllRepo([]);

    const result = await expandViaTLL(USER, [], repo, pool);

    expect(result).toEqual([]);
    expect(query).not.toHaveBeenCalled();
    expect(chainsFor).not.toHaveBeenCalled();
  });

  it('returns [] and skips chainsFor when no entities are found', async () => {
    const { pool, query } = makePool([]);
    const { repo, chainsFor } = makeTllRepo([]);

    const result = await expandViaTLL(USER, ['m-1'], repo, pool);

    expect(result).toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(chainsFor).not.toHaveBeenCalled();
  });

  it('looks up entities first then expands via chainsFor', async () => {
    const callOrder: string[] = [];
    const { pool, query } = makePool([{ entity_id: 'e-1' }, { entity_id: 'e-2' }]);
    query.mockImplementationOnce(async () => {
      callOrder.push('entitiesForMemories');
      return { rows: [{ entity_id: 'e-1' }, { entity_id: 'e-2' }] };
    });
    const { repo, chainsFor } = makeTllRepo(['mem-a', 'mem-b']);
    chainsFor.mockImplementationOnce(async () => {
      callOrder.push('chainsFor');
      return ['mem-a', 'mem-b'];
    });

    const result = await expandViaTLL(USER, ['m-1', 'm-2'], repo, pool);

    expect(result).toEqual(['mem-a', 'mem-b']);
    expect(callOrder).toEqual(['entitiesForMemories', 'chainsFor']);
    expect(chainsFor).toHaveBeenCalledWith(USER, ['e-1', 'e-2']);
  });

  it('slices initialMemoryIds to TLL_ENTITY_LOOKUP_SEED_LIMIT before entity lookup', async () => {
    const { pool, query } = makePool([{ entity_id: 'e-1' }]);
    const { repo } = makeTllRepo(['mem-x']);

    const inputIds = Array.from(
      { length: TLL_ENTITY_LOOKUP_SEED_LIMIT * 2 + 5 },
      (_, i) => `m-${i}`,
    );
    await expandViaTLL(USER, inputIds, repo, pool);

    expect(query).toHaveBeenCalledTimes(1);
    const params = query.mock.calls[0][1] as unknown[];
    const passedIds = params[0] as string[];
    expect(passedIds).toHaveLength(TLL_ENTITY_LOOKUP_SEED_LIMIT);
    expect(passedIds).toEqual(inputIds.slice(0, TLL_ENTITY_LOOKUP_SEED_LIMIT));
  });

  it('does not slice when initialMemoryIds length is <= TLL_ENTITY_LOOKUP_SEED_LIMIT', async () => {
    const { pool, query } = makePool([{ entity_id: 'e-1' }]);
    const { repo } = makeTllRepo(['mem-x']);

    const inputIds = ['m-1', 'm-2', 'm-3'];
    await expandViaTLL(USER, inputIds, repo, pool);

    const params = query.mock.calls[0][1] as unknown[];
    expect(params[0]).toEqual(inputIds);
  });

  it('forwards the userId to chainsFor verbatim', async () => {
    const { pool } = makePool([{ entity_id: 'e-7' }]);
    const { repo, chainsFor } = makeTllRepo([]);

    await expandViaTLL('user-tenant-42', ['m-1'], repo, pool);

    expect(chainsFor).toHaveBeenCalledWith('user-tenant-42', ['e-7']);
  });
});
