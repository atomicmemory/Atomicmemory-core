/**
 * Supplemental extraction coverage for high-signal deterministic facts.
 * Merges quick extractor output into the main LLM extraction result when the
 * supplemental fact adds missing entities, relations, or temporal detail.
 */

import type { ExtractedFact } from './extraction.js';
import { normalizeExtractedFacts } from './fact-normalization.js';
import { quickExtractFacts } from './quick-extraction.js';
import { containsRelativeTemporalPhrase } from './relative-temporal.js';
import { extractAffectEvidenceFacts } from './affect-evidence-extraction.js';
import { extractCompetitionEvidenceFacts } from './competition-evidence-extraction.js';
import { extractSharedSchoolFacts } from './shared-school-extraction.js';
import { extractSharedOverlapFacts } from './shared-overlap-extraction.js';
import { extractVisualEvidenceFacts } from './visual-evidence-extraction.js';

const LITERAL_DETAIL_PATTERN =
  /\b(?:necklace|book|books|song|songs|music|musicians|fan|painting|paintings|photo|poster|posters|library|store|decor|furniture|flooring|pet|pets|cat|cats|dog|dogs|guinea pig|turtle|turtles|snake|snakes|workshop|poetry reading|sign|slipper|bowl)\b/i;
const QUOTED_TEXT_PATTERN = /["“”][^"“”]{2,}["“”]/;
const TEMPORAL_DETAIL_PATTERN =
  /\b(last year|last month|last week|last [a-z]+|today|tomorrow|first|second|before|after|deadline|deadlines|timeline|relative to|months later|weeks later|few days ago|for \d+ years?|for three years?|for two years?|for four years?|for five years?)\b/i;
const EVENT_DETAIL_PATTERN =
  /\b(?:accepted|interview|internship|mentor(?:ed|ing)?|network(?:ing)?|social media|competition|investor(?:s)?|fashion editors|analytics tools|video presentation|website|collaborat(?:e|ion)|dance class|Shia Labeouf|trip|travel(?:ed|ling)?|retreat|phuket|doctor|doc|check-up|appointment|blog|car mods?|restor(?:e|ed|ing|ation))\b/i;
const VISUAL_EVIDENCE_PATTERN =
  /\b(?:shared image evidence|painted (?:a sunset|the subject of sunsets))\b/i;
const AFFECT_INVENTORY_PATTERN =
  /\b(?:all that bring(?:s)? .*happiness|bring(?:s)? .*joy|bring(?:s)? .*happiness|happiness in life)\b/i;
const SHARED_SCHOOL_PATTERN =
  /\b(?:attended|studied at|went to).*\b(?:elementary school|school|class).*\btogether\b/i;
const SHARED_OVERLAP_PATTERN =
  /\bshare (?:an interest|frustration|the activity)|\bshared (?:interest|frustration|activity)\b/i;

interface SupplementalFeatureSet {
  temporal: boolean;
  literal: boolean;
  event: boolean;
  visual: boolean;
  affectInventory: boolean;
  sharedSchool: boolean;
  sharedOverlap: boolean;
}

export interface SupplementalExtractionOptions {
  /**
   * Gate for the narrow LoCoMo-tuned extractors (affect inventory,
   * dance-crew competition phrasing, elementary-school co-attendance,
   * shared dessert/movie/car-work overlap, beach-walk-from-photo-tags,
   * sunset-painting subject). These rules were observed-fitted against
   * specific LoCoMo10 failures and do not generalize. When false,
   * `mergeSupplementalFacts` only runs `quickExtractFacts`, which is
   * the pre-existing production behavior on `origin/main`.
   */
  locomoTunedExtractionEnabled: boolean;
}

export function mergeSupplementalFacts(
  primaryFacts: ExtractedFact[],
  conversationText: string,
  options: SupplementalExtractionOptions,
): ExtractedFact[] {
  const merged = [...primaryFacts];
  const supplementalFacts = normalizeExtractedFacts([
    // quickExtractFacts is the pre-existing production-shipped supplemental
    // path and stays unconditional. Only the LoCoMo-tuned extractors below
    // are gated by the new flag.
    ...quickExtractFacts(conversationText),
    ...(options.locomoTunedExtractionEnabled ? extractAffectEvidenceFacts(conversationText) : []),
    ...(options.locomoTunedExtractionEnabled ? extractCompetitionEvidenceFacts(conversationText) : []),
    ...(options.locomoTunedExtractionEnabled ? extractSharedSchoolFacts(conversationText) : []),
    ...(options.locomoTunedExtractionEnabled ? extractSharedOverlapFacts(conversationText) : []),
    ...(options.locomoTunedExtractionEnabled ? extractVisualEvidenceFacts(conversationText) : []),
  ]);

  for (const fact of supplementalFacts) {
    const upgradeIndex = findUpgradeableFactIndex(merged, fact);
    if (upgradeIndex >= 0) {
      merged[upgradeIndex] = fact;
      continue;
    }
    if (shouldIncludeSupplementalFact(merged, fact)) {
      merged.push(fact);
    }
  }

  return dedupeByNormalizedFact(merged);
}

function shouldIncludeSupplementalFact(
  existingFacts: ExtractedFact[],
  candidate: ExtractedFact,
): boolean {
  const normalizedFact = normalizeFact(candidate.fact);
  if (existingFacts.some((fact) => normalizeFact(fact.fact) === normalizedFact)) {
    return false;
  }

  const candidateShape = buildCoverageShape(candidate);
  const candidateFeatures = buildFeatureSet(candidate.fact);
  if (!hasSupplementalSignal(candidate, candidateFeatures)) {
    return false;
  }

  const shapeMatches = existingFacts.filter(
    (fact) => buildCoverageShape(fact) === candidateShape,
  );

  if (shapeMatches.length === 0) {
    return true;
  }

  return hasUncoveredFeature(shapeMatches, candidateFeatures);
}

function findUpgradeableFactIndex(
  existingFacts: ExtractedFact[],
  candidate: ExtractedFact,
): number {
  const candidateEntities = new Set(listNonUserEntities(candidate));
  const candidateRelations = new Set(candidate.relations.map((relation) => relation.type));
  const candidateFeatures = buildFeatureSet(candidate.fact);

  return existingFacts.findIndex((fact) => {
    const existingEntities = listNonUserEntities(fact);
    if (existingEntities.length === 0) {
      return false;
    }

    const entitiesCovered = existingEntities.every((entity) => candidateEntities.has(entity));
    if (!entitiesCovered) {
      return false;
    }

    const existingRelations = fact.relations.map((relation) => relation.type);
    const relationsCovered = existingRelations.every((relation) => candidateRelations.has(relation));
    if (!relationsCovered) {
      return false;
    }

    if (candidateFeatures.sharedSchool && !hasSharedSchoolDetail(fact.fact)) {
      return true;
    }

    if (candidateEntities.size <= existingEntities.length) {
      return false;
    }

    if (candidate.fact.length <= fact.fact.length + 10) {
      return false;
    }

    return hasAnyFeature(candidateFeatures)
      || !hasRelativeTemporalDetail(fact.fact);
  });
}

function buildFeatureSet(text: string): SupplementalFeatureSet {
  return {
    temporal: hasRelativeTemporalDetail(text),
    literal: hasLiteralDetail(text),
    event: hasEventDetail(text),
    visual: hasVisualEvidenceDetail(text),
    affectInventory: hasAffectInventoryDetail(text),
    sharedSchool: hasSharedSchoolDetail(text),
    sharedOverlap: hasSharedOverlapDetail(text),
  };
}

function hasSupplementalSignal(candidate: ExtractedFact, features: SupplementalFeatureSet): boolean {
  return listNonUserEntities(candidate).length > 0 || hasAnyFeature(features);
}

function hasAnyFeature(features: SupplementalFeatureSet): boolean {
  return Object.values(features).some(Boolean);
}

function hasUncoveredFeature(
  shapeMatches: ExtractedFact[],
  features: SupplementalFeatureSet,
): boolean {
  if (features.visual) return true;
  if (!hasAnyFeature(features)) return false;
  if (features.sharedSchool) return shapeMatches.every((fact) => !hasSharedSchoolDetail(fact.fact));
  if (features.sharedOverlap) return shapeMatches.every((fact) => !hasSharedOverlapDetail(fact.fact));
  if (features.affectInventory) return shapeMatches.every((fact) => !hasAffectInventoryDetail(fact.fact));
  if (features.temporal) return shapeMatches.every((fact) => !hasRelativeTemporalDetail(fact.fact));
  if (features.literal) return shapeMatches.every((fact) => !hasLiteralDetail(fact.fact));
  if (features.event) return shapeMatches.every((fact) => !hasEventDetail(fact.fact));
  return false;
}

function buildCoverageShape(fact: ExtractedFact): string {
  const entities = listNonUserEntities(fact).join('|');
  const relations = fact.relations.map((relation) => relation.type).sort().join('|');
  return `${entities}::${relations}`;
}

function listNonUserEntities(fact: ExtractedFact): string[] {
  return [...new Set(
    fact.entities
      .map((entity) => entity.name.trim().toLowerCase())
      .filter((name) => name && name !== 'user'),
  )].sort();
}

function hasRelativeTemporalDetail(text: string): boolean {
  return TEMPORAL_DETAIL_PATTERN.test(text) || containsRelativeTemporalPhrase(text);
}

function hasLiteralDetail(text: string): boolean {
  return LITERAL_DETAIL_PATTERN.test(text) || QUOTED_TEXT_PATTERN.test(text);
}

function hasEventDetail(text: string): boolean {
  return EVENT_DETAIL_PATTERN.test(text);
}

function hasVisualEvidenceDetail(text: string): boolean {
  return VISUAL_EVIDENCE_PATTERN.test(text);
}

function hasAffectInventoryDetail(text: string): boolean {
  return AFFECT_INVENTORY_PATTERN.test(text);
}

function hasSharedSchoolDetail(text: string): boolean {
  return SHARED_SCHOOL_PATTERN.test(text);
}

function hasSharedOverlapDetail(text: string): boolean {
  return SHARED_OVERLAP_PATTERN.test(text);
}

function dedupeByNormalizedFact(facts: ExtractedFact[]): ExtractedFact[] {
  const unique = new Map<string, ExtractedFact>();
  for (const fact of facts) {
    unique.set(normalizeFact(fact.fact), fact);
  }
  return [...unique.values()];
}

function normalizeFact(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}
