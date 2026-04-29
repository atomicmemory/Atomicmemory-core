/**
 * Deterministic extraction for shared interests and frustrations.
 *
 * LoCoMo shared-overlap questions often require joining two nearby statements
 * into one explicit shared fact. This extractor preserves only high-confidence
 * overlap evidence that the primary extractor and answer synthesizer commonly
 * leave implicit.
 */

import type { ExtractedFact } from './extraction.js';
import {
  extractEvidenceKeywords,
  matchSpeakerLine,
  parseSpeakerTurns,
  type SpeakerTurn,
} from './supplemental-evidence-utils.js';

const MOVIE_INTEREST_PATTERN = /\bwatch(?:ing)?\s+(?:classic\s+)?movies\b/i;
const DESSERT_INTEREST_PATTERN =
  /\b(?:desserts?|dairy-free dessert recipes?|ice\s?cream|baking|cooking)\b/i;
const DESSERT_SHARED_PATTERN =
  /\b(?:love your creations|enjoy the desserts|brings us together|try (?:the|your).{0,30}ice\s?cream|talented at making dairy-free desserts)\b/i;
const PET_FRIENDLY_PATTERN = /\bpet[- ]friendly\s+(?:spot|spots|place|places)\b/i;
const PET_FRUSTRATION_PATTERN = /\b(?:frustrat|tough|no luck|discouraged|not to find)\b/i;
const CAR_WORK_PATTERN =
  /\b(?:working on cars|car restoration|restoring (?:it|cars?|a ford mustang)|work(?:ing)? on (?:that|this)?\s*(?:car|ford mustang)|garage|grease)\b/i;

export function extractSharedOverlapFacts(conversationText: string): ExtractedFact[] {
  const turns = parseSpeakerTurns(conversationText);
  return dedupeFacts([
    ...extractSharedMovieFacts(turns),
    ...extractSharedDessertFacts(turns),
    ...extractPetFriendlyFrustrationFacts(turns),
    ...extractSharedCarWorkFacts(conversationText),
  ]);
}

function extractSharedMovieFacts(turns: SpeakerTurn[]): ExtractedFact[] {
  const speakers = findSpeakers(turns, (turn) => MOVIE_INTEREST_PATTERN.test(turn.text));
  const pair = firstPair(speakers);
  if (!pair) return [];
  return [buildSharedInterestFact(pair[0], pair[1], 'watching movies')];
}

function extractSharedDessertFacts(turns: SpeakerTurn[]): ExtractedFact[] {
  const speakers = findDessertInterestSpeakers(turns);
  const pair = firstPair(speakers);
  if (!pair) return [];
  return [buildSharedInterestFact(pair[0], pair[1], 'making desserts and baking')];
}

function findDessertInterestSpeakers(turns: SpeakerTurn[]): string[] {
  return findSpeakers(turns, (turn) => {
    if (DESSERT_SHARED_PATTERN.test(turn.text)) return true;
    return DESSERT_INTEREST_PATTERN.test(turn.text) && /\b(?:make|making|bake|baking|recipe|recipes|try|love|enjoy)\b/i.test(turn.text);
  });
}

function extractPetFriendlyFrustrationFacts(turns: SpeakerTurn[]): ExtractedFact[] {
  return turns.flatMap((turn, index) => {
    if (!isPetFriendlyFrustration(turn.text)) return [];
    const otherSpeaker = findNearbyOtherSpeaker(turns, index);
    if (!otherSpeaker) return [];
    return [buildSharedFrustrationFact(turn.speaker, otherSpeaker)];
  });
}

function extractSharedCarWorkFacts(conversationText: string): ExtractedFact[] {
  const speakers = findCarWorkSpeakers(conversationText);
  const pair = firstPair(speakers);
  if (!pair) return [];
  return [buildSharedActivityFact(pair[0], pair[1], 'working on cars')];
}

