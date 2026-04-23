/**
 * Chunked extraction — splits conversations into overlapping turn windows
 * before extracting facts. Helps smaller LLMs (e.g. qwen3:8b) that struggle
 * with long contexts by giving them focused 3-4 turn windows instead of the
 * full conversation.
 *
 * Each chunk includes a session date header and overlap with the previous
 * chunk to preserve cross-turn context. Facts are deduplicated across chunks
 * using embedding similarity.
 */

import { config } from '../config.js';
import { extractFacts, type ExtractedFact } from './extraction.js';
import { cachedExtractFacts } from './extraction-cache.js';
import { cosineSimilarity, embedText } from './embedding.js';

const DEDUP_SIMILARITY_THRESHOLD = 0.92;

/**
 * Split conversation text into overlapping turn-based chunks.
 * Expects format: "[Session date: YYYY-MM-DD]\nSpeaker: text\nSpeaker: text\n..."
 */
function chunkConversation(
  conversationText: string,
  chunkSize: number,
  overlap: number,
): string[] {
  const lines = conversationText.split('\n');

  // Extract session header (first line if it starts with "[Session")
  let header = '';
  let turnLines: string[] = [];
  if (lines[0]?.startsWith('[Session')) {
    header = lines[0];
    turnLines = lines.slice(1).filter((l) => l.trim().length > 0);
  } else {
    turnLines = lines.filter((l) => l.trim().length > 0);
  }

  // Each turn is a line matching "Speaker: text"
  const turns = turnLines.filter((l) => /^\w[\w\s]*:/.test(l));

  if (turns.length <= chunkSize) {
    return [conversationText];
  }

  const chunks: string[] = [];
  const step = Math.max(1, chunkSize - overlap);
  for (let i = 0; i < turns.length; i += step) {
    const chunkTurns = turns.slice(i, i + chunkSize);
    if (chunkTurns.length === 0) break;
    const chunkText = header
      ? `${header}\n${chunkTurns.join('\n')}`
      : chunkTurns.join('\n');
    chunks.push(chunkText);
    if (i + chunkSize >= turns.length) break;
  }

  return chunks;
}

/**
 * Extract facts from each chunk and deduplicate across chunks.
 * Uses embedding similarity to detect duplicate facts from overlapping windows.
 */
export async function chunkedExtractFacts(
  conversationText: string,
): Promise<ExtractedFact[]> {
  const chunks = chunkConversation(
    conversationText,
    config.chunkSizeTurns,
    config.chunkOverlapTurns,
  );

  if (chunks.length <= 1) {
    return config.extractionCacheEnabled
      ? cachedExtractFacts(conversationText)
      : extractFacts(conversationText);
  }

  // Extract facts from each chunk
  const allFacts: ExtractedFact[] = [];
  for (const chunk of chunks) {
    const facts = config.extractionCacheEnabled
      ? await cachedExtractFacts(chunk)
      : await extractFacts(chunk);
    allFacts.push(...facts);
  }

  if (allFacts.length === 0) return [];

  // Deduplicate using embedding similarity
  return deduplicateFacts(allFacts);
}

/**
 * Remove near-duplicate facts by comparing embeddings.
 * Keeps the first occurrence (from earlier chunks) when duplicates found.
 */
async function deduplicateFacts(
  facts: ExtractedFact[],
): Promise<ExtractedFact[]> {
  if (facts.length <= 1) return facts;

  const embeddings = await Promise.all(
    facts.map((f) => embedText(f.fact)),
  );

  const kept = markDuplicates(facts, embeddings);
  return facts.filter((_, i) => kept[i]);
}

/**
 * Pairwise comparison to mark near-duplicate facts.
 * Keeps the higher-importance fact when duplicates are found.
 */
function markDuplicates(
  facts: ExtractedFact[],
  embeddings: number[][],
): boolean[] {
  const kept: boolean[] = new Array(facts.length).fill(true);
  for (let i = 0; i < facts.length; i++) {
    if (!kept[i]) continue;
    for (let j = i + 1; j < facts.length; j++) {
      if (!kept[j]) continue;
      if (cosineSimilarity(embeddings[i], embeddings[j]) < DEDUP_SIMILARITY_THRESHOLD) continue;
      if (facts[j].importance > facts[i].importance) {
        kept[i] = false;
        break;
      }
      kept[j] = false;
    }
  }
  return kept;
}
