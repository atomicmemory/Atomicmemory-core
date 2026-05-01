/**
 * Runtime config seam tests for consensus extraction.
 *
 * Verifies per-request chunking controls are threaded into chunked extraction
 * instead of being read from the module-level config singleton.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCachedExtractFacts,
  mockChunkedExtractFacts,
  mockExtractFacts,
} = vi.hoisted(() => ({
  mockCachedExtractFacts: vi.fn(),
  mockChunkedExtractFacts: vi.fn(),
  mockExtractFacts: vi.fn(),
}));

vi.mock('../extraction-cache.js', () => ({
  cachedExtractFacts: mockCachedExtractFacts,
}));
vi.mock('../chunked-extraction.js', () => ({
  chunkedExtractFacts: mockChunkedExtractFacts,
}));
vi.mock('../extraction.js', () => ({
  extractFacts: mockExtractFacts,
}));
vi.mock('../memory-network.js', () => ({
  classifyNetwork: vi.fn((facts) => facts),
}));
vi.mock('../quoted-entity-extraction.js', () => ({
  mergeQuotedEntityFacts: vi.fn((facts) => facts),
}));

const { consensusExtractFacts } = await import('../consensus-extraction.js');

describe('consensusExtractFacts runtime config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes per-request chunking config into chunked extraction', async () => {
    mockChunkedExtractFacts.mockResolvedValue([]);

    await consensusExtractFacts('User: I commute 45 minutes.', {
      chunkedExtractionEnabled: true,
      chunkedExtractionFallbackEnabled: false,
      chunkSizeTurns: 8,
      chunkOverlapTurns: 2,
      consensusExtractionEnabled: false,
      consensusExtractionRuns: 1,
      extractionCacheEnabled: false,
      observationDateExtractionEnabled: true,
      locomoTunedExtractionEnabled: false,
      quotedEntityExtractionEnabled: false,
    });

    expect(mockChunkedExtractFacts).toHaveBeenCalledWith(
      'User: I commute 45 minutes.',
      { observationDateExtractionEnabled: true, locomoTunedExtractionEnabled: false },
      { chunkSizeTurns: 8, chunkOverlapTurns: 2, extractionCacheEnabled: false },
    );
    expect(mockCachedExtractFacts).not.toHaveBeenCalled();
  });

  it('falls back to chunked extraction for long zero-fact inputs', async () => {
    mockCachedExtractFacts.mockResolvedValue([]);
    mockChunkedExtractFacts.mockResolvedValue([]);
    const longConversation = [
      'User: one',
      'Assistant: two',
      'User: three',
    ].join('\n');

    await consensusExtractFacts(longConversation, {
      chunkedExtractionEnabled: false,
      chunkedExtractionFallbackEnabled: true,
      chunkSizeTurns: 2,
      chunkOverlapTurns: 1,
      consensusExtractionEnabled: false,
      consensusExtractionRuns: 1,
      extractionCacheEnabled: true,
      observationDateExtractionEnabled: false,
      locomoTunedExtractionEnabled: false,
      quotedEntityExtractionEnabled: false,
    });

    expect(mockCachedExtractFacts).toHaveBeenCalledWith(longConversation, {
      observationDateExtractionEnabled: false,
      locomoTunedExtractionEnabled: false,
    });
    expect(mockChunkedExtractFacts).toHaveBeenCalledWith(
      longConversation,
      { observationDateExtractionEnabled: false, locomoTunedExtractionEnabled: false },
      { chunkSizeTurns: 2, chunkOverlapTurns: 1, extractionCacheEnabled: true },
    );
  });

  it('does not fall back to chunked extraction when normal extraction finds facts', async () => {
    mockCachedExtractFacts.mockResolvedValue([{ fact: 'User prefers Rust' }]);
    mockChunkedExtractFacts.mockResolvedValue([]);

    await consensusExtractFacts('User: one\nAssistant: two\nUser: three', {
      chunkedExtractionEnabled: false,
      chunkedExtractionFallbackEnabled: true,
      chunkSizeTurns: 2,
      chunkOverlapTurns: 1,
      consensusExtractionEnabled: false,
      consensusExtractionRuns: 1,
      extractionCacheEnabled: true,
      observationDateExtractionEnabled: false,
      locomoTunedExtractionEnabled: false,
      quotedEntityExtractionEnabled: false,
    });

    expect(mockChunkedExtractFacts).not.toHaveBeenCalled();
  });

  it('routes around the cache when runtime extractionCacheEnabled is false', async () => {
    mockExtractFacts.mockResolvedValue([{ fact: 'User prefers Rust' }]);
    mockCachedExtractFacts.mockResolvedValue([{ fact: 'cached but should not be called' }]);

    await consensusExtractFacts('User: I prefer Rust', {
      chunkedExtractionEnabled: false,
      chunkedExtractionFallbackEnabled: false,
      chunkSizeTurns: 8,
      chunkOverlapTurns: 2,
      consensusExtractionEnabled: false,
      consensusExtractionRuns: 1,
      extractionCacheEnabled: false,
      observationDateExtractionEnabled: false,
      locomoTunedExtractionEnabled: false,
      quotedEntityExtractionEnabled: false,
    });

    expect(mockExtractFacts).toHaveBeenCalledWith('User: I prefer Rust', {
      observationDateExtractionEnabled: false,
      locomoTunedExtractionEnabled: false,
    });
    expect(mockCachedExtractFacts).not.toHaveBeenCalled();
  });

  it('threads locomoTunedExtractionEnabled into extractFacts options', async () => {
    mockExtractFacts.mockResolvedValue([]);

    await consensusExtractFacts('User: tasty desserts', {
      chunkedExtractionEnabled: false,
      chunkedExtractionFallbackEnabled: false,
      chunkSizeTurns: 8,
      chunkOverlapTurns: 2,
      consensusExtractionEnabled: false,
      consensusExtractionRuns: 1,
      extractionCacheEnabled: false,
      observationDateExtractionEnabled: false,
      locomoTunedExtractionEnabled: true,
      quotedEntityExtractionEnabled: false,
    });

    expect(mockExtractFacts).toHaveBeenCalledWith('User: tasty desserts', {
      observationDateExtractionEnabled: false,
      locomoTunedExtractionEnabled: true,
    });
  });

  it('threads locomoTunedExtractionEnabled=false into chunkedExtractFacts options', async () => {
    mockChunkedExtractFacts.mockResolvedValue([]);

    await consensusExtractFacts('User: a long conversation', {
      chunkedExtractionEnabled: true,
      chunkedExtractionFallbackEnabled: false,
      chunkSizeTurns: 8,
      chunkOverlapTurns: 2,
      consensusExtractionEnabled: false,
      consensusExtractionRuns: 1,
      extractionCacheEnabled: false,
      observationDateExtractionEnabled: false,
      locomoTunedExtractionEnabled: false,
      quotedEntityExtractionEnabled: false,
    });

    expect(mockChunkedExtractFacts).toHaveBeenCalledWith(
      'User: a long conversation',
      { observationDateExtractionEnabled: false, locomoTunedExtractionEnabled: false },
      expect.any(Object),
    );
  });

  it('threads locomoTunedExtractionEnabled=true into cachedExtractFacts options', async () => {
    mockCachedExtractFacts.mockResolvedValue([]);

    await consensusExtractFacts('User: tasty desserts cached', {
      chunkedExtractionEnabled: false,
      chunkedExtractionFallbackEnabled: false,
      chunkSizeTurns: 8,
      chunkOverlapTurns: 2,
      consensusExtractionEnabled: false,
      consensusExtractionRuns: 1,
      extractionCacheEnabled: true,
      observationDateExtractionEnabled: false,
      locomoTunedExtractionEnabled: true,
      quotedEntityExtractionEnabled: false,
    });

    expect(mockCachedExtractFacts).toHaveBeenCalledWith('User: tasty desserts cached', {
      observationDateExtractionEnabled: false,
      locomoTunedExtractionEnabled: true,
    });
    expect(mockExtractFacts).not.toHaveBeenCalled();
  });
});
