/**
 * EXP-23: Topic noun extraction for event-ordering queries.
 *
 * Pulls the most specific topic noun phrase out of a query so that
 * topic-aware retrieval can re-search against the topic itself rather
 * than the (often vague) full question text.
 *
 * Pure regex/keyword. Returns null when no clear topic candidate exists,
 * so callers fail closed and skip the topic-aware path.
 */

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'or', 'the', 'this', 'that', 'these', 'those',
  'i', 'me', 'my', 'we', 'us', 'our', 'you', 'your',
  'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'do', 'does', 'did', 'has', 'have', 'had',
  'will', 'would', 'should', 'could', 'can', 'may', 'might',
  'what', 'when', 'where', 'which', 'who', 'whom', 'whose', 'why', 'how',
  'list', 'order', 'sequence', 'timeline', 'chronological', 'first', 'then', 'finally',
  'in', 'on', 'at', 'of', 'to', 'for', 'with', 'by', 'from', 'into', 'about', 'across',
  'different', 'aspects', 'aspect', 'brought', 'bring', 'up',
  'conversations', 'conversation', 'projects', 'project',
  'integrating', 'integrate', 'integration',
  'tell', 'show', 'give', 'remind', 'remember',
]);

const QUOTED_PHRASE = /["“]([^"”]{2,80})["”]/g;
const PROPER_NOUN_PHRASE = /\b([A-Z][\w.+-]*(?:\s+[A-Z][\w.+-]*){0,3})\b/g;

/**
 * Extract the most specific topic noun phrase from `query`, or null when
 * no candidate is clear enough to drive topic-aware retrieval.
 *
 * Strategy (pure regex):
 *   1. quoted phrases ("...")    → strongest signal
 *   2. proper-noun runs          → e.g. "Bootstrap", "AWS Lambda"
 *   3. trailing non-stop content noun phrase
 * Returns the longest non-stop-word candidate.
 */
export function extractTopicNoun(query: string): string | null {
  if (typeof query !== 'string') return null;
  const trimmed = query.trim();
  if (trimmed.length < 8) return null;

  const candidates: string[] = [];
  collectQuoted(trimmed, candidates);
  collectProperNouns(trimmed, candidates);

  const filtered = candidates
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.length >= 2)
    .filter((candidate) => !isAllStopWords(candidate));

  if (filtered.length === 0) return null;

  filtered.sort((a, b) => b.length - a.length);
  return filtered[0];
}

function collectQuoted(query: string, out: string[]): void {
  for (const match of query.matchAll(QUOTED_PHRASE)) {
    if (match[1]) out.push(match[1]);
  }
}

function collectProperNouns(query: string, out: string[]): void {
  // Skip the very first word — sentence-initial caps are noise ("List the order ...").
  const stripped = query.replace(/^\s*\S+\s*/, ' ');
  for (const match of stripped.matchAll(PROPER_NOUN_PHRASE)) {
    if (match[1]) out.push(match[1]);
  }
}

function isAllStopWords(phrase: string): boolean {
  const tokens = phrase.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  return tokens.every((token) => STOP_WORDS.has(token));
}
