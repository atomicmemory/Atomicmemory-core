/**
 * Unit tests for FirstMentionService.
 * Validates LLM-output parsing, salvage path for truncated arrays,
 * mapping turn_id -> memory_id, schema filtering, and storage interaction.
 * The repository and chatFn are both mocked — no DB or network access.
 */

import { beforeEach, describe, it, expect, vi } from 'vitest';
import {
  FirstMentionRepository,
  type FirstMentionEvent,
} from '../../db/repository-first-mentions.js';
import { FirstMentionService } from '../first-mention-service.js';

interface ChatResult {
  text: string;
}

function makeRepo() {
  const store = vi.fn().mockResolvedValue(undefined);
  const getByMemoryId = vi.fn().mockResolvedValue(null);
  const list = vi.fn().mockResolvedValue([]);
  const repo = { store, getByMemoryId, list } as unknown as FirstMentionRepository;
  return { repo, store, getByMemoryId, list };
}

function chatReturning(text: string) {
  return vi.fn(
    async (): Promise<ChatResult> => ({ text }),
  );
}

describe('FirstMentionService.extractAndStore', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('happy path: stores and returns events from valid JSON array', async () => {
    const json = JSON.stringify([
      { topic: 'auth setup', turn_id: 2, session_id: 1, anchor_date: '2026-01-15T00:00:00Z' },
      { topic: 'redis cache', turn_id: 5, session_id: 1, anchor_date: null },
    ]);
    const { repo, store } = makeRepo();
    const chatFn = chatReturning(json);
    const svc = new FirstMentionService(repo, chatFn);

    const memoryIds = new Map<number, string>([
      [2, 'mem-aaaa'],
      [5, 'mem-bbbb'],
    ]);

    const result = await svc.extractAndStore('user-1', 'conv text', 'beam', memoryIds);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      topic: 'auth setup',
      turnId: 2,
      memoryId: 'mem-aaaa',
      positionInConversation: 2,
    });
    expect(result[0].anchorDate).toBeInstanceOf(Date);
    expect(result[1].anchorDate).toBeNull();
    expect(store).toHaveBeenCalledWith('user-1', 'beam', result);
  });
});

describe('FirstMentionService salvage and error paths', () => {
  it('salvage path: recovers events from truncated JSON', async () => {
    const truncated =
      '[\n' +
      '  {"topic": "first topic", "turn_id": 1, "session_id": 1, "anchor_date": null},\n' +
      '  {"topic": "second topic", "turn_id": 3, "session_id": 1, "anchor_date": null}';
    const { repo, store } = makeRepo();
    const chatFn = chatReturning(truncated);
    const svc = new FirstMentionService(repo, chatFn);

    const memoryIds = new Map<number, string>([
      [1, 'mem-1'],
      [3, 'mem-3'],
    ]);

    const result = await svc.extractAndStore('u', 'conv', 'beam', memoryIds);
    expect(result.map((e) => e.topic)).toEqual(['first topic', 'second topic']);
    expect(store).toHaveBeenCalledTimes(1);
  });

  it('garbage path: returns [] and skips repo.store when no array found', async () => {
    const { repo, store } = makeRepo();
    const chatFn = chatReturning('I cannot help with that.');
    const svc = new FirstMentionService(repo, chatFn);

    const result = await svc.extractAndStore('u', 'conv', 'beam', new Map());
    expect(result).toEqual([]);
    expect(store).not.toHaveBeenCalled();
  });

  it('non-array JSON: returns [] without storing', async () => {
    const { repo, store } = makeRepo();
    const chatFn = chatReturning('{"topic": "not an array"}');
    const svc = new FirstMentionService(repo, chatFn);

    const result = await svc.extractAndStore('u', 'conv', 'beam', new Map());
    expect(result).toEqual([]);
    expect(store).not.toHaveBeenCalled();
  });

  it('chatFn throws: returns [] without throwing', async () => {
    const { repo, store } = makeRepo();
    const chatFn = vi.fn(async () => {
      throw new Error('upstream timeout');
    });
    const svc = new FirstMentionService(repo, chatFn);

    const result = await svc.extractAndStore('u', 'conv', 'beam', new Map());
    expect(result).toEqual([]);
    expect(store).not.toHaveBeenCalled();
    expect(chatFn).toHaveBeenCalledTimes(1);
  });
});

