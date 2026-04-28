/**
 * Score semantics and relevance threshold policy for retrieval packaging.
 */

import type { SearchResult } from '../db/repository-types.js';
import { classifyQueryDetailed, type QueryComplexityLabel } from './retrieval-policy.js';

export interface RelevanceGateConfig {
  similarityThreshold: number;
}

export interface RelevanceGate {
  threshold: number | null;
  source: 'request' | 'config' | 'disabled';
  reason: string;
  queryLabel: QueryComplexityLabel;
}

export interface RelevanceFilterDecision {
  id: string;
  sourceSite: string;
  sourceKind: 'integration' | 'local';
  namespace: string | null;
  semanticSimilarity: number;
  rankingScore: number;
  relevance: number;
  threshold: number | null;
  decision: 'kept' | 'filtered';
  reason: string;
}

export interface RelevanceFilterResult {
  memories: SearchResult[];
  decisions: RelevanceFilterDecision[];
  removedIds: string[];
}

const BROAD_QUERY_LABELS = new Set<QueryComplexityLabel>(['aggregation', 'multi-hop']);
const INTEGRATION_SOURCE_MARKERS = [
  'integration',
  'gmail',
  'google-drive',
  'google_drive',
  'drive',
  'x.com',
  'twitter',
];

export function resolveRelevanceGate(
  query: string,
  requestedThreshold: number | undefined,
  runtimeConfig: RelevanceGateConfig,
): RelevanceGate {
  const queryLabel = classifyQueryDetailed(query).label;
  if (requestedThreshold !== undefined) {
    return buildGate(requestedThreshold, 'request', 'caller-threshold', queryLabel);
  }
  if (BROAD_QUERY_LABELS.has(queryLabel)) {
    return { threshold: null, source: 'disabled', reason: `broad-${queryLabel}-query`, queryLabel };
  }
  return buildGate(runtimeConfig.similarityThreshold, 'config', 'direct-query-default', queryLabel);
}

export function applyRelevanceFilter(
  memories: SearchResult[],
  gate: RelevanceGate,
): RelevanceFilterResult {
  const scored = memories.map(withScoreSemantics);
  const decisions = scored.map((memory) => buildDecision(memory, gate));
  if (gate.threshold === null) return { memories: scored, decisions, removedIds: [] };

  const keptIds = new Set(
    decisions.filter((decision) => decision.decision === 'kept').map((decision) => decision.id),
  );
  return {
    memories: scored.filter((memory) => keptIds.has(memory.id)),
    decisions,
    removedIds: decisions.filter((decision) => decision.decision === 'filtered').map((decision) => decision.id),
  };
}

function withScoreSemantics(memory: SearchResult): SearchResult {
  const semanticSimilarity = finiteOrZero(memory.semantic_similarity ?? memory.similarity);
  const rankingScore = finiteOrZero(memory.ranking_score ?? memory.score);
  const relevance = clampUnit(memory.relevance ?? semanticSimilarity);
  return {
    ...memory,
    semantic_similarity: semanticSimilarity,
    ranking_score: rankingScore,
    relevance,
  };
}

function buildGate(
  rawThreshold: number,
  source: RelevanceGate['source'],
  reason: string,
  queryLabel: QueryComplexityLabel,
): RelevanceGate {
  const threshold = clampUnit(rawThreshold);
  if (threshold <= 0) return { threshold: null, source: 'disabled', reason: 'non-positive-threshold', queryLabel };
  return { threshold, source, reason, queryLabel };
}

function buildDecision(memory: SearchResult, gate: RelevanceGate): RelevanceFilterDecision {
  const sourceKind = isIntegrationSource(memory.source_site) ? 'integration' : 'local';
  const threshold = gate.threshold;
  const kept = threshold === null || (memory.relevance ?? 0) >= threshold;
  return {
    id: memory.id,
    sourceSite: memory.source_site,
    sourceKind,
    namespace: memory.namespace ?? null,
    semanticSimilarity: memory.semantic_similarity ?? 0,
    rankingScore: memory.ranking_score ?? memory.score,
    relevance: memory.relevance ?? 0,
    threshold,
    decision: kept ? 'kept' : 'filtered',
    reason: buildReason(kept, gate, sourceKind),
  };
}

function buildReason(
  kept: boolean,
  gate: RelevanceGate,
  sourceKind: RelevanceFilterDecision['sourceKind'],
): string {
  if (gate.threshold === null) return gate.reason;
  if (sourceKind === 'integration') {
    return kept ? 'integration-meets-threshold' : 'integration-below-threshold';
  }
  return kept ? 'meets-threshold' : 'below-threshold';
}

function isIntegrationSource(sourceSite: string): boolean {
  const normalized = sourceSite.toLowerCase();
  return INTEGRATION_SOURCE_MARKERS.some((marker) => normalized.includes(marker));
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
