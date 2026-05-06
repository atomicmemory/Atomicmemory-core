/**
 * Phase 4b — TLL retrieval signal.
 *
 * For event-ordering / temporal-reasoning / multi-session-reasoning queries,
 * expand the candidate set by traversing entity TLL chains. This is the
 * unique architectural primitive: nobody else ships per-entity event-chain
 * traversal at retrieval time.
 *
 * The mechanism:
 *   1. From the initial retrieval candidates, find which entities they link.
 *   2. For each entity, fetch its full TLL chain (event sequence).
 *   3. Merge chain memory_ids into the candidate pool.
 *   4. Boost score for memories that appear in TLL chains for the query's
 *      entities — they're explicitly part of the chronological story.
 *
 * Skipped for non-ordering queries (factual lookups don't need chains).
 */

import type pg from 'pg';
import type { TllRepository } from '../db/repository-tll.js';

/**
 * Cap on the number of top similarity-ranked candidates that seed TLL
 * entity-lookup. Bounds the per-query fan-out for the
 * `memory_entities` join — a higher value increases recall on
 * sprawling queries but inflates the worst-case row scan when an
 * entity dictionary is dense. 10 matches the production search seed
 * count in `memory-search.ts` so both call sites move together.
 */
export const TLL_ENTITY_LOOKUP_SEED_LIMIT = 10;

const ORDERING_QUERY_RE =
  /\b(order|first|last|before|after|when did|evolution|chronological|sequence|timeline|history|over time|originally|initially|then|later|brought up|track|progression|how did .* evolve|in what order)\b/i;

export function shouldUseTLL(query: string): boolean {
  return ORDERING_QUERY_RE.test(query);
}

/**
 * Get the entity_ids linked to a set of memory_ids via memory_entities.
 * Used to find which entities to chain-traverse from initial retrieval.
 * Exported for direct unit testing of SQL shape; the production caller
 * is `expandViaTLL` below.
 */
export async function entitiesForMemories(
  pool: pg.Pool,
  memoryIds: string[],
): Promise<string[]> {
  if (memoryIds.length === 0) return [];
  const result = await pool.query(
    `SELECT DISTINCT entity_id FROM memory_entities WHERE memory_id = ANY($1::uuid[])`,
    [memoryIds],
  );
  return result.rows.map((r) => r.entity_id);
}

/**
 * Expand candidate set via TLL chain traversal for the entities most
 * relevant to the query (derived from initial retrieval).
 * Returns: array of memory_ids in chronological chain order, deduplicated.
 */
export async function expandViaTLL(
  userId: string,
  initialMemoryIds: string[],
  tllRepository: TllRepository,
  pool: pg.Pool,
): Promise<string[]> {
  if (initialMemoryIds.length === 0) return [];
  const entityIds = await entitiesForMemories(
    pool,
    initialMemoryIds.slice(0, TLL_ENTITY_LOOKUP_SEED_LIMIT),
  );
  if (entityIds.length === 0) return [];
  return tllRepository.chainsFor(userId, entityIds);
}
