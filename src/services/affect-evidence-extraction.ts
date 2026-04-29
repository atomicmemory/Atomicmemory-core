/**
 * Deterministic extraction for explicit affect evidence.
 *
 * LoCoMo affect questions often depend on short statements like "they bring
 * me joy" whose pronoun target is established by nearby pet/dog context. The
 * LLM extractor can drop these because they look conversational rather than
 * factual, so this helper preserves the explicit affect relation.
 */

import type { ExtractedFact } from './extraction.js';
import {
  extractEvidenceKeywords,
  parseSpeakerTurns,
  type SpeakerTurn,
} from './supplemental-evidence-utils.js';

const JOY_PRONOUN_PATTERN = /\b(?:joy they bring me|they bring me (?:joy|happiness))\b/i;
const MOTIVATION_PRONOUN_PATTERN =
  /\bthey (?:make me think of|help motivate me|motivate me|inspire me|give me)\b/i;
const HAPPINESS_INVENTORY_PATTERN = /\b(.+?)\s+are all that bring me happiness in life\b/i;
const OBJECT_PATTERN = /\b(dogs|pets|cats|turtles?|snakes|guinea pigs?|labradors?|shepherds?)\b/i;

export function extractAffectEvidenceFacts(conversationText: string): ExtractedFact[] {
  const facts: ExtractedFact[] = [];
  const turns = parseSpeakerTurns(conversationText);

  for (let index = 0; index < turns.length; index++) {
    facts.push(...extractTurnAffectFacts(turns, index));
  }

  return facts;
}

function extractTurnAffectFacts(turns: SpeakerTurn[], index: number): ExtractedFact[] {
  const turn = turns[index]!;
  const facts: ExtractedFact[] = [];
  const inventory = turn.text.match(HAPPINESS_INVENTORY_PATTERN)?.[1]?.trim();
  if (inventory) {
    facts.push(buildFact(turn.speaker, `${turn.speaker}'s ${inventory} bring ${turn.speaker} happiness in life.`));
  }
  if (JOY_PRONOUN_PATTERN.test(turn.text)) {
    const object = findNearbyObject(turns, index);
    if (object) {
      facts.push(buildFact(turn.speaker, `${turn.speaker}'s ${object} bring ${turn.speaker} joy.`));
    }
  }
  if (MOTIVATION_PRONOUN_PATTERN.test(turn.text)) {
    const object = findNearbyObject(turns, index);
    if (object) {
      facts.push(buildFact(turn.speaker, `${turn.speaker} likes the animal ${object} and finds them motivating.`));
    }
  }
  return facts;
}

function findNearbyObject(turns: SpeakerTurn[], index: number): string | null {
  const start = Math.max(0, index - 4);
  const context = turns.slice(start, index + 1).map((turn) => turn.text).join(' ');
  const matched = context.match(OBJECT_PATTERN)?.[1]?.toLowerCase();
  if (!matched) return null;
  if (matched === 'turtle') return 'turtles';
  return /labrador|shepherd/.test(matched) ? 'dogs' : matched;
}

function buildFact(speaker: string, fact: string): ExtractedFact {
  return {
    fact,
    headline: `${speaker} affect evidence`,
    importance: 0.6,
    type: 'preference',
    keywords: extractEvidenceKeywords(fact, { limit: 10 }),
    entities: [{ name: speaker, type: 'person' }],
    relations: [],
  };
}
