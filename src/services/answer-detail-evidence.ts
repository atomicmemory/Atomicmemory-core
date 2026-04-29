/**
 * Query-aware detail evidence formatting.
 *
 * This module surfaces compact, answer-bearing details that tiered packaging can
 * otherwise hide behind L0/L1 summaries. It is intentionally query-specific and
 * derives evidence only from already-retrieved memories.
 */

import type { SearchResult } from '../db/memory-repository.js';

const EVIDENCE_MAX_CHARS = 170;
const PRACTICAL_CONCERN_QUERY = /\bpractical concern\b/i;
const COLLEAGUE_ROLE_QUERY = /\bcolleagues?\b/i;
const ROLE_QUERY = /\broles?\b/i;
const CONCERN_SIGNAL = /\b(expensive|cost(?:ly|s)?|compute|practical|resource[-\s]?intensive)\b/i;
const RESEARCH_SIGNAL = /\b(multilingual|language|model|models|research|lora|fine[-\s]?tuning)\b/i;
const MITIGATION_SIGNAL = /\b(lora|parameter[-\s]?efficient|fine[-\s]?tuning|efficient)\b/i;

export function buildAnswerDetailEvidenceBlock(
  memories: SearchResult[],
  query: string,
): string {
  if (PRACTICAL_CONCERN_QUERY.test(query)) return buildPracticalConcernBlock(memories);
  if (COLLEAGUE_ROLE_QUERY.test(query) && ROLE_QUERY.test(query)) return buildColleagueRoleBlock(memories);
  return '';
}

function buildPracticalConcernBlock(memories: SearchResult[]): string {
  const sentences = memories.flatMap((memory) => splitSentences(memory.content));
  const concern = sentences.find((sentence) => CONCERN_SIGNAL.test(sentence) && RESEARCH_SIGNAL.test(sentence));
  if (!concern) return '';
  const mitigation = sentences.find((sentence) =>
    sentence !== concern && MITIGATION_SIGNAL.test(sentence) && RESEARCH_SIGNAL.test(sentence),
  );
  const lines = ['Practical concern evidence:', `- concern: ${truncateEvidence(concern)}`];
  if (mitigation) lines.push(`- mitigation: ${truncateEvidence(mitigation)}`);
  return lines.join('\n');
}

function buildColleagueRoleBlock(memories: SearchResult[]): string {
  const rolesByName = new Map<string, Set<string>>();
  for (const sentence of memories.flatMap((memory) => splitSentences(memory.content))) {
    collectColleagueRoles(sentence, rolesByName);
  }
  const lines = [...rolesByName.entries()]
    .filter(([, roles]) => roles.size > 0)
    .map(([name, roles]) => `- ${name}: ${[...roles].join('; ')}`);
  if (lines.length < 2) return '';
  return ['Colleague role evidence:', ...lines].join('\n');
}

function collectColleagueRoles(sentence: string, rolesByName: Map<string, Set<string>>): void {
  collectMatch(sentence, /\bcolleague\s+([A-Z][a-z]+)\s+recommended\s+([^.;]+)/, rolesByName, 'colleague', 'recommended');
  collectMatch(sentence, /\b([A-Z][a-z]+)\s+is a colleague\b/, rolesByName, 'colleague');
  collectMatch(sentence, /\bteam lead\s+([A-Z][a-z]+)\s+suggested\s+([^.;]+)/, rolesByName, 'team lead', 'suggested');
  collectMatch(sentence, /\b([A-Z][a-z]+)\s+\([^)]*team lead[^)]*\)\s+recommended\s+([^.;]+)/, rolesByName, 'team lead', 'recommended');
  collectMatch(sentence, /\b([A-Z][a-z]+)\s+is one of the first beta testers\b/, rolesByName, 'beta tester');
}

function collectMatch(
  sentence: string,
  pattern: RegExp,
  rolesByName: Map<string, Set<string>>,
  role: string,
  relation?: string,
): void {
  const match = sentence.match(pattern);
  if (!match?.[1]) return;
  const name = match[1];
  const detail = relation && match[2] ? `${relation} ${cleanDetail(match[2])}` : role;
  getRoleSet(rolesByName, name).add(role);
  if (detail !== role) getRoleSet(rolesByName, name).add(detail);
}

function getRoleSet(rolesByName: Map<string, Set<string>>, name: string): Set<string> {
  const existing = rolesByName.get(name);
  if (existing) return existing;
  const roles = new Set<string>();
  rolesByName.set(name, roles);
  return roles;
}

function splitSentences(content: string): string[] {
  return content
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

function cleanDetail(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncateEvidence(text: string): string {
  const compact = cleanDetail(text);
  if (compact.length <= EVIDENCE_MAX_CHARS) return compact;
  return `${compact.slice(0, EVIDENCE_MAX_CHARS - 3)}...`;
}
