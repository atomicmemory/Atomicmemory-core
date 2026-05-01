/**
 * Prediction-error retrieval boost stage (EXP-15).
 *
 * Boosts memories whose persisted `metadata.prediction_error_score` is
 * elevated when the query carries contradiction/transition keywords —
 * "actually", "now", "currently", "instead", "switch", "change",
 * "contradict", "different from before", "anymore". These queries ask
 * about state change, so the model should prefer facts that conflicted
 * with prior memories (high prediction error) over background facts
 * that simply match the topic.
 *
 * The boost is purely additive: the configured weight times the persisted
 * `prediction_error_score` is added to each result's `score`, then the
 * candidate set is re-sorted. Returns the input array reference unchanged
 * when the master flag is off, the weight is non-positive, the query
 * carries no transition cue, or no candidate has a stored score.
 *
 * Both halves (ingest stamping and retrieval boost) are gated by
 * `predictionErrorEnabled` (default false). The retrieval boost is the
 * read-side companion to `computePredictionErrorScore`.
 */

import type { SearchResult } from '../db/repository-types.js';

export interface PredictionErrorBoostConfig {
  predictionErrorEnabled: boolean;
  predictionErrorBoostWeight: number;
}

export interface PredictionErrorBoostInput {
  query: string;
  candidates: SearchResult[];
  config: PredictionErrorBoostConfig;
}

export interface PredictionErrorBoostResult {
  applied: boolean;
  boostedCount: number;
  results: SearchResult[];
}

/** Lowercase patterns that signal a contradiction or state-transition query. */
const TRANSITION_KEYWORDS = [
  'contradict',
  'change',
  'switch',
  'now',
  'currently',
  'instead',
  'actually',
  'different from before',
  'anymore',
];

const NO_OP = (candidates: SearchResult[]): PredictionErrorBoostResult => ({
  applied: false,
  boostedCount: 0,
  results: candidates,
});

export function applyPredictionErrorBoost(input: PredictionErrorBoostInput): PredictionErrorBoostResult {
  const { query, candidates, config } = input;
  if (!config.predictionErrorEnabled) return NO_OP(candidates);
  if (candidates.length === 0) return NO_OP(candidates);
  if (!Number.isFinite(config.predictionErrorBoostWeight) || config.predictionErrorBoostWeight <= 0) {
    return NO_OP(candidates);
  }
  if (!queryCarriesTransitionCue(query)) return NO_OP(candidates);

  let boostedCount = 0;
  const adjusted = candidates.map((result) => {
    const score = readPredictionErrorScore(result);
    if (score <= 0) return result;
    boostedCount += 1;
    return { ...result, score: result.score + config.predictionErrorBoostWeight * score };
  });

  if (boostedCount === 0) return NO_OP(candidates);

  adjusted.sort((a, b) => b.score - a.score);
  return { applied: true, boostedCount, results: adjusted };
}

function queryCarriesTransitionCue(query: string): boolean {
  if (typeof query !== 'string' || query.length === 0) return false;
  const lower = query.toLowerCase();
  return TRANSITION_KEYWORDS.some((keyword) => lower.includes(keyword));
}

function readPredictionErrorScore(result: SearchResult): number {
  const raw = result.metadata?.prediction_error_score;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
  if (raw < 0) return 0;
  if (raw > 1) return 1;
  return raw;
}
