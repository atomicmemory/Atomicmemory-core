/**
 * EXP-23: Event-ordering query detector.
 *
 * Returns true when `query` looks like an event-ordering question —
 * i.e. asking for a chronological sequence rather than a single fact.
 * Pure regex/keyword; no LLM.
 *
 * Used by the search-pipeline to gate topic-aware retrieval.
 */

const ORDERING_MARKERS = [
  'list the order',
  'in what order',
  'in chronological order',
  'chronological order',
  'in order',
  'order in which',
  'walk me through the order',
  'timeline',
  'sequence',
  'over time',
  'evolution of',
  'progression of',
];

const COMPOUND_FIRST_THEN = /\bfirst\b[^.?!]*\bthen\b[^.?!]*\b(?:and\s+)?finally\b/i;
const COMPOUND_FIRST_THEN_LOOSE = /\bfirst\b[^.?!]*\bthen\b/i;

/**
 * Returns true when the query is event-ordering style.
 * Markers: "list the order", "in what order", "in chronological order",
 * "sequence", "first ... then ... and finally", "timeline".
 */
export function isEventOrderingQuery(query: string): boolean {
  if (typeof query !== 'string') return false;
  const trimmed = query.trim();
  if (trimmed.length < 6) return false;
  const lower = trimmed.toLowerCase();

  if (ORDERING_MARKERS.some((marker) => lower.includes(marker))) return true;
  if (COMPOUND_FIRST_THEN.test(lower)) return true;
  if (COMPOUND_FIRST_THEN_LOOSE.test(lower) && /\bfinally\b/.test(lower)) return true;
  return false;
}
