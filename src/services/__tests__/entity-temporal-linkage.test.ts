/**
 * EXP-21: per-entity temporal linkage retrieval boost.
 *
 * Covers:
 * - flag-off → no-op (returns input reference, no DB calls).
 * - 3 facts about Stripe at different timestamps → ordered chronologically.
 * - query without entities → no-op + empty matchedEntities.
 * - candidates without matching links → applied=false but flag still on.
 * - earliest mention across multiple matched entities wins the rank.
 * - boost weight=0 short-circuits.
 * - normalizeEntityId lowercases + collapses whitespace.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  applyEntityTemporalLinkageBoost,
  normalizeEntityId,
  type EntityTemporalLinkageConfig,
} from '../entity-temporal-linkage.js';
import { createSearchResult } from './test-fixtures.js';
import type { RepresentationStore } from '../../db/stores.js';
import type { EntityTemporalLinkRow } from '../../db/repository-entity-temporal-links.js';

const USER = 'user-1';

function buildConfig(overrides: Partial<EntityTemporalLinkageConfig> = {}): EntityTemporalLinkageConfig {
  return {
    perEntityTemporalLinkageEnabled: true,
    perEntityTemporalLinkageBoostWeight: 0.6,
    ...overrides,
  };
}

/**
 * Minimal RepresentationStore stub backed by a fixed link map. We only
 * exercise `listEntityTemporalLinks`; everything else throws to surface
 * accidental dependencies on the rest of the surface.
 */
function buildRepresentation(
  linksByEntity: Map<string, EntityTemporalLinkRow[]>,
): { store: RepresentationStore; calls: string[] } {
  const calls: string[] = [];
  const store: RepresentationStore = {
    storeAtomicFacts: async () => { throw new Error('not used'); },
    storeForesight: async () => { throw new Error('not used'); },
    listAtomicFactsForMemory: async () => { throw new Error('not used'); },
    listForesightForMemory: async () => { throw new Error('not used'); },
    replaceAtomicFactsForMemory: async () => { throw new Error('not used'); },
    replaceForesightForMemory: async () => { throw new Error('not used'); },
    storeEntityTemporalLinks: async () => { throw new Error('not used'); },
    listEntityTemporalLinks: vi.fn(async (_userId: string, entityId: string, _limit: number) => {
      calls.push(entityId);
      return linksByEntity.get(entityId) ?? [];
    }),
  };
  return { store, calls };
}

function row(id: string, ms: number): EntityTemporalLinkRow {
  return { fact_id: `f-${id}`, parent_memory_id: id, created_at: new Date(ms) };
}

