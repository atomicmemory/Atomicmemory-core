/**
 * Unit tests for EXP-08 scheduled consolidation.
 *
 * Verifies the per-user_id turn counter triggers consolidation exactly
 * at multiples of the configured interval, that the gate is defaults-off,
 * and that thrown consolidation errors are logged but not propagated.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockExecuteConsolidation } = vi.hoisted(() => ({
  mockExecuteConsolidation: vi.fn(),
}));

vi.mock('../consolidation-service.js', () => ({
  executeConsolidation: mockExecuteConsolidation,
}));

const {
  recordIngestTurn,
  __resetTurnCountsForTest,
  __peekTurnCountForTest,
} = await import('../scheduled-consolidation.js');

type DepsLike = Parameters<typeof recordIngestTurn>[0];

function makeDeps(overrides: Partial<{
  enabled: boolean;
  interval: number;
  llmModel: string;
}> = {}): DepsLike {
  const memory = { __tag: 'memory-store' };
  const claim = { __tag: 'claim-store' };
  return {
    config: {
      scheduledConsolidationEnabled: overrides.enabled ?? true,
      scheduledConsolidationTurnInterval: overrides.interval ?? 50,
      llmModel: overrides.llmModel ?? 'gpt-4o-mini',
    },
    stores: { memory, claim },
  } as unknown as DepsLike;
}

describe('scheduled-consolidation', () => {
  beforeEach(() => {
    __resetTurnCountsForTest();
    mockExecuteConsolidation.mockReset();
    mockExecuteConsolidation.mockResolvedValue({
      clustersConsolidated: 0,
      memoriesArchived: 0,
      memoriesCreated: 0,
      consolidatedMemoryIds: [],
    });
  });

  afterEach(() => {
    __resetTurnCountsForTest();
  });

  it('does not trigger when disabled (defaults-off)', async () => {
    const deps = makeDeps({ enabled: false });
    for (let i = 0; i < 200; i++) await recordIngestTurn(deps, 'user-1');
    expect(mockExecuteConsolidation).not.toHaveBeenCalled();
    expect(__peekTurnCountForTest('user-1')).toBe(0);
  });

  it('triggers exactly twice across 100 turns at interval 50', async () => {
    const deps = makeDeps({ enabled: true, interval: 50 });
    for (let i = 0; i < 100; i++) await recordIngestTurn(deps, 'user-1');
    expect(mockExecuteConsolidation).toHaveBeenCalledTimes(2);
    expect(__peekTurnCountForTest('user-1')).toBe(100);
  });

  it('passes the configured llmModel through to executeConsolidation', async () => {
    const deps = makeDeps({ enabled: true, interval: 3, llmModel: 'gpt-test' });
    for (let i = 0; i < 3; i++) await recordIngestTurn(deps, 'user-1');
    expect(mockExecuteConsolidation).toHaveBeenCalledTimes(1);
    expect(mockExecuteConsolidation).toHaveBeenCalledWith(
      expect.objectContaining({ __tag: 'memory-store' }),
      expect.objectContaining({ __tag: 'claim-store' }),
      'user-1',
      undefined,
      { llmModel: 'gpt-test' },
    );
  });

  it('tracks counters per user_id independently', async () => {
    const deps = makeDeps({ enabled: true, interval: 5 });
    for (let i = 0; i < 5; i++) await recordIngestTurn(deps, 'user-a');
    for (let i = 0; i < 4; i++) await recordIngestTurn(deps, 'user-b');
    expect(mockExecuteConsolidation).toHaveBeenCalledTimes(1);
    expect(mockExecuteConsolidation).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'user-a',
      undefined,
      expect.anything(),
    );
  });

  it('logs and swallows errors thrown by executeConsolidation', async () => {
    const deps = makeDeps({ enabled: true, interval: 2 });
    mockExecuteConsolidation.mockRejectedValueOnce(new Error('boom'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(recordIngestTurn(deps, 'user-1')).resolves.toBeUndefined();
    await expect(recordIngestTurn(deps, 'user-1')).resolves.toBeUndefined();
    expect(mockExecuteConsolidation).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0]?.[0]).toContain('scheduled-consolidation');
    expect(errSpy.mock.calls[0]?.[0]).toContain('boom');
    errSpy.mockRestore();
  });

  it('does nothing for non-positive intervals', async () => {
    const deps = makeDeps({ enabled: true, interval: 0 });
    for (let i = 0; i < 10; i++) await recordIngestTurn(deps, 'user-1');
    expect(mockExecuteConsolidation).not.toHaveBeenCalled();
  });
});
