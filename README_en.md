# cf-openai-azure-proxy

<a href="./README_en.md">English</a> |
<a href="./README.md">中文</a>

> An OpenAI-compatible proxy for Cloudflare Workers. It accepts `/v1/*` requests from OpenAI-style clients and forwards them to Azure OpenAI or Azure AI Foundry using the upstream shape each backend expects.

## What This Project Does

Many desktop and mobile clients only know how to talk to the OpenAI API. This project acts as a thin compatibility layer:

- clients keep calling `/v1/chat/completions`, `/v1/responses`, `/v1/embeddings`, and similar OpenAI-style routes
- the Worker looks up the requested `model`
- the request is then forwarded to Azure OpenAI or Azure AI Model Inference

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
- Azure OpenAI classic deployment routes
  - `/openai/deployments/{deployment}/*`
- Azure OpenAI Responses API
  - `/openai/responses`
- Azure AI Model Inference routes
  - `/models/*`
- Native streaming passthrough
- Optional client-side allowlist auth via `CLIENT_API_KEYS`

## Supported Model Categories

The built-in default mapping includes examples for:

- GPT family
  - `gpt-5.4`
  - `gpt-4o`
  - `gpt-4o-mini`
  - `o1`
  - `o3-mini`
- Image generation
  - `gpt-image-1`
  - `gpt-image-1.5`
  - `dall-e-3`
- Embeddings
  - `text-embedding-3-small`
  - `text-embedding-3-large`
- Audio
  - `whisper-1`
  - `tts-1`
- Third-party Azure AI Foundry models
  - `grok-4-20`
  - `grok-3`
  - `deepseek-r1`
  - `deepseek-v3`
  - `llama-3.3-70b`

What actually works depends on which deployments exist in your Azure resources and how `MODEL_MAPPING` is configured.

## How It Works

```text
OpenAI-compatible client
  -> /v1/chat/completions | /v1/responses | /v1/embeddings | ...
  -> Cloudflare Worker
  -> validate Authorization / CLIENT_API_KEYS
  -> read body.model
  -> resolve backend + deployment from MODEL_MAPPING
  -> forward to the right Azure upstream
     - backend=oai   -> {AZURE_OAI_ENDPOINT}/openai/...
     - backend=infer -> {AZURE_INFER_ENDPOINT}/models/...
  -> return the upstream response as-is
```

## Environment Variables

Configure these in Cloudflare Workers Variables / Secrets:

| Variable | Required | Description |
|---|---|---|
| `AZURE_API_KEY` | Recommended | Azure API key used by the Worker when calling Azure |
| `AZURE_OAI_ENDPOINT` | Required for Azure OpenAI | Example: `https://your-resource.cognitiveservices.azure.com` |
| `AZURE_INFER_ENDPOINT` | Required for Azure AI Model Inference | Example: `https://your-project.services.ai.azure.com` |
| `CLIENT_API_KEYS` | Recommended | Comma-separated keys accepted by your proxy |
| `ALLOWED_ORIGINS` | No | Comma-separated browser origins allowed by CORS, for example `https://chat.example.com` |
| `AZURE_OAI_API_VERSION` | No | Defaults to `2025-04-01-preview` |
| `AZURE_INFER_API_VERSION` | No | Defaults to `2024-05-01-preview` |
| `UPSTREAM_TIMEOUT_MS` | No | Timeout for Azure upstream requests, defaults to `30000` |
| `MODEL_MAPPING` | No | JSON string; falls back to the built-in default mapping |

Notes:

- if `CLIENT_API_KEYS` is set, clients must use one of those keys to access the proxy
- if `CLIENT_API_KEYS` is set, `AZURE_API_KEY` must also be set so client keys are never forwarded upstream by mistake
- if `CLIENT_API_KEYS` is not set, client auth is skipped
- if `CLIENT_API_KEYS` is not set and `AZURE_API_KEY` is also not set, the Worker will try to forward the client's `Authorization: Bearer ...` value as the Azure key
- if `ALLOWED_ORIGINS` is set, only those browser origins receive CORS access; non-browser clients are unaffected

## MODEL_MAPPING Format

`MODEL_MAPPING` is a JSON object where each key is the model name seen by the client, and each value tells the Worker which backend and deployment to use.

Example:

```json
{
  "gpt-5.4": {
    "backend": "oai",
    "deployment": "gpt-5.4"
  },
  "gpt-4o": {
    "backend": "oai",
    "deployment": "gpt-4o"
  },
  "grok-4-20": {
    "backend": "infer",
    "deployment": "grok-4-20"
  },
  "deepseek-r1": {
    "backend": "infer",
    "deployment": "deepseek-r1"
  }
}
```

Rules:

- `backend: "oai"` routes to Azure OpenAI
- `backend: "infer"` routes to Azure AI Model Inference
- `deployment` must match the real deployment name in Azure
- optional `apiVersion` can override the default API version for that entry

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
  - `AZURE_OAI_API_VERSION`
  - `AZURE_INFER_API_VERSION`
- secrets for sensitive values
  - `AZURE_API_KEY`
  - `CLIENT_API_KEYS`
  - `MODEL_MAPPING`

You can start with the minimum required set:

- `AZURE_API_KEY`
- `AZURE_OAI_ENDPOINT` or `AZURE_INFER_ENDPOINT`
- `CLIENT_API_KEYS` (recommended)

Add `MODEL_MAPPING` only if you want to override the built-in mapping.

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
AZURE_OAI_ENDPOINT      = "https://your-resource.cognitiveservices.azure.com"
AZURE_INFER_ENDPOINT    = "https://your-project.services.ai.azure.com"
AZURE_OAI_API_VERSION   = "2025-04-01-preview"
AZURE_INFER_API_VERSION = "2024-05-01-preview"
ALLOWED_ORIGINS         = "https://chat.example.com"
UPSTREAM_TIMEOUT_MS     = "30000"
```

Use secrets for sensitive values:

```bash
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

Clients that support the newer Responses API can use the same base URL; the proxy will translate `/v1/responses` to Azure's `/openai/responses`.

## Notes

- manual deployment and Wrangler deployment behave the same after release; the main difference is how you publish updates
- `GET /v1/models` reflects the configured mapping, not Azure auto-discovery
- a model only works if the corresponding endpoint and deployment are actually configured in Azure
- the proxy now forwards only a small whitelist of safe response headers instead of exposing Azure-specific `x-ms-*` or `apim-*` headers as-is
- this project intentionally stays small: it does not implement retries, caching, quotas, auditing, or multi-tenant management
- the repository also ships a Docker image, but it runs `wrangler dev --local` and is meant for local debugging rather than production deployment

## Main Files

- [cf-openai-azure-proxy.js](./cf-openai-azure-proxy.js): current Worker implementation
- [wrangler.toml](./wrangler.toml): Worker configuration
- [cf-openai-palm-proxy.js](./cf-openai-palm-proxy.js): older PaLM proxy script, unrelated to the current Azure-focused implementation

## License

[MIT](./LICENSE)
