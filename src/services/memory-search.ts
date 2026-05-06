/**
 * Search and retrieval orchestration for MemoryService.
 * Pure orchestration: delegates formatting to retrieval-format, dedup to
 * composite-dedup, side effects to retrieval-side-effects, lesson recording
 * to lesson-service, and the main retrieval to search-pipeline.
 */

import { type SearchResult } from '../db/memory-repository.js';
import { checkLessons, recordConsensusLessons, type LessonCheckResult } from './lesson-service.js';
import { validateConsensus, type ConsensusResult } from './consensus-validation.js';
import { embedText } from './embedding.js';
import { resolveSearchLimitDetailed, classifyQueryDetailed } from './retrieval-policy.js';
import { runSearchPipelineWithTrace } from './search-pipeline.js';
import { buildCitations as buildRichCitations, buildInjection, computePackagingSignal } from './retrieval-format.js';
import { finalizePackagingTrace } from './packaging-observability.js';
import { isCurrentStateQuery } from './current-state-ranking.js';
import { TraceCollector } from './retrieval-trace.js';
import { excludeStaleComposites } from './composite-staleness.js';
import { applyFlatPackagingPolicy } from './composite-dedup.js';
import { recordSearchSideEffects } from './retrieval-side-effects.js';
import {
  applyRelevanceFilter,
  resolveRelevanceGate,
  type RelevanceFilterDecision,
} from './relevance-policy.js';
import { shouldUseTLL, expandViaTLL, TLL_ENTITY_LOOKUP_SEED_LIMIT } from './tll-retrieval.js';
import type { AgentScope, WorkspaceContext } from '../db/repository-types.js';
import type { MemoryServiceDeps, RetrievalOptions, RetrievalResult } from './memory-service-types.js';

interface RelevanceFilterSummary {
  threshold: number | null;
  source: string;
  reason: string;
  queryLabel: string;
  removedIds: string[];
  decisions: RelevanceFilterDecision[];
}

interface PostProcessedSearch {
  memories: SearchResult[];
  consensusResult?: ConsensusResult;
  relevanceFilter: RelevanceFilterSummary;
}

interface PackagedSearchOutput {
  mode: RetrievalResult['retrievalMode'];
  outputMemories: SearchResult[];
  injectionText: string;
  tierAssignments: ReturnType<typeof buildInjection>['tierAssignments'];
  expandIds: ReturnType<typeof buildInjection>['expandIds'];
  estimatedContextTokens: ReturnType<typeof buildInjection>['estimatedContextTokens'];
  packagingSummary: ReturnType<typeof finalizePackagingTrace>['packagingSummary'];
  assemblySummary: ReturnType<typeof finalizePackagingTrace>['assemblySummary'];
}

/** Check lessons safety gate; returns undefined if lessons disabled. */
async function checkSearchLessons(deps: MemoryServiceDeps, userId: string, query: string): Promise<LessonCheckResult | undefined> {
  if (!deps.config.lessonsEnabled || !deps.stores.lesson) return undefined;
  return checkLessons(deps.stores.lesson, userId, query);
}

/** Try to resolve an atomicmem:// URI query. Returns result or null. */
async function tryUriResolution(
  deps: MemoryServiceDeps,
  query: string,
  userId: string,
  retrievalOptions: RetrievalOptions | undefined,
  trace: TraceCollector,
): Promise<RetrievalResult | null> {
  if (!query.startsWith('atomicmem://')) return null;
  const uriTier = retrievalOptions?.retrievalMode === 'flat' ? 'L2' : 'L1';
  const resolved = await deps.uriResolver.resolve(query, userId, uriTier);
  if (!resolved) return null;

  const resultMemories = Array.isArray(resolved.data) ? resolved.data : [resolved.data];
  trace.event('uri-resolution', { uri: query, type: resolved.type, tier: uriTier });
  trace.finalize(resultMemories);
  return {
    memories: resultMemories,
    injectionText: deps.uriResolver.format(resolved),
    citations: resultMemories.map((m: any) => m.id),
    retrievalMode: retrievalOptions?.retrievalMode ?? 'flat',
  };
}

