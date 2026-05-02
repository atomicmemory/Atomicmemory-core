/**
 * Retrieval confidence gate — computes a confidence score based on the
 * separation and absolute strength of top results. When confidence is low,
 * signals to the caller that retrieval may be insufficient for a definitive
 * answer.
 *
 * This targets the abstention ability (ABS) on BEAM, where Honcho scores
 * below the no-memory baseline because over-retrieval poisons "I don't know"
 * answers.
 */

export interface RetrievalConfidence {
  /** True when the confidence composite falls below the configured floor. */
  lowConfidence: boolean;
  /** Composite confidence in [0, 1]. */
  confidence: number;
  /** Highest similarity across all results (after sorting). */
  topSimilarity: number;
  /** Margin between top-1 and top-2 similarity (after sorting). */
  margin: number;
  /** Mean of top-K similarities (the absolute-signal driver). */
  topKMean: number;
}

export interface RetrievalConfidenceConfig {
  retrievalConfidenceGateEnabled: boolean;
  retrievalConfidenceMarginNormalizer: number;
  retrievalConfidenceSimilarityNormalizer: number;
  retrievalConfidenceFloor: number;
  retrievalConfidenceTopKWindow: number;
}

// Fix A v2 (2026-05-02): empirical recalibration on full BEAM-100K conv-1.
//
// Three changes from the original gate:
//   1. SORT similarities before reading top-1/top-2. The pipeline ranks
//      results by `score` (post-RRF/MMR/cross-encoder), but the gate must
//      reason about raw `similarity`. Reading position 0 of a score-ranked
//      list gave non-monotonic similarities and margin=0 even when retrieval
//      was strong.
//   2. ABSOLUTE signal switches from top-1 sim to mean(top-K sims). Single
//      top-1 is noisy; the mean is a more stable signal of retrieval quality.
//   3. WEIGHTS shift from 0.6 margin / 0.4 abs to 0.2 / 0.8. Margin saturates
//      at tiny separations and dominates the old formula; absolute is the
//      better discriminator empirically.
//
// Calibrated on conv-1 (2337 memories): ABS-1 conf=0.534, ABS-2 conf=0.548
// (both flag); PF-1 conf=0.601, KU-1 conf=0.734, TR-1 conf=0.730 (all pass).
// Floor 0.6 sits in the gap between abstention and answerable cases.
const DEFAULT_MARGIN_NORMALIZER = 0.15;
const DEFAULT_SIMILARITY_NORMALIZER = 0.85;
const DEFAULT_CONFIDENCE_FLOOR = 0.6;
const DEFAULT_TOP_K_WINDOW = 3;
const MARGIN_WEIGHT = 0.2;
const ABSOLUTE_WEIGHT = 0.8;

/**
 * Compute retrieval confidence from a ranked list of results.
 *
 * Uses `similarity` (not `score`) because `score` is rewritten by RRF,
 * cross-encoder, MMR, and additive boosts mid-pipeline. `similarity` is the
 * only stable, scale-invariant signal that survives all stages.
 *
 * @param results — search results; must expose `similarity: number`. The
 *   incoming order is irrelevant — the gate sorts by similarity internally.
 * @param cfg — gate configuration; when disabled returns `null`.
 */
export function computeRetrievalConfidence(
  results: ReadonlyArray<{ similarity: number }>,
  cfg: Partial<RetrievalConfidenceConfig> & { retrievalConfidenceGateEnabled: boolean },
): RetrievalConfidence | null {
  if (!cfg.retrievalConfidenceGateEnabled) return null;

  if (results.length === 0) {
    return {
      lowConfidence: true,
      confidence: 0,
      topSimilarity: 0,
      margin: 0,
      topKMean: 0,
    };
  }

  const sortedSims = results.map((r) => r.similarity).sort((a, b) => b - a);
  const top = sortedSims[0];
  const second = sortedSims.length > 1 ? sortedSims[1] : 0;
  const margin = top - second; // guaranteed >= 0 because sorted desc

  const marginNormalizer = cfg.retrievalConfidenceMarginNormalizer ?? DEFAULT_MARGIN_NORMALIZER;
  const similarityNormalizer = cfg.retrievalConfidenceSimilarityNormalizer ?? DEFAULT_SIMILARITY_NORMALIZER;
  const floor = cfg.retrievalConfidenceFloor ?? DEFAULT_CONFIDENCE_FLOOR;
  const topKWindow = cfg.retrievalConfidenceTopKWindow ?? DEFAULT_TOP_K_WINDOW;

  const topK = sortedSims.slice(0, topKWindow);
  const topKMean = topK.reduce((acc, s) => acc + s, 0) / topK.length;

  const marginConf = Math.min(1, margin / marginNormalizer);
  const absConf = Math.min(1, topKMean / similarityNormalizer);
  const confidence = MARGIN_WEIGHT * marginConf + ABSOLUTE_WEIGHT * absConf;

  return {
    lowConfidence: confidence < floor,
    confidence,
    topSimilarity: top,
    margin,
    topKMean,
  };
}
