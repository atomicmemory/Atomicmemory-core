# Prototype Architecture Overview

Three-layer architecture (REST API → Service → Repository) with contradiction-safe
versioning and complementary retrieval signals.

## Layers

```
┌──────────────────────────────────────────────────────────────┐
│  REST API  (routes/memories.ts)                              │
│  POST /ingest  POST /search  POST /consolidate               │
│  GET /list  GET /stats  PUT /config  DELETE /:id             │
├──────────────────────────────────────────────────────────────┤
│  Service Layer  (services/)                                  │
│  MemoryService: ingest + search + consolidation orchestrator │
│  SearchPipeline: retrieval → repair → expansion → reranking  │
│  Extraction: LLM fact extraction + AUDN resolution           │
│  ConflictPolicy: guardrails + candidate merging              │
│  RetrievalPolicy: repair loop + adaptive limits              │
│  EntropyGate: write-time novelty filtering                   │
│  AffinityClustering: batch merge candidate identification    │
│  TieredLoading: L0/L1/L2 token budget allocation             │
│  NamespaceRetrieval: hierarchical scope inference + filtering │
│  RetrievalTrace: per-stage pipeline observability             │
├──────────────────────────────────────────────────────────────┤
│  Repository Layer  (db/)                            │
│  MemoryRepository: read/write/links facade          │
│  ClaimRepository: versioned fact tracking            │
│  VectorSearch: pgvector HNSW + hybrid FTS           │
│  MMR / PPR: reranking + graph propagation           │
├─────────────────────────────────────────────────────┤
│  PostgreSQL + pgvector                              │
│  memories, episodes, memory_claims,                 │
│  memory_claim_versions, memory_evidence,            │
│  memory_links                                       │
└─────────────────────────────────────────────────────┘
```

## Data Flow: Ingest

```
Conversation text
  │
  ▼
extractFacts() ─── LLM extracts discrete, atomic facts
  │                 with importance (0-1.0) and keywords
  ▼
normalizeExtractedFacts() ─── splits compound facts
  │                            (recommendations, because-clauses)
  ▼
For each fact:
  │
  ├─ embed() ─── generate embedding vector
  │
  ├─ Entropy Gate (if ENTROPY_GATE_ENABLED)
  │    score = α·entityNovelty + (1-α)·semanticNovelty
  │    skip fact if score < threshold (default 0.35)
  │    entities and embeddings accumulate across the batch
  │
  ├─ findNearDuplicates() ─── vector similarity candidates (≥0.7)
  ├─ findKeywordCandidates() ─── FTS keyword candidates
  ├─ mergeCandidates() ─── deduplicate, sort by similarity
  │
  ├─ resolveAUDN() ─── LLM decides: ADD/UPDATE/SUPERSEDE/DELETE/NOOP/CLARIFY
  ├─ applyClarificationOverrides() ─── guardrail post-processing
  │
  └─ executeDecision()
       ├─ ADD ──────── storeMemory() + createClaim() + addEvidence()
       ├─ UPDATE ───── updateMemoryContent() + updateClaimVersion()
       ├─ SUPERSEDE ── softDelete(old) + storeMemory(new) + supersedeClaimVersion()
       ├─ DELETE ───── softDeleteMemory()
       ├─ NOOP ─────── addEvidence() to existing claim
       └─ CLARIFY ──── storeMemory(status='needs_clarification')
  │
  ▼
inferNamespace() ─── assign namespace from content/source/keywords
  │
  ▼
generateL1Overview() ─── create condensed overview for L1 tier
  │
  ▼
createLinks() ─── 1-hop semantic links for newly stored memories
  │
  ▼
IngestResult { factsExtracted, memoriesStored, memoriesUpdated, ... }
```

## Data Flow: Search

