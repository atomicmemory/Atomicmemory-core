/**
 * Route-level validation tests for memory API endpoints.
 * Tests UUID validation on param/query inputs and filter behavior
 * on the list endpoint. Requires DATABASE_URL in .env.test.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Mock embedText to avoid hitting the real embedding provider in CI where
// OPENAI_API_KEY is a placeholder. Returns a deterministic zero vector
// matching the configured embedding dimensions.
vi.mock('../services/embedding.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/embedding.js')>();
  return {
    ...actual,
    embedText: vi.fn(async () => {
      const { config: cfg } = await import('../config.js');
      return new Array(cfg.embeddingDimensions).fill(0);
    }),
  };
});

import { pool } from '../db/pool.js';
import { MemoryRepository } from '../db/memory-repository.js';
import { ClaimRepository } from '../db/claim-repository.js';
import { MemoryService } from '../services/memory-service.js';
import { createMemoryRouter } from '../routes/memories.js';
import { setupTestSchema } from '../db/__tests__/test-fixtures.js';
import express from 'express';

const TEST_USER = 'route-validation-test-user';
const VALID_UUID = '00000000-0000-0000-0000-000000000001';
const INVALID_UUID = 'not-a-uuid';

let server: ReturnType<typeof app.listen>;
let baseUrl: string;
const app = express();
app.use(express.json());

beforeAll(async () => {
  await setupTestSchema(pool);

  const repo = new MemoryRepository(pool);
  const claimRepo = new ClaimRepository(pool);
  const service = new MemoryService(repo, claimRepo);
  app.use('/memories', createMemoryRouter(service));

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      baseUrl = `http://localhost:${port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

describe('GET /memories/:id — UUID validation', () => {
  it('returns 400 for an invalid UUID', async () => {
    const res = await fetch(`${baseUrl}/memories/${INVALID_UUID}?user_id=${TEST_USER}`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/valid UUID/);
  });

  it('returns 404 for a valid but non-existent UUID', async () => {
    const res = await fetch(`${baseUrl}/memories/${VALID_UUID}?user_id=${TEST_USER}`);
    expect(res.status).toBe(404);
  });
});

describe('DELETE /memories/:id — UUID validation', () => {
  it('returns 400 for an invalid UUID', async () => {
    const res = await fetch(`${baseUrl}/memories/${INVALID_UUID}?user_id=${TEST_USER}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/valid UUID/);
  });
});

describe('POST /memories/ingest/quick — skip_extraction (storeVerbatim)', () => {
  it('stores a single memory without extraction when skip_extraction is true', async () => {
    const res = await fetch(`${baseUrl}/memories/ingest/quick`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: TEST_USER,
        conversation: 'Verbatim content that should not be extracted into facts.',
        source_site: 'verbatim-test',
        source_url: 'https://example.com/verbatim',
        skip_extraction: true,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.memories_stored).toBe(1);
    expect(body.stored_memory_ids).toHaveLength(1);
    expect(body.updated_memory_ids).toHaveLength(0);
  });
});

describe('GET /memories/list — source_site filter', () => {
  it('returns memories filtered by source_site', async () => {
    const res = await fetch(
      `${baseUrl}/memories/list?user_id=${TEST_USER}&source_site=test-site`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('memories');
    expect(body).toHaveProperty('count');
  });
});

describe('POST /memories/search — scope and observability contract', () => {
  it('returns canonical user scope and only includes observability sections that the retrieval path actually emitted', async () => {
    const res = await fetch(`${baseUrl}/memories/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: TEST_USER,
        query: 'verbatim',
        source_site: 'verbatim-test',
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scope).toEqual({ kind: 'user', user_id: TEST_USER });
    expect(body.observability?.retrieval).toBeUndefined();
    expect(body.observability?.packaging?.package_type).toBe('subject-pack');
    expect(body.observability?.assembly?.blocks).toEqual(['subject']);
  });

  it('returns canonical workspace scope for workspace searches', async () => {
    const workspaceId = '00000000-0000-0000-0000-000000000111';
    const agentId = '00000000-0000-0000-0000-000000000222';
    const res = await fetch(`${baseUrl}/memories/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: TEST_USER,
        query: 'verbatim',
        workspace_id: workspaceId,
        agent_id: agentId,
        source_site: 'verbatim-test',
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scope).toEqual({
      kind: 'workspace',
      user_id: TEST_USER,
      workspace_id: workspaceId,
      agent_id: agentId,
    });
  });
});

describe('GET /memories/list — episode_id filter', () => {
  it('returns 400 for an invalid episode_id', async () => {
    const res = await fetch(
      `${baseUrl}/memories/list?user_id=${TEST_USER}&episode_id=${INVALID_UUID}`,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/valid UUID/);
  });

  it('accepts a valid episode_id UUID', async () => {
    const res = await fetch(
      `${baseUrl}/memories/list?user_id=${TEST_USER}&episode_id=${VALID_UUID}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('memories');
  });
});

describe('agent_id validation on workspace query routes', () => {
  it('returns 400 for an invalid agent_id on GET /list', async () => {
    const res = await fetch(
      `${baseUrl}/memories/list?user_id=${TEST_USER}&workspace_id=${VALID_UUID}&agent_id=${INVALID_UUID}`,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/valid UUID/);
  });

  it('returns 400 for an invalid agent_id on GET /:id', async () => {
    const res = await fetch(
      `${baseUrl}/memories/${VALID_UUID}?user_id=${TEST_USER}&workspace_id=${VALID_UUID}&agent_id=${INVALID_UUID}`,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/valid UUID/);
  });

  it('returns 400 for an invalid agent_id on DELETE /:id', async () => {
    const res = await fetch(
      `${baseUrl}/memories/${VALID_UUID}?user_id=${TEST_USER}&workspace_id=${VALID_UUID}&agent_id=${INVALID_UUID}`,
      { method: 'DELETE' },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/valid UUID/);
  });

  it('returns 404 (not 500) for workspace DELETE when memory is not visible', async () => {
    const nonExistentMemory = '00000000-0000-0000-0000-000000000999';
    const res = await fetch(
      `${baseUrl}/memories/${nonExistentMemory}?user_id=${TEST_USER}&workspace_id=${VALID_UUID}&agent_id=${VALID_UUID}`,
      { method: 'DELETE' },
    );
    expect(res.status).toBe(404);
  });
});

describe('workspace queries require agent_id', () => {
  it('returns 400 on GET /list when workspace_id is present without agent_id', async () => {
    const res = await fetch(
      `${baseUrl}/memories/list?user_id=${TEST_USER}&workspace_id=${VALID_UUID}`,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/agent_id is required/);
  });

  it('returns 400 on GET /:id when workspace_id is present without agent_id', async () => {
    const res = await fetch(
      `${baseUrl}/memories/${VALID_UUID}?user_id=${TEST_USER}&workspace_id=${VALID_UUID}`,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/agent_id is required/);
  });

  it('returns 400 on DELETE /:id when workspace_id is present without agent_id', async () => {
    const res = await fetch(
      `${baseUrl}/memories/${VALID_UUID}?user_id=${TEST_USER}&workspace_id=${VALID_UUID}`,
      { method: 'DELETE' },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/agent_id is required/);
  });
});
