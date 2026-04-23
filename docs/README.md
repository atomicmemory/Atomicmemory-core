# Documentation

## Structure

- `api-reference.md` — pointer to the rendered HTTP API reference at https://docs.atomicmemory.ai and to the OpenAPI source-of-truth
- `consuming-core.md` — how research, extensions, and SDK consumers boot core (HTTP, in-process, docker)
- `design/` — architecture and design documents
- `memory-research/architecture-overview.md` — system architecture overview

## Contributing docs

- **HTTP API**: edit `src/schemas/*.ts` + `src/schemas/openapi.ts`, then `npm run generate:openapi`. CI enforces `openapi.yaml` / `openapi.json` stay in sync with the Zod schemas. The rendered site at https://docs.atomicmemory.ai regenerates from whichever version of `@atomicmemory/atomicmemory-core` it has vendored.
- Architecture and design documents go in `design/`.
- Keep docs focused on the shipped runtime — research and evaluation artifacts belong in a separate repo.
