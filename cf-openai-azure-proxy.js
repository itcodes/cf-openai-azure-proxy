// Cloudflare Workers proxy: OpenAI-compatible -> Azure AI Foundry
// Every request goes to Azure's OpenAI-compatible v1 API:
//   {endpoint}/openai/v1/{path}   (deployment name in body.model, no api-version)
// Any number of Azure resources can be configured. The model name picks which
// kind of resource is tried first (Azure OpenAI vs. AI Foundry); if a resource
// doesn't have the deployment, the request is retried on the next one. Model
// names are passed through as deployment names, so new deployments work without
// code changes.
//
// Env vars (set in Workers dashboard -> Settings -> Variables):
//   AZURE_ENDPOINTS          comma/newline-separated resources, each `url` or `url|key`, e.g.
//                            https://a.openai.azure.com|key1,https://b.services.ai.azure.com|key2
//   AZURE_API_KEY            (Secret) Key for resources listed without their own key
//   AZURE_OAI_ENDPOINT       legacy single Azure OpenAI resource, appended to AZURE_ENDPOINTS
//   AZURE_INFER_ENDPOINT     legacy single AI Foundry resource, appended to AZURE_ENDPOINTS
//   MODEL_MAPPING            optional JSON aliases, see parseModelMapping below
//   MODEL_LIST               optional comma-separated model ids for GET /v1/models
//   CLIENT_API_KEYS          comma-separated list, e.g. sk-abc,sk-def (optional but recommended)
//   ALLOWED_ORIGINS          comma-separated browser origins allowed by CORS (optional)
//   UPSTREAM_TIMEOUT_MS      timeout for upstream Azure requests in milliseconds (optional)

// Default governs time-to-first-byte. 120s accommodates reasoning models (o1,
// gpt-5.x) whose non-streaming TTFB routinely exceeds 30s.
const DEFAULT_UPSTREAM_TIMEOUT_MS = 120000;
const DEFAULT_CORS_ALLOW_HEADERS = "Authorization, Content-Type, api-key";
const SAFE_RESPONSE_HEADERS = new Set([
  "cache-control",
  "content-disposition",
  "content-encoding",
  "content-language",
  "content-type",
  "openai-processing-ms",
  "retry-after",
  "x-ratelimit-limit-requests",
  "x-ratelimit-limit-tokens",
  "x-ratelimit-remaining-requests",
  "x-ratelimit-remaining-tokens",
  "x-ratelimit-reset-requests",
  "x-ratelimit-reset-tokens",
  "x-request-id"
]);
// Expose to browser JS every safe header that isn't required by default (CORS
// already exposes Cache-Control, Content-Language, Content-Type, Expires,
// Last-Modified, Pragma).
const DEFAULT_CORS_EXPOSE_HEADERS = [
  "content-disposition",
  "content-encoding",
  "openai-processing-ms",
  "retry-after",
  "x-ratelimit-limit-requests",
  "x-ratelimit-limit-tokens",
  "x-ratelimit-remaining-requests",
  "x-ratelimit-remaining-tokens",
  "x-ratelimit-reset-requests",
  "x-ratelimit-reset-tokens",
  "x-request-id"
].join(", ");
const TEXT_ENCODER = new TextEncoder();

let cachedModelMappingRaw = null;
let cachedModelMapping = null;
// deployment -> endpoint that served it last, so a fallback hit isn't repeated
// on every request handled by this isolate.
const endpointCache = new Map();

const JSON_ROUTES = new Set([
  "/chat/completions",
  "/responses",
  "/completions",
  "/embeddings",
  "/images/generations",
  "/audio/speech"
]);
// Multipart routes (audio + image edits) — must not json-parse the body
const MULTIPART_ROUTES = new Set([
  "/audio/transcriptions",
  "/audio/translations",
  "/images/edits",
  "/images/variations"
]);

// Models whose names match this are tried on Azure OpenAI resources first;
// everything else (grok, deepseek, llama, ...) on AI Foundry resources first.
const OAI_MODEL_PATTERN = /^(gpt-|chatgpt-|o\d|text-embedding-|dall-e-|whisper|tts-|codex-|sora|computer-use)/i;

// MODEL_MAPPING holds aliases only; unmapped model names are used as the
// deployment name directly. Values are a deployment name, or
// { deployment, backend: "oai" | "infer", endpoint } to pin which resource is
// tried first.
const DEFAULT_MAPPING = {};