/** Execute the core search (as-of or pipeline). */
async function executeSearchStep(
  deps: MemoryServiceDeps,
  userId: string,
  query: string,
  effectiveLimit: number,
  sourceSite: string | undefined,
  referenceTime: Date | undefined,
  namespaceScope: string | undefined,
  retrievalOptions: RetrievalOptions | undefined,
  asOf: string | undefined,
  trace: TraceCollector,
): Promise<{ memories: SearchResult[]; activeTrace: TraceCollector }> {
  if (asOf) {
    const memories = await deps.stores.claim.searchClaimVersions(userId, await embedText(query, 'query'), effectiveLimit, asOf, sourceSite);
    trace.stage('as-of-search', memories, { asOf });
    return { memories, activeTrace: trace };
  }
  const pipelineStores = { search: deps.stores.search, link: deps.stores.link, memory: deps.stores.memory, entity: deps.stores.entity, pool: deps.stores.pool };
  const pipelineResult = await runSearchPipelineWithTrace(pipelineStores, userId, query, effectiveLimit, sourceSite, referenceTime, {
    namespaceScope,
    retrievalMode: retrievalOptions?.retrievalMode,
    searchStrategy: retrievalOptions?.searchStrategy,
    skipRepairLoop: retrievalOptions?.skipRepairLoop,
    skipReranking: retrievalOptions?.skipReranking,
    runtimeConfig: deps.config,
  });
  // TLL augmentation runs AFTER the pipeline (which already applied its own
  // relevance/similarity filtering). Chain-membership is a different
  // retrieval signal than semantic similarity, so the augmented rows ride
  // around the post-pipeline relevance gate (see appendChainAugmentation
  // callsite in performSearch). Pipeline-filtered rows stay first.
  return { memories: pipelineResult.filtered, activeTrace: pipelineResult.trace };
}

/**
 * TLL retrieval signal. For ordering/temporal/multi-session queries, expand
 * the candidate set by traversing entity event chains. Returns hydrated
 * SearchResult rows tagged with `retrieval_signal: 'tll-chain'` so the
 * relevance gate can recognize them as non-similarity-scored augmentations.
 * Fail-open: chain expansion errors don't block primary retrieval.
 */
