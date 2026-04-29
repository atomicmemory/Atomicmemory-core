/**
 * Integration coverage for extraction-time event-anchor fact generation.
 */

import { describe, expect, it } from 'vitest';
import { quickExtractFacts } from '../quick-extraction.js';
import { inferEventAnchorFacts } from '../event-anchor-facts.js';
import type { ExtractedFact } from '../extraction.js';

function makeFact(text: string, overrides: Partial<ExtractedFact> = {}): ExtractedFact {
  return {
    fact: text,
    headline: overrides.headline ?? text.slice(0, 40),
    importance: overrides.importance ?? 0.6,
    type: overrides.type ?? 'knowledge',
    keywords: overrides.keywords ?? [],
    entities: overrides.entities ?? [],
    relations: overrides.relations ?? [],
    network: overrides.network,
    opinionConfidence: overrides.opinionConfidence ?? null,
  };
}

describe('event anchor facts', () => {
  it('emits mentorship.received anchors from relative-time facts', () => {
    const facts = quickExtractFacts([
      '[Session date: 2023-06-16]',
      'Jon: Gina, you won\'t believe it - I got mentored by this amazing business dude yesterday!',
    ].join('\n'));

    const anchor = facts.find((fact) => fact.fact.includes('event anchor mentorship.received'));
    expect(anchor?.fact).toContain('for Jon');
    expect(anchor?.fact).toContain('occurred on June 15, 2023');
  });

  it('emits networking.first_visit anchors from speaker-labeled turns', () => {
    const facts = quickExtractFacts([
      '[Session date: 2023-06-21]',
      'Jon: That\'s awesome, Gina! Yesterday I chose to go to networking events to make things happen.',
    ].join('\n'));

    const anchor = facts.find((fact) => fact.fact.includes('event anchor networking.first_visit'));
    expect(anchor?.fact).toContain('occurred on June 20, 2023');
  });

  it('emits internship.accepted anchors for accepted-role facts', () => {
    const facts = quickExtractFacts([
      '[Session date: 2023-05-27]',
      'Gina: Hey Jon! Long time no talk! A lot\'s happened - I just got accepted for a fashion internship!',
    ].join('\n'));

    const anchor = facts.find((fact) => fact.fact.includes('event anchor internship.accepted'));
    expect(anchor?.fact).toContain('occurred on May 27, 2023');
  });

  it('emits trip.paris anchors from relative travel facts', () => {
    const facts = quickExtractFacts([
      '[Session date: 2023-01-29]',
      'Jon: Oh, I\'ve been to Paris yesterday! It was sooo cool.',
    ].join('\n'));

    const anchor = facts.find((fact) => fact.fact.includes('event anchor trip.paris'));
    expect(anchor?.fact).toContain('for Jon');
    expect(anchor?.fact).toContain('occurred on January 28, 2023');
  });

  it('emits trip.rome anchors from short-trip facts', () => {
    const facts = quickExtractFacts([
      '[Session date: 2023-06-16]',
      'Jon: Took a short trip last week to Rome to clear my mind a little.',
    ].join('\n'));

    const anchor = facts.find((fact) => fact.fact.includes('event anchor trip.rome'));
    expect(anchor?.fact).toContain('for Jon');
    expect(anchor?.fact).toContain('occurred on June 9, 2023');
    expect(facts.some((fact) => fact.fact.includes('event anchor trip.took_short_trip_rome'))).toBe(true);
  });
});

describe('event anchor facts — generic event.occurred fall-through (EXP-06)', () => {
  it('emits a generic event.occurred anchor when flag is on and no rule matches', () => {
    const fact = makeFact('As of January 2026, user is using PostgreSQL.');
    const anchors = inferEventAnchorFacts(fact, { genericEventAnchorEnabled: true });
    expect(anchors).toHaveLength(1);
    expect(anchors[0].fact).toContain('event anchor event.occurred');
    expect(anchors[0].fact).toContain('for User');
    expect(anchors[0].fact).toContain('occurred on January 1, 2026');
  });

  it('emits a generic event.occurred anchor for full-date prefix when flag is on', () => {
    const fact = makeFact('As of March 15 2025, user completed the API migration.');
    const anchors = inferEventAnchorFacts(fact, { genericEventAnchorEnabled: true });
    expect(anchors).toHaveLength(1);
    expect(anchors[0].fact).toContain('event anchor event.occurred');
    expect(anchors[0].fact).toContain('for User');
    expect(anchors[0].fact).toContain('occurred on March 15, 2025');
  });

  it('emits no anchor when the flag is off, even if the prefix matches', () => {
    const fact = makeFact('As of January 2026, user is using PostgreSQL.');
    expect(inferEventAnchorFacts(fact)).toHaveLength(0);
    expect(inferEventAnchorFacts(fact, { genericEventAnchorEnabled: false })).toHaveLength(0);
  });

  it('emits no anchor for facts without an "As of <date>" prefix', () => {
    const fact = makeFact('User prefers Rust over Go.');
    expect(inferEventAnchorFacts(fact, { genericEventAnchorEnabled: true })).toHaveLength(0);
  });

  it('does not emit a generic anchor when a DESCRIPTOR_RULE already matches (regression)', () => {
    const facts = quickExtractFacts([
      '[Session date: 2023-06-16]',
      'Jon: Gina, you won\'t believe it - I got mentored by this amazing business dude yesterday!',
    ].join('\n'));

    // Re-run with the flag on by feeding the enriched facts back through.
    // The DESCRIPTOR_RULES path emits mentorship.received and the generic
    // fall-through must not also fire on the same source fact.
    const sourceFact = facts.find((f) => /As of /i.test(f.fact) && !f.fact.includes('event anchor'));
    expect(sourceFact).toBeDefined();
    const anchors = inferEventAnchorFacts(sourceFact as ExtractedFact, { genericEventAnchorEnabled: true });
    const labels = anchors.map((a) => a.headline);
    expect(labels).toContain('Event mentorship.received');
    expect(labels).not.toContain('Event event.occurred');
  });

  it('returns no anchors when subject cannot be inferred (graceful fallback)', () => {
    const fact = makeFact('As of January 2026, the situation continues.');
    const anchors = inferEventAnchorFacts(fact, { genericEventAnchorEnabled: true });
    expect(anchors).toHaveLength(0);
  });

  it('returns no anchors on weird non-prefixed input rather than crashing', () => {
    const fact = makeFact('Random unstructured text without temporal prefix.');
    expect(() => inferEventAnchorFacts(fact, { genericEventAnchorEnabled: true })).not.toThrow();
    expect(inferEventAnchorFacts(fact, { genericEventAnchorEnabled: true })).toHaveLength(0);
  });
});
