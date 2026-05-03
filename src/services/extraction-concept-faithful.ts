/**
 * Concept-faithful extraction prompt — Phase 2 / Mem0-pattern alternative.
 *
 * The default EXTRACTION_PROMPT in extraction.ts is explicitly aggressive
 * about atomic splitting ("AGGRESSIVE TECHNOLOGY SPLITTING", "Each fact
 * must be a single, atomic statement"). This is the OPPOSITE of Mem0's
 * 15-80-word "Concise but Complete" pattern that scored 0.635 on BEAM
 * SUM (vs our 0.10) and 0.652 on MSR (vs our 0.30).
 *
 * The hypothesis: BEAM rubric items use concept-level vocabulary
 * ("Transaction error handling", "Security and deployment"). Our atomic
 * extractor strips those phrases. Mem0's richer memories preserve them.
 *
 * This prompt is NOT yet wired into the runtime — it's a draft for the
 * Phase 2 experiment. To deploy:
 *
 *   1. Replace EXTRACTION_PROMPT in extraction.ts with this string
 *   2. Re-ingest convs (~50min each w/ AUDN fix)
 *   3. Re-run multirun against new UIDs
 *   4. Compare composite to Phase B baseline
 *
 * The expected behavior change: memories like
 *   OLD: ["User implemented Werkzeug pbkdf2:sha256 password hashing"]
 *   NEW: ["User implemented authentication for the budget tracker
 *          including Werkzeug.security pbkdf2:sha256 password hashing,
 *          Flask-Login session management, and CSRF protection during
 *          the security improvements phase in March 2026."]
 */

export const CONCEPT_FAITHFUL_EXTRACTION_PROMPT = `You are a memory extraction system. Extract self-contained, contextually rich facts from the conversation below. Each fact should preserve the user's actual phrasing for technologies, decisions, and topics — these phrases will be used months later to answer questions that may quote them verbatim.

GUIDING PRINCIPLE — Concise but Complete:
Each memory should be 15-80 words. Long enough to preserve context and the user's vocabulary; short enough to be a focused unit. NEVER split a coherent topic across multiple atomic facts; that loses the conceptual structure that makes the memory useful.

EXAMPLES:

WRONG (atomic-only, our previous default):
  "User is using Flask 2.3.0."
  "User is using Werkzeug pbkdf2:sha256."
  "User implemented session management."
  "User added CSRF protection."
  → 4 disconnected facts; the relationship between them is lost; the rubric phrase "transaction error handling" never appears as a unit.

RIGHT (concept-faithful, Mem0 pattern):
  "User is building a Flask 2.3.0 budget tracker app and during the security improvements phase implemented authentication using Werkzeug.security pbkdf2:sha256 password hashing, Flask-Login session management, and CSRF protection. As of March 2026."
  → 1 rich memory; preserves topic ("security improvements phase"), specific tokens (Flask 2.3.0, Werkzeug pbkdf2:sha256), and temporal anchor.

RULES:
- 15-80 word range. Under 15 = too sparse; over 80 = covers multiple topics, split.
- VERBATIM TECHNICAL TOKENS: When the user mentions a specific library version, framework, API name, or named entity, REPRODUCE that token EXACTLY. "Flask 2.3.0" stays "Flask 2.3.0", not "Flask".
- TOPICAL COHERENCE: Each memory should cover ONE topic ("security implementation", "deployment configuration", "transaction error handling") and bundle all the specific decisions/tools associated with that topic into one memory.
- TEMPORAL ANCHORING: Include the date or session context ("As of March 2026", "during the second sprint", "after the database migration phase") when available.
- ENTITY-FOCUSED: Every named person, institution, organization, library, project, or specific number mentioned by the user MUST appear in at least one memory.
- CORRECTION/REVISION PRESERVATION: When the conversation contains an explicit correction (e.g. "Correction:", "Actually,", "Changed my mind"), the memory MUST preserve the corrective relationship. Use phrases like "instead of Y", "replacing Y", "corrected from Y".
- Skip pleasantries, filler, acknowledgments, and meta-conversation.
- Skip generic assistant chatter ("sure!", "got it"). DO extract specific factual content from assistant responses (named entities, recommendations with proper nouns) prefixed with "Assistant mentioned:" or "Assistant recommended:".

CATEGORIES:
- preference: Likes, dislikes, opinions, style choices
- project: What the user is building, tools used, architecture decisions
- knowledge: Patterns learned, problems solved, techniques discovered
- person: People mentioned, relationships, roles
- plan: Goals, intentions, scheduled activities, future work

KEYWORDS:
For each memory, extract keywords for keyword search. Include:
- Proper nouns (people, companies, products, tools) verbatim
- Dates and time references
- Project names and domains
- Technical terms that might be lost in paraphrasing
- Organization names
Keywords preserve the original spelling and casing from the conversation.

HEADLINE:
For each memory, write a short headline (max 10 words) capturing the topic.

ENTITIES:
Extract named entities mentioned. Each entity has:
- name: canonical name verbatim
- type: person, tool, project, organization, place, concept
Only extract entities explicitly named in the memory.

RELATIONS:
Extract relationships between entities. Each relation has:
- source: source entity name
- target: target entity name
- type: uses, works_on, works_at, located_in, knows, prefers, created, belongs_to, studies, manages

IMPORTANCE:
Rate importance 0.0-1.0:
  0.0-0.3 = trivial (greeting style, minor preferences)
  0.4-0.6 = useful (project details, tools mentioned)
  0.7-0.9 = important (core preferences, key decisions, recurring patterns)
  1.0 = critical (explicit instructions for future, strong opinions)

OUTPUT: A JSON object \`{"memories": [...]}\` where each memory has fields: text, category, importance, keywords (array), headline, entities (array of {name, type}), relations (array of {source, target, type}).
`;
