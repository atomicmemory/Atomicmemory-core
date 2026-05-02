/**
 * Tests for event-ordering-detector.ts (EXP-23).
 *
 * The detector must return true on the BEAM event-ordering question shapes
 * we observed (and only those), so the topic-aware retrieval stage fires
 * exactly when it should.
 */

import { describe, it, expect } from 'vitest';
import { isEventOrderingQuery } from '../event-ordering-detector.js';

describe('isEventOrderingQuery', () => {
  it('detects "list the order" queries', () => {
    expect(isEventOrderingQuery(
      'Can you list the order in which I brought up different aspects of developing my budget tracker?',
    )).toBe(true);
  });

  it('detects "in chronological order" queries', () => {
    expect(isEventOrderingQuery(
      'Walk me through my project phases in chronological order.',
    )).toBe(true);
  });

  it('detects "walk me through the order in which" queries (BEAM template)', () => {
    expect(isEventOrderingQuery(
      'Can you walk me through the order in which I brought up different aspects of my app development?',
    )).toBe(true);
  });

  it('detects "timeline" queries', () => {
    expect(isEventOrderingQuery('Give me a timeline of how my login feature evolved.')).toBe(true);
  });

  it('detects "evolution of" queries', () => {
    expect(isEventOrderingQuery('Describe the evolution of my caching strategy.')).toBe(true);
  });

  it('detects "first ... then ... finally" structure', () => {
    expect(isEventOrderingQuery(
      'I first set up Bootstrap, then customized the theme, and finally deployed — what happened next?',
    )).toBe(true);
  });

  it('does NOT flag a single-fact extraction question', () => {
    expect(isEventOrderingQuery('What is my OpenWeather API key?')).toBe(false);
  });

  it('does NOT flag a how-to question', () => {
    expect(isEventOrderingQuery('How do I set up a caching system?')).toBe(false);
  });

  it('does NOT flag a knowledge-update question', () => {
    expect(isEventOrderingQuery('What is the test coverage percentage for my API integration module?')).toBe(false);
  });

  it('does NOT flag empty or trivial input', () => {
    expect(isEventOrderingQuery('')).toBe(false);
    expect(isEventOrderingQuery('hi')).toBe(false);
    expect(isEventOrderingQuery('   ')).toBe(false);
  });

  it('handles non-string input defensively', () => {
    expect(isEventOrderingQuery(null as unknown as string)).toBe(false);
    expect(isEventOrderingQuery(undefined as unknown as string)).toBe(false);
  });
});
