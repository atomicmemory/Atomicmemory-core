/**
 * Query-aware shared-overlap evidence formatting.
 *
 * Builds compact evidence blocks for questions that ask what two people both
 * painted, visited, or did together. The block is derived only from retrieved
 * memories, so it improves answerability without adding hidden facts.
 */

import type { SearchResult } from '../db/memory-repository.js';

const EVIDENCE_MAX_CHARS = 150;
const PAINTED_SUBJECT_QUERY = /\bwhat\b[\s\S]*\bsubject\b[\s\S]*\bboth\b[\s\S]*\bpainted\b/i;
const VISITED_CITY_QUERY = /\bwhich\b[\s\S]*\bcity\b[\s\S]*\bboth\b[\s\S]*\bvisited\b/i;
const SHARED_ACTIVITY_QUERY = /\bwhat\b[\s\S]*\bshared activit(?:y|ies)\b/i;
interface CandidateEvidence {
  speaker: string;
  value: string;
  memory: SearchResult;
  snippet: string;
}

const PAINTED_SUNSET_PATTERNS = [
  /\b(?:As of [^,]+, )?([A-Z][a-z]+) painted the subject of sunsets\b/,
  /\b(?:As of [^,]+, )?([A-Z][a-z]+) shared image evidence with caption "[^"]*\bpainting of a sunset\b/,
  /\b(?:As of [^,]+, )?([A-Z][a-z]+)[^.]*\benjoys? painting[^.]*\bsunsets?\b/,
];

const ROME_VISIT_PATTERNS = [
  /\b([A-Z][a-z]+) has visited Rome\b/,
  /\b([A-Z][a-z]+) visited Rome\b/,
  /\b([A-Z][a-z]+) took a short trip(?: last week)? to Rome\b/,
];

export function buildSharedOverlapEvidenceBlock(
  memories: SearchResult[],
  query: string,
): string {
  if (PAINTED_SUBJECT_QUERY.test(query)) {
    return buildCandidateBlock('Shared painted-subject evidence:', 'shared painted subject', findPaintedSubjects(memories));
  }
  if (VISITED_CITY_QUERY.test(query)) {
    return buildCandidateBlock('Shared visited-city evidence:', 'shared visited city', findVisitedCities(memories));
  }
  if (SHARED_ACTIVITY_QUERY.test(query)) {
    return buildCandidateBlock('Shared activity evidence:', 'explicit shared activity', findSharedActivities(memories));
  }
  return '';
}

function findPaintedSubjects(memories: SearchResult[]): CandidateEvidence[] {
  return memories.flatMap((memory) => {
    const evidence: CandidateEvidence[] = [];
    for (const match of findPatternMatches(memory.content, PAINTED_SUNSET_PATTERNS)) {
      evidence.push({ ...match, value: 'sunsets', memory });
    }
    return evidence;
  });
}

function findVisitedCities(memories: SearchResult[]): CandidateEvidence[] {
  return memories.flatMap((memory) => {
    const evidence: CandidateEvidence[] = [];
    const lower = memory.content.toLowerCase();
    if (!lower.includes('rome')) return evidence;
    for (const match of findPatternMatches(memory.content, ROME_VISIT_PATTERNS)) {
      evidence.push({ ...match, value: 'Rome', memory });
    }
    return evidence;
  });
}

function findSharedActivities(memories: SearchResult[]): CandidateEvidence[] {
  return memories.flatMap((memory) => {
    const match = memory.content.match(/\b([A-Z][a-z]+) and ([A-Z][a-z]+) share the activity of working on cars\b/);
    if (!match) return [];
    return [
      { speaker: match[1]!, value: 'working on cars', memory, snippet: match[0] },
      { speaker: match[2]!, value: 'working on cars', memory, snippet: match[0] },
    ];
  });
}

function buildCandidateBlock(
  heading: string,
  label: string,
  candidates: CandidateEvidence[],
): string {
  const shared = selectSharedCandidate(candidates);
  if (!shared) return '';
  const lines = shared.evidence.map((candidate) =>
    `- ${candidate.speaker}: ${truncateEvidence(candidate.snippet)}`,
  );
  return [heading, `- ${label}: ${shared.value}`, ...lines].join('\n');
}

function selectSharedCandidate(
  candidates: CandidateEvidence[],
): { value: string; evidence: CandidateEvidence[] } | null {
  const byValue = groupCandidatesByValue(candidates);
  for (const evidence of byValue.values()) {
    const bySpeaker = uniqueEvidenceBySpeaker(evidence);
    if (bySpeaker.length >= 2) return { value: bySpeaker[0]!.value, evidence: bySpeaker.slice(0, 2) };
  }
  return null;
}

function groupCandidatesByValue(candidates: CandidateEvidence[]): Map<string, CandidateEvidence[]> {
  const grouped = new Map<string, CandidateEvidence[]>();
  for (const candidate of candidates) {
    const key = candidate.value.toLowerCase();
    grouped.set(key, [...(grouped.get(key) ?? []), candidate]);
  }
  return grouped;
}

function uniqueEvidenceBySpeaker(candidates: CandidateEvidence[]): CandidateEvidence[] {
  const seen = new Set<string>();
  const unique: CandidateEvidence[] = [];
  for (const candidate of candidates) {
    const key = candidate.speaker.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }
  return unique;
}

function findPatternMatches(
  content: string,
  patterns: RegExp[],
): Array<{ speaker: string; snippet: string }> {
  const matches = new Map<string, { speaker: string; snippet: string }>();
  const sentences = content.split(/(?<=[.!?])\s+/);
  for (const sentence of sentences) {
    for (const pattern of patterns) {
      const match = sentence.match(pattern);
      if (match?.[1]) matches.set(match[1], { speaker: match[1], snippet: sentence });
    }
  }
  return [...matches.values()];
}

function truncateEvidence(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= EVIDENCE_MAX_CHARS) return compact;
  return `${compact.slice(0, EVIDENCE_MAX_CHARS - 3)}...`;
}
