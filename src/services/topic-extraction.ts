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
// "aspects of <noun-phrase>" / "integrating <X>" / "implementing the <X>" — the
// most common BEAM event-ordering question template. The captured phrase runs
// up to a clause/preposition boundary so we get e.g. "the city autocomplete
// feature" out of "different aspects of implementing the city autocomplete
// feature across our conversations."
const ASPECTS_OF_PATTERN = /\baspects of\s+(?:integrating\s+|implementing\s+|building\s+|customizing\s+|configuring\s+|developing\s+|handling\s+)?((?:the\s+|my\s+)?[a-z][\w-]*(?:\s+[a-z][\w-]+){0,5}?)(?=\s+(?:across|throughout|in\s+|during|over|to\s+|for\s+|since)\b|[.?!]|$)/i;
const INTEGRATING_PATTERN = /\b(?:integrating|integrated|implementing|implemented|building|built|customizing|customized|configuring|configured|deploying|deployed|developing|developed|handling|handled)\s+((?:the\s+|my\s+)?[a-z][\w-]*(?:\s+[a-z][\w-]+){0,4}?)(?=\s+(?:across|throughout|in\s+|during|over|to\s+|for\s+|since|through)\b|[.?!]|$)/i;

/**
 * Extract the most specific topic noun phrase from `query`, or null when
 * no candidate is clear enough to drive topic-aware retrieval.
 *
 * Strategy (pure regex):
 *   1. quoted phrases ("...")    → strongest signal
 *   2. proper-noun runs          → e.g. "Bootstrap", "AWS Lambda"
 *   3. "aspects of <noun>" / "integrating <noun>" templates — the BEAM
 *      event-ordering question shape, where the topic isn't capitalized.
 * Returns the longest non-stop-word candidate.
 */
export function extractTopicNoun(query: string): string | null {
  if (typeof query !== 'string') return null;
  const trimmed = query.trim();
  if (trimmed.length < 8) return null;

  const candidates: string[] = [];
  collectQuoted(trimmed, candidates);
  collectProperNouns(trimmed, candidates);
  collectTemplateNouns(trimmed, candidates);

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

function collectTemplateNouns(query: string, out: string[]): void {
  const aspectsMatch = query.match(ASPECTS_OF_PATTERN);
  if (aspectsMatch?.[1]) out.push(aspectsMatch[1]);
  const integratingMatch = query.match(INTEGRATING_PATTERN);
  if (integratingMatch?.[1]) out.push(integratingMatch[1]);
}

function isAllStopWords(phrase: string): boolean {
  const tokens = phrase.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  return tokens.every((token) => STOP_WORDS.has(token));
}
