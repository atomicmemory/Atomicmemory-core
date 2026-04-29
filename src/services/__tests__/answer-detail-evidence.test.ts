/**
 * Unit tests for query-aware answer-detail evidence blocks.
 */

import { describe, expect, it } from 'vitest';
import { createSearchResult } from './test-fixtures.js';
import { buildAnswerDetailEvidenceBlock } from '../answer-detail-evidence.js';

function makeMemory(id: string, content: string) {
  return createSearchResult({
    id,
    content,
    created_at: new Date('2026-02-01T00:00:00.000Z'),
  });
}

describe('buildAnswerDetailEvidenceBlock', () => {
  it('surfaces expensive-training evidence for practical concern questions', () => {
    const block = buildAnswerDetailEvidenceBlock([
      makeMemory('research', [
        'As of February 1, 2026, user is exploring LoRA for language adaptation.',
        'As of February 1, 2026, Training multilingual models is expensive.',
      ].join(' ')),
    ], 'What practical concern does the student raise about their NLP research?');

    expect(block).toContain('Practical concern evidence:');
    expect(block).toContain('Training multilingual models is expensive');
    expect(block).toContain('LoRA');
  });

  it('does not emit concern evidence for ordinary research-topic questions', () => {
    const block = buildAnswerDetailEvidenceBlock([
      makeMemory('research', 'Training multilingual models is expensive.'),
    ], 'What NLP topic is the student researching?');

    expect(block).toBe('');
  });

  it('surfaces colleague roles from split role and beta-tester memories', () => {
    const block = buildAnswerDetailEvidenceBlock([
      makeMemory('jake', "User's colleague Jake recommended Supabase for the personal finance tracker project."),
      makeMemory('sarah', "Sarah (user's team lead) recommended using React Query for all data fetching patterns."),
      makeMemory('beta', 'Jake is one of the first beta testers. Sarah is one of the first beta testers.'),
    ], 'Who are the two colleagues mentioned, and what roles do they play?');

    expect(block).toContain('Colleague role evidence:');
    expect(block).toContain('Jake:');
    expect(block).toContain('recommended Supabase');
    expect(block).toContain('beta tester');
    expect(block).toContain('Sarah:');
    expect(block).toContain('team lead');
    expect(block).toContain('React Query');
  });
});
