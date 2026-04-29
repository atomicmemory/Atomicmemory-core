/**
 * Observation-date extraction helpers.
 *
 * Keeps benchmark-only temporal prompt and post-processing behavior behind one
 * default-off option so relative-date experiments can run by configuration.
 */

import type { ExtractedFact } from './extraction.js';
import {
  annotateRelativeTemporalText,
  extractRelativeTemporalAnchors,
} from './relative-temporal.js';
import { extractSessionTimestamp, parseSessionDate } from './session-date.js';

export interface ExtractionOptions {
  observationDateExtractionEnabled?: boolean;
  /**
   * EXP-06: when no DESCRIPTOR_RULE matches but the fact has an `As of <date>,`
   * prefix and a recoverable subject, emit a generic `event.occurred` anchor.
   * Threaded through to `enrichExtractedFacts` and `inferEventAnchorFacts`.
   * Defaults to off.
   */
  genericEventAnchorEnabled?: boolean;
  /**
   * EXP-13: piggyback on the extraction LLM call to also identify event
   * boundaries — turns where the topic, activity, or context shifts
   * significantly. Adds `event_boundary` and `boundary_strength` fields to
   * each extracted fact. Defaults to off.
   */
  eventBoundaryExtractionEnabled?: boolean;
}

export function buildExtractionUserMessage(
  conversationText: string,
  options: ExtractionOptions = {},
): string {
  const parts: string[] = [];

  if (options.observationDateExtractionEnabled) {
    const observationTimestamp = extractObservationTimestamp(conversationText);
    if (observationTimestamp) {
      parts.push(
        `Observation timestamp: ${observationTimestamp}`,
        'Use this timestamp to resolve relative dates in the conversation.',
        'For relative phrases such as "last Friday", include the resolved absolute date in extracted facts when possible.',
      );
    }
  }

  if (options.eventBoundaryExtractionEnabled) {
    parts.push(
      'EVENT BOUNDARIES (IMPORTANT FOR ORDERING):',
      'For each fact, also identify whether it sits at an event boundary — a turn where the topic, activity, or context shifts significantly relative to the surrounding conversation.',
      '- event_boundary: true if this fact marks the start of a new episode/topic. false otherwise.',
      '- boundary_strength: a number in [0, 1]. 0.0 = continuation. 1.0 = completely new topic. ~0.5 = related but distinct sub-topic.',
      'Both fields default to false / 0 when uncertain. Boundaries are signals about ORDERING, not importance.',
      'Add "event_boundary": <bool>, "boundary_strength": <number> to each entry in the memories array.',
    );
  }

  if (parts.length > 0) {
    parts.push('');
  }
  parts.push(`Conversation to extract from:\n${conversationText}`);
  return parts.join('\n');
}

export function applyObservationDateAnchors(
  facts: ExtractedFact[],
  conversationText: string,
  options: ExtractionOptions = {},
): ExtractedFact[] {
  if (!options.observationDateExtractionEnabled) return facts;
  const observationDate = parseObservationDate(conversationText);
  if (!observationDate) return facts;

  return facts.map((fact) => annotateFact(fact, observationDate));
}

function annotateFact(fact: ExtractedFact, observationDate: Date): ExtractedFact {
  const annotatedFact = annotateRelativeTemporalText(fact.fact, observationDate);
  if (annotatedFact === fact.fact) return fact;

  const anchorKeywords = extractRelativeTemporalAnchors(fact.fact, observationDate)
    .map((anchor) => anchor.eventDate);
  return {
    ...fact,
    fact: annotatedFact,
    keywords: [...new Set([...fact.keywords, ...anchorKeywords])],
  };
}

function parseObservationDate(conversationText: string): Date | null {
  return parseSessionDate(conversationText);
}

function extractObservationTimestamp(conversationText: string): string | null {
  return extractSessionTimestamp(conversationText);
}
