/**
 * Timeline summary helpers for retrieval packaging.
 *
 * Keeps generic multi-date timeline formatting separate from query-aware
 * evidence blocks so retrieval-format stays small and focused.
 */

import type { SearchResult } from '../db/memory-repository.js';
import { formatDateLabel, formatDuration } from './temporal-format.js';

export function appendTimelineSummary(
  sections: string[],
  memories: SearchResult[],
): string {
  const timeline = buildTimelineSummary(memories);
  const mainContent = sections.join('\n\n');
  return timeline ? `${mainContent}\n\n${timeline}` : mainContent;
}

function buildTimelineSummary(memories: SearchResult[]): string {
  const uniqueDates = getUniqueDates(memories);
  if (uniqueDates.length < 2) return '';

  const gaps = buildGapLines(uniqueDates);
  if (gaps.length === 0) return '';

  const first = uniqueDates[0];
  const last = uniqueDates[uniqueDates.length - 1];
  const totalDays = Math.round((last.getTime() - first.getTime()) / 86400000);
  const totalLine = `Total span: ${formatDateLabel(first)} to ${formatDateLabel(last)} (${formatDuration(totalDays)})`;
  const evidenceLines = buildEvidenceLines(memories, uniqueDates);
  const evidenceBlock = evidenceLines.length > 0
    ? `\nKey temporal evidence:\n${evidenceLines.join('\n')}`
    : '';

  return `Timeline:\n${gaps.join('\n')}\n${totalLine}${evidenceBlock}`;
}

function getUniqueDates(memories: SearchResult[]): Date[] {
  const seen = new Set<string>();
  return memories.flatMap((memory) => {
    const key = memory.created_at.toISOString().slice(0, 10);
    if (seen.has(key)) return [];
    seen.add(key);
    return [memory.created_at];
  });
}

function buildGapLines(dates: Date[]): string[] {
  const gaps: string[] = [];
  for (let i = 1; i < dates.length; i++) {
    const diffDays = Math.round((dates[i].getTime() - dates[i - 1].getTime()) / 86400000);
    if (diffDays === 0) continue;
    const duration = formatDuration(diffDays);
    gaps.push(`- ${formatDateLabel(dates[i - 1])} → ${formatDateLabel(dates[i])}: ${duration}`);
  }
  return gaps;
}

function buildEvidenceLines(memories: SearchResult[], dates: Date[]): string[] {
  return dates
    .slice(0, 4)
    .map((date) => buildEvidenceLine(memories, date))
    .filter((line): line is string => line !== null);
}

function buildEvidenceLine(memories: SearchResult[], date: Date): string | null {
  const key = formatDateLabel(date);
  const sameDate = memories.filter((memory) => formatDateLabel(memory.created_at) === key);
  const selected = sameDate.find((memory) => memory.content.toLowerCase().includes('answer')) ?? sameDate[0];
  if (!selected) return null;
  return `- ${key}: ${truncateEvidence(selected.content)}`;
}

function truncateEvidence(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 180) return normalized;
  return `${normalized.slice(0, 177)}...`;
}
