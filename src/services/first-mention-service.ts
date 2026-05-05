/**
 * First-mention extraction service — produces a chronological list of
 * topic-introduction events from a conversation transcript.
 *
 * One LLM call scans the full transcript and outputs a JSON array of
 * `{topic, turn_id, session_id, anchor_date}` records. The service
 * maps those onto core's stricter `FirstMentionEvent` shape (joining
 * turn_id to memory_id via a caller-supplied map) and persists via
 * `FirstMentionRepository.store`.
 *
 * Best-effort: extraction failures are logged to stderr and produce an
 * empty array. Storage errors are propagated (no silent swallow).
 *
 * Prompts and salvage parser were ported verbatim from the BEAM harness
 * (`atomicmemory-benchmarks/data/exp-stage7-beam-dryrun/lib.ts`) so the
 * core implementation matches the validated extraction behaviour.
 */

import {
  FirstMentionRepository,
  type FirstMentionEvent,
} from '../db/repository-first-mentions.js';

interface ChatResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

type ChatFn = (
  system: string,
  user: string,
  maxTokens: number,
) => Promise<ChatResult>;

/** Loose shape produced by the LLM; mapped onto `FirstMentionEvent`. */
interface RawFirstMention {
  topic: string;
  turn_id: number;
  session_id?: number;
  anchor_date?: string | null;
}

const FIRST_MENTIONS_MAX_TOKENS = 8000;

const FIRST_MENTIONS_SYSTEM =
  'You scan a conversation chronologically and identify FIRST-MENTION events: ' +
  'the moment when a NEW major topic is introduced for the first time. ' +
  'A "topic" is a specific aspect, feature, tech decision, problem, milestone, ' +
  'or planning item — NOT a sub-aspect of a previously-introduced topic and ' +
  'NOT a generic concept. Use SPECIFIC TECHNICAL PHRASES from the conversation ' +
  'verbatim (version numbers, library names, config flags, named operations). ' +
  'Order strictly by turn appearance. Output ONLY a JSON array.';

function buildFirstMentionsUser(turnsText: string): string {
  return (
    `Conversation turns (in chronological order, with turn_id and session_id markers):\n\n` +
    turnsText +
    `\n\nWalk through the turns sequentially. For each turn that introduces ` +
    `a NEW major topic (not discussed in any earlier turn), record one event:\n` +
    `  {"topic": "<COMPACT specific topic phrase, 5-12 words MAX>", "turn_id": <int>, ` +
    `"session_id": <int>, "anchor_date": "<time_anchor or null>"}\n\n` +
    `Output ONLY a valid JSON array (no markdown fences, no preamble). ` +
    `Aim for 15-30 first-mentions across the whole conversation, covering ` +
    `distinct major aspects spanning all sessions. ` +
    `Each topic phrase MUST be SHORT (5-12 words). Use verbatim tech tokens ` +
    `(version numbers, library names) inside the short phrase. ` +
    `Skip generic chatter, sub-aspects of already-listed topics, and assistant ` +
    `explanatory content. Close the JSON array with ] before any other output.`
  );
}

/**
 * Salvage parser: if the model truncated mid-array (no closing ]),
 * find the last complete object and synthesize a closing bracket.
 */
function salvageJsonArray(text: string): string | null {
  const start = text.indexOf('[');
  if (start < 0) return null;
  const lastBrace = text.lastIndexOf('}');
  if (lastBrace < start) return null;
  return text.slice(start, lastBrace + 1) + ']';
}

function isRawFirstMention(value: unknown): value is RawFirstMention {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.topic === 'string' && typeof v.turn_id === 'number';
}

function parseAnchorDate(raw: unknown): Date | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return null;
  return new Date(ms);
}

/** Extract a JSON array from raw LLM text, salvaging truncated output. */
function extractJsonArray(text: string): unknown[] | null {
  const trimmed = text.trim();
  const start = trimmed.indexOf('[');
  if (start < 0) {
    process.stderr.write(
      `  ⚠ first-mentions: no opening [ in response (text len=${trimmed.length})\n`,
    );
    return null;
  }
  const end = trimmed.lastIndexOf(']');
  let jsonSlice: string;
  if (end <= start) {
    const salvaged = salvageJsonArray(trimmed);
    if (!salvaged) return null;
    process.stderr.write(
      `  ⚠ first-mentions: response truncated; salvaged ${salvaged.length} chars\n`,
    );
    jsonSlice = salvaged;
  } else {
    jsonSlice = trimmed.slice(start, end + 1);
  }
  const parsed: unknown = JSON.parse(jsonSlice);
  if (!Array.isArray(parsed)) {
    process.stderr.write(
      `  ⚠ first-mentions: parsed JSON is not an array (type=${typeof parsed})\n`,
    );
    return null;
  }
  return parsed;
}

export class FirstMentionService {
  constructor(
    private repo: FirstMentionRepository,
    private chatFn: ChatFn,
  ) {}

  /**
   * Extract first-mention events from a conversation transcript and
   * persist them. Returns the parsed events (post-mapping). Best-effort:
   * if the LLM call fails or returns unparseable output the method
   * logs to stderr and returns `[]` without throwing.
   *
   * `memoryIdsByTurnId` provides the mapping the LLM cannot produce —
   * any event whose `turn_id` is not present in the map is dropped.
   */
  async extractAndStore(
    userId: string,
    conversationText: string,
    sourceSite: string,
    memoryIdsByTurnId: Map<number, string>,
  ): Promise<FirstMentionEvent[]> {
    const raw = await this.invokeLlm(conversationText);
    if (raw === null) return [];
    const events = this.mapToEvents(raw, memoryIdsByTurnId);
    if (events.length > 0) {
      await this.repo.store(userId, sourceSite, events);
    }
    return events;
  }

  /** Run the extraction LLM call; return parsed array or null on failure. */
  private async invokeLlm(conversationText: string): Promise<unknown[] | null> {
    let rawText = '';
    try {
      const res = await this.chatFn(
        FIRST_MENTIONS_SYSTEM,
        buildFirstMentionsUser(conversationText),
        FIRST_MENTIONS_MAX_TOKENS,
      );
      rawText = res.text;
      return extractJsonArray(rawText);
    } catch (err) {
      const msg = err instanceof Error ? err.message.slice(0, 200) : String(err);
      process.stderr.write(`  ⚠ first-mentions extraction failed: ${msg}\n`);
      if (rawText) {
        process.stderr.write(
          `  ⚠ raw response (first 500 chars): ${rawText.slice(0, 500).replace(/\n/g, ' ')}\n`,
        );
      }
      return null;
    }
  }

  /** Map LLM output records onto core's `FirstMentionEvent` shape. */
  private mapToEvents(
    raw: unknown[],
    memoryIdsByTurnId: Map<number, string>,
  ): FirstMentionEvent[] {
    const filtered = raw.filter(isRawFirstMention);
    const events: FirstMentionEvent[] = [];
    for (const m of filtered) {
      const memoryId = memoryIdsByTurnId.get(m.turn_id);
      if (!memoryId) continue;
      events.push({
        topic: m.topic,
        turnId: m.turn_id,
        memoryId,
        anchorDate: parseAnchorDate(m.anchor_date),
        positionInConversation: m.turn_id,
      });
    }
    events.sort((a, b) => a.positionInConversation - b.positionInConversation);
    if (events.length === 0 && filtered.length > 0) {
      process.stderr.write(
        `  ⚠ first-mentions: ${filtered.length} parsed entries had no matching memory_id\n`,
      );
    }
    return events;
  }
}
