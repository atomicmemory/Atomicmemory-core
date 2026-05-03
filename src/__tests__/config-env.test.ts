/**
 * Regression tests for env-backed runtime configuration.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const originalSimilarityThreshold = process.env.SIMILARITY_THRESHOLD;

afterEach(() => {
  if (originalSimilarityThreshold === undefined) {
    delete process.env.SIMILARITY_THRESHOLD;
  } else {
    process.env.SIMILARITY_THRESHOLD = originalSimilarityThreshold;
  }
  vi.resetModules();
});

describe('config env loading', () => {
  it('loads SIMILARITY_THRESHOLD from the environment', async () => {
    process.env.SIMILARITY_THRESHOLD = '0.42';
    vi.resetModules();

    const { config } = await import('../config.js');

    expect(config.similarityThreshold).toBe(0.42);
  });

  it('rejects SIMILARITY_THRESHOLD outside the normalized range', async () => {
    process.env.SIMILARITY_THRESHOLD = '1.5';
    vi.resetModules();

    await expect(import('../config.js')).rejects.toThrow('SIMILARITY_THRESHOLD must be a finite number between 0 and 1');
  });
});
