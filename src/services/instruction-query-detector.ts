/**
 * Instruction-style query detection (EXP-IF).
 *
 * Pure-string classifier that decides whether a retrieval query is asking
 * about instructions/preferences/style the user has previously stated, and
 * therefore should preferentially fetch from the instruction-tagged subset
 * of memories before filling with general-retrieval results.
 *
 * Tagging at ingest time is performed by `extraction-enrichment.ts`
 * (`applyInstructionTagging`), which sets `metadata.fact_role: 'instruction'`
 * on imperative phrasings ("always X", "never Y", "from now on", etc.).
 * This module routes *queries* — at no point does it call the LLM.
 *
 * Defaults-OFF behind `instructionPreferenceRetrievalEnabled`. Callers must
 * still gate by that flag; this module is pure detection.
 */

const INSTRUCTION_PHRASES: readonly string[] = [
  'what did i tell you',
  'what did i say',
  "what's my preference",
  'what is my preference',
  "what's my style",
  'what is my style',
  'how should i',
  'how should you',
  'how do i format',
  'how do you format',
  "what's my format",
  'what is my format',
  'remember to',
  'remind me',
  'always',
  'never',
  'from now on',
  'preferred',
  'preference',
  'my style',
  'my format',
  'instruction',
  'instructions',
  'rule i set',
  'rules i set',
];

/**
 * Returns true when the query reads like a request for the user's
 * previously-stated instruction, preference, or style. Match is
 * case-insensitive and based on substring presence of one of
 * `INSTRUCTION_PHRASES`. Pure function — no side effects.
 */
export function isInstructionStyleQuery(query: string): boolean {
  if (typeof query !== 'string' || query.length === 0) return false;
  const normalized = query.toLowerCase();
  for (const phrase of INSTRUCTION_PHRASES) {
    if (normalized.includes(phrase)) return true;
  }
  return false;
}
