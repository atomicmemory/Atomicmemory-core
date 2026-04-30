/**
 * Unit tests for deterministic entity/relation enrichment on extracted facts.
 */

import { describe, expect, it } from 'vitest';
import {
  detectInstructionFact,
  enrichExtractedFact,
} from '../extraction-enrichment.js';
import type { ExtractedFact } from '../extraction.js';

describe('enrichExtractedFact', () => {
  it('adds a self entity and uses relation for tool timeline facts', () => {
    const fact = buildFact(
      'As of January 15 2026, user has been using Tailwind CSS for the last year.',
      ['Tailwind CSS'],
    );

    const enriched = enrichExtractedFact(fact);

    expect(enriched.entities).toEqual(expect.arrayContaining([
      { name: 'User', type: 'person' },
      { name: 'Tailwind CSS', type: 'tool' },
    ]));
    expect(enriched.relations).toContainEqual({
      source: 'User',
      target: 'Tailwind CSS',
      type: 'uses',
    });
  });

  it('adds advisor and organization relations for advisor timeline facts', () => {
    const fact = buildFact(
      'As of February 15 2026, user got some career advice from Dr. Chen at MSR.',
      ['Dr. Chen', 'MSR'],
    );

    const enriched = enrichExtractedFact(fact);

    expect(enriched.entities).toEqual(expect.arrayContaining([
      { name: 'User', type: 'person' },
      { name: 'Dr. Chen', type: 'person' },
      { name: 'Microsoft Research', type: 'organization' },
    ]));
    expect(enriched.relations).toEqual(expect.arrayContaining([
      { source: 'User', target: 'Dr. Chen', type: 'knows' },
      { source: 'Dr. Chen', target: 'Microsoft Research', type: 'works_at' },
    ]));
  });

  it('adds project-tool relations for integration facts', () => {
    const fact = buildFact(
      'As of January 22 2026, user added Plaid integration for bank account syncing in the finance tracker.',
      ['Plaid', 'finance tracker'],
    );

    const enriched = enrichExtractedFact(fact);

    expect(enriched.entities).toEqual(expect.arrayContaining([
      { name: 'User', type: 'person' },
      { name: 'Plaid', type: 'tool' },
      { name: 'finance tracker', type: 'project' },
    ]));
    expect(enriched.relations).toEqual(expect.arrayContaining([
      { source: 'User', target: 'Plaid', type: 'uses' },
      { source: 'finance tracker', target: 'Plaid', type: 'uses' },
    ]));
  });
});

function buildFact(factText: string, keywords: string[]): ExtractedFact {
  return {
    fact: factText,
    headline: factText.slice(0, 30),
    importance: 0.7,
    type: 'knowledge',
    keywords,
    entities: [],
    relations: [],
  };
}

describe('instruction tagging (EXP-05)', () => {
  const INSTRUCTION_PHRASES = [
    'Always respond in formal English.',
    'Never share my email address.',
    'From now on, summarize replies in three bullets.',
    'Please remember that I prefer Celsius.',
    'Make sure to cite sources for every claim.',
    "Don't forget to greet me by name.",
    'Every time I ask for code, include tests.',
    'Whenever you mention prices, use USD.',
    'Going forward, omit emoji from responses.',
    'In the future, default to Python over JavaScript.',
    'Remember to mention deployment caveats.',
  ];

  for (const phrase of INSTRUCTION_PHRASES) {
    it(`detects an imperative marker in: "${phrase}"`, () => {
      expect(detectInstructionFact(phrase)).toBe(true);
    });
  }

  it('does not flag a regular factual statement as an instruction', () => {
    expect(detectInstructionFact('User is building a personal finance tracker.')).toBe(false);
    expect(detectInstructionFact('User favorite color is blue.')).toBe(false);
  });

  // EXP-05 H-310 — BEAM soft-imperative additions.
  // BEAM users phrase instructions softer than the original strict
  // imperatives. These positive cases mirror the surface form that the
  // extraction pipeline emits (third person "user prefers / wants / ...").
  const BEAM_INSTRUCTION_PHRASES = [
    'User prefers simple, minimal dependencies to keep the app lightweight.',
    'User wants the dashboard API response time to stay under 250ms.',
    'User would like all responses to include explicit version numbers.',
    "I'd like the assistant to suggest only lightweight libraries.",
    'Please respond in formal English when discussing security topics.',
    'Assistant should always include unit tests in code examples.',
    'Assistant should never log passwords or session tokens.',
    'User preference is to use TypeScript over JavaScript for new files.',
    'User has a preference for syntax-highlighted code snippets in discussions.',
  ];

  for (const phrase of BEAM_INSTRUCTION_PHRASES) {
    it(`H-310: detects BEAM soft-imperative in: "${phrase}"`, () => {
      expect(detectInstructionFact(phrase)).toBe(true);
    });
  }

  // False-positive prevention: phrasings that LOOK directive but are
  // actually questions or negations and must NOT be tagged.
  const BEAM_FALSE_POSITIVE_PHRASES = [
    // Question prefixes — "wants to know" is a query, not a standing rule.
    'User wants to know how Flask sessions work.',
    "I'd like to know which Python version is currently installed.",
    'User would like to ask about the difference between SQLite and Postgres.',
    // Negations — "prefers not to" is not a standing rule we should boost.
    'User prefers not to use heavy frameworks for this project.',
    'User does not prefer dark mode in the IDE.',
  ];

  for (const phrase of BEAM_FALSE_POSITIVE_PHRASES) {
    it(`H-310: suppresses false positive: "${phrase}"`, () => {
      expect(detectInstructionFact(phrase)).toBe(false);
    });
  }

  it('tags fact metadata with fact_role=instruction and floors importance', () => {
    const fact = buildFact('Always respond to me in formal English.', []);

    const enriched = enrichExtractedFact(fact);

    expect(enriched.metadata).toMatchObject({ fact_role: 'instruction' });
    expect(enriched.importance).toBeGreaterThanOrEqual(0.95);
  });

  it('preserves importance above the floor when already higher', () => {
    const fact = { ...buildFact('Never log my passwords.', []), importance: 0.99 };

    const enriched = enrichExtractedFact(fact);

    expect(enriched.importance).toBe(0.99);
    expect(enriched.metadata?.fact_role).toBe('instruction');
  });

  it('does not add fact_role for non-imperative facts', () => {
    const fact = buildFact('User is using Tailwind CSS for the finance tracker.', ['Tailwind CSS']);

    const enriched = enrichExtractedFact(fact);

    expect(enriched.metadata?.fact_role).toBeUndefined();
    expect(enriched.importance).toBe(0.7);
  });

  it('merges with caller-supplied metadata without clobbering it', () => {
    const fact: ExtractedFact = {
      ...buildFact('Always send me weekly summaries.', []),
      metadata: { custom_tag: 'value' },
    };

    const enriched = enrichExtractedFact(fact);

    expect(enriched.metadata).toMatchObject({
      custom_tag: 'value',
      fact_role: 'instruction',
    });
  });
});
