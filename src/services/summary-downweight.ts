/**
 * EXP-SUM: retrieval-time down-weight for summary memories.
 *
 * Summary memories produced by `summary-synthesis.ts` carry
 * `metadata.fact_role: 'summary'`. They are useful for BEAM SUM-style
 * questions ("summarize", "what did we discuss"), but for the rest of
 * the BEAM abilities (TR, IE, etc.) summaries are noisier than the
 * underlying canonical facts they were synthesized from.
 *
 * To avoid summaries diluting non-SUM retrieval, this stage multiplies
 * summary-tagged results' `score` by `summaryDownweightFactor` (default
 * 0.5) — but ONLY when the query is NOT itself summarization-style. For
 * summarization-style queries, summaries surface naturally with no
 * adjustment.
 *
 * The keyword detector lives here (kept tight; expanded literals are
 * intentional). Defaults preserve current behavior: with the default
 * factor, the stage is a no-op until at least one summary memory exists.
 */

import type { SearchResult } from '../db/repository-types.js';

export interface SummaryDownweightConfig {
  /** Multiplicative factor applied to summary-tagged results. */
  summaryDownweightFactor: number;
}

/**
 * Detect summarization-style queries (rough keyword match). Returns true
 * for queries that *want* a summary memory. Conservative on purpose —
 * a false negative just causes a small score nudge; a false positive
 * skips the down-weight, which is fine.
 */
export function isSummarizationStyleQuery(query: string): boolean {
  const q = query.toLowerCase();
  return (
    q.includes('summarize')
    || q.includes('summary of')
    || q.includes('summary about')
    || q.includes('what did we discuss')
    || q.includes('what have we discussed')
    || q.includes('give me an overview')
    || q.includes('overview of')
    || q.includes('recap')
    || q.includes('tl;dr')
  );
}

/**
 * Apply the summary down-weight stage.
 *
 * - Returns the input reference unchanged when the factor is >= 1
 *   (no-op), when the query is summarization-style, or when no
 *   summary-tagged results are present.
 * - Otherwise returns a new array with summary results' scores scaled
 *   by `summaryDownweightFactor`, re-sorted by the new score.
 */
export function applySummaryDownweight(
  results: SearchResult[],
  query: string,
  config: SummaryDownweightConfig,
): SearchResult[] {
  if (results.length === 0) return results;
  if (config.summaryDownweightFactor >= 1) return results;
  if (isSummarizationStyleQuery(query)) return results;
  if (!results.some(isSummaryResult)) return results;

  const adjusted = results.map((r) =>
    isSummaryResult(r)
      ? { ...r, score: r.score * config.summaryDownweightFactor }
      : r,
  );
  adjusted.sort((a, b) => b.score - a.score);
  return adjusted;
}

function isSummaryResult(result: SearchResult): boolean {
  return result.metadata?.fact_role === 'summary';
}