// What GET /v1/models advertises when MODEL_LIST is unset. Purely cosmetic:
// models missing here still work.
const DEFAULT_MODEL_LIST = [
  "gpt-5.5", "gpt-5.4", "gpt-4o", "gpt-4o-mini", "o1", "o3-mini",
  "gpt-image-1", "gpt-image-1.5", "dall-e-3",
  "text-embedding-3-small", "text-embedding-3-large", "whisper-1", "tts-1",
  "grok-4-20", "grok-3", "deepseek-r1", "deepseek-v3", "llama-3.3-70b"
];

export default {
  async fetch(request, env) {
    let cfg;
    try {
      cfg = loadConfig(env);

      const originErr = checkOrigin(request, cfg);
      if (originErr) return originErr;

      if (request.method === "OPTIONS") {
        return new Response(null, { headers: getCorsHeaders(request, cfg) });
      }

      const url = new URL(request.url);
      const path = normalizeClientPath(url.pathname);

      // Client auth
      const authErr = checkClientAuth(request, cfg);
      if (authErr) return authErr;

      // Routes that don't need model lookup
      if (path === "/models" && request.method === "GET") {
        return listModels(cfg, request);
      }

      if (MULTIPART_ROUTES.has(path)) {
        return proxyMultipart(request, path, cfg);
      }

      if (request.method !== "POST") {
        return errorResponse(404, "not_found", `No handler for ${request.method} ${path}`, request, cfg);
      }
      if (!JSON_ROUTES.has(path)) {
        return errorResponse(404, "not_found", `Unsupported path: ${url.pathname}`, request, cfg);
      }

      const body = await request.json().catch(() => null);
      if (!body) {
        return errorResponse(400, "invalid_request_error", "Request body must be valid JSON", request, cfg);
      }

      const modelName = body.model;
      if (!modelName) {
        return errorResponse(400, "invalid_request_error", "Missing 'model' field in request body", request, cfg, "model");
      }

      const target = resolveModel(modelName, cfg);
      return proxyToAzure(
        request,
        cfg,
        path,
        target,
        JSON.stringify({ ...body, model: target.deployment }),
        { "Content-Type": "application/json" }
      );
    } catch (e) {
      return errorResponse(500, "proxy_error", e.message || String(e), request, cfg);
    }
  }
};

function loadConfig(env) {
  const mapping = parseModelMapping(env.MODEL_MAPPING || "");
  const modelList = splitCsv(env.MODEL_LIST || "");
  const clientKeys = splitCsv(env.CLIENT_API_KEYS || "");
  const allowedOrigins = splitCsv(env.ALLOWED_ORIGINS || "");
  const azureKey = (env.AZURE_API_KEY || "").trim();
  const endpoints = parseEndpoints(env);

  if (clientKeys.length > 0 && !azureKey && endpoints.some((e) => !e.key)) {
    throw new Error("AZURE_API_KEY (or a per-endpoint key in AZURE_ENDPOINTS) is required when CLIENT_API_KEYS is configured");
  }

  return {
    mapping,
    modelList: modelList.length > 0 ? modelList : DEFAULT_MODEL_LIST,
    clientKeys,
    allowedOrigins,
    azureKey,
    endpoints,
    upstreamTimeoutMs: parseUpstreamTimeoutMs(env.UPSTREAM_TIMEOUT_MS || "")
  };
}

function parseEndpoints(env) {
  const entries = (env.AZURE_ENDPOINTS || "").split(/[,\n]/).map((s) => s.trim()).filter(Boolean)
    .map((item) => {
      const [url, key = ""] = item.split("|").map((s) => s.trim());
      return { url, key, kind: endpointKind(url) };
    });
  if (env.AZURE_OAI_ENDPOINT) entries.push({ url: env.AZURE_OAI_ENDPOINT.trim(), key: "", kind: "oai" });
  if (env.AZURE_INFER_ENDPOINT) entries.push({ url: env.AZURE_INFER_ENDPOINT.trim(), key: "", kind: "infer" });

  const seen = new Set();
  const endpoints = [];
  for (const entry of entries) {
    let parsed;
    try {
      parsed = new URL(entry.url);
    } catch {
      throw new Error(`Invalid Azure endpoint URL: ${entry.url}`);
    }
    const url = stripTrailingSlash(parsed.origin + parsed.pathname);
    if (seen.has(url)) continue;
    seen.add(url);
    endpoints.push({ ...entry, url });
  }
  return endpoints;
}

// "oai" for Azure OpenAI resources, "infer" for AI Foundry, null if unknown
// (custom domain, APIM, ...), which keeps the configured order.
function endpointKind(url) {
  if (/\.(openai|cognitiveservices)\.azure\.com/i.test(url)) return "oai";
  if (/\.(services|models)\.ai\.azure\.com/i.test(url)) return "infer";
  return null;
}

