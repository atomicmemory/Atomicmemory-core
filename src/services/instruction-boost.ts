/**
 * Instruction-type retrieval boost (EXP-05).
 *
 * Adds a configurable additive weight to search results whose persisted
 * `metadata.fact_role` is `'instruction'`, then re-sorts by score. Memory
 * systems dilute imperative instructions when they sit alongside thousands
 * of regular memories; this stage recovers the signal at retrieval time
 * without changing the underlying ranking primitives.
 *
 * Tagging happens in `extraction-enrichment.ts` (`applyInstructionTagging`).
 * Both halves are gated by `instructionBoostEnabled` (default false).
 *
 * Defaults preserve current behavior: when the flag is off the function
 * returns the input array reference unchanged.
 */

import type { SearchResult } from '../db/repository-types.js';

export interface InstructionBoostConfig {
  /** Master flag. When false, this stage is a strict no-op. */
  instructionBoostEnabled: boolean;
  /** Additive boost applied to instruction-tagged results' `score`. */
  instructionBoostWeight: number;
}

/**
 * Apply the instruction-type retrieval boost.
 *
 * - Returns the input reference unchanged when the flag is off.
 * - Otherwise returns a new array sorted by adjusted score (descending).
 *   Inputs are not mutated.
 *
 * `_query` is reserved for future query-aware gating (e.g. only boost when
 * the query itself is imperative). Currently unused — the boost fires for
 * every query so instruction memories surface across all retrieval paths.
 */
export function applyInstructionBoost(
  results: SearchResult[],
  _query: string,
  config: InstructionBoostConfig,
): SearchResult[] {
  if (!config.instructionBoostEnabled) return results;
  if (results.length === 0) return results;

  const adjusted = results.map((result) => {
    if (!isInstructionResult(result)) return result;
    return { ...result, score: result.score + config.instructionBoostWeight };
  });
  adjusted.sort((a, b) => b.score - a.score);
  return adjusted;
}

function isInstructionResult(result: SearchResult): boolean {
  return result.metadata?.fact_role === 'instruction';
}
