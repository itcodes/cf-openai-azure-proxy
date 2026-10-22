# cf-openai-azure-proxy

<a href="./README_en.md">English</a> |
<a href="./README.md">中文</a>

> An OpenAI-compatible proxy for Cloudflare Workers. It accepts `/v1/*` requests from OpenAI-style clients and forwards them to Azure OpenAI or Azure AI Foundry through Azure's OpenAI-compatible v1 API.

## What This Project Does

Many desktop and mobile clients only know how to talk to the OpenAI API. This project acts as a thin compatibility layer:

- clients keep calling `/v1/chat/completions`, `/v1/responses`, `/v1/embeddings`, and similar OpenAI-style routes
- the Worker forwards the request to Azure's `/openai/v1/*` API, using the client's `model` as the deployment name
- with two Azure resources configured (Azure OpenAI + Azure AI Foundry), it picks one from the model name and falls back to the other if the deployment isn't there

This is a stateless proxy. It is not a chatbot app, billing system, admin panel, or database-backed service.

## Current Capabilities

- OpenAI-compatible entrypoints
  - `POST /v1/chat/completions`
  - `POST /v1/responses`
  - `POST /v1/completions`
  - `POST /v1/embeddings`
  - `POST /v1/images/generations`
  - `POST /v1/audio/speech`
  - `POST /v1/audio/transcriptions`
  - `POST /v1/audio/translations`
  - `POST /v1/images/edits`
  - `POST /v1/images/variations`
  - `GET /v1/models`
- New Azure deployments work without changing code or config, as long as the client uses the deployment name
- Native streaming passthrough
- Optional client-side allowlist auth via `CLIENT_API_KEYS`

## How It Works

```text
OpenAI-compatible client
  -> /v1/chat/completions | /v1/responses | /v1/embeddings | ...
  -> Cloudflare Worker
  -> validate Authorization / CLIENT_API_KEYS
  -> read body.model, apply MODEL_MAPPING alias if any -> deployment name
  -> pick which resource to try first
     - gpt-* / o1 / o3 / text-embedding-* / dall-e-* / whisper / tts-* -> AZURE_OAI_ENDPOINT
     - everything else (grok, deepseek, llama, ...)                  -> AZURE_INFER_ENDPOINT
  -> POST {endpoint}/openai/v1/{path} with model = deployment name
  -> if that resource answers 404 / unknown model, retry on the other one
  -> return the upstream response as-is
```

The resource that worked is remembered per Worker instance, so a fallback only costs an extra round trip the first time.

## Environment Variables

Configure these in Cloudflare Workers Variables / Secrets:

| Variable | Required | Description |
|---|---|---|
| `AZURE_API_KEY` | Recommended | Azure API key used by the Worker when calling Azure (the same key is used for both resources) |
| `AZURE_OAI_ENDPOINT` | At least one endpoint | Azure OpenAI resource, e.g. `https://your-resource.cognitiveservices.azure.com` |
| `AZURE_INFER_ENDPOINT` | At least one endpoint | Azure AI Foundry resource, e.g. `https://your-project.services.ai.azure.com` |
| `CLIENT_API_KEYS` | Recommended | Comma-separated keys accepted by your proxy |
| `ALLOWED_ORIGINS` | No | Comma-separated browser origins allowed by CORS, for example `https://chat.example.com` |
| `UPSTREAM_TIMEOUT_MS` | No | Timeout for Azure upstream requests in milliseconds, defaults to `120000`. Bounds time-to-first-byte only — streaming bodies are not cut off once they start |
| `MODEL_MAPPING` | No | JSON aliases, see below. Only needed when a client-facing name differs from the deployment name |
| `MODEL_LIST` | No | Comma-separated model ids returned by `GET /v1/models`; defaults to a built-in list of common models |

Notes:

- if `CLIENT_API_KEYS` is set, clients must use one of those keys to access the proxy
- if `CLIENT_API_KEYS` is set, `AZURE_API_KEY` must also be set so client keys are never forwarded upstream by mistake
- if `CLIENT_API_KEYS` is not set, client auth is skipped
- if `CLIENT_API_KEYS` is not set and `AZURE_API_KEY` is also not set, the Worker will try to forward the client's `Authorization: Bearer ...` value as the Azure key
- if `ALLOWED_ORIGINS` is set, only those browser origins receive CORS access; non-browser clients are unaffected
- `api-version` is no longer needed: the v1 API doesn't take one

## MODEL_MAPPING Format

Optional. Keys are the model names clients send; values are either the deployment name, or an object that also pins which resource to try first:

```json
{
  "gpt-chat-latest": "gpt-5.5",
  "my-grok": { "deployment": "grok-4-20", "backend": "infer" }
}
```

- `backend: "oai"` tries `AZURE_OAI_ENDPOINT` first, `backend: "infer"` tries `AZURE_INFER_ENDPOINT` first
- without `MODEL_MAPPING`, the built-in mapping only aliases `gpt-chat-latest` to `gpt-5.5`
- setting `MODEL_MAPPING` replaces the built-in mapping
- mapped names are also listed by `GET /v1/models`

