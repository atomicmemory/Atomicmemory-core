/**
 * Log-spaced recency-bin boost stage (EXP-12).
 *
 * Reads the inferred query bin from `temporal-query-expansion.inferQueryBin`,
 * recomputes each candidate's bin from `result.created_at` against the
 * provided reference time, and adds `weight * computeBinAffinity(...)` to
 * each result's `score`. Re-sorts and returns the new order.
 *
 * Recomputation is deliberate: persisted `metadata.recency_bin` is a debug
 * breadcrumb only — it goes stale the moment a fact ages past its bin
 * boundary. We always recompute from `created_at` at retrieval time so
 * the boost matches the query's "feel" of recency at the moment of the
 * search call.
 *
 * The stage is wired in `search-pipeline.ts` after `applyCurrentStateRanking`
 * and short-circuits when current-state-ranking already triggered, to
 * avoid double-counting two recency-flavored signals on the same query.
 */

import type { SearchResult } from '../db/repository-types.js';
import { assignRecencyBin, computeBinAffinity, type RecencyBin } from './temporal-fingerprint.js';
import { inferQueryBin } from './temporal-query-expansion.js';

export interface RecencyBinBoostInput {
  query: string;
  candidates: SearchResult[];
  weight: number;
  referenceTime: Date;
  /**
   * When `applyCurrentStateRanking.triggered` is true the current-state
   * stage has already added a recency-flavored signal; layering the bin
   * boost on top double-counts. The pipeline passes that flag through so
   * this stage can no-op cleanly.
   */
  currentStateTriggered: boolean;
}

export interface RecencyBinBoostResult {
  applied: boolean;
  queryBin: RecencyBin | null;
  results: SearchResult[];
}

const NO_OP = (candidates: SearchResult[], queryBin: RecencyBin | null): RecencyBinBoostResult => ({
  applied: false,
  queryBin,
  results: candidates,
});

export function applyRecencyBinBoost(input: RecencyBinBoostInput): RecencyBinBoostResult {
  const { query, candidates, weight, referenceTime, currentStateTriggered } = input;
  if (currentStateTriggered) return NO_OP(candidates, null);
  if (candidates.length === 0) return NO_OP(candidates, null);
  if (!Number.isFinite(weight) || weight === 0) return NO_OP(candidates, null);

  const queryBin = inferQueryBin(query, referenceTime);
  if (queryBin === null) return NO_OP(candidates, queryBin);

  const rescored = candidates
    .map((result) => {
      const factBin = assignRecencyBin(result.created_at, referenceTime);
      const affinity = computeBinAffinity(queryBin, factBin);
      if (affinity === 0) return result;
      return { ...result, score: result.score + weight * affinity };
    })
    .sort((left, right) => right.score - left.score);

  return { applied: true, queryBin, results: rescored };
}
