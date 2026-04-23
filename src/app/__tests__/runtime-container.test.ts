/**
 * Phase 1A composition tests.
 *
 * Verifies the runtime container boots cleanly with explicit deps, and
 * that startup checks return a structured result instead of exiting the
 * process. These tests don't depend on a live database — they exercise
 * the composition seam itself.
 */

import { describe, it, expect, vi } from 'vitest';
import pg from 'pg';
import { createCoreRuntime } from '../runtime-container.js';
import { checkEmbeddingDimensions } from '../startup-checks.js';
import { createApp } from '../create-app.js';
import { config } from '../../config.js';

function stubPool(rows: Array<{ typmod: number }> = []): pg.Pool {
  return { query: vi.fn(async () => ({ rows })) } as unknown as pg.Pool;
}

/**
 * Temporarily mutate a config flag, run a function, and restore.
 * Used to exercise repo-construction branches without accepting a config
 * override on createCoreRuntime (which would be dishonest — most code
 * reads config from the module singleton directly).
 */
function withConfigFlag<K extends 'entityGraphEnabled' | 'lessonsEnabled'>(
  key: K,
  value: typeof config[K],
  run: () => void,
): void {
  const previous = config[key];
  (config as unknown as Record<string, unknown>)[key] = value;
  try {
    run();
  } finally {
    (config as unknown as Record<string, unknown>)[key] = previous;
  }
}

describe('createCoreRuntime', () => {
  it('composes a runtime with explicit pool dep', () => {
    const pool = stubPool();
    const runtime = createCoreRuntime({ pool });
    expect(runtime.pool).toBe(pool);
    expect(runtime.config).toBe(config);
    expect(runtime.repos.memory).toBeDefined();
    expect(runtime.repos.claims).toBeDefined();
    expect(runtime.repos.trust).toBeDefined();
    expect(runtime.repos.links).toBeDefined();
    expect(runtime.services.memory).toBeDefined();
  });

  it('constructs domain-facing stores alongside repos', () => {
    const pool = stubPool();
    const runtime = createCoreRuntime({ pool });
    expect(runtime.stores.memory).toBeDefined();
    expect(runtime.stores.episode).toBeDefined();
    expect(runtime.stores.search).toBeDefined();
    expect(runtime.stores.link).toBeDefined();
    expect(runtime.stores.representation).toBeDefined();
    expect(runtime.stores.claim).toBeDefined();
  });

  it('store entity/lesson track config flags', () => {
    const pool = stubPool();
    withConfigFlag('entityGraphEnabled', false, () => {
      expect(createCoreRuntime({ pool }).stores.entity).toBeNull();
    });
    withConfigFlag('entityGraphEnabled', true, () => {
      expect(createCoreRuntime({ pool }).stores.entity).not.toBeNull();
    });
    withConfigFlag('lessonsEnabled', false, () => {
      expect(createCoreRuntime({ pool }).stores.lesson).toBeNull();
    });
    withConfigFlag('lessonsEnabled', true, () => {
      expect(createCoreRuntime({ pool }).stores.lesson).not.toBeNull();
    });
  });

  it('runtime.config references the module-level config singleton', () => {
    // Phase 1A.5 truthfulness: the container does not accept a config
    // override because routes/services still read the singleton.
    const pool = stubPool();
    const runtime = createCoreRuntime({ pool });
    expect(runtime.config).toBe(config);
  });

  it('entity repo tracks config.entityGraphEnabled', () => {
    const pool = stubPool();
    withConfigFlag('entityGraphEnabled', false, () => {
      expect(createCoreRuntime({ pool }).repos.entities).toBeNull();
    });
    withConfigFlag('entityGraphEnabled', true, () => {
      expect(createCoreRuntime({ pool }).repos.entities).not.toBeNull();
    });
  });

  it('lesson repo tracks config.lessonsEnabled', () => {
    const pool = stubPool();
    withConfigFlag('lessonsEnabled', false, () => {
      expect(createCoreRuntime({ pool }).repos.lessons).toBeNull();
    });
    withConfigFlag('lessonsEnabled', true, () => {
      expect(createCoreRuntime({ pool }).repos.lessons).not.toBeNull();
    });
  });
});

describe('checkEmbeddingDimensions', () => {
  it('returns ok=false when memories.embedding column is missing', async () => {
    const pool = stubPool([]);
    const result = await checkEmbeddingDimensions(pool, config);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('run npm run migrate');
  });

  it('returns ok=false when DB dims differ from config', async () => {
    const pool = stubPool([{ typmod: 1024 }]);
    const cfg = { ...config, embeddingDimensions: 1536 };
    const result = await checkEmbeddingDimensions(pool, cfg);
    expect(result.ok).toBe(false);
    expect(result.dbDims).toBe(1024);
    expect(result.configDims).toBe(1536);
    expect(result.message).toContain('1024 dimensions');
    expect(result.message).toContain('EMBEDDING_DIMENSIONS=1536');
  });

  it('returns ok=true when DB dims match config', async () => {
    const pool = stubPool([{ typmod: 1024 }]);
    const cfg = { ...config, embeddingDimensions: 1024 };
    const result = await checkEmbeddingDimensions(pool, cfg);
    expect(result.ok).toBe(true);
    expect(result.dbDims).toBe(1024);
  });

  it('returns ok=true when DB typmod is unset (0 or negative)', async () => {
    const pool = stubPool([{ typmod: -1 }]);
    const result = await checkEmbeddingDimensions(pool, config);
    expect(result.ok).toBe(true);
    expect(result.dbDims).toBeNull();
  });
});

describe('createApp', () => {
  it('returns an Express app wired from a runtime container', () => {
    const pool = stubPool();
    const runtime = createCoreRuntime({ pool });
    const app = createApp(runtime);
    expect(typeof app.use).toBe('function');
    expect(typeof app.listen).toBe('function');
  });
});
