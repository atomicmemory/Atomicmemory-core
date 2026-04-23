/**
 * Per-fact ingest pipeline: embed, gate, find candidates, decide, store.
 *
 * Unifies the three per-fact paths (full, quick, workspace) behind a single
 * parameterized function. Each path is a different combination of options
 * rather than a separate code path.
 */

import { embedText } from './embedding.js';
import { mergeCandidates } from './conflict-policy.js';
import { computeEntropyScore } from './entropy-gate.js';
import { assessWriteSecurity, recordRejectedWrite } from './write-security.js';
import { timed } from './timing.js';
import { storeCanonicalFact, resolveDeterministicClaimSlot, findSlotConflictCandidates } from './memory-storage.js';
import { findFilteredCandidates, resolveAndExecuteAudn } from './memory-audn.js';
import type { WorkspaceContext } from '../db/repository-types.js';
import type {
  AudnFactContext,
  EntropyContext,
  FactInput,
  FactResult,
  MemoryServiceDeps,
} from './memory-service-types.js';

// ---------------------------------------------------------------------------
// Pipeline options
// ---------------------------------------------------------------------------

/** Controls which stages of the per-fact pipeline are active. */
export interface FactPipelineOptions {
  /** When set, scopes candidate finding and storage to this workspace. */
  workspace?: WorkspaceContext;
  /** Run the entropy gate before candidate search (off for quick-ingest). */
  entropyGate: boolean;
  /** Run the full AUDN path (fast + deferred + LLM). When false, uses quick duplicate threshold only. */
  fullAudn: boolean;
  /** Mutable set of superseded target IDs, shared across a batch. */
  supersededTargets: Set<string>;
  /** Mutable entropy context, shared across a batch. */
  entropyCtx: EntropyContext;
  /** Optional logical timestamp for backdating. */
  logicalTimestamp?: Date;
  /** Timing label prefix for timed() wrappers. */
  timingPrefix: string;
}

// ---------------------------------------------------------------------------
// Main pipeline function
// ---------------------------------------------------------------------------

/** Process a single extracted fact through the ingest pipeline. */
export async function processFactThroughPipeline(
  deps: MemoryServiceDeps,
  userId: string,
  fact: FactInput,
  sourceSite: string,
  sourceUrl: string,
  episodeId: string,
  options: FactPipelineOptions,
): Promise<FactResult> {
  if (options.workspace) {
    return processWorkspaceFact(deps, userId, fact, sourceSite, sourceUrl, episodeId, options.workspace, options.supersededTargets, options.timingPrefix);
  }
  if (options.fullAudn) {
    return processFullAudnFact(deps, userId, fact, sourceSite, sourceUrl, episodeId, options);
  }
  return processQuickFact(deps, userId, fact, sourceSite, sourceUrl, episodeId, options.logicalTimestamp, options.timingPrefix);
}

// ---------------------------------------------------------------------------
// Full AUDN path (performIngest)
// ---------------------------------------------------------------------------

async function processFullAudnFact(
  deps: MemoryServiceDeps,
  userId: string,
  fact: FactInput,
  sourceSite: string,
  sourceUrl: string,
  episodeId: string,
  options: FactPipelineOptions,
): Promise<FactResult> {
  const embedding = await timed(`${options.timingPrefix}.fact.embed`, () => embedText(fact.fact));
  const writeSecurity = assessWriteSecurity(fact.fact, sourceSite, deps.config);

  if (!writeSecurity.allowed) {
    await recordRejectedWrite(userId, fact.fact, sourceSite, writeSecurity, deps.config, deps.stores.lesson);
    return { outcome: 'skipped', memoryId: null };
  }

  if (options.entropyGate && !passesEntropyGate(fact, embedding, options.entropyCtx, deps.config)) {
    return { outcome: 'skipped', memoryId: null };
  }

  const claimSlot = await resolveDeterministicClaimSlot(deps, userId, fact);
  const filteredCandidates = await findFilteredCandidates(deps, userId, fact, embedding, claimSlot, options.supersededTargets);

  const ctx: AudnFactContext = {
    userId, fact, embedding, sourceSite, sourceUrl, episodeId,
    trustScore: writeSecurity.trust.score, claimSlot, logicalTimestamp: options.logicalTimestamp,
  };

  if (filteredCandidates.length === 0) {
    const result = await storeCanonicalFact(deps, ctx);
    return { ...result, embedding };
  }

  return resolveAndExecuteAudn(
    deps, userId, fact, embedding, sourceSite, sourceUrl, episodeId,
    writeSecurity.trust.score, claimSlot, options.logicalTimestamp,
    filteredCandidates, options.supersededTargets,
  );
}

