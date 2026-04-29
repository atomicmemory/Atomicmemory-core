/**
 * Event-boundary retrieval boost (EXP-13).
 *
 * Adds a configurable additive boost to search results whose persisted
 * `metadata.event_boundary` is `true`, scaled by `boundary_strength` when
 * available. Event boundaries mark topic shifts — these are natural anchor
 * points for event-ordering (EO) and temporal-reasoning (TR) queries.
 *
 * Boundary detection happens at extraction time (conditional on
 * `eventBoundaryExtractionEnabled` in the extraction prompt). The boost is
 * applied at retrieval time (conditional on the same flag, or on a separate
 * runtime override via `config_override`).
 *
 * Defaults preserve current behavior: when the flag is off the function
 * returns the input array reference unchanged.
 */

import type { SearchResult } from '../db/repository-types.js';

export interface EventBoundaryBoostConfig {
  /** Master flag. When false, this stage is a strict no-op. */
  eventBoundaryBoostEnabled: boolean;
  /** Additive boost applied to boundary results' `score`. Scaled by strength. */
  eventBoundaryBoostWeight: number;
}

export interface EventBoundaryBoostResult {
  /** Whether the boost was actually applied (flag on and at least one hit). */
  applied: boolean;
  /** The re-sorted results. */
  results: SearchResult[];
  /** How many results received the boost. */
  boostedCount: number;
}

/**
 * Apply the event-boundary retrieval boost.
 *
 * - Returns `{ applied: false, results: input, boostedCount: 0 }` when the
 *   flag is off or no results carry the boundary marker.
 * - Otherwise returns a new array sorted by adjusted score (descending).
 *   Inputs are not mutated.
 */
export function applyEventBoundaryBoost(
  results: SearchResult[],
  config: EventBoundaryBoostConfig,
): EventBoundaryBoostResult {
  if (!config.eventBoundaryBoostEnabled || results.length === 0) {
    return { applied: false, results, boostedCount: 0 };
  }

  let boostedCount = 0;
  const adjusted = results.map((result) => {
    const strength = getBoundaryStrength(result);
    if (strength === null) return result;
    boostedCount++;
    return { ...result, score: result.score + config.eventBoundaryBoostWeight * strength };
  });

  if (boostedCount === 0) {
    return { applied: false, results, boostedCount: 0 };
  }

  adjusted.sort((a, b) => b.score - a.score);
  return { applied: true, results: adjusted, boostedCount };
}

/**
 * Read `metadata.event_boundary` from a search result.
 * Returns the strength multiplier (1.0 when no explicit strength) or null
 * when the result is not a boundary.
 */
function getBoundaryStrength(result: SearchResult): number | null {
  if (result.metadata?.event_boundary !== true) return null;
  const rawStrength = result.metadata.boundary_strength;
  if (typeof rawStrength === 'number' && Number.isFinite(rawStrength)) {
    return Math.max(0, Math.min(1, rawStrength));
  }
  return 1.0;
}