```
Query text
  │
  ▼
embed(query)
  │
  ▼
searchSimilar() / searchHybrid() ─── initial candidate retrieval
  │                                    three-signal scoring:
  │                                    α·similarity + β·importance + γ·recency
  ▼
Repair Loop (if enabled)
  │  rewriteQuery() ─── LLM rewrites ambiguous query
  │  re-search with rewritten query
  │  merge results if improvement detected
  │
  ▼
MMR Reranking (if enabled)
  │  λ·sim(d,query) - (1-λ)·max(sim(d,selected_i))
  │  balances relevance vs diversity
  │
  ▼
Link Expansion (if enabled)
  │  1-hop semantic links (memory_links table)
  │  temporal neighbors (±30min same episode)
  │  optional: PPR graph propagation
  │
  ▼
Namespace Filtering (if namespaceScope provided)
  │  isInScope() — hierarchical dot-path scoping (e.g., "work.acme")
  │
  ▼
Format injection text
  │  Full mode: XML with metadata attributes
  │  Staged mode: summaries only, with expand_ids for on-demand loading
  │  Tiered mode: L0/L1/L2 per memory based on token budget
  │
  ▼
RetrievalResult { memories, injectionText, citations }
```

## Database Schema

Six tables in PostgreSQL with pgvector extension:

| Table | Purpose |
|-------|---------|
| `episodes` | Source conversation records (user_id, content, source) |
| `memories` | Active memory projection — the current state of each fact |
| `memory_claims` | Fact identity tracking — one claim per conceptual fact |
| `memory_claim_versions` | Version history — snapshots with valid_from/valid_to |
| `memory_evidence` | Provenance — quotes, speakers, episode links |
| `memory_links` | 1-hop semantic links (bidirectional, similarity scored) |

**Memory lifecycle**: A memory starts as ADD, may be UPDATEd in place, or
SUPERSEDEd (old soft-deleted, new created, claim version chain preserved).
Claim versions enable temporal queries: "what did I believe on date X?"

**Key indexes**:
- HNSW on `memories.embedding` (m=16, ef_construction=200) — vector similarity
- GIN on `memories.fts` — full-text search for hybrid mode
- B-tree on `memory_links.target_id` — reverse link lookup

**Constraint**: Pool max=1 to prevent pgvector HNSW deadlocks between
concurrent INSERT (AccessExclusiveLock) and SELECT (AccessShareLock).

## API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/v1/memories/ingest` | Extract facts from conversation, apply AUDN, store |
| POST | `/v1/memories/search` | Retrieve relevant memories for a query |
| GET | `/v1/memories/list` | Paginated memory listing |
| GET | `/v1/memories/stats` | Memory count + clarification status |
| GET | `/v1/memories/:id` | Single memory by ID |
| DELETE | `/v1/memories/:id` | Soft-delete memory |
| GET | `/v1/memories/health` | Server health + config state |
| POST | `/v1/memories/consolidate` | Dry-run affinity clustering (returns merge candidates) |
| PUT | `/v1/memories/config` | Update runtime config (providers, thresholds) |

## Service Layer

**MemoryService** (`services/memory-service.ts`) — the central orchestrator.

Public methods:

| Method | Description |
|--------|-------------|
| `ingest(userId, text, sourceSite, sourceUrl?, sessionTimestamp?)` | Full extraction pipeline (with optional entropy gating) |
| `search(userId, query, sourceSite?, limit?, asOf?, referenceTime?, namespaceScope?)` | Full retrieval pipeline (with optional namespace filtering) |
| `list(userId, limit?, offset?)` | Paginated active memories |
| `get(id, userId)` | Single memory with embedding |
| `expand(userId, memoryIds)` | Load full content for staged summaries |
| `delete(id, userId)` | Soft-delete + claim version supersession |
| `consolidate(userId)` | Identify memory clusters for consolidation |

**Supporting services**:

