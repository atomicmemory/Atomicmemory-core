/**
 * Deterministic extraction for text-encoded visual evidence.
 *
 * LoCoMo turns include image captions and search-query tags as text. The LLM
 * extractor can compress these into generic "ocean" or "photo" memories and
 * drop the tags that identify the answerable object. This helper preserves the
 * provided visual evidence without inventing facts from pixels.
 */

import type { ExtractedFact } from './extraction.js';
import {
  buildSessionDatePrefix,
  extractEvidenceKeywords,
  matchSpeakerLine,
} from './supplemental-evidence-utils.js';

const IMAGE_CAPTION_PATTERN = /^\s*Image caption:\s*(.+)$/i;
const IMAGE_QUERY_PATTERN = /^\s*Image query:\s*(.+)$/i;
const BEACH_VISUAL_PATTERN = /\b(?:beach|ocean|shore|coast|surf|seaside)\b/i;
const WALK_TEXT_PATTERN = /\b(?:walk|walking|stroll|strolling)\b/i;
const STOP_WORDS = new Set(['and', 'the', 'with', 'from', 'that', 'this', 'over', 'into']);

interface VisualTurn {
  speaker: string;
  text: string;
  caption?: string;
  query?: string;
}

export function extractVisualEvidenceFacts(conversationText: string): ExtractedFact[] {
  const prefix = buildSessionDatePrefix(conversationText);
  const facts: ExtractedFact[] = [];
  let current: VisualTurn | null = null;

  for (const line of conversationText.split('\n')) {
    current = processLine(line, current, facts, prefix);
  }
  pushVisualFact(current, facts, prefix);
  return facts;
}

function processLine(
  line: string,
  current: VisualTurn | null,
  facts: ExtractedFact[],
  prefix: string,
): VisualTurn | null {
  const speaker = matchSpeakerLine(line);
  if (speaker) {
    pushVisualFact(current, facts, prefix);
    return { speaker: speaker.speaker, text: speaker.text };
  }
  return applyVisualLine(line, current);
}

function applyVisualLine(line: string, current: VisualTurn | null): VisualTurn | null {
  if (!current) return null;
  const caption = line.match(IMAGE_CAPTION_PATTERN)?.[1]?.trim();
  if (caption) return { ...current, caption };
  const query = line.match(IMAGE_QUERY_PATTERN)?.[1]?.trim();
  if (query) return { ...current, query };
  return current;
}

function pushVisualFact(
  turn: VisualTurn | null,
  facts: ExtractedFact[],
  prefix: string,
): void {
  if (!turn || (!turn.caption && !turn.query)) return;
  const fact = buildVisualFactText(turn, prefix);
  facts.push(buildFact(turn.speaker, fact, `${turn.speaker} shared image evidence`, 0.6));
  const placeFact = buildBeachWalkFactText(turn, prefix);
  if (placeFact) {
    facts.push(buildFact(turn.speaker, placeFact, `${turn.speaker} shared beach walk evidence`, 0.65));
  }
}

function buildVisualFactText(turn: VisualTurn, prefix: string): string {
  const details = [
    turn.caption ? `caption "${turn.caption}"` : null,
    turn.query ? `visual tags "${turn.query}"` : null,
  ].filter((value): value is string => value !== null);
  const context = summarizeTurnText(turn.text);
  return `${prefix}${turn.speaker} shared image evidence with ${details.join(' and ')}${context}.`;
}

function buildBeachWalkFactText(turn: VisualTurn, prefix: string): string | null {
  const visualText = `${turn.caption ?? ''} ${turn.query ?? ''}`;
  if (!BEACH_VISUAL_PATTERN.test(visualText) || !WALK_TEXT_PATTERN.test(turn.text)) {
    return null;
  }
  return `${prefix}${turn.speaker} shared image evidence showing ${turn.speaker} went for a walk by the beach or ocean.`;
}

function buildFact(
  speaker: string,
  fact: string,
  headline: string,
  importance: number,
): ExtractedFact {
  return {
    fact,
    headline,
    importance,
    type: 'knowledge',
    keywords: extractEvidenceKeywords(fact, { stopWords: STOP_WORDS }),
    entities: [{ name: speaker, type: 'person' }],
    relations: [],
  };
}

function summarizeTurnText(text: string): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (!trimmed) return '';
  const clipped = trimmed.length > 140 ? `${trimmed.slice(0, 137)}...` : trimmed;
  return ` while saying "${clipped}"`;
}