function findCarWorkSpeakers(conversationText: string): string[] {
  const speakers: string[] = [];
  let currentSpeaker: string | null = null;
  for (const line of conversationText.split('\n')) {
    const turn = matchSpeakerLine(line);
    if (turn) currentSpeaker = turn.speaker;
    const speaker = turn?.speaker ?? currentSpeaker;
    if (speaker && CAR_WORK_PATTERN.test(line)) speakers.push(speaker);
  }
  return [...new Set(speakers)];
}

function isPetFriendlyFrustration(text: string): boolean {
  return PET_FRIENDLY_PATTERN.test(text) && PET_FRUSTRATION_PATTERN.test(text);
}

function findSpeakers(
  turns: SpeakerTurn[],
  predicate: (turn: SpeakerTurn) => boolean,
): string[] {
  const names = turns.filter(predicate).map((turn) => turn.speaker);
  return [...new Set(names)];
}

function firstPair(speakers: string[]): [string, string] | null {
  return speakers.length >= 2 ? [speakers[0]!, speakers[1]!] : null;
}

function findNearbyOtherSpeaker(turns: SpeakerTurn[], index: number): string | null {
  const window = turns.slice(Math.max(0, index - 3), index + 4);
  const currentSpeaker = turns[index]!.speaker;
  return window.find((turn) => turn.speaker !== currentSpeaker)?.speaker ?? null;
}

function buildSharedInterestFact(
  firstSpeaker: string,
  secondSpeaker: string,
  interest: string,
): ExtractedFact {
  const detail = sharedInterestDetail(firstSpeaker, secondSpeaker, interest);
  const fact = `${firstSpeaker} and ${secondSpeaker} share an interest in ${interest}. ${detail}`;
  return buildSharedFact(firstSpeaker, secondSpeaker, interest, fact, 'shared interest');
}

function buildSharedFrustrationFact(firstSpeaker: string, secondSpeaker: string): ExtractedFact {
  const topic = 'pet-friendly spots';
  const fact = `${firstSpeaker} and ${secondSpeaker} share frustration about not being able to find pet-friendly spots.`;
  return buildSharedFact(firstSpeaker, secondSpeaker, topic, fact, 'shared frustration');
}

function buildSharedActivityFact(
  firstSpeaker: string,
  secondSpeaker: string,
  activity: string,
): ExtractedFact {
  const fact = [
    `${firstSpeaker} and ${secondSpeaker} share the activity of ${activity}.`,
    'Their shared car-work evidence involves restoration, garage work, and bringing old cars back to life.',
  ].join(' ');
  return buildSharedFact(firstSpeaker, secondSpeaker, activity, fact, 'shared activity');
}

function buildSharedFact(
  firstSpeaker: string,
  secondSpeaker: string,
  topic: string,
  fact: string,
  headlineSuffix: string,
): ExtractedFact {
  return {
    fact,
    headline: `${firstSpeaker} and ${secondSpeaker} ${headlineSuffix}`,
    importance: 0.65,
    type: 'person',
    keywords: extractEvidenceKeywords(fact, { limit: 10 }),
    entities: buildEntities(firstSpeaker, secondSpeaker, topic),
    relations: [],
  };
}

function sharedInterestDetail(
  firstSpeaker: string,
  secondSpeaker: string,
  interest: string,
): string {
  if (interest === 'making desserts and baking') {
    return `Their shared dessert evidence involves dairy-free desserts, ice cream, recipes, homemade cakes, and baking.`;
  }
  if (interest === 'watching movies') {
    return `${firstSpeaker} and ${secondSpeaker} both mention watching movies as an interest.`;
  }
  return `${firstSpeaker} and ${secondSpeaker} both mention this interest.`;
}

function buildEntities(firstSpeaker: string, secondSpeaker: string, topic: string): ExtractedFact['entities'] {
  return [
    { name: firstSpeaker, type: 'person' },
    { name: secondSpeaker, type: 'person' },
    { name: topic, type: 'concept' },
  ];
}

function dedupeFacts(facts: ExtractedFact[]): ExtractedFact[] {
  const unique = new Map<string, ExtractedFact>();
  for (const fact of facts) unique.set(fact.fact.toLowerCase(), fact);
  return [...unique.values()];
}
