/**
 * Retrieval confidence gate — computes a confidence score based on the
 * separation between top results. When confidence is low, signals to the
 * caller that retrieval may be insufficient for a definitive answer.
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
  /** Similarity of the top result (the stable, scale-invariant signal). */
  topSimilarity: number;
  /** Margin between top and second result similarities. */
  margin: number;
}

export interface RetrievalConfidenceConfig {
  retrievalConfidenceGateEnabled: boolean;
  retrievalConfidenceMarginNormalizer: number;
  retrievalConfidenceSimilarityNormalizer: number;
  retrievalConfidenceFloor: number;
}

const DEFAULT_MARGIN_NORMALIZER = 0.05;
const DEFAULT_SIMILARITY_NORMALIZER = 0.5;
const DEFAULT_CONFIDENCE_FLOOR = 0.3;
const MARGIN_WEIGHT = 0.6;
const ABSOLUTE_WEIGHT = 0.4;

/**
 * Compute retrieval confidence from a ranked list of results.
 *
 * Uses `similarity` (not `score`) because `score` is rewritten by RRF,
 * cross-encoder, MMR, and additive boosts mid-pipeline. `similarity` is the
 * only stable, scale-invariant signal that survives all stages.
 *
 * @param results — ranked search results; must expose `similarity: number`.
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
    };
  }

  const top = results[0].similarity;
  const second = results.length > 1 ? results[1].similarity : 0;
  const margin = Math.max(0, top - second);

  const marginNormalizer = cfg.retrievalConfidenceMarginNormalizer ?? DEFAULT_MARGIN_NORMALIZER;
  const similarityNormalizer = cfg.retrievalConfidenceSimilarityNormalizer ?? DEFAULT_SIMILARITY_NORMALIZER;
  const floor = cfg.retrievalConfidenceFloor ?? DEFAULT_CONFIDENCE_FLOOR;

  const marginConf = Math.min(1, margin / marginNormalizer);
  const absConf = Math.min(1, top / similarityNormalizer);
  const confidence = MARGIN_WEIGHT * marginConf + ABSOLUTE_WEIGHT * absConf;

  return {
    lowConfidence: confidence < floor,
    confidence,
    topSimilarity: top,
    margin,
  };
}
