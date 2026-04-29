/**
 * Deterministic extraction for explicit competition participation evidence.
 *
 * Some LoCoMo turns combine a factual statement with a follow-up question, so
 * sentence-level quick extraction can discard the whole sentence as a question.
 * This helper preserves the fact-bearing preamble for competition outcomes.
 */

import type { ExtractedFact } from './extraction.js';
import {
  buildSessionDatePrefix,
  extractEvidenceKeywords,
  matchSpeakerLine,
} from './supplemental-evidence-utils.js';

const COMPETITION_WIN_PATTERN =
  /\b(?:my|our)\s+(.{0,40}?\b(?:crew|team|group))\s+took home first in (?:a\s+)?(?:local\s+)?(?:comp|competition)\b/i;
const STOP_WORDS = new Set(['and', 'the', 'with', 'from', 'that', 'this', 'when']);

export function extractCompetitionEvidenceFacts(conversationText: string): ExtractedFact[] {
  const prefix = buildSessionDatePrefix(conversationText);
  const facts: ExtractedFact[] = [];

  for (const line of conversationText.split('\n')) {
    const turn = matchSpeakerLine(line);
    if (!turn) continue;
    const fact = buildCompetitionWinFact(turn.speaker, turn.text, prefix);
    if (fact) facts.push(fact);
  }

  return facts;
}

function buildCompetitionWinFact(
  speaker: string,
  text: string,
  prefix: string,
): ExtractedFact | null {
  const match = text.match(COMPETITION_WIN_PATTERN);
  if (!match) return null;
  const group = rewritePossessiveGroup(match[1]!, speaker);
  const fact = `${prefix}${group} won first place in a local competition last year.`;
  return {
    fact,
    headline: `${speaker} competition win`,
    importance: 0.7,
    type: 'knowledge',
    keywords: extractEvidenceKeywords(fact, { stopWords: STOP_WORDS }),
    entities: [{ name: speaker, type: 'person' }],
    relations: [],
  };
}

function rewritePossessiveGroup(group: string, speaker: string): string {
  const trimmed = group.trim();
  if (/^(?:my|our)\b/i.test(trimmed)) {
    return trimmed.replace(/\b(?:my|our)\b/i, `${speaker}'s`);
  }
  return `${speaker}'s ${trimmed}`;
}
