/**
 * Shared helpers for deterministic supplemental evidence extractors.
 *
 * These helpers keep the small LoCoMo-targeted extractors focused on their
 * evidence patterns instead of duplicating transcript parsing and metadata
 * shaping code.
 */

const SESSION_DATE_PATTERN = /^\[Session date:\s*([^\]]+)\]/im;
const SPEAKER_LINE_PATTERN = /^([A-Z][A-Za-z0-9' -]{1,40}):\s*(.*)$/;
const WORD_PATTERN = /\b[A-Za-z][A-Za-z0-9'-]{2,}\b/g;

export interface SpeakerTurn {
  speaker: string;
  text: string;
}

export function parseSpeakerTurns(conversationText: string): SpeakerTurn[] {
  return conversationText
    .split('\n')
    .map((line) => line.match(SPEAKER_LINE_PATTERN))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => ({ speaker: match[1]!, text: match[2]!.trim() }));
}

export function matchSpeakerLine(line: string): SpeakerTurn | null {
  const match = line.match(SPEAKER_LINE_PATTERN);
  if (!match) return null;
  return { speaker: match[1]!, text: match[2]!.trim() };
}

export function buildSessionDatePrefix(text: string): string {
  const raw = text.match(SESSION_DATE_PATTERN)?.[1];
  if (!raw) return '';
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return '';
  return `As of ${formatDate(date)}, `;
}

export function extractEvidenceKeywords(
  text: string,
  options: { stopWords?: Set<string>; limit?: number } = {},
): string[] {
  const stopWords = options.stopWords ?? new Set<string>();
  const words = text.match(WORD_PATTERN) ?? [];
  const keywords = words
    .map((word) => word.toLowerCase())
    .filter((word) => !stopWords.has(word));
  return [...new Set(keywords)].slice(0, options.limit);
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}