## Deployment

The recommended starting point is manual deployment in the Cloudflare Dashboard because it is the most obvious path for first-time setup. `Wrangler` is optional and is better for repeat updates, versioned config, and local development.

### Option 1: Manual Deployment in the Cloudflare Dashboard

#### 1. Create a Worker

- Sign in to the Cloudflare Dashboard
- Open Workers & Pages
- Create a new Worker

#### 2. Paste the script

Copy the full contents of [cf-openai-azure-proxy.js](./cf-openai-azure-proxy.js) into the Cloudflare Worker editor and replace the default sample code.

#### 3. Configure Variables and Secrets

In the Worker Settings / Variables page, add:

- regular variables for non-sensitive values
  - `AZURE_OAI_ENDPOINT`
  - `AZURE_INFER_ENDPOINT`
  - `MODEL_LIST` (optional)
- secrets for sensitive values
  - `AZURE_API_KEY`
  - `CLIENT_API_KEYS`
  - `MODEL_MAPPING`

You can start with the minimum required set:

- `AZURE_API_KEY`
- `AZURE_OAI_ENDPOINT` or `AZURE_INFER_ENDPOINT`
- `CLIENT_API_KEYS` (recommended)

Add `MODEL_MAPPING` only if you want aliases.

#### 4. Deploy and use the Worker URL

Save and deploy the Worker. Cloudflare will give you a Worker URL.

Use this as the base URL in your OpenAI-compatible client:

```text
https://your-worker.your-subdomain.workers.dev/v1
```

If you have your own domain, you can also bind a custom domain or route in the Worker settings and use `https://your-domain/v1` instead.

### Option 2: Deploy with Wrangler CLI

`Wrangler` is not required. It simply turns the "paste code in the dashboard, fill in variables, click deploy" flow into a CLI workflow that is easier to repeat.

In this repository:

- [wrangler.toml](./wrangler.toml) sets the entrypoint with `main = "cf-openai-azure-proxy.js"`
- `wrangler deploy` uploads [cf-openai-azure-proxy.js](./cf-openai-azure-proxy.js) as the Worker
- non-secret values from `[vars]` are included automatically
- sensitive values such as `AZURE_API_KEY`, `CLIENT_API_KEYS`, and `MODEL_MAPPING` should still be stored as secrets

#### 1. Install and log in

```bash
npm i -g wrangler
wrangler login
```

#### 2. Configure variables

Use `[vars]` in `wrangler.toml` for non-secret values, for example:

```toml
[vars]
MODEL_LIST              = "gpt-5.5,gpt-5.4,grok-4-20,deepseek-r1"
ALLOWED_ORIGINS         = "https://chat.example.com"
UPSTREAM_TIMEOUT_MS     = "120000"
```

If your repository is public, keep the Azure endpoints out of `wrangler.toml` and set them as secrets instead (see below).

Use secrets for sensitive values:

```bash
wrangler secret put AZURE_OAI_ENDPOINT
wrangler secret put AZURE_INFER_ENDPOINT
wrangler secret put AZURE_API_KEY
wrangler secret put CLIENT_API_KEYS
wrangler secret put MODEL_MAPPING
```

#### 3. Deploy

```bash
wrangler deploy
```

After deployment, point your client to `{WORKER_URL}/v1`.

## Client Configuration

For an OpenAI-compatible client:

- Base URL: `https://your-worker.your-subdomain.workers.dev/v1`
- API Key: one of the keys listed in `CLIENT_API_KEYS`

Clients that support the newer Responses API can use the same base URL; the proxy forwards `/v1/responses` to Azure's `/openai/v1/responses`.

## Notes

- manual deployment and Wrangler deployment behave the same after release; the main difference is how you publish updates
- `GET /v1/models` returns `MODEL_MAPPING` keys plus `MODEL_LIST`, not Azure auto-discovery (listing deployments needs Azure management credentials, not an API key). Models missing from the list still work
- a model only works if the corresponding endpoint and deployment are actually configured in Azure
- the proxy now forwards only a small whitelist of safe response headers instead of exposing Azure-specific `x-ms-*` or `apim-*` headers as-is
- this project intentionally stays small: apart from the resource fallback above, it does not implement retries, caching, quotas, auditing, or multi-tenant management
- the repository also ships a Docker image, but it runs `wrangler dev --local` and is meant for local debugging rather than production deployment

## Main Files

- [cf-openai-azure-proxy.js](./cf-openai-azure-proxy.js): current Worker implementation
- [wrangler.toml](./wrangler.toml): Worker configuration
- [cf-openai-palm-proxy.js](./cf-openai-palm-proxy.js): older PaLM proxy script, unrelated to the current Azure-focused implementation

## License

[MIT](./LICENSE)