| Service | File | Responsibility |
|---------|------|----------------|
| Extraction | `services/extraction.ts` | LLM fact extraction, AUDN resolution, query rewriting |
| Conflict Policy | `services/conflict-policy.ts` | AUDN guardrails, candidate merging, keyword analysis |
| Retrieval Policy | `services/retrieval-policy.ts` | Repair loop heuristics, query complexity classification |
| Retrieval Profiles | `services/retrieval-profiles.ts` | Named config bundles (safe/balanced/quality) |
| Retrieval Format | `services/retrieval-format.ts` | Injection text formatting (full/staged/tiered modes) |
| Tiered Loading | `services/tiered-loading.ts` | L0/L1/L2 token budget allocation for context injection |
| Namespace Retrieval | `services/namespace-retrieval.ts` | Hierarchical namespace inference and scope filtering |
| Entropy Gate | `services/entropy-gate.ts` | Write-time novelty filtering (entity + semantic signals) |
| Affinity Clustering | `services/affinity-clustering.ts` | Pairwise affinity scoring and greedy cluster formation |
| Consolidation | `services/consolidation-service.ts` | Bridge between repository and clustering for merge candidates |
| Fact Normalization | `services/fact-normalization.ts` | Post-extraction splitting of compound facts |
| Retrieval Trace | `services/retrieval-trace.ts` | Per-stage pipeline observability (single-line JSON) |
| LLM | `services/llm.ts` | Provider-agnostic LLM abstraction |
| Embedding | `services/embedding.ts` | Provider-agnostic embedding abstraction |
| Extraction Cache | `services/extraction-cache.ts` | Disk cache for deterministic evals |

## Repository Layer

**MemoryRepository** (`db/memory-repository.ts`) — facade wrapping split modules:

| Module | File | Key Operations |
|--------|------|----------------|
| Read | `db/repository-read.ts` | searchSimilar, findNearDuplicates, findKeywordCandidates, findTemporalNeighbors |
| Write | `db/repository-write.ts` | storeMemory, updateMemoryContent, softDeleteMemory, backdateMemories |
| Links | `db/repository-links.ts` | createLinks, findLinkedMemoryIds, fetchMemoriesByIds |
| Vector Search | `db/repository-vector-search.ts` | searchVectorsPg, searchHybrid (pgvector + FTS RRF) |

**ClaimRepository** (`db/repository-claims.ts`) — claim versioning:

| Method | Purpose |
|--------|---------|
| `createClaim()` | New claim (one per conceptual fact) |
| `createClaimVersion()` | Snapshot at point in time |
| `supersedeClaimVersion()` | Mark old version replaced by new |
| `searchClaimVersions()` | Temporal query: beliefs at date X |
| `addEvidence()` | Link quote + episode + memory to version |

**Specialized modules**:
- `db/mmr.ts` — Maximal Marginal Relevance reranking
- `db/ppr.ts` — Personalized PageRank on memory link graph
- `db/pool.ts` — PostgreSQL connection pool (max=1)
- `db/schema.sql` — DDL for all tables + indexes
- `db/migrate.ts` — Schema migration runner

## Webapp Adapter

`adapters/webapp-adapter.ts` provides a **Mem0-compatible interface** for
drop-in replacement in the web console:

```typescript
interface WebappMemoryEngine {
  add(userId, content, metadata?)
  update(memoryId, userId, content, metadata?)
  search(userId, query, options?)
  list(userId)
  get(memoryId, userId)
  delete(memoryId, userId)
}
```

This translates Mem0-style API calls to the richer AtomicMemory service layer.

## Configuration

All runtime config flows through `src/config.ts`, which reads env vars at
module load time (singleton pattern). Individual features can be overridden
via env vars or bundled via retrieval profiles.

See [retrieval-patterns-guide.md](retrieval-patterns-guide.md) for the
complete feature flag reference.

**Critical**: `config.ts` evaluates once at import time. Changing env vars
in-process has no effect — use subprocess isolation for eval comparisons.

## Eval Harness

The `src/eval/` directory contains benchmark runners:

| Runner | Purpose |
|--------|---------|
| `run-mini-eval.ts` | Standard mini-LoCoMo evaluation (50 QA pairs) |
| `run-no-memory-eval.ts` | No-retrieval baseline (LLM general knowledge) |
| `run-baseline-ladder.ts` | Three-tier comparison (no-memory/simple/full) |
| `run-combined-comparison.ts` | Multi-config comparison in single run |
| `run-repair-ablation.ts` | Repair loop ON/OFF/gated comparison |
| `run-hybrid-ablation.ts` | Vector-only vs hybrid comparison |
| `run-long-horizon-eval.ts` | Memory mutation integrity (5 scenarios) |
| `run-variance-comparison.ts` | Determinism measurement (seed/cache/time) |
| `run-mem0-comparison.ts` | AtomicMemory vs Mem0 head-to-head |
| `run-weight-sweep.ts` | Scoring weight grid search |