describe('FirstMentionService mapping and filtering', () => {
  it('drops events whose turn_id has no memoryId mapping', async () => {
    const json = JSON.stringify([
      { topic: 'mapped topic', turn_id: 2, session_id: 1, anchor_date: null },
      { topic: 'orphan topic', turn_id: 99, session_id: 1, anchor_date: null },
    ]);
    const { repo, store } = makeRepo();
    const chatFn = chatReturning(json);
    const svc = new FirstMentionService(repo, chatFn);

    const memoryIds = new Map<number, string>([[2, 'mem-2']]);
    const result = await svc.extractAndStore('u', 'conv', 'beam', memoryIds);

    expect(result).toHaveLength(1);
    expect(result[0].turnId).toBe(2);
    expect(store).toHaveBeenCalledWith('u', 'beam', result);
  });

  it('drops entries missing required fields (topic / turn_id)', async () => {
    const json = JSON.stringify([
      { topic: 'good', turn_id: 1, session_id: 1, anchor_date: null },
      { turn_id: 2, session_id: 1 },
      { topic: 'no turn id', session_id: 1 },
      { topic: 42, turn_id: 3 },
      null,
      'string entry',
    ]);
    const { repo, store } = makeRepo();
    const chatFn = chatReturning(json);
    const svc = new FirstMentionService(repo, chatFn);

    const memoryIds = new Map<number, string>([
      [1, 'mem-1'],
      [2, 'mem-2'],
      [3, 'mem-3'],
    ]);
    const result = await svc.extractAndStore('u', 'conv', 'beam', memoryIds);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ topic: 'good', turnId: 1 });
    expect(store).toHaveBeenCalledTimes(1);
  });

  it('parses anchor_date strings and tolerates invalid dates as null', async () => {
    const json = JSON.stringify([
      { topic: 'a', turn_id: 1, session_id: 1, anchor_date: '2026-03-10T12:00:00Z' },
      { topic: 'b', turn_id: 2, session_id: 1, anchor_date: 'not-a-date' },
      { topic: 'c', turn_id: 3, session_id: 1, anchor_date: null },
    ]);
    const { repo } = makeRepo();
    const chatFn = chatReturning(json);
    const svc = new FirstMentionService(repo, chatFn);

    const memoryIds = new Map<number, string>([
      [1, 'mem-1'],
      [2, 'mem-2'],
      [3, 'mem-3'],
    ]);
    const result: FirstMentionEvent[] = await svc.extractAndStore(
      'u',
      'conv',
      'beam',
      memoryIds,
    );

    expect(result).toHaveLength(3);
    expect(result[0].anchorDate).toBeInstanceOf(Date);
    expect(result[1].anchorDate).toBeNull();
    expect(result[2].anchorDate).toBeNull();
  });

  it('sorts results by position_in_conversation ascending', async () => {
    const json = JSON.stringify([
      { topic: 'late', turn_id: 9, session_id: 1, anchor_date: null },
      { topic: 'early', turn_id: 2, session_id: 1, anchor_date: null },
      { topic: 'middle', turn_id: 5, session_id: 1, anchor_date: null },
    ]);
    const { repo } = makeRepo();
    const chatFn = chatReturning(json);
    const svc = new FirstMentionService(repo, chatFn);

    const memoryIds = new Map<number, string>([
      [2, 'mem-2'],
      [5, 'mem-5'],
      [9, 'mem-9'],
    ]);
    const result = await svc.extractAndStore('u', 'conv', 'beam', memoryIds);

    expect(result.map((e) => e.topic)).toEqual(['early', 'middle', 'late']);
    expect(result.map((e) => e.positionInConversation)).toEqual([2, 5, 9]);
  });
});
