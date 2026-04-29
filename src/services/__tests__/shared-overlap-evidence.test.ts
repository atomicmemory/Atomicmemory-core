/**
 * Unit tests for query-aware shared-overlap evidence blocks.
 */

import { describe, expect, it } from 'vitest';
import { createSearchResult } from './test-fixtures.js';
import { buildSharedOverlapEvidenceBlock } from '../shared-overlap-evidence.js';

function makeMemory(id: string, content: string) {
  return createSearchResult({
    id,
    content,
    created_at: new Date('2023-08-25T00:00:00.000Z'),
  });
}

describe('buildSharedOverlapEvidenceBlock', () => {
  it('emits shared painted-subject evidence when two speakers have sunset-painting facts', () => {
    const block = buildSharedOverlapEvidenceBlock([
      makeMemory('caroline', 'As of August 25, 2023, Caroline painted the subject of sunsets.'),
      makeMemory('melanie', 'As of May 8, 2023, Melanie shared image evidence with caption "a photo of a painting of a sunset over a lake".'),
    ], 'What subject have Caroline and Melanie both painted?');

    expect(block).toContain('Shared painted-subject evidence:');
    expect(block).toContain('shared painted subject: sunsets');
    expect(block).toContain('Caroline:');
    expect(block).toContain('Melanie:');
  });

  it('emits shared visited-city evidence when two speakers have Rome evidence', () => {
    const block = buildSharedOverlapEvidenceBlock([
      makeMemory('gina', 'Gina has visited Rome once but has never been to Paris.'),
      makeMemory('jon', 'In mid-June 2023, Jon took a short trip to Rome to clear his mind.'),
    ], 'Which city have both Jean and John visited?');

    expect(block).toContain('Shared visited-city evidence:');
    expect(block).toContain('shared visited city: Rome');
    expect(block).toContain('Gina:');
    expect(block).toContain('Jon:');
  });

  it('emits explicit shared activity evidence without promoting adjacent concerts', () => {
    const block = buildSharedOverlapEvidenceBlock([
      makeMemory('cars', 'Calvin and Dave share the activity of working on cars. Their shared car-work evidence involves restoration.'),
      makeMemory('concerts', 'Dave likes concerts, and Calvin performs music for crowds.'),
    ], 'What shared activities do Dave and Calvin have?');

    expect(block).toContain('Shared activity evidence:');
    expect(block).toContain('explicit shared activity: working on cars');
    expect(block).not.toContain('concert');
  });

  it('does not emit overlap evidence when only one speaker supports a candidate', () => {
    const block = buildSharedOverlapEvidenceBlock([
      makeMemory('caroline', 'Caroline painted the subject of sunsets.'),
      makeMemory('melanie', 'Melanie painted a horse.'),
    ], 'What subject have Caroline and Melanie both painted?');

    expect(block).toBe('');
  });
});