All runners use subprocess isolation (`execSync`) to ensure `config.ts`
is re-evaluated with correct env vars per configuration.

## Tiered Context Loading (L0/L1/L2)

Three representation tiers per memory, reducing injection tokens by serving
the cheapest tier that preserves enough signal for the model to act on.

| Tier | Storage Field | Typical Size | Content |
|------|---------------|-------------|---------|
| L0 | `summary` | ~10-20 tokens | Abstract headline |
| L1 | `overview` | ~100-200 tokens | Condensed overview |
| L2 | `content` | variable | Full original text |

**Budget allocation** (`services/tiered-loading.ts`): Given a token budget,
`assignTiers()` processes memories in score order (highest first). Each memory
gets the richest tier that fits in the remaining budget. Lower-ranked memories
degrade to L1 or L0 as budget is consumed.

**Fallback chain**: L0 falls back to truncated headline if no summary stored.
L1 falls back to full content if no overview stored.

**L1 generation** (`services/tiered-context.ts`): `generateL1Overview()` creates
condensed overviews at ingest time using heuristic sentence extraction.

**Injection modes** (`services/retrieval-format.ts`):
- Full mode: all memories at L2 (XML with metadata)
- Staged mode: all at L0 with `expand_ids` for on-demand loading
- Tiered mode: per-memory tier assignment based on budget

## Namespace Retrieval

Hierarchical dot-path namespaces for scoped retrieval. Each memory is
assigned a namespace at ingest time based on content, source site, and keywords.

**Inference** (`services/namespace-retrieval.ts`): `inferNamespace()` maps
source sites and keyword patterns to namespace paths (e.g., `work.acme`,
`personal.health`, `dev.typescript`).

**Scope filtering**: `isInScope(memoryNamespace, queryScope)` uses hierarchical
matching — querying `work` matches `work.acme` and `work.meetings`, but not
`personal`. Applied as a post-filter after retrieval.

## Entropy-Aware Write Gating

Filters low-information writes before they reach the memory store, preventing
redundant memories from accumulating.

**Signal**: `score = α × entityNovelty + (1-α) × semanticNovelty`
- Entity novelty: ratio of new (unseen) keywords to total keywords in the fact
- Semantic novelty: cosine distance from the previous fact's embedding

**Behavior**: Accumulates entities and embeddings across the ingest batch, so
each fact's novelty is measured against what came before it in the same call.
Facts scoring below the threshold (default 0.35) are skipped.

**Config**: `ENTROPY_GATE_ENABLED` (default false), `ENTROPY_GATE_THRESHOLD`,
`ENTROPY_GATE_ALPHA`. Source: SimpleMem pattern.

## Affinity-Based Memory Clustering

Batch identification of related memories that are candidates for LLM-based
consolidation (synthesis into abstract memories).

**Affinity score**: `affinity = β × semanticSimilarity + (1-β) × temporalProximity`
- Semantic similarity: cosine similarity between memory embeddings
- Temporal proximity: `exp(-λ × hoursDiff)` — decays with time distance

**Cluster formation** (`services/affinity-clustering.ts`): Greedy algorithm
processes memories by importance (highest first). For each unassigned memory,
find all unassigned neighbors with affinity ≥ threshold. If the group meets
minimum cluster size, it becomes a cluster.

**Consolidation service** (`services/consolidation-service.ts`): Bridges the
repository to the clustering algorithm. `POST /v1/memories/consolidate` returns
cluster candidates (member IDs, contents, average affinity) without modifying
data. LLM synthesis step is not yet wired.

**Config**: `AFFINITY_CLUSTERING_THRESHOLD` (0.85), `AFFINITY_CLUSTERING_MIN_SIZE` (3),
`AFFINITY_CLUSTERING_BETA` (0.5), `AFFINITY_CLUSTERING_TEMPORAL_LAMBDA` (0.1).
Source: SimpleMem pattern.
