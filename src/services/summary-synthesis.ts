/**
 * EXP-SUM: synthesize-only periodic consolidation.
 *
 * Re-uses the existing consolidation primitives (`findConsolidationCandidates`
 * + `synthesizeCluster`) but DOES NOT call `softDeleteMemory` on cluster
 * members. Original facts stay live; the LLM-synthesized summary is stored
 * alongside them, tagged via `metadata.fact_role: 'summary'` and
 * `metadata.summary_of: [original_fact_ids]`.
 *
 * Targets BEAM SUM (1/6 across sprint-2 with EXP-08 archive-style
 * consolidation; 2/6 without). EXP-08 hurt SUM because archiving cluster
 * members removes facts BEAM SUM questions need to retrieve. Synthesizing
 * alongside originals preserves the underlying facts other BEAM abilities
 * (TR, IE, etc.) need while still letting summary-style queries surface a
 * compact, retrievable answer.
 *
 * Per-user_id turn counter mirrors the EXP-08 pattern; counts live in a
 * process-local map (intentionally not persisted across restarts —
 * synthesis is a tuning heuristic, not a correctness mechanism).
 *
 * Failure mode: synthesis errors are logged via `console.error` and the
 * caller (memory-ingest) continues. Defaults-off behind
 * `summarySynthesisEnabled`.
 */

import {
  findConsolidationCandidates,
  synthesizeCluster,
} from './consolidation-service.js';
import { embedText } from './embedding.js';
import type { MemoryServiceDeps } from './memory-service-types.js';
import type { MemoryRow } from '../db/repository-types.js';
import type { MemoryStore } from '../db/stores.js';

const turnCounts = new Map<string, number>();

/**
 * Increment the per-user_id turn counter and synthesize-only when the
 * counter crosses a multiple of `summarySynthesisTurnInterval`.
 *
 * Returns the IDs of any newly stored summary memories (empty when the
 * trigger does not fire, when synthesis is disabled, or when no clusters
 * meet the affinity threshold).
 */
export async function synthesizeSummariesForUser(
  deps: MemoryServiceDeps,
  userId: string,
): Promise<string[]> {
  if (!deps.config.summarySynthesisEnabled) return [];

  const interval = deps.config.summarySynthesisTurnInterval;
  if (!Number.isFinite(interval) || interval < 1) return [];

  const next = (turnCounts.get(userId) ?? 0) + 1;
  turnCounts.set(userId, next);
  if (next % interval !== 0) return [];

  try {
    return await runSynthesisCycle(deps.stores.memory, userId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[summary-synthesis] failed for user=${userId} at turn=${next}: ${msg}`,
    );
    return [];
  }
}

/**
 * Cluster active memories, synthesize each cluster, and store the summary
 * WITHOUT archiving the originals. Returns the new summary memory IDs.
 */
async function runSynthesisCycle(
  memoryStore: MemoryStore,
  userId: string,
): Promise<string[]> {
  const candidates = await findConsolidationCandidates(memoryStore, userId);
  const summaryIds: string[] = [];

  for (const cluster of candidates.clusters) {
    const id = await synthesizeAndStoreCluster(memoryStore, userId, cluster);
    if (id) summaryIds.push(id);
  }

  return summaryIds;
}

/**
 * Synthesize a single cluster and write the summary alongside originals.
 * Returns the new memory ID, or null if synthesis or member lookup failed.
 */
async function synthesizeAndStoreCluster(
  memoryStore: MemoryStore,
  userId: string,
  cluster: { memberIds: string[]; memberContents: string[]; avgAffinity: number; memberCount: number },
): Promise<string | null> {
  const synthesized = await synthesizeCluster(cluster.memberContents);
  if (!synthesized) return null;

  const memberMemories = await Promise.all(
    cluster.memberIds.map((id) => memoryStore.getMemory(id, userId)),
  );
  const validMembers = memberMemories.filter((m): m is MemoryRow => m !== null);
  if (validMembers.length < 2) return null;

  const importance = Math.min(
    1.0,
    Math.max(...validMembers.map((m) => m.importance)) + 0.05,
  );
  const embedding = await embedText(synthesized);

  return memoryStore.storeMemory({
    userId,
    content: synthesized,
    embedding,
    memoryType: 'semantic',
    importance,
    sourceSite: validMembers[0].source_site,
    metadata: {
      fact_role: 'summary',
      summary_of: cluster.memberIds,
      cluster_size: cluster.memberCount,
      avg_affinity: cluster.avgAffinity,
    },
  });
}

/** Test-only: clear the per-user turn counter. */
export function __resetSummaryTurnCountsForTest(): void {
  turnCounts.clear();
}

/** Test-only: peek the current counter for a user. */
export function __peekSummaryTurnCountForTest(userId: string): number {
  return turnCounts.get(userId) ?? 0;
}