function parseModelMapping(raw) {
  if (raw === cachedModelMappingRaw) return cachedModelMapping;

  if (!raw) {
    cachedModelMappingRaw = raw;
    cachedModelMapping = DEFAULT_MAPPING;
    return cachedModelMapping;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error("MODEL_MAPPING is not valid JSON: " + e.message);
  }

  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("MODEL_MAPPING must be a JSON object");
  }

  cachedModelMappingRaw = raw;
  cachedModelMapping = parsed;
  return cachedModelMapping;
}

function parseUpstreamTimeoutMs(raw) {
  if (!raw.trim()) return DEFAULT_UPSTREAM_TIMEOUT_MS;
  const timeout = Number.parseInt(raw, 10);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error("UPSTREAM_TIMEOUT_MS must be a positive integer");
  }
  return timeout;
}

function splitCsv(raw) {
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function normalizeClientPath(pathname) {
  const normalized = pathname.replace(/\/+/g, "/");
  const withoutPrefix = normalized.replace(/^\/v1(?=\/|$)/, "");
  return withoutPrefix || "/";
}

function stripTrailingSlash(s) {
  return s.replace(/\/+$/, "");
}

function checkOrigin(request, cfg) {
  if (cfg.allowedOrigins.length === 0) return null;

  const origin = request.headers.get("Origin");
  if (!origin) return null;

  if (!cfg.allowedOrigins.includes(origin)) {
    return errorResponse(403, "origin_not_allowed", "Origin is not allowed", request, cfg);
  }
  return null;
}

function checkClientAuth(request, cfg) {
  // If no CLIENT_API_KEYS configured, allow through (legacy mode: client supplies Azure key).
  if (cfg.clientKeys.length === 0) return null;

  const auth = request.headers.get("Authorization") || "";
  const key = auth.replace(/^Bearer\s+/i, "").trim();
  if (!key || !hasMatchingClientKey(key, cfg.clientKeys)) {
    return errorResponse(401, "invalid_api_key", "Invalid API key", request, cfg);
  }
  return null;
}

function hasMatchingClientKey(key, clientKeys) {
  for (const candidate of clientKeys) {
    if (timingSafeEqual(key, candidate)) return true;
  }
  return false;
}

function timingSafeEqual(a, b) {
  const left = TEXT_ENCODER.encode(a);
  const right = TEXT_ENCODER.encode(b);
  const maxLen = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;

  for (let i = 0; i < maxLen; i += 1) {
    diff |= (left[i] || 0) ^ (right[i] || 0);
  }
  return diff === 0;
}

function resolveAzureKey(request, cfg, endpoint) {
  if (endpoint.key) return endpoint.key;
  if (cfg.azureKey) return cfg.azureKey;
  const auth = request.headers.get("Authorization") || "";
  return auth.replace(/^Bearer\s+/i, "").trim();
}

function resolveModel(modelName, cfg) {
  const entry = cfg.mapping[modelName];
  const deployment = (typeof entry === "string" ? entry : entry && entry.deployment) || modelName;
  const pinned = entry && typeof entry === "object" ? entry : {};
  const backend = pinned.backend || (OAI_MODEL_PATTERN.test(deployment) ? "oai" : "infer");

  // Priority: endpoint that last served this deployment, endpoint pinned in
  // MODEL_MAPPING, endpoints of the preferred kind, then the rest in config order.
  const cached = endpointCache.get(deployment);
  const rank = (e) => {
    if (e.url === cached) return 0;
    if (pinned.endpoint && e.url.includes(stripTrailingSlash(pinned.endpoint))) return 1;
    return e.kind === backend ? 2 : 3;
  };
  const endpoints = cfg.endpoints
    .map((e, i) => ({ e, i }))
    .sort((a, b) => rank(a.e) - rank(b.e) || a.i - b.i)
    .map(({ e }) => e);
  return { deployment, endpoints };
}

async function proxyToAzure(request, cfg, path, target, body, extraHeaders = {}) {
  if (target.endpoints.length === 0) {
    return errorResponse(500, "proxy_error", "No Azure endpoint configured (set AZURE_ENDPOINTS)", request, cfg);
  }

  for (let i = 0; i < target.endpoints.length; i += 1) {
    const endpoint = target.endpoints[i];
    const azureKey = resolveAzureKey(request, cfg, endpoint);
    if (!azureKey) {
      return errorResponse(500, "proxy_error", "No Azure API key available (set AZURE_API_KEY or send Authorization header)", request, cfg);
    }

    let resp;
    try {
      resp = await fetchUpstream(cfg, `${endpoint.url}/openai/v1${path}`, azureKey, body, extraHeaders);
    } catch (e) {
      if (e && e.name === "AbortError") {
        return errorResponse(
          504,
          "upstream_timeout",
          `Azure upstream timed out after ${cfg.upstreamTimeoutMs}ms`,
          request,
          cfg
        );
      }
      throw e;
    }

    const isLast = i === target.endpoints.length - 1;
    if (!isLast && await isDeploymentMissing(resp)) {
      if (resp.body) await resp.body.cancel();
      continue;
    }
    if (resp.ok) endpointCache.set(target.deployment, endpoint.url);

    return new Response(resp.body, {
      status: resp.status,
      headers: buildClientResponseHeaders(resp.headers, request, cfg)
    });
  }
}

async function isDeploymentMissing(resp) {
  if (resp.status === 404) return true;
  if (resp.status !== 400) return false;
  const text = await resp.clone().text().catch(() => "");
  return /DeploymentNotFound|unknown_model|model_not_found|unknown model/i.test(text);
}

async function fetchUpstream(cfg, upstreamUrl, azureKey, body, extraHeaders) {
  const headers = new Headers(extraHeaders);
  headers.set("api-key", azureKey);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), cfg.upstreamTimeoutMs);

  try {
    return await fetch(upstreamUrl, {
      method: "POST",
      headers,
      body,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function proxyMultipart(request, path, cfg) {
  // Parse form to extract `model`, then rebuild with the deployment name.
  const form = await request.formData();
  const modelName = form.get("model");
  if (typeof modelName !== "string" || !modelName) {
    return errorResponse(400, "invalid_request_error", "Missing 'model' field in form", request, cfg, "model");
  }

  const target = resolveModel(modelName, cfg);
  const upstreamForm = new FormData();
  for (const [k, v] of form.entries()) {
    if (k === "model") continue;
    upstreamForm.append(k, v);
  }
  upstreamForm.append("model", target.deployment);

  return proxyToAzure(request, cfg, path, target, upstreamForm);
}

function buildClientResponseHeaders(upstreamHeaders, request, cfg) {
  const headers = new Headers();

  for (const [key, value] of upstreamHeaders.entries()) {
    if (SAFE_RESPONSE_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  }

  const corsHeaders = getCorsHeaders(request, cfg);
  for (const [key, value] of corsHeaders.entries()) {
    headers.set(key, value);
  }
  return headers;
}

function getCorsHeaders(request, cfg) {
  const headers = new Headers();
  const origin = request.headers.get("Origin");
  const allowOrigin = resolveAllowedOrigin(origin, cfg);

  if (allowOrigin) {
    headers.set("Access-Control-Allow-Origin", allowOrigin);
  }
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", request.headers.get("Access-Control-Request-Headers") || DEFAULT_CORS_ALLOW_HEADERS);
  headers.set("Access-Control-Expose-Headers", DEFAULT_CORS_EXPOSE_HEADERS);
  headers.set("Access-Control-Max-Age", "86400");

  if (cfg && cfg.allowedOrigins.length > 0) appendVary(headers, "Origin");
  if (request.headers.get("Access-Control-Request-Headers")) appendVary(headers, "Access-Control-Request-Headers");

  return headers;
}

function resolveAllowedOrigin(origin, cfg) {
  if (!cfg || cfg.allowedOrigins.length === 0) return "*";
  if (!origin) return "";
  return cfg.allowedOrigins.includes(origin) ? origin : "";
}

function appendVary(headers, value) {
  const existing = headers.get("Vary");
  if (!existing) {
    headers.set("Vary", value);
    return;
  }

  const values = existing.split(",").map((part) => part.trim()).filter(Boolean);
  if (!values.includes(value)) values.push(value);
  headers.set("Vary", values.join(", "));
}

function listModels(cfg, request) {
  const created = Math.floor(Date.now() / 1000);
  const ids = [...new Set([...Object.keys(cfg.mapping), ...cfg.modelList])];
  const data = ids.map((id) => ({ id, object: "model", created, owned_by: "azure" }));

  return new Response(JSON.stringify({ object: "list", data }, null, 2), {
    headers: buildClientResponseHeaders(new Headers({ "Content-Type": "application/json" }), request, cfg)
  });
}

function errorResponse(status, type, message, request, cfg, param = null) {
  return new Response(
    JSON.stringify({ error: { message, type, param, code: type } }),
    {
      status,
      headers: buildClientResponseHeaders(new Headers({ "Content-Type": "application/json" }), request, cfg)
    }
  );
}
