/**
 * EXP-23: Topic-aware retrieval for event-ordering queries.
 *
 * When a query like "list the order in which I brought up different aspects
 * of integrating Bootstrap" runs through standard semantic retrieval, the
 * top-K facts match the *question phrasing* rather than the underlying
 * topic. Result: the chronology of the topic itself is missed.
 *
 * This stage re-issues a vector search using the extracted *topic noun*
 * (not the full question), pulls up to `topicRetrievalK` facts, and sorts
 * them by `created_at` ascending so the LLM receives the topic's evolution
 * in chronological order.
 *
 * Defaults-off behind `topicAwareRetrievalEnabled`. Fires only when the
 * caller has already determined the query is event-ordering style and a
 * topic noun was extracted; otherwise this module returns the input
 * candidate set unchanged so downstream stages stay deterministic.
 */

import type { SearchResult } from '../db/repository-types.js';
import type { SearchStore } from '../db/stores.js';
import { embedText } from './embedding.js';
import { extractTopicNoun } from './topic-extraction.js';

export interface TopicAwareRetrievalConfig {
  /** Master flag. When false, the stage is a strict no-op. */
  topicAwareRetrievalEnabled: boolean;
  /** Max facts pulled by the topic-targeted re-search (default 30). */
  topicRetrievalK: number;
}

export interface TopicAwareRetrievalDeps {
  search: SearchStore;
}

export interface TopicAwareRetrievalResult {
  /** Whether the topic-aware re-search actually ran and produced facts. */
  applied: boolean;
  /** Topic noun used for the re-search, when applied. */
  topic: string | null;
  /** New candidate set (chronologically ordered) when applied; original otherwise. */
  results: SearchResult[];
}

/**
 * Re-search using the extracted topic noun and return the resulting
 * facts sorted by `created_at` ascending.
 *
 * Replaces (does not merge with) the input candidate set when applied —
 * the caller decides where in the pipeline to invoke this so MMR /
 * cross-encoder reranking don't scramble the chronological order.
 */
export async function applyTopicAwareRetrieval(
  deps: TopicAwareRetrievalDeps,
  userId: string,
  query: string,
  candidateMemories: SearchResult[],
  config: TopicAwareRetrievalConfig,
  sourceSite?: string,
  referenceTime?: Date,
): Promise<TopicAwareRetrievalResult> {
  if (!config.topicAwareRetrievalEnabled) {
    return { applied: false, topic: null, results: candidateMemories };
  }

  const topic = extractTopicNoun(query);
  if (!topic) {
    return { applied: false, topic: null, results: candidateMemories };
  }

  const k = Math.max(1, Math.floor(config.topicRetrievalK));
  const topicEmbedding = await embedText(topic, 'query');
  const topicResults = await deps.search.searchSimilar(
    userId,
    topicEmbedding,
    k,
    sourceSite,
    referenceTime,
  );

  if (topicResults.length === 0) {
    return { applied: false, topic, results: candidateMemories };
  }

  const chronological = sortByCreatedAtAscending(topicResults);
  return { applied: true, topic, results: chronological };
}

function sortByCreatedAtAscending(results: SearchResult[]): SearchResult[] {
  return [...results].sort((a, b) => {
    const aTime = a.created_at instanceof Date ? a.created_at.getTime() : new Date(a.created_at).getTime();
    const bTime = b.created_at instanceof Date ? b.created_at.getTime() : new Date(b.created_at).getTime();
    return aTime - bTime;
  });
}
