/**
 * Unit tests for log-spaced recency bin assignment (EXP-12).
 *
 * Bin ladder: 1m | 10m | 1h | 10h | 1d | 10d | 100d | older.
 * Bins are an upper-bound classification — exactly-on-the-boundary ages
 * land in the corresponding bin, ages just past the boundary land in the
 * next rung.
 */

import { describe, expect, it } from 'vitest';
import {
  assignRecencyBin,
  computeBinAffinity,
  RECENCY_BIN_LABELS,
  type RecencyBin,
} from '../temporal-fingerprint.js';

const NOW = new Date('2026-04-29T12:00:00.000Z');

function ageMs(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

describe('assignRecencyBin — bin boundary table', () => {
  const cases: ReadonlyArray<{ label: string; ageMs: number; expected: RecencyBin }> = [
    { label: 'now (0ms)',                ageMs: 0,                  expected: '1m' },
    { label: '1 minute exactly',         ageMs: 60_000,             expected: '1m' },
    { label: 'just past 1m (61s)',       ageMs: 61_000,             expected: '10m' },
    { label: '9 minutes',                ageMs: 9 * 60_000,         expected: '10m' },
    { label: '10 minutes exactly',       ageMs: 10 * 60_000,        expected: '10m' },
    { label: '11 minutes',               ageMs: 11 * 60_000,        expected: '1h' },
    { label: '59 minutes',               ageMs: 59 * 60_000,        expected: '1h' },
    { label: '1 hour exactly',           ageMs: 3_600_000,          expected: '1h' },
    { label: 'just past 1h',             ageMs: 3_600_001,          expected: '10h' },
    { label: '10 hours exactly',         ageMs: 36_000_000,         expected: '10h' },
    { label: '23 hours',                 ageMs: 23 * 3_600_000,     expected: '1d' },
    { label: '1 day exactly',            ageMs: 86_400_000,         expected: '1d' },
    { label: 'just past 1 day',          ageMs: 86_400_001,         expected: '10d' },
    { label: '9 days',                   ageMs: 9 * 86_400_000,     expected: '10d' },
    { label: '10 days exactly',          ageMs: 10 * 86_400_000,    expected: '10d' },
    { label: '11 days',                  ageMs: 11 * 86_400_000,    expected: '100d' },
    { label: '99 days',                  ageMs: 99 * 86_400_000,    expected: '100d' },
    { label: '100 days exactly',         ageMs: 100 * 86_400_000,   expected: '100d' },
    { label: '101 days',                 ageMs: 101 * 86_400_000,   expected: 'older' },
    { label: '1 year',                   ageMs: 365 * 86_400_000,   expected: 'older' },
  ];

  for (const c of cases) {
    it(c.label, () => {
      expect(assignRecencyBin(ageMs(c.ageMs), NOW)).toBe(c.expected);
    });
  }

  it('clamps future-dated facts to the youngest bin', () => {
    const future = new Date(NOW.getTime() + 60_000);
    expect(assignRecencyBin(future, NOW)).toBe('1m');
  });
});

describe('computeBinAffinity', () => {
  it('exact match returns 1', () => {
    expect(computeBinAffinity('1h', '1h')).toBe(1);
  });

  it('adjacent bins return 0.5', () => {
    expect(computeBinAffinity('1h', '10h')).toBe(0.5);
    expect(computeBinAffinity('10h', '1h')).toBe(0.5);
    expect(computeBinAffinity('100d', 'older')).toBe(0.5);
    expect(computeBinAffinity('1m', '10m')).toBe(0.5);
  });

  it('non-adjacent bins return 0', () => {
    expect(computeBinAffinity('1m', '1h')).toBe(0);
    expect(computeBinAffinity('1h', '1d')).toBe(0);
    expect(computeBinAffinity('1m', 'older')).toBe(0);
  });

  it('exposes the canonical bin order for callers', () => {
    expect(RECENCY_BIN_LABELS).toEqual(['1m', '10m', '1h', '10h', '1d', '10d', '100d', 'older']);
  });
});
