/**
 * Core runtime container — the explicit composition root for Atomicmemory-core.
 *
 * Owns the construction of config, pool, repositories, and services so
 * startup (`server.ts`), tests, and in-process research harnesses all boot
 * through the same seam. Replaces the hidden singleton wiring that used to
 * live inline in `server.ts`.
 *
 * Phase 1A of the rearchitecture — the composition root that replaces
 * per-startup hand-wiring of repos and services in `server.ts`.
 */

import pg from 'pg';
import { config, updateRuntimeConfig, type CrossEncoderDtype } from '../config.js';
import { AgentTrustRepository } from '../db/agent-trust-repository.js';
import { ClaimRepository } from '../db/claim-repository.js';
import { LinkRepository } from '../db/link-repository.js';
import { MemoryRepository } from '../db/memory-repository.js';
import { EntityRepository } from '../db/repository-entities.js';
import { LessonRepository } from '../db/repository-lessons.js';
import type { CoreStores } from '../db/stores.js';
import { PgMemoryStore } from '../db/pg-memory-store.js';
import { PgEpisodeStore } from '../db/pg-episode-store.js';
import { PgSearchStore } from '../db/pg-search-store.js';
import { PgSemanticLinkStore } from '../db/pg-link-store.js';
import { PgRepresentationStore } from '../db/pg-representation-store.js';
import type { RetrievalProfile } from '../services/retrieval-profiles.js';
import { MemoryService } from '../services/memory-service.js';
import { initEmbedding } from '../services/embedding.js';
import { initLlm } from '../services/llm.js';
import {
  readRuntimeConfigRouteSnapshot,
  type RuntimeConfigRouteSnapshot,
} from './runtime-config-route-snapshot.js';

/**
 * Explicit runtime configuration subset currently needed by the runtime
 * container, startup checks, search/runtime seams, and MemoryService deps.
 *
 * This is intentionally narrower than the module-level config singleton:
 * it describes the config surface already threaded through those seams
 * today, without claiming full runtime-wide configurability yet.
 *
 * NOTE (phase 1b status): `runtime.config` still references the
 * module-level singleton object. MemoryService accepts an optional
 * `runtimeConfig` override (stored as deps.config), and the search-
 * pipeline orchestration and ingest orchestration files (memory-ingest,
 * memory-storage, memory-audn, memory-lineage) read the fields listed
 * in `CoreRuntimeConfig` and `IngestRuntimeConfig` through deps.config
 * rather than the singleton. The route layer reads through an injectable
 * adapter seam (`configRouteAdapter`), but the default adapter
 * implementation still reads the module singleton directly — it is not
 * a genuinely independent config path.
 *
 * Critically, the threaded orchestration files still call leaf modules
 * that read the singleton: embedding.ts (provider/model selection),
 * llm.ts, consensus-extraction.ts, write-security.ts, etc. Two
 * runtimes with different configs would diverge only on the fields
 * explicitly in `CoreRuntimeConfig` / `IngestRuntimeConfig`; any field
 * read by a leaf module (embedding provider, LLM model, extraction
 * settings) would silently share the singleton value.
 *
 * Remaining singleton importers: 33 non-test source files (tracked by
 * config-singleton-audit.test.ts). This includes infrastructure, CRUD/
 * lifecycle, leaf helpers, the DB repository layer, and index.ts.
 */
export interface CoreRuntimeConfig {
  adaptiveRetrievalEnabled: boolean;
  adaptiveSimpleLimit: number;
  adaptiveMediumLimit: number;
  adaptiveComplexLimit: number;
  adaptiveMultiHopLimit: number;
  adaptiveAggregationLimit: number;
  agenticRetrievalEnabled: boolean;
  auditLoggingEnabled: boolean;
  consensusMinMemories: number;
  consensusValidationEnabled: boolean;
  crossEncoderDtype: CrossEncoderDtype;
  crossEncoderEnabled: boolean;
  crossEncoderModel: string;
  embeddingDimensions: number;
  entityGraphEnabled: boolean;
  entitySearchMinSimilarity: number;
  hybridSearchEnabled: boolean;
  iterativeRetrievalEnabled: boolean;
  lessonsEnabled: boolean;
  linkExpansionBeforeMMR: boolean;
  linkExpansionEnabled: boolean;
  linkExpansionMax: number;
  linkSimilarityThreshold: number;
  literalListProtectionEnabled: boolean;
  literalListProtectionMaxProtected: number;
  maxSearchResults: number;
  mmrEnabled: boolean;
  mmrLambda: number;
  namespaceClassificationEnabled: boolean;
  pprDamping: number;
  pprEnabled: boolean;
  port: number;
  queryAugmentationEnabled: boolean;
  queryAugmentationMaxEntities: number;
  queryAugmentationMinSimilarity: number;
  queryExpansionEnabled: boolean;
  queryExpansionMinSimilarity: number;
  repairConfidenceFloor: number;
  repairDeltaThreshold: number;
  repairLoopEnabled: boolean;
  repairLoopMinSimilarity: number;
  rerankSkipMinGap: number;
  rerankSkipTopSimilarity: number;
  retrievalProfileSettings: RetrievalProfile;
  temporalQueryConstraintBoost: number;
  temporalQueryConstraintEnabled: boolean;
}

