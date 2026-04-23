# HTTP API Reference

> **The full, always-current HTTP API reference lives at https://docs.atomicmemory.ai/api-reference/http/conventions**

The rendered reference is generated from `openapi.yaml` + `openapi.json` at this repo's root, which are in turn generated from the Zod schemas in `src/schemas/`. Those schemas are the same ones the Express handlers use for runtime request validation, so wire contracts, error envelopes, and response shapes stay in sync by construction.

## Where to look

| You want to… | Open… |
|---|---|
| Read the endpoint reference | https://docs.atomicmemory.ai/api-reference/http/conventions |
| Inspect the raw spec locally | `openapi.yaml` / `openapi.json` at this repo's root |
| Change an endpoint's contract | `src/schemas/memories.ts` or `src/schemas/agents.ts`, then `src/schemas/openapi.ts` |
| Add a new endpoint | register the route, add its schema in `src/schemas/*.ts`, add a `registerPath` entry in `src/schemas/openapi.ts`, run `npm run generate:openapi` |

## Regenerating the spec

```bash
npm run generate:openapi   # writes openapi.yaml + openapi.json
npm run check:openapi      # same + fails if the tree is dirty (CI check)
```

CI runs `check:openapi` on every PR — it blocks changes that touch schemas without regenerating the spec. `prepublishOnly` also regenerates so the published npm tarball always ships with the current spec.

## How downstream consumers get the spec

`openapi.yaml` and `openapi.json` are shipped inside the `@atomicmemory/atomicmemory-core` npm package and exposed via:

- `require('@atomicmemory/atomicmemory-core/openapi.json')` (CommonJS / `createRequire`)
- `@atomicmemory/atomicmemory-core/openapi.yaml` (path resolved by bundlers / docs toolchains)

`atomicmemory-docs` renders its HTTP API section from a vendored copy refreshed via its own `npm run vendor:spec` script after each core release.