describe('applyEntityTemporalLinkageBoost', () => {
  it('returns the input unchanged when the flag is off', async () => {
    const candidates = [
      createSearchResult({ id: 'a', score: 1.0 }),
      createSearchResult({ id: 'b', score: 0.5 }),
    ];
    const { store, calls } = buildRepresentation(new Map());

    const out = await applyEntityTemporalLinkageBoost({
      query: 'tell me about Stripe',
      candidates,
      userId: USER,
      representation: store,
      config: buildConfig({ perEntityTemporalLinkageEnabled: false }),
    });

    expect(out.applied).toBe(false);
    expect(out.results).toBe(candidates);
    expect(calls).toEqual([]);
  });

  it('orders three Stripe facts chronologically — earliest first', async () => {
    // Three facts about Stripe persisted at different times.
    const facts = [
      createSearchResult({ id: 'late',  score: 1.0, content: 'Stripe later' }),
      createSearchResult({ id: 'early', score: 1.0, content: 'Stripe earliest' }),
      createSearchResult({ id: 'mid',   score: 1.0, content: 'Stripe middle' }),
    ];
    // Linkage list: earliest -> mid -> late.
    const links = new Map<string, EntityTemporalLinkRow[]>([
      ['stripe', [row('early', 1_000), row('mid', 2_000), row('late', 3_000)]],
    ]);
    const { store } = buildRepresentation(links);

    const out = await applyEntityTemporalLinkageBoost({
      query: 'when did we first onboard Stripe',
      candidates: facts,
      userId: USER,
      representation: store,
      config: buildConfig(),
    });

    expect(out.applied).toBe(true);
    expect(out.matchedEntities).toEqual(['stripe']);
    // 'early' (rank 0/2 → factor 1.0) and 'mid' (rank 1/2 → factor 0.5)
    // both get a boost; 'late' (rank 2/2 → factor 0) keeps its base score.
    // The chronological order still wins because the boost makes 'early'
    // strictly higher than 'mid', and both higher than 'late'.
    expect(out.boostedCount).toBe(2);
    expect(out.results.map((r) => r.id)).toEqual(['early', 'mid', 'late']);
    const byId = new Map(out.results.map((r) => [r.id, r.score]));
    expect(byId.get('early')).toBeCloseTo(1.6, 5);
    expect(byId.get('mid')).toBeCloseTo(1.3, 5);
    expect(byId.get('late')).toBeCloseTo(1.0, 5);
  });

  it('is a no-op when the query mentions no entity', async () => {
    const candidates = [createSearchResult({ id: 'a', score: 0.7 })];
    const { store, calls } = buildRepresentation(new Map());

    const out = await applyEntityTemporalLinkageBoost({
      query: 'what was decided?',
      candidates,
      userId: USER,
      representation: store,
      config: buildConfig(),
    });

    expect(out.applied).toBe(false);
    expect(out.matchedEntities).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('applied=false when no candidate matches a link list entry', async () => {
    const candidates = [createSearchResult({ id: 'unrelated', score: 0.7 })];
    const links = new Map<string, EntityTemporalLinkRow[]>([
      ['stripe', [row('other', 1_000)]],
    ]);
    const { store } = buildRepresentation(links);

    const out = await applyEntityTemporalLinkageBoost({
      query: 'what about Stripe',
      candidates,
      userId: USER,
      representation: store,
      config: buildConfig(),
    });

    // Linkage exists but has no overlap with the candidate set, so we
    // produced no rank deltas — count is zero, applied=false.
    expect(out.boostedCount).toBe(0);
    expect(out.applied).toBe(false);
    expect(out.results).toEqual(candidates);
  });

  it('uses the strongest (smallest) rank when multiple entities link the same memory', async () => {
    const candidates = [
      createSearchResult({ id: 'shared', score: 1.0 }),
      createSearchResult({ id: 'only-stripe', score: 1.0 }),
    ];
    // 'shared' is rank 5 in Stripe's list but rank 0 in Acme's. We expect
    // rank 0 to win, giving 'shared' the full weight boost.
    const stripeLinks = Array.from({ length: 6 }, (_, i) => row(`s${i}`, i * 100));
    stripeLinks[5] = row('shared', 500);
    const acmeLinks = [row('shared', 50), row('only-stripe', 60)];

    const links = new Map<string, EntityTemporalLinkRow[]>([
      ['stripe', stripeLinks],
      ['acme', acmeLinks],
    ]);
    const { store } = buildRepresentation(links);

    const out = await applyEntityTemporalLinkageBoost({
      query: 'compare Stripe and Acme',
      candidates,
      userId: USER,
      representation: store,
      config: buildConfig({ perEntityTemporalLinkageBoostWeight: 1.0 }),
    });

    expect(out.applied).toBe(true);
    // 'shared' got rank 0 in Acme list (full weight=1.0) → score 2.0.
    // 'only-stripe' got rank 1 of 2 in Acme list (factor=0) → score 1.0.
    const byId = new Map(out.results.map((r) => [r.id, r.score]));
    expect(byId.get('shared')).toBeCloseTo(2.0, 5);
    expect(byId.get('only-stripe')).toBeCloseTo(1.0, 5);
  });

  it('respects a weight of 0 — short-circuits before the DB call', async () => {
    const candidates = [createSearchResult({ id: 'a', score: 1.0 })];
    const { store, calls } = buildRepresentation(
      new Map([['stripe', [row('a', 1_000)]]]),
    );

    const out = await applyEntityTemporalLinkageBoost({
      query: 'about Stripe',
      candidates,
      userId: USER,
      representation: store,
      config: buildConfig({ perEntityTemporalLinkageBoostWeight: 0 }),
    });

    expect(out.applied).toBe(false);
    expect(out.results).toBe(candidates);
    expect(calls).toEqual([]);
  });

  it('handles empty candidates without touching the store', async () => {
    const { store, calls } = buildRepresentation(new Map());

    const out = await applyEntityTemporalLinkageBoost({
      query: 'about Stripe',
      candidates: [],
      userId: USER,
      representation: store,
      config: buildConfig(),
    });

    expect(out.applied).toBe(false);
    expect(out.results).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe('normalizeEntityId', () => {
  it('lowercases the input', () => {
    expect(normalizeEntityId('Stripe')).toBe('stripe');
    expect(normalizeEntityId('ACME')).toBe('acme');
  });

  it('collapses interior whitespace', () => {
    expect(normalizeEntityId('  New   York  ')).toBe('new york');
  });

  it('preserves single spaces between words', () => {
    expect(normalizeEntityId('Acme Corp')).toBe('acme corp');
  });
});
