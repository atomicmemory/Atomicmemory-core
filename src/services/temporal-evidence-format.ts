/**
 * Formatting helpers for query-aware temporal evidence blocks.
 *
 * Keeps endpoint formatting and coarse calendar-span hints separate from
 * candidate selection so temporal retrieval logic stays small and testable.
 */

import type { SearchResult } from '../db/memory-repository.js';

const EVIDENCE_MAX_CHARS = 160;
const COARSE_TEMPORAL_CUES = /\b(recently|last week|last month|a while back|around|about)\b/i;
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export interface TemporalEvidenceEndpoint {
  dateKey: string;
  memory: SearchResult;
}

export function formatEndpointLine(label: string, candidate: TemporalEvidenceEndpoint): string {
  return `- ${label}: ${candidate.dateKey} — ${truncateEvidence(candidate.memory.content)}`;
}

export function diffDays(first: Date, second: Date): number {
  return Math.round((second.getTime() - first.getTime()) / 86400000);
}

export function formatCoarseCalendarSpanLine(
  first: TemporalEvidenceEndpoint,
  second: TemporalEvidenceEndpoint,
): string | null {
  if (!hasCoarseTemporalCue(first.memory.content) && !hasCoarseTemporalCue(second.memory.content)) {
    return null;
  }

  const exactRoundedMonths = Math.round(diffDays(first.memory.created_at, second.memory.created_at) / 30);
  const inclusiveMonths = inclusiveCalendarMonths(first.memory.created_at, second.memory.created_at);
  if (inclusiveMonths <= exactRoundedMonths) return null;

  return `- coarse calendar-month span: ${inclusiveMonths} months (${formatMonthYear(
    first.memory.created_at,
  )} through ${formatMonthYear(second.memory.created_at)})`;
}

function hasCoarseTemporalCue(content: string): boolean {
  return COARSE_TEMPORAL_CUES.test(content);
}

function inclusiveCalendarMonths(first: Date, second: Date): number {
  const yearDelta = second.getUTCFullYear() - first.getUTCFullYear();
  const monthDelta = second.getUTCMonth() - first.getUTCMonth();
  return (yearDelta * 12) + monthDelta + 1;
}

function formatMonthYear(date: Date): string {
  return `${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

function truncateEvidence(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= EVIDENCE_MAX_CHARS) return normalized;
  return `${normalized.slice(0, EVIDENCE_MAX_CHARS - 3)}...`;
}