/** Repositories constructed by the runtime container. */
export interface CoreRuntimeRepos {
  memory: MemoryRepository;
  claims: ClaimRepository;
  trust: AgentTrustRepository;
  links: LinkRepository;
  entities: EntityRepository | null;
  lessons: LessonRepository | null;
}

/** Services constructed on top of repositories. */
export interface CoreRuntimeServices {
  memory: MemoryService;
}

export interface CoreRuntimeConfigRouteAdapter {
  current: () => RuntimeConfigRouteSnapshot;
  update: (updates: {
    similarityThreshold?: number;
    audnCandidateThreshold?: number;
    clarificationConflictThreshold?: number;
    maxSearchResults?: number;
  }) => string[];
}

/**
 * Explicit dependency bundle accepted by `createCoreRuntime`.
 *
 * `pool` is required — the composition root never reaches around to
 * import the singleton `pg.Pool` itself.
 *
 * A `config` override is deliberately NOT accepted here. The container
 * now owns several explicit config seams, but many downstream services
 * and repositories still read the module singleton directly. Accepting
 * an override here would therefore apply only partially and misstate the
 * current architecture.
 */
export interface CoreRuntimeDeps {
  pool: pg.Pool;
}

/** The composed runtime — single source of truth for route registration. */
export interface CoreRuntime {
  config: CoreRuntimeConfig;
  configRouteAdapter: CoreRuntimeConfigRouteAdapter;
  pool: pg.Pool;
  repos: CoreRuntimeRepos;
  /** Domain-facing store interfaces (Phase 5). Will replace repos once migration is complete. */
  stores: CoreStores;
  services: CoreRuntimeServices;
}

/**
 * Compose the core runtime. Instantiates repositories and the memory
 * service from an explicit pool. Reads the module-level config singleton
 * for repo-construction flags and passes that same singleton explicitly
 * into MemoryService so the composition root owns the config seam.
 * No mutation.
 */
export function createCoreRuntime(deps: CoreRuntimeDeps): CoreRuntime {
  const { pool } = deps;

  // Leaf-module config init (Phase 7 Step 3d). Embedding and LLM modules
  // hold module-local config bound here at composition-root time.
  // Provider/model selection is startup-only (Step 3c), so rebinding
  // only happens via explicit init call (e.g., from tests that swap
  // providers).
  initEmbedding(config);
  initLlm(config);

  const memory = new MemoryRepository(pool);
  const claims = new ClaimRepository(pool);
  const trust = new AgentTrustRepository(pool);
  const links = new LinkRepository(pool);
  const entities = config.entityGraphEnabled ? new EntityRepository(pool) : null;
  const lessons = config.lessonsEnabled ? new LessonRepository(pool) : null;

  const stores: CoreStores = {
    memory: new PgMemoryStore(pool),
    episode: new PgEpisodeStore(pool),
    search: new PgSearchStore(pool),
    link: new PgSemanticLinkStore(pool),
    representation: new PgRepresentationStore(pool),
    claim: claims,
    entity: entities,
    lesson: lessons,
    pool,
  };

  const service = new MemoryService(
    memory,
    claims,
    entities ?? undefined,
    lessons ?? undefined,
    undefined,
    config,
    stores,
  );

  return {
    config,
    configRouteAdapter: {
      current() {
        return readRuntimeConfigRouteSnapshot(config);
      },
      update(updates) {
        return updateRuntimeConfig(updates);
      },
    },
    pool,
    repos: { memory, claims, trust, links, entities, lessons },
    stores,
    services: { memory: service },
  };
}
