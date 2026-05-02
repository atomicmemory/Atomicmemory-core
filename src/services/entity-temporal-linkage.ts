/**
 * Per-entity temporal linkage retrieval boost (EXP-21).
 *
 * Targets BEAM EO (event ordering) and MR (multi-session reasoning):
 * current bag-of-facts retrieval has no entity-graph-aware ordering, so
 * questions like "what happened first?" lose chronology.
 *
 * Ingest side (see `memory-storage.ts`): when the flag is on, every stored
 * fact emits one row per mentioned entity into `atomic_entity_temporal_links`
 * — a sparse linked list per entity sorted by `created_at`.
 *
 * Retrieval side (this module): when the query mentions an entity AND the
 * flag is on, walk the per-entity link list in chronological order and boost
 * each fact's score by `weight * (1 - normalizedRank)` where rank=0 is the
 * earliest mention. Earlier mentions surface first, which matches the
 * "what happened first" framing the EO benchmark exercises.
 *
 * Defaults-off. Stage is wired AFTER current-state-ranking but BEFORE the
 * final RRF rerank (same insertion site as the EXP-12 recency-bin boost).
 */

import type { SearchResult } from '../db/repository-types.js';
import type { RepresentationStore } from '../db/stores.js';
import { extractNamedEntityCandidates } from './query-expansion.js';

export interface EntityTemporalLinkageConfig {
  /** Master flag. When false, the stage is a strict no-op. */
  perEntityTemporalLinkageEnabled: boolean;
  /** Maximum additive boost applied to the chronologically first fact. */
  perEntityTemporalLinkageBoostWeight: number;
}

export interface EntityTemporalLinkageInput {
  query: string;
  candidates: SearchResult[];
  userId: string;
  representation: RepresentationStore;
  config: EntityTemporalLinkageConfig;
  /**
   * Cap on how many links per entity we fetch to avoid unbounded scans on
   * pathologically chatty entities. The retrieval boost only needs the
   * head of the timeline; tail facts wouldn't cross any score threshold.
   */
  perEntityFetchLimit?: number;
}

export interface EntityTemporalLinkageResult {
  applied: boolean;
  matchedEntities: string[];
  boostedCount: number;
  results: SearchResult[];
}

const DEFAULT_FETCH_LIMIT = 64;

const NO_OP = (candidates: SearchResult[]): EntityTemporalLinkageResult => ({
  applied: false,
  matchedEntities: [],
  boostedCount: 0,
  results: candidates,
});

/**
 * Apply the per-entity temporal-linkage retrieval boost.
 *
 * - Returns the candidate list unchanged when the flag is off, the query
 *   has no extractable entity, or the candidate set is empty.
 * - Otherwise returns a re-sorted copy. The input array is not mutated.
 */
export async function applyEntityTemporalLinkageBoost(
  input: EntityTemporalLinkageInput,
): Promise<EntityTemporalLinkageResult> {
  const { query, candidates, userId, representation, config } = input;
  if (!config.perEntityTemporalLinkageEnabled) return NO_OP(candidates);
  if (candidates.length === 0) return NO_OP(candidates);
  if (!Number.isFinite(config.perEntityTemporalLinkageBoostWeight)) return NO_OP(candidates);
  if (config.perEntityTemporalLinkageBoostWeight === 0) return NO_OP(candidates);

  const queryEntities = extractQueryEntities(query);
  if (queryEntities.length === 0) return NO_OP(candidates);

  const fetchLimit = input.perEntityFetchLimit ?? DEFAULT_FETCH_LIMIT;
  const rankByMemoryId = await buildLinkageRanks(
    representation, userId, queryEntities, fetchLimit,
  );
  if (rankByMemoryId.size === 0) {
    return { applied: false, matchedEntities: queryEntities, boostedCount: 0, results: candidates };
  }

  const adjusted = rescoreByLinkageRank(
    candidates, rankByMemoryId, config.perEntityTemporalLinkageBoostWeight,
  );
  return {
    applied: adjusted.boostedCount > 0,
    matchedEntities: queryEntities,
    boostedCount: adjusted.boostedCount,
    results: adjusted.results,
  };
}

/**
 * Resolve the canonical entity ids the query refers to. We mirror ingest's
 * lowercase normalization so retrieval looks up the same key the writer
 * inserted under.
 */
function extractQueryEntities(query: string): string[] {
  const candidates = extractNamedEntityCandidates(query);
  const normalized = new Set<string>();
  for (const candidate of candidates) {
    const id = normalizeEntityId(candidate);
    if (id.length >= 2) normalized.add(id);
  }
  return [...normalized];
}

/** Lowercase + collapse whitespace; used by both writer and reader. */
export function normalizeEntityId(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Walk the per-entity timeline for each query entity. For each linked
 * memory, keep the strongest (smallest) rank seen across entities — facts
 * mentioned earliest in the timeline of any matching entity get the
 * largest boost.
 */
async function buildLinkageRanks(
  representation: RepresentationStore,
  userId: string,
  entities: string[],
  fetchLimit: number,
): Promise<Map<string, { rank: number; total: number }>> {
  const ranks = new Map<string, { rank: number; total: number }>();
  for (const entityId of entities) {
    const links = await representation.listEntityTemporalLinks(userId, entityId, fetchLimit);
    if (links.length === 0) continue;
    const total = links.length;
    for (let i = 0; i < links.length; i++) {
      const memoryId = links[i].parent_memory_id;
      const existing = ranks.get(memoryId);
      if (!existing || i < existing.rank) {
        ranks.set(memoryId, { rank: i, total });
      }
    }
  }
  return ranks;
}

interface RescoreResult {
  results: SearchResult[];
  boostedCount: number;
}

/**
 * Add `weight * positionFactor` to each candidate where positionFactor =
 * `1 - rank / max(total - 1, 1)`. The chronologically first fact gets the
 * full weight; later facts decay linearly. Re-sort by score descending.
 */
function rescoreByLinkageRank(
  candidates: SearchResult[],
  rankByMemoryId: Map<string, { rank: number; total: number }>,
  weight: number,
): RescoreResult {
  let boostedCount = 0;
  const adjusted = candidates.map((result) => {
    const ranking = rankByMemoryId.get(result.id);
    if (!ranking) return result;
    const denom = Math.max(ranking.total - 1, 1);
    const factor = 1 - (ranking.rank / denom);
    if (factor <= 0) return result;
    boostedCount += 1;
    return { ...result, score: result.score + weight * factor };
  });
  adjusted.sort((left, right) => right.score - left.score);
  return { results: adjusted, boostedCount };
}
