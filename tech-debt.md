# Tech debt

Items deferred rather than fixed inline. Fallow baselines at
`.fallow/health-baseline.json` and `.fallow/dupes-baseline.json` keep
these from blocking PRs; the CI ratchet check keeps the baseline
monotonic (shrink-only), so every refactor that lowers an entry counts.

When fixing an item: refactor the code, regenerate the relevant
baseline (`npx fallow health --save-baseline=.fallow/health-baseline.json`
or `npx fallow dupes --save-baseline=.fallow/dupes-baseline.json`),
commit both the code change and the smaller baseline, and delete the
entry from this file.

## HIGH-complexity functions (baseline: 4 HIGH + 13 other, 17 total)

Each entry blocks the ceiling; splitting any of them lets the baseline
shrink.

- [ ] `src/db/repository-write.ts:140 buildBaseParams` — 15 cyclomatic / 14 cognitive / 26 lines / CRAP 63.6. Param-building branch tree; candidate for a config-table pattern.
- [ ] `src/db/repository-claims.ts:256 createClaimVersionWithClient` — 15 / 9 / 46. Multi-insert transaction; extract the slot-resolution and version-linking branches.
- [ ] `src/services/llm.ts:176 chat` — 14 / 13 / 40. Provider-dispatch plus retry; split the retry wrapper from the provider selection.
- [ ] `src/services/memory-audn.ts:132 tryOpinionIntercept` — 14 / 8 / 28. Confidence-threshold cascade; table-drive the decision.
- [ ] `src/services/search-pipeline.ts:667 applyExpansionAndReranking` — 13 / 12 / 100 lines. The longest function in core; split into expansion / reranking / packaging phases.
- [ ] `src/services/extraction.ts:38 repairTruncatedJson` — 11 / 10 / 38.
- [ ] `src/services/llm.ts:78 cleaned` — 11 / 9 / 11.
- [ ] `src/services/extraction-enrichment.ts:205 inferCrossEntityRelations` — 11 / 14 / 20.
- [ ] `src/services/deferred-audn.ts:196 applyDeferredDecision` — 11 / 7 / 49.
- [ ] `src/services/llm.ts:147 recordOpenAICost` — 10 / 6 / 18.
- [ ] `src/services/llm.ts:233 chat` (second `chat`) — 10 / 6 / 23. Same file as the HIGH one above; may dedupe via shared base.
- [ ] `src/services/quick-extraction.ts:82 extractFactBearingTurns` — 10 / 11 / 40.
- [ ] `src/db/repository-claims.ts:58 createClaimWithClient` — 10 / 5 / 25.
- [ ] `src/services/embedding.ts:99 requestAndTrack` — 10 / 5 / 13.
- [ ] `src/services/supplemental-extraction.ts:41 shouldIncludeSupplementalFact` — 10 / 6 / 35.
- [ ] `src/services/__tests__/poisoning-dataset.ts` — 10 / 9 / 112 (test fixture; may be fine as-is).
- [ ] `src/services/atomicmem-uri.ts:33 resolve` — 10 / 13 / 34.

## Clone groups (baseline: 29 groups, 848 lines)

Biggest wins come from extracting shared helpers across the storage
adapter / DB layer.

- [ ] **memory-repository ↔ pg-*-store near-duplicates** (~375 lines across 3 clone groups). `src/db/memory-repository.ts:87-409` vs `src/db/stores.ts:31-90`, and several smaller blocks against `pg-memory-store.ts` and `pg-search-store.ts`. Extract a shared DB-access helper into `src/db/`. Biggest single win.
- [ ] **runtime-container ↔ formatHealthConfig** (16 lines). `src/app/runtime-container.ts:227-242` vs `src/routes/memories.ts:611-626`. Both snapshot the same runtime config fields; extract a single `snapshotRuntimeConfig` helper.
- [ ] **repository-claims ↔ memory-lineage** (15 lines). `src/db/repository-claims.ts:360-374` vs `src/services/memory-lineage.ts:67-81`.
- [ ] **test setup duplication**. `memory-ingest-runtime-config.test.ts` has 41 lines of internal dupes across 2 groups; `memory-service-config.test.ts` has 18 lines across 3 instances; `smoke.test.ts` + `research-consumption-seams.test.ts` share 14 lines of bootstrap. Extract to test-fixtures.
- [ ] 20 remaining smaller clone groups — run `npx fallow dupes` for the full list.

## OpenAPI response schemas (separate from fallow)

- [ ] Response bodies aren't declared in the OpenAPI spec today — only request bodies. Adding them would let `npm run check:openapi` catch wire-shape drift automatically (the earlier snake_case flip couldn't have silently changed the spec). See `atomicmemory-core/src/schemas/openapi.ts`.

## Fallow version pin removal

Landed in the baseline-upgrade PR. No action required — CI now uses
fallow's latest via `npx fallow audit`.