async function maybeExpandViaTLL(
  deps: MemoryServiceDeps,
  userId: string,
  query: string,
  memories: SearchResult[],
  effectiveLimit: number,
): Promise<SearchResult[]> {
  if (!deps.tllRepository || memories.length === 0 || !shouldUseTLL(query)) {
    return [];
  }
  try {
    const initialIds = memories.slice(0, TLL_ENTITY_LOOKUP_SEED_LIMIT).map((m) => m.id);
    const chainIds = await expandViaTLL(userId, initialIds, deps.tllRepository, deps.stores.pool);
    const knownIds = new Set(memories.map((m) => m.id));
    const newIds = chainIds.filter((id) => !knownIds.has(id)).slice(0, effectiveLimit);
    if (newIds.length === 0) return [];
    const hydrated = await hydrateChainMemories(deps, userId, newIds);
    console.log(`[tll-retrieval] expanded ${newIds.length} chain memories for ordering query`);
    return hydrated;
  } catch (err) {
    // Fail-open: TLL is augmentation; never block primary retrieval
    console.error('[tll-retrieval] expansion failed:', err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * Direct SQL hydration into SearchResult shape — bypasses store
 * abstraction since this is a deterministic chain-traversal augmentation,
 * not a similarity search. Rows are tagged with `retrieval_signal:
 * 'tll-chain'` and carry `similarity: null` so the relevance gate can
 * skip them rather than score them against semantic similarity.
 */
async function hydrateChainMemories(
  deps: MemoryServiceDeps,
  userId: string,
  newIds: string[],
): Promise<SearchResult[]> {
  const hydratedRes = await deps.stores.pool.query<{ id: string; content: string; created_at: Date; importance: number; namespace: string | null }>(
    `SELECT id, content, created_at, importance, namespace
     FROM memories
     WHERE user_id = $1 AND id = ANY($2::uuid[])
       AND deleted_at IS NULL AND status = 'active'`,
    [userId, newIds],
  );
  return hydratedRes.rows.map((r) => ({
    id: r.id,
    content: r.content,
    similarity: null,
    retrieval_signal: 'tll-chain',
    created_at: r.created_at,
    importance: Number(r.importance),
    namespace: r.namespace,
    tags: [],
    keywords: [],
    workspace_id: null,
    agent_id: null,
  } as unknown as SearchResult));
}

/** Filter workspace-scoped, stale composites, and consensus-violating memories. */
async function postProcessResults(
  deps: MemoryServiceDeps,
  rawMemories: SearchResult[],
  activeTrace: TraceCollector,
  userId: string,
  query: string,
  asOf: string | undefined,
  sourceSite: string | undefined,
  retrievalOptions: RetrievalOptions | undefined,
): Promise<PostProcessedSearch> {
  let memories = rawMemories.filter((m) => !m.workspace_id);

  if (!asOf) {
    const compositeResult = await excludeStaleComposites(deps.stores.memory, userId, memories);
    if (compositeResult.removedCompositeIds.length > 0) {
      memories = compositeResult.filtered;
      activeTrace.stage('stale-composite-filter', memories, {
        removedCount: compositeResult.removedCompositeIds.length,
        removedIds: compositeResult.removedCompositeIds,
      });
    }
  }

  let consensusResult: ConsensusResult | undefined;

  if (deps.config.consensusValidationEnabled && memories.length >= deps.config.consensusMinMemories) {
    consensusResult = await validateConsensus(query, memories);
    if (consensusResult.removedMemoryIds.length > 0) {
      const removedSet = new Set(consensusResult.removedMemoryIds);
      memories = memories.filter((m) => !removedSet.has(m.id));
      activeTrace.stage('consensus-filter', memories, {
        removedCount: consensusResult.removedMemoryIds.length,
        removedIds: consensusResult.removedMemoryIds,
      });
      if (deps.config.lessonsEnabled && deps.stores.lesson) {
        recordConsensusLessons(deps.stores.lesson, userId, consensusResult, memories).catch(
          (err) => console.error('Consensus lesson recording failed:', err),
        );
      }
    }
  }

  const relevanceFilter = applySearchRelevanceFilter(
    memories,
    activeTrace,
    query,
    retrievalOptions,
    deps.config,
    { asOf, sourceSite },
  );
  return { memories: relevanceFilter.memories, consensusResult, relevanceFilter };
}

function applySearchRelevanceFilter(
  memories: SearchResult[],
  activeTrace: TraceCollector,
  query: string,
  retrievalOptions: RetrievalOptions | undefined,
  runtimeConfig: MemoryServiceDeps['config'],
  gateContext: { asOf?: string; sourceSite?: string } = {},
): RelevanceFilterSummary & { memories: SearchResult[] } {
  const gate = resolveRelevanceGate(query, retrievalOptions?.relevanceThreshold, runtimeConfig, gateContext);
  const result = applyRelevanceFilter(memories, gate);
  const summary = {
    threshold: gate.threshold,
    source: gate.source,
    reason: gate.reason,
    queryLabel: gate.queryLabel,
    removedIds: result.removedIds,
    decisions: result.decisions,
  };
  activeTrace.stage('relevance-filter', result.memories, {
    ...summary,
    removedCount: result.removedIds.length,
  });
  return { ...summary, memories: result.memories };
}

/** Package memories, build injection text, and assemble the final response. */
function assembleResponse(
  deps: MemoryServiceDeps,
  postProcessed: PostProcessedSearch,
  query: string,
  userId: string,
  activeTrace: TraceCollector,
  retrievalOptions: RetrievalOptions | undefined,
  asOf: string | undefined,
  sourceSite: string | undefined,
  lessonCheck: LessonCheckResult | undefined,
): RetrievalResult {
  const packaged = packageSearchOutput(postProcessed, query, activeTrace, retrievalOptions);
  recordSearchSideEffects(deps, packaged.outputMemories, userId, query, sourceSite, asOf);
  updateRetrievalSummary(activeTrace, packaged.outputMemories, query, retrievalOptions, postProcessed.relevanceFilter);
  activeTrace.finalize(packaged.outputMemories);
  return buildRetrievalResult(postProcessed, packaged, activeTrace, lessonCheck);
}

function packageSearchOutput(
  postProcessed: PostProcessedSearch,
  query: string,
  activeTrace: TraceCollector,
  retrievalOptions: RetrievalOptions | undefined,
): PackagedSearchOutput {
  const mode = retrievalOptions?.retrievalMode ?? 'flat';
  const packaged = applyFlatPackagingPolicy(postProcessed.memories, query, mode, activeTrace);
  const outputMemories = isCurrentStateQuery(query) ? packaged.sort((a, b) => b.score - a.score) : packaged;
  const { injectionText, tierAssignments, expandIds, estimatedContextTokens } =
    buildInjection(outputMemories, query, mode, retrievalOptions?.tokenBudget);
  const { packagingSummary, assemblySummary } = finalizePackagingTrace(activeTrace, {
    outputMemories, mode, injectionText, estimatedContextTokens, tierAssignments,
    tokenBudget: retrievalOptions?.tokenBudget,
  });
  return {
    mode, outputMemories, injectionText, tierAssignments, expandIds,
    estimatedContextTokens, packagingSummary, assemblySummary,
  };
}

function updateRetrievalSummary(
  activeTrace: TraceCollector,
  outputMemories: SearchResult[],
  query: string,
  retrievalOptions: RetrievalOptions | undefined,
  relevanceFilter: RelevanceFilterSummary,
): void {
  const priorSummary = activeTrace.getRetrievalSummary();
  activeTrace.setRetrievalSummary({
    candidateIds: outputMemories.map((memory) => memory.id),
    candidateCount: outputMemories.length,
    queryText: priorSummary?.queryText ?? query,
    skipRepair: priorSummary?.skipRepair ?? retrievalOptions?.skipRepairLoop ?? false,
    relevanceThreshold: relevanceFilter.threshold,
    relevanceFilterSource: relevanceFilter.source,
    relevanceFilterReason: relevanceFilter.reason,
    filteredCandidateIds: relevanceFilter.removedIds,
    filterDecisions: relevanceFilter.decisions,
  });
}

function buildRetrievalResult(
  postProcessed: PostProcessedSearch,
  packaged: PackagedSearchOutput,
  activeTrace: TraceCollector,
  lessonCheck: LessonCheckResult | undefined,
): RetrievalResult {
  return {
    memories: packaged.outputMemories,
    injectionText: packaged.injectionText,
    citations: buildRichCitations(packaged.outputMemories).map((c) => c.memory_id),
    retrievalMode: packaged.mode,
    tierAssignments: packaged.tierAssignments,
    expandIds: packaged.expandIds,
    estimatedContextTokens: packaged.estimatedContextTokens,
    lessonCheck, consensusResult: postProcessed.consensusResult,
    packagingSignal: computePackagingSignal(packaged.outputMemories),
    retrievalSummary: activeTrace.getRetrievalSummary(),
    packagingSummary: packaged.packagingSummary,
    assemblySummary: packaged.assemblySummary,
  };
}

/** Full search with lesson check, URI resolution, pipeline, post-processing, and packaging. */
export async function performSearch(
  deps: MemoryServiceDeps,
  userId: string,
  query: string,
  sourceSite?: string,
  limit?: number,
  asOf?: string,
  referenceTime?: Date,
  namespaceScope?: string,
  retrievalOptions?: RetrievalOptions,
): Promise<RetrievalResult> {
  const lessonCheck = await checkSearchLessons(deps, userId, query);
  if (lessonCheck && !lessonCheck.safe) {
    return { memories: [], injectionText: '', citations: [], retrievalMode: retrievalOptions?.retrievalMode ?? 'flat', lessonCheck };
  }

  const { limit: effectiveLimit, classification } = resolveSearchLimitDetailed(query, limit, deps.config);
  const trace = new TraceCollector(query, userId);
  trace.event('query-classification', { label: classification.label, limit: effectiveLimit, matchedMarker: classification.matchedMarker });

  const uriResult = await tryUriResolution(deps, query, userId, retrievalOptions, trace);
  if (uriResult) return uriResult;

  const { memories: rawMemories, activeTrace } = await executeSearchStep(deps, userId, query, effectiveLimit, sourceSite, referenceTime, namespaceScope, retrievalOptions, asOf, trace);
  const filteredMemories = await postProcessResults(
    deps, rawMemories, activeTrace, userId, query, asOf, sourceSite, retrievalOptions,
  );
  const augmented = await appendTllAugmentation(deps, userId, query, filteredMemories, effectiveLimit, activeTrace);
  return assembleResponse(deps, augmented, query, userId, activeTrace, retrievalOptions, asOf, sourceSite, lessonCheck);
}

/**
 * Append TLL chain-membership augmentations after the relevance gate. The
 * augmented rows ride around the similarity threshold because chain
 * membership is a structurally different signal — they have no
 * meaningful similarity score against the query.
 */
async function appendTllAugmentation(
  deps: MemoryServiceDeps,
  userId: string,
  query: string,
  postProcessed: PostProcessedSearch,
  effectiveLimit: number,
  activeTrace: TraceCollector,
): Promise<PostProcessedSearch> {
  const augment = await maybeExpandViaTLL(deps, userId, query, postProcessed.memories, effectiveLimit);
  if (augment.length === 0) return postProcessed;
  activeTrace.stage('tll-augmentation', [...postProcessed.memories, ...augment], {
    addedCount: augment.length,
    addedIds: augment.map((m) => m.id),
  });
  return { ...postProcessed, memories: [...postProcessed.memories, ...augment] };
}

/**
 * Latency-optimized search that skips repair/reranking for simple and medium
 * queries, but escalates to the full pipeline for multi-hop, aggregation, and
 * complex queries where the LLM rewrite materially improves retrieval.
 */
export async function performFastSearch(
  deps: MemoryServiceDeps,
  userId: string,
  query: string,
  sourceSite?: string,
  limit?: number,
  namespaceScope?: string,
  retrievalOptions?: RetrievalOptions,
): Promise<RetrievalResult> {
  const label = classifyQueryDetailed(query).label;
  const escalate = label === 'multi-hop' || label === 'aggregation' || label === 'complex';
  // Fast search owns these latency toggles based on query class; caller options
  // still flow through for packaging, threshold, and strategy controls.
  return performSearch(deps, userId, query, sourceSite, limit, undefined, undefined, namespaceScope, {
    ...retrievalOptions,
    skipRepairLoop: !escalate,
    skipReranking: !escalate,
  });
}

/**
 * Workspace-scoped search: retrieves memories from the workspace memory pool.
 * Uses workspace-filtered vector search with agent scope and visibility enforcement.
 */
export async function performWorkspaceSearch(
  deps: MemoryServiceDeps,
  userId: string,
  query: string,
  workspace: WorkspaceContext,
  options: {
    agentScope?: AgentScope;
    limit?: number;
    referenceTime?: Date;
    retrievalOptions?: RetrievalOptions;
  } = {},
): Promise<RetrievalResult> {
  const { limit: effectiveLimit } = resolveSearchLimitDetailed(query, options.limit, deps.config);
  const queryEmbedding = await embedText(query, 'query');

  const memories = await deps.stores.search.searchSimilarInWorkspace(
    workspace.workspaceId, queryEmbedding, effectiveLimit,
    options.agentScope ?? 'all', workspace.agentId, options.referenceTime,
  );
  const trace = new TraceCollector(query, userId);
  trace.stage('workspace-search', memories, {
    workspaceId: workspace.workspaceId,
    agentId: workspace.agentId,
    agentScope: options.agentScope ?? 'all',
  });

  const { filtered: staleFilteredMemories, removedCompositeIds } =
    await excludeStaleComposites(deps.stores.memory, userId, memories);
  if (removedCompositeIds.length > 0) {
    trace.stage('stale-composite-filter', staleFilteredMemories, {
      removedCount: removedCompositeIds.length,
      removedIds: removedCompositeIds,
    });
  }

  const relevanceFilter = applySearchRelevanceFilter(
    staleFilteredMemories,
    trace,
    query,
    options.retrievalOptions,
    deps.config,
  );
  const filteredMemories = relevanceFilter.memories;
  for (const m of filteredMemories) deps.stores.memory.touchMemory(m.id).catch(() => {});

  const mode = options.retrievalOptions?.retrievalMode ?? 'flat';
  const injection = buildInjection(filteredMemories, query, mode, options.retrievalOptions?.tokenBudget);
  updateRetrievalSummary(trace, filteredMemories, query, options.retrievalOptions, relevanceFilter);
  trace.finalize(filteredMemories);
  return {
    memories: filteredMemories,
    citations: filteredMemories.map((m) => m.id),
    retrievalMode: mode,
    retrievalSummary: trace.getRetrievalSummary(),
    ...injection,
  };
}
