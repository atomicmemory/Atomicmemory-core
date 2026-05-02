/**
 * Tests for topic-extraction.ts (EXP-23).
 *
 * The extractor must pull a clean topic noun from real BEAM event-ordering
 * questions so the topic-aware re-search lands on the right cluster.
 */

import { describe, it, expect } from 'vitest';
import { extractTopicNoun } from '../topic-extraction.js';

describe('extractTopicNoun', () => {
  it('returns the proper-noun phrase from a topic-anchored query', () => {
    expect(extractTopicNoun(
      'Can you list the order in which I brought up different aspects of integrating Bootstrap?',
    )).toBe('Bootstrap');
  });

  it('returns the longest proper-noun run', () => {
    expect(extractTopicNoun(
      'List the order in which I configured AWS Lambda for the project.',
    )).toBe('AWS Lambda');
  });

  it('prefers a quoted phrase over proper nouns', () => {
    const out = extractTopicNoun(
      'Walk me through the order in which I added "user authentication and session management" to React.',
    );
    expect(out).toBe('user authentication and session management');
  });

  it('returns null when the query has no specific topic', () => {
    expect(extractTopicNoun(
      'Can you tell me about my background and previous development projects?',
    )).toBeNull();
  });

  it('returns null when the only caps are sentence-initial noise', () => {
    expect(extractTopicNoun('List the order I worked on things.')).toBeNull();
  });

  it('returns null on empty or trivial input', () => {
    expect(extractTopicNoun('')).toBeNull();
    expect(extractTopicNoun('hi')).toBeNull();
    expect(extractTopicNoun(null as unknown as string)).toBeNull();
  });

  it('extracts a common-noun topic from the "aspects of implementing X" BEAM template', () => {
    const out = extractTopicNoun(
      'Can you list the order in which I brought up different aspects of implementing the city autocomplete feature across our conversations?',
    );
    expect(out).not.toBeNull();
    expect(out!.toLowerCase()).toContain('city autocomplete');
  });

  it('extracts a common-noun topic from the "aspects of integrating X" BEAM template', () => {
    const out = extractTopicNoun(
      'Can you list the order in which I brought up different aspects of integrating and customizing the framework in my projects?',
    );
    expect(out).not.toBeNull();
  });

  it('extracts a common-noun topic from "configured <X>" template (past tense)', () => {
    const out = extractTopicNoun(
      'List the order in which I configured the deployment pipeline through our conversations.',
    );
    expect(out).not.toBeNull();
    expect(out!.toLowerCase()).toContain('deployment');
  });
});
