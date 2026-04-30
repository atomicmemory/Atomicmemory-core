/**
 * EXP-08: Scheduled consolidation after ingest.
 *
 * Tracks per-user_id ingest "turn" counts in a process-local map and
 * triggers `executeConsolidation` once the count crosses a multiple of
 * `scheduledConsolidationTurnInterval`. This targets BEAM SUM ability,
 * which has been 0/2 to 1/2 across all 15 Sprint 2 iters and has no
 * other planned fix.
 *
 * Failure mode: if consolidation throws, the error is logged via
 * `console.error` and the ingest call returns normally. There is no
 * retry, no fallback, no automatic backoff — fail closed.
 *
 * Defaults-off: gated by `scheduledConsolidationEnabled` (default false).
 * The default interval is 50 turns. Both fields live in
 * INTERNAL_POLICY_CONFIG_FIELDS.
 *
 * Scope: a "turn" here is a single completed `performIngest`,
 * `performQuickIngest`, or `performWorkspaceIngest` call for the given
 * user_id. The counter is per-user; counts are not persisted across
 * process restarts (this is intentional — consolidation is a tuning
 * heuristic, not a correctness mechanism).
 */

import { executeConsolidation } from './consolidation-service.js';
import type { MemoryServiceDeps } from './memory-service-types.js';

const turnCounts = new Map<string, number>();

/**
 * Increment the turn counter for `userId` and trigger consolidation when
 * the counter crosses a multiple of `scheduledConsolidationTurnInterval`.
 *
 * Always returns once the increment is recorded. Awaits the consolidation
 * call when triggered so callers can observe the write before returning,
 * but swallows + logs any thrown errors (no propagation into ingest).
 */
export async function recordIngestTurn(
  deps: MemoryServiceDeps,
  userId: string,
): Promise<void> {
  if (!deps.config.scheduledConsolidationEnabled) return;

  const interval = deps.config.scheduledConsolidationTurnInterval;
  if (!Number.isFinite(interval) || interval < 1) return;

  const next = (turnCounts.get(userId) ?? 0) + 1;
  turnCounts.set(userId, next);
  if (next % interval !== 0) return;

  try {
    await executeConsolidation(
      deps.stores.memory,
      deps.stores.claim,
      userId,
      undefined,
      { llmModel: deps.config.llmModel },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[scheduled-consolidation] failed for user=${userId} at turn=${next}: ${msg}`,
    );
  }
}

/**
 * Test-only: clear the in-memory per-user turn counter. Exposed so unit
 * tests can run independent scenarios in the same process.
 */
export function __resetTurnCountsForTest(): void {
  turnCounts.clear();
}

/**
 * Test-only: peek the current counter for a user. Used by unit tests to
 * assert the trigger fired exactly when expected.
 */
export function __peekTurnCountForTest(userId: string): number {
  return turnCounts.get(userId) ?? 0;
}
