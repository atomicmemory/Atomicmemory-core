/**
 * Instruction-marker phrase list for EXP-05 (H-310).
 *
 * Detects facts that express a user-supplied directive, preference, or
 * standing instruction. Two layers:
 *
 *   1. INSTRUCTION_MARKERS — case-insensitive substrings that flag the fact.
 *   2. FALSE_POSITIVE_PATTERNS — subsequences that disqualify a hit
 *      (e.g. "wants to know" is a question prefix, not a directive).
 *
 * Both lists are intentionally additive on top of the original strict
 * imperatives ("always X / never Y / from now on / going forward / make
 * sure to / ...") so existing behavior is preserved. The expansion
 * targets BEAM-style soft imperatives that the Stage-7 v1 dryrun missed
 * (only 15/2000 facts tagged — see plan H-310).
 *
 * Detection runs over the post-extraction fact form, which is third
 * person ("user prefers X", "user wants Y") — so the markers match that
 * surface form rather than first-person ("I prefer X"). Both forms are
 * supported by relying on the unanchored substring "prefer" / "want".
 */

/**
 * Phrases that flag an extracted fact as an explicit instruction or
 * preference. Matched as case-insensitive substrings against the fact
 * text padded with spaces on either side.
 *
 * Ordering note: the list MUST keep all original strict imperatives at
 * the top so that existing behavior is preserved verbatim.
 */
export const INSTRUCTION_MARKERS = [
  // --- Original strict imperatives (preserved verbatim from EXP-05 v1) ---
  'always ',
  'never ',
  'from now on',
  'please remember',
  'make sure to',
  "don't forget",
  'do not forget',
  'every time',
  'whenever you',
  'going forward',
  'in the future',
  'remember to',
  // --- BEAM soft-imperative additions (H-310) ---
  // Preferences (PF questions)
  'prefer ',
  'prefers ',
  'preference is',
  'preference for',
  // First/third-person desires that read as standing requests
  ' want ',
  ' wants ',
  "i'd like",
  'would like',
  // Standing-rule phrasings users issue mid-conversation
  'please ',
  'should always',
  'should never',
  'must always',
  // Inclusion/format directives
  'always include',
  'always use',
  'use only',
] as const;

/**
 * Disqualifying sub-phrases. If any of these appears in the lower-cased
 * fact text, the instruction tag is suppressed even when an
 * INSTRUCTION_MARKERS entry matched. These cover cases where the
 * marker word is part of a question or hedge rather than a directive.
 *
 * Examples blocked:
 *   - "user wants to know"     → question prefix, not a directive
 *   - "user would like to know" / "would like to ask" → question prefix
 *   - "user prefers not to"    → negation; expressed as not-doing, not a rule
 *   - "user does not prefer"   → negation
 *   - "i want to know"         → question, surfaces post-extraction unchanged
 */
export const FALSE_POSITIVE_PATTERNS: readonly string[] = [
  'want to know',
  'wants to know',
  'wanted to know',
  'would like to know',
  'would like to ask',
  "i'd like to know",
  "i'd like to ask",
  'prefer not to',
  'prefers not to',
  'does not prefer',
  'do not prefer',
] as const;

/**
 * Returns true when the fact text contains at least one instruction
 * marker AND is not blocked by a false-positive pattern.
 *
 * The leading/trailing space pad lets us match word-boundary-like
 * patterns ("always ", " want ") without resorting to regex. The pad
 * also makes "wants" not match a marker that requires "want " with a
 * trailing space — only " wants " (the dedicated marker) matches.
 */
export function matchesInstructionMarker(text: string): boolean {
  const lower = ` ${text.toLowerCase()} `;
  if (FALSE_POSITIVE_PATTERNS.some((pattern) => lower.includes(pattern))) {
    return false;
  }
  return INSTRUCTION_MARKERS.some((marker) => lower.includes(marker));
}
