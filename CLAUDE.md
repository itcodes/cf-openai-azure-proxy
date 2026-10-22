# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A stateless Cloudflare Worker that accepts OpenAI-style `/v1/*` requests and forwards them to Azure OpenAI / Azure AI Foundry. The whole implementation is one file, `cf-openai-azure-proxy.js`, with no dependencies and no build step. `cf-openai-palm-proxy.js` is a legacy PaLM script unrelated to the main proxy; leave it alone unless asked.

## Commands

There is no build step and no runtime dependencies. `package.json` exists only to set `"type": "module"` and the test script.

```bash
npm test                                   # node --test, runs test/*.test.js
node --test --test-name-pattern="fallback" # run a single test by name
node --check cf-openai-azure-proxy.js      # syntax check
sh -n docker-entrypoint.sh                 # entrypoint syntax
```

CI (`.github/workflows/validate.yml`, Node 20) runs these checks. It also verifies that every relative `](./...)` link in `README.md` and `README_en.md` points to a file that exists. The tests import the worker and replace `globalThis.fetch` with a mock that records upstream calls. `endpointCache` is module-level and shared across tests, so each test uses its own model names.

To run locally, put secrets in `.dev.vars`, then run `wrangler dev`. Deploy with `wrangler deploy`. The Docker image only wraps `wrangler dev --local` for local debugging. Pushing a `v*` tag builds the image, pushes it to Docker Hub, and creates a GitHub release.

## Architecture

The `fetch` handler runs these steps in order: `loadConfig`, then origin check (`ALLOWED_ORIGINS`), then the OPTIONS preflight, then path normalization (strips the `/v1` prefix and collapses repeated slashes), then client auth, then routing. Only the paths in `JSON_ROUTES` and `MULTIPART_ROUTES` (plus `GET /models`) are accepted.

Every request goes to Azure's OpenAI-compatible v1 API: `{endpoint}/openai/v1{path}`. The deployment name is in `body.model`, and there is no `api-version`. `resolveModel` handles the model lookup:
- **Deployment name:** the `MODEL_MAPPING` alias if one exists (a string value, or `{deployment, backend}`), otherwise the client's model name as-is. The mapping is optional.
- **Endpoints:** `parseEndpoints` builds the resource list from `AZURE_ENDPOINTS` (`url` or `url|key`, comma- or newline-separated), then appends the legacy `AZURE_OAI_ENDPOINT` / `AZURE_INFER_ENDPOINT`. `endpointKind` labels each resource by hostname: `oai` for `*.openai.azure.com` / `*.cognitiveservices.azure.com`, `infer` for `*.services.ai.azure.com`, `null` otherwise. A resource without its own key uses `AZURE_API_KEY`.
- **Resource order:** in priority order: the endpoint in `endpointCache` (per isolate, the one that last served this deployment), the endpoint pinned by `entry.endpoint` (substring match), then endpoints whose kind matches `entry.backend` or `OAI_MODEL_PATTERN`. All remaining endpoints follow in config order. Each one is a fallback for the one before it.

`proxyToAzure` tries the endpoints in order. It moves on to the next one only when `isDeploymentMissing` returns true: a 404, or a 400 whose body looks like an unknown-model error. The last endpoint's response is always returned to the client. `fetchUpstream` applies an `AbortController` timeout (`UPSTREAM_TIMEOUT_MS`, default 120s; this covers time-to-first-byte only, so SSE keeps streaming afterwards). A timeout becomes a 504.

Multipart routes go through `proxyMultipart` before any JSON parsing. It rebuilds the form with `model` replaced by the deployment name.

Response headers are filtered through the `SAFE_RESPONSE_HEADERS` allowlist, and CORS headers are added. If you allowlist a new upstream header, also add it to `DEFAULT_CORS_EXPOSE_HEADERS` unless it is CORS-safelisted.

Auth model:
- If `CLIENT_API_KEYS` is set, the client's Bearer token must match one entry (compared with a timing-safe check), and `AZURE_API_KEY` is then required. `loadConfig` throws if it is missing.
- If `CLIENT_API_KEYS` is not set, all requests are allowed through. The proxy uses `AZURE_API_KEY` if set; otherwise it forwards the client's Bearer token as the Azure key.

Errors use the OpenAI shape `{ error: { message, type, param, code } }` and are returned via `errorResponse`. Use it for any new error path.

## Keeping things in sync

When you add or change an env var, update every place that lists it:
- the header comment in `cf-openai-azure-proxy.js`
- `[vars]` and the secrets comment in `wrangler.toml`
- the env tables in `README.md` (Chinese, primary) and `README_en.md`
- the `write_var` list in `docker-entrypoint.sh`

New Azure deployments need no change. `DEFAULT_MODEL_LIST` only affects what `GET /v1/models` shows.

The repo is public. Don't commit real Azure hostnames, keys, or client keys anywhere, including `wrangler.toml`, code comments, docs, and tests. The endpoints are set with `wrangler secret put` (locally in the gitignored `.dev.vars`).
