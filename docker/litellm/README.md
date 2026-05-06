# LiteLLM unified gateway

Run a [LiteLLM](https://github.com/BerriAI/litellm) proxy locally to route AtomicMemory's LLM calls to Anthropic, OpenAI, Microsoft Foundry / Azure, AWS Bedrock, or Google Gemini through a single OpenAI-compatible endpoint. Provider swap is config-only — no code changes in `atomicmemory-core`.

## Why this exists

`atomicmemory-core` already supports any OpenAI-compatible endpoint via:

```
LLM_PROVIDER=openai-compatible
LLM_API_URL=<base_url>
LLM_API_KEY=<key>
LLM_MODEL=<model alias>
```

(see `src/services/llm.ts` -> `OpenAICompatibleLLM`). The LiteLLM proxy *is* an OpenAI-compatible endpoint, so wiring it up is purely an infra/config change. No new provider lane in `llm.ts`.

## Quick start

```bash
# 1. Set provider credentials (fill in the ones you need)
cp docker/litellm/.env.example docker/litellm/.env
$EDITOR docker/litellm/.env

# 2. Start the proxy on http://localhost:4000
docker compose -f docker/litellm/docker-compose.litellm.yml up -d

# 3. Sanity-check it's up
curl -s http://localhost:4000/health/liveliness
# -> {"status":"alive",...}

# 4. List configured models
curl -s http://localhost:4000/v1/models \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY"
```

Point AtomicMemory at it (your `.env`):

```
LLM_PROVIDER=openai-compatible
LLM_API_URL=http://localhost:4000
LLM_API_KEY=sk-litellm-master       # value of LITELLM_MASTER_KEY in docker/litellm/.env
LLM_MODEL=anthropic-haiku-4-5       # or any model_name from litellm-config.yaml
```

Restart the core dev server to pick up the new env. The proxy and core can run side-by-side because they're on different ports (4000 vs 3050).

## Switching providers at runtime

Two options:

1. **Env-only.** Change `LLM_MODEL` to a different `model_name` from `litellm-config.yaml` and restart core.
2. **Per-request.** Use `config_override.llm_model` in the ingest/search request body (see core's per-request override pattern). The proxy is stateless w.r.t. AtomicMemory, so swapping models per request just changes which `model_list` entry the proxy resolves.

## Configured providers

| `model_name` (LLM_MODEL value) | Upstream | Required env |
|---|---|---|
| `anthropic-haiku-4-5` | Anthropic | `ANTHROPIC_API_KEY` |
| `anthropic-sonnet-4-6` | Anthropic | `ANTHROPIC_API_KEY` |
| `openai-gpt-5-chat` | OpenAI | `OPENAI_API_KEY` |
| `openai-gpt-4o-mini` | OpenAI | `OPENAI_API_KEY` |
| `foundry-gpt-5-chat` | Microsoft Foundry / Azure AI Projects | `FOUNDRY_API_BASE`, `FOUNDRY_API_KEY`, `FOUNDRY_API_VERSION` |
| `bedrock-claude-sonnet` | AWS Bedrock | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION_NAME` |
| `gemini-1-5-pro` | Google Gemini direct API | `GEMINI_API_KEY` |

To add a model, append a `model_list` entry to `litellm-config.yaml` and restart the proxy. No core code change required.

## Limitations / known caveats

- **Cost telemetry.** Core's `cost-telemetry.ts` estimates cost from the model name and the OpenAI-compatible `usage` block returned by the proxy. Per-provider rates aren't perfectly mirrored across providers behind LiteLLM yet — Bedrock especially does its own per-deployment pricing. Treat per-call cost estimates as upper-bound when routed through the proxy. LiteLLM does emit an `x-litellm-response-cost` HTTP header; wiring core to read it is future work.
- **Streaming.** The proxy supports streaming, but core's LLM call sites don't currently stream — irrelevant today.
- **Foundry + Entra ID auth.** LiteLLM's `azure/` provider requires a static API key. The existing `foundry-client.ts` in `atomicmemory-benchmarks` uses `DefaultAzureCredential`. If your Foundry deployment is Entra-only with no static key, keep using `foundry-client.ts` directly and route only the other providers through LiteLLM.
- **Model name format.** Aliases here use kebab-case (`anthropic-haiku-4-5`). If a downstream tool expects the upstream model id verbatim, use the alias for routing and let LiteLLM translate.

## Where this fits

- `litellm-config.yaml` — model routing table (provider keys via `os.environ/...`).
- `docker-compose.litellm.yml` — sidecar service definition (port 4000, healthcheck, env wiring).
- `.env.example` — credential template for the host environment.
