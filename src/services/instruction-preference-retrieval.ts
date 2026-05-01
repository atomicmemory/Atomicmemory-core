/**
 * Instruction-preference two-stage retrieval (EXP-IF).
 *
 * When `instructionPreferenceRetrievalEnabled` is on AND the query is
 * instruction-style (see `instruction-query-detector.ts`), retrieval should
 * preferentially surface memories tagged `metadata.fact_role: 'instruction'`
 * before filling the rest of the candidate slots with general-retrieval
 * results. Today's RRF treats instruction memories as just-another-source —
 * even with the EXP-05 boost, the instruction subset (~4% of corpus) doesn't
 * move the BEAM IF score because it's drowned in non-instruction noise.
 *
 * Implementation note (CRITICAL): the existing `repository-vector-search`
 * does NOT accept a `metadata.fact_role` filter at the SQL layer. Adding one
 * requires new SQL infrastructure and is explicitly out-of-scope for this PR.
 * Instead this module oversamples via the existing `searchSimilar` and
 * post-filters the results in JS, taking the top K_inst instruction-tagged
 * memories. This avoids inventing SQL while delivering the routing behavior
 * the BEAM IF slice needs.
 *
 * Defaults preserve current behavior: when the flag is off OR the query is
 * not instruction-style, the function returns the input results unchanged.
 */

import type { SearchResult } from '../db/repository-types.js';
import type { SearchStore } from '../db/stores.js';
import { isInstructionStyleQuery } from './instruction-query-detector.js';

export interface InstructionPreferenceRetrievalConfig {
  /** Master flag. When false this stage is a strict no-op. */
  instructionPreferenceRetrievalEnabled: boolean;
  /** How many instruction-tagged slots to reserve at the top of the candidate pool. */
  instructionPreferenceTopK: number;
}

export interface InstructionPreferenceRetrievalArgs {
  search: SearchStore;
  userId: string;
  query: string;
  queryEmbedding: number[];
  initialResults: SearchResult[];
  candidateDepth: number;
  sourceSite?: string;
  referenceTime?: Date;
}

export interface InstructionPreferenceRetrievalOutcome {
  /** Final candidate pool, instruction-stage results first when applied. */
  results: SearchResult[];
  /** True iff the two-stage path actually ran (flag on + query matched). */
  applied: boolean;
  /** Count of instruction-tagged candidates surfaced at the top. */
  instructionCount: number;
}

/** Oversample multiplier used when searching for instruction-tagged candidates. */
const INSTRUCTION_OVERSAMPLE_MULTIPLIER = 5;

/**
 * Apply instruction-preference two-stage retrieval. Returns the input
 * `initialResults` unchanged when disabled or when the query isn't
 * instruction-style. When applied, returns a deduped pool with instruction
 * results first (capped at `instructionPreferenceTopK`), followed by the
 * original general-retrieval results.
 */
export async function applyInstructionPreferenceRetrieval(
  args: InstructionPreferenceRetrievalArgs,
  config: InstructionPreferenceRetrievalConfig,
): Promise<InstructionPreferenceRetrievalOutcome> {
  if (!shouldApplyInstructionPreference(args.query, config)) {
    return { results: args.initialResults, applied: false, instructionCount: 0 };
  }

  const oversampleLimit = Math.max(
    args.candidateDepth,
    config.instructionPreferenceTopK * INSTRUCTION_OVERSAMPLE_MULTIPLIER,
  );
  const oversampled = await args.search.searchSimilar(
    args.userId, args.queryEmbedding, oversampleLimit, args.sourceSite, args.referenceTime,
  );
  const instructionStage = oversampled
    .filter(isInstructionTagged)
    .slice(0, config.instructionPreferenceTopK);

  if (instructionStage.length === 0) {
    return { results: args.initialResults, applied: true, instructionCount: 0 };
  }
  const merged = mergeInstructionFirst(instructionStage, args.initialResults, args.candidateDepth);
  return { results: merged, applied: true, instructionCount: instructionStage.length };
}

function shouldApplyInstructionPreference(
  query: string,
  config: InstructionPreferenceRetrievalConfig,
): boolean {
  if (!config.instructionPreferenceRetrievalEnabled) return false;
  if (config.instructionPreferenceTopK <= 0) return false;
  return isInstructionStyleQuery(query);
}

function isInstructionTagged(result: SearchResult): boolean {
  return result.metadata?.fact_role === 'instruction';
}

/**
 * Merge instruction-stage candidates ahead of general-stage candidates,
 * dedupe by id, and trim to `limit`.
 */
function mergeInstructionFirst(
  instructionStage: SearchResult[],
  generalStage: SearchResult[],
  limit: number,
): SearchResult[] {
  const seen = new Set<string>();
  const merged: SearchResult[] = [];
  for (const item of instructionStage) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    merged.push(item);
  }
  for (const item of generalStage) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    merged.push(item);
  }
  if (limit <= 0) return merged;
  return merged.slice(0, limit);
}
