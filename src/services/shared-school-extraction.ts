/**
 * Deterministic extraction for shared school/class history.
 *
 * Some LoCoMo questions ask whether two speakers studied together. The raw
 * evidence may phrase this indirectly as an elementary-school photo plus a
 * shared "we left class early" memory, so this helper preserves the explicit
 * shared-school relation for retrieval and answer synthesis.
 */

import type { ExtractedFact } from './extraction.js';
import {
  extractEvidenceKeywords,
  parseSpeakerTurns,
  type SpeakerTurn,
} from './supplemental-evidence-utils.js';

const SCHOOL_MEMORY_PATTERN = /\bremember .* elementary school\b/i;
const SHARED_CLASS_PATTERN = /\bwe\b.*\b(?:left class|class early|school)\b/i;

export function extractSharedSchoolFacts(conversationText: string): ExtractedFact[] {
  const turns = parseSpeakerTurns(conversationText);
  const facts: ExtractedFact[] = [];

  for (let index = 0; index < turns.length; index++) {
    const current = turns[index]!;
    const match = findSharedClassResponse(turns, index);
    if (SCHOOL_MEMORY_PATTERN.test(current.text) && match) {
      facts.push(buildSharedSchoolFact(current.speaker, match.speaker));
    }
  }

  return facts;
}

function findSharedClassResponse(turns: SpeakerTurn[], index: number): SpeakerTurn | null {
  const lookahead = turns.slice(index + 1, index + 4);
  return lookahead.find((turn) => SHARED_CLASS_PATTERN.test(turn.text)) ?? null;
}

function buildSharedSchoolFact(firstSpeaker: string, secondSpeaker: string): ExtractedFact {
  const fact = `${firstSpeaker} and ${secondSpeaker} attended elementary school and class together.`;
  return {
    fact,
    headline: `${firstSpeaker} and ${secondSpeaker} shared school history`,
    importance: 0.6,
    type: 'person',
    keywords: extractEvidenceKeywords(fact, { limit: 10 }),
    entities: [
      { name: firstSpeaker, type: 'person' },
      { name: secondSpeaker, type: 'person' },
    ],
    relations: [{ source: firstSpeaker, target: secondSpeaker, type: 'knows' }],
  };
}
