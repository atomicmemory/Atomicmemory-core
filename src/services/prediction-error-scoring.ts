/**
 * Prediction-error unified signal (EXP-15).
 *
 * Computes a 0..1 `prediction_error_score` for a fact about to be stored,
 * based on AUDN action and top-K cosine similarity to the existing memory
 * neighborhood. High scores mark facts that conflicted with — or were
 * surprising relative to — the user's existing memory cloud. The score is
 * persisted in `metadata.prediction_error_score` (gated by the
 * `predictionErrorEnabled` flag) and consumed at retrieval by the
 * prediction-error boost stage.
 *
 * Heuristic (from EXP-15 spec):
 * - SUPERSEDE / DELETE → 0.9 (the new fact directly invalidated a prior one)
 * - UPDATE              → max(0.5, 1 - topKSimilarity) (refinement carries
 *                         at least moderate prediction error)
 * - ADD                 → 1 - topKSimilarity (low overlap = surprising)
 * - NOOP / CLARIFY      → 0.0 (no actionable prediction error)
 *
 * Top-K similarity is the maximum cosine similarity over the candidate
 * memories AUDN considered. When no candidates exist (empty neighborhood)
 * the ADD branch yields 1.0 — a wholly new region of the user's memory.
 */

import type { AUDNAction } from './extraction.js';

export interface PredictionErrorHit {
  /** Cosine similarity in [0, 1]. */
  similarity: number;
}

export interface PredictionErrorInputs {
  /** AUDN action that produced the storage event. */
  audnAction: AUDNAction;
  /**
   * Top-K cosine-similar existing memories already considered by AUDN.
   * The maximum similarity in this set drives the surprise term. Pass an
   * empty array when the neighborhood is empty (fully novel region).
   */
  existingMemoryHits: ReadonlyArray<PredictionErrorHit>;
}

const SUPERSEDE_DELETE_SCORE = 0.9;
const UPDATE_FLOOR = 0.5;

/**
 * Compute a prediction-error score in [0, 1] from the AUDN decision and
 * neighborhood similarity. Pure function — no IO, no side effects.
 */
export function computePredictionErrorScore(inputs: PredictionErrorInputs): number {
  const { audnAction, existingMemoryHits } = inputs;
  if (audnAction === 'SUPERSEDE' || audnAction === 'DELETE') {
    return SUPERSEDE_DELETE_SCORE;
  }
  if (audnAction === 'NOOP' || audnAction === 'CLARIFY') {
    return 0;
  }

  const topSimilarity = topKSimilarity(existingMemoryHits);
  const surprise = clamp01(1 - topSimilarity);

  if (audnAction === 'UPDATE') {
    return Math.max(UPDATE_FLOOR, surprise);
  }
  // ADD — high similarity ⇒ low surprise ⇒ near-zero score; low similarity
  // ⇒ surprising new fact ⇒ high score.
  return surprise;
}

function topKSimilarity(hits: ReadonlyArray<PredictionErrorHit>): number {
  if (hits.length === 0) return 0;
  let max = 0;
  for (const hit of hits) {
    const sim = clamp01(hit.similarity);
    if (sim > max) max = sim;
  }
  return max;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