// ---------------------------------------------------------------------------
// Quick path (performQuickIngest)
// ---------------------------------------------------------------------------

async function processQuickFact(
  deps: MemoryServiceDeps,
  userId: string,
  fact: FactInput,
  sourceSite: string,
  sourceUrl: string,
  episodeId: string,
  logicalTimestamp: Date | undefined,
  timingPrefix: string,
): Promise<FactResult> {
  const embedding = await timed(`${timingPrefix}.fact.embed`, () => embedText(fact.fact));
  const writeSecurity = assessWriteSecurity(fact.fact, sourceSite, deps.config);
  if (!writeSecurity.allowed) return { outcome: 'skipped', memoryId: null };
  const claimSlot = await resolveDeterministicClaimSlot(deps, userId, fact);

  const [vectorCandidates, slotCandidates] = await timed(`${timingPrefix}.fact.find-dupes`, async () => Promise.all([
    deps.stores.search.findNearDuplicates(userId, embedding, deps.config.audnCandidateThreshold),
    findSlotConflictCandidates(deps, userId, claimSlot),
  ]));
  const candidates = mergeCandidates(vectorCandidates, slotCandidates);

  if (candidates.length > 0) {
    const topCandidate = candidates.reduce((a, b) => a.similarity > b.similarity ? a : b);
    if (topCandidate.similarity >= deps.config.fastAudnDuplicateThreshold) {
      return { outcome: 'skipped', memoryId: topCandidate.id };
    }
  }

  const ctx: AudnFactContext = { userId, fact, embedding, sourceSite, sourceUrl, episodeId, trustScore: writeSecurity.trust.score, claimSlot, logicalTimestamp };
  const result = await storeCanonicalFact(deps, ctx);
  return { ...result, embedding };
}

// ---------------------------------------------------------------------------
// Workspace path (performWorkspaceIngest)
// ---------------------------------------------------------------------------

async function processWorkspaceFact(
  deps: MemoryServiceDeps,
  userId: string,
  fact: FactInput,
  sourceSite: string,
  sourceUrl: string,
  episodeId: string,
  workspace: WorkspaceContext,
  supersededTargets: Set<string>,
  timingPrefix: string,
): Promise<FactResult> {
  const embedding = await timed(`${timingPrefix}.fact.embed`, () => embedText(fact.fact));
  const writeSecurity = assessWriteSecurity(fact.fact, sourceSite, deps.config);
  if (!writeSecurity.allowed) {
    await recordRejectedWrite(userId, fact.fact, sourceSite, writeSecurity, deps.config);
    return { outcome: 'skipped', memoryId: null };
  }

  const candidates = await deps.stores.search.findNearDuplicatesInWorkspace(
    workspace.workspaceId, embedding, deps.config.audnCandidateThreshold, 10, 'all', workspace.agentId,
  );

  const ctx: AudnFactContext = {
    userId, fact, embedding, sourceSite, sourceUrl, episodeId,
    trustScore: writeSecurity.trust.score, workspace,
  };

  if (candidates.length === 0) {
    const result = await storeCanonicalFact(deps, ctx);
    return { ...result, embedding };
  }

  return resolveAndExecuteAudn(
    deps, userId, fact, embedding, sourceSite, sourceUrl, episodeId,
    writeSecurity.trust.score, null, undefined,
    candidates.map((c) => ({ ...c, content: c.content ?? '' })),
    supersededTargets,
    workspace,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check entropy gate; returns false if the fact should be skipped. */
function passesEntropyGate(
  fact: FactInput,
  embedding: number[],
  entropyCtx: EntropyContext,
  runtimeConfig: Pick<
    MemoryServiceDeps['config'],
    'entropyGateEnabled' | 'entropyGateThreshold' | 'entropyGateAlpha'
  >,
): boolean {
  if (!runtimeConfig.entropyGateEnabled) return true;
  const entropyResult = computeEntropyScore(
    {
      windowEntities: fact.keywords,
      existingEntities: entropyCtx.seenEntities,
      windowEmbedding: embedding,
      previousEmbedding: entropyCtx.previousEmbedding,
    },
    { threshold: runtimeConfig.entropyGateThreshold, alpha: runtimeConfig.entropyGateAlpha },
  );
  entropyCtx.previousEmbedding = embedding;
  for (const kw of fact.keywords) entropyCtx.seenEntities.add(kw);
  return entropyResult.accepted;
}
