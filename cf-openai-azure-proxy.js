// Cloudflare Workers proxy: OpenAI-compatible -> Azure AI Foundry
// Supports three upstream shapes:
//   1. Classic Azure OpenAI   : {OAI}/openai/deployments/{deployment}/{endpoint}?api-version=...
//   2. Responses API          : {OAI}/openai/responses?api-version=...   (model in body, no deployment in URL)
//   3. Azure Model Inference  : {INFER}/models/{endpoint}?api-version=... (model in body, no deployment in URL)
//
// Required env vars (set in Workers dashboard -> Settings -> Variables):
//   AZURE_API_KEY            (Secret) Shared key for both resources when CLIENT_API_KEYS is enabled
//   AZURE_OAI_ENDPOINT       e.g. https://yoyo.cognitiveservices.azure.com
//   AZURE_INFER_ENDPOINT     e.g. https://waytoagi.services.ai.azure.com
//   AZURE_OAI_API_VERSION    default 2025-04-01-preview
//   AZURE_INFER_API_VERSION  default 2024-05-01-preview
//   MODEL_MAPPING            JSON string, see DEFAULT_MAPPING below
//   CLIENT_API_KEYS          comma-separated list, e.g. sk-abc,sk-def (optional but recommended)
//   ALLOWED_ORIGINS          comma-separated browser origins allowed by CORS (optional)
//   UPSTREAM_TIMEOUT_MS      timeout for upstream Azure requests in milliseconds (optional)

const DEFAULT_OAI_API_VERSION = "2025-04-01-preview";
const DEFAULT_INFER_API_VERSION = "2024-05-01-preview";
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

const DEFAULT_MAPPING = {
  // OpenAI-family on yoyo (classic + responses share the same entry;
  // the proxy picks the upstream path based on which client path was hit)
  "gpt-chat-latest":       { backend: "oai",   deployment: "gpt-5.5" },
  "gpt-5.5":               { backend: "oai",   deployment: "gpt-5.5" },
  "gpt-5.4":               { backend: "oai",   deployment: "gpt-5.4" },
  "gpt-4o":                { backend: "oai",   deployment: "gpt-4o" },
  "gpt-4o-mini":           { backend: "oai",   deployment: "gpt-4o-mini" },
  "o1":                    { backend: "oai",   deployment: "o1" },
  "o3-mini":               { backend: "oai",   deployment: "o3-mini" },

  "gpt-image-1":           { backend: "oai",   deployment: "gpt-image-1",   apiVersion: "2024-02-01" },
  "gpt-image-1.5":         { backend: "oai",   deployment: "gpt-image-1.5", apiVersion: "2024-02-01" },
  "dall-e-3":              { backend: "oai",   deployment: "dall-e-3" },

  "text-embedding-3-small":{ backend: "oai",   deployment: "text-embedding-3-small" },
  "text-embedding-3-large":{ backend: "oai",   deployment: "text-embedding-3-large" },
  "whisper-1":             { backend: "oai",   deployment: "whisper-1" },
  "tts-1":                 { backend: "oai",   deployment: "tts-1" },

  // Non-OpenAI models on waytoagi (Azure AI Model Inference)
  "grok-4-20":             { backend: "infer", deployment: "grok-4-20" },
  "grok-3":                { backend: "infer", deployment: "grok-3" },
  "deepseek-r1":           { backend: "infer", deployment: "deepseek-r1" },
  "deepseek-v3":           { backend: "infer", deployment: "deepseek-v3" },
  "llama-3.3-70b":         { backend: "infer", deployment: "llama-3.3-70b" }
};

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

      // Multipart routes (audio + image edits) — must not json-parse the body
      if (path === "/audio/transcriptions" || path === "/audio/translations" ||
          path === "/images/edits" || path === "/images/variations") {
        return proxyMultipart(request, path, cfg);
      }

      // JSON routes
      if (request.method !== "POST") {
        return errorResponse(404, "not_found", `No handler for ${request.method} ${path}`, request, cfg);
      }

      const body = await request.json().catch(() => null);
      if (!body) {
        return errorResponse(400, "invalid_request_error", "Request body must be valid JSON", request, cfg);
      }

      const modelName = body.model;
      if (!modelName) {
        return errorResponse(400, "invalid_request_error", "Missing 'model' field in request body", request, cfg, "model");
      }

      const entry = cfg.mapping[modelName];
      if (!entry) {
        return errorResponse(400, "model_not_found", `Model '${modelName}' is not mapped. Update MODEL_MAPPING env var.`, request, cfg, "model");
      }

      // Route by client path + backend
      const azureKey = resolveAzureKey(request, cfg);
      if (path === "/chat/completions") {
        return proxyChatCompletions(request, body, entry, cfg, azureKey);
      }
      if (path === "/responses") {
        return proxyResponses(request, body, entry, cfg, azureKey);
      }
      if (path === "/completions") {
        return proxyClassic(request, body, entry, cfg, "completions", azureKey);
      }
      if (path === "/embeddings") {
        if (entry.backend === "infer") return proxyInference(request, body, entry, cfg, "embeddings", azureKey);
        return proxyClassic(request, body, entry, cfg, "embeddings", azureKey);
      }
      if (path === "/images/generations") {
        return proxyClassic(request, body, entry, cfg, "images/generations", azureKey);
      }
      if (path === "/audio/speech") {
        return proxyClassic(request, body, entry, cfg, "audio/speech", azureKey);
      }

      return errorResponse(404, "not_found", `Unsupported path: ${url.pathname}`, request, cfg);
    } catch (e) {
      return errorResponse(500, "proxy_error", e.message || String(e), request, cfg);
    }
  }
};

function loadConfig(env) {
  const mapping = parseModelMapping(env.MODEL_MAPPING || "");
  const clientKeys = splitCsv(env.CLIENT_API_KEYS || "");
  const allowedOrigins = splitCsv(env.ALLOWED_ORIGINS || "");
  const azureKey = (env.AZURE_API_KEY || "").trim();

  if (clientKeys.length > 0 && !azureKey) {
    throw new Error("AZURE_API_KEY is required when CLIENT_API_KEYS is configured");
  }

  return {
    mapping,
    clientKeys,
    allowedOrigins,
    azureKey,
    oaiEndpoint: stripTrailingSlash(env.AZURE_OAI_ENDPOINT || ""),
    inferEndpoint: stripTrailingSlash(env.AZURE_INFER_ENDPOINT || ""),
    oaiApiVersion: env.AZURE_OAI_API_VERSION || DEFAULT_OAI_API_VERSION,
    inferApiVersion: env.AZURE_INFER_API_VERSION || DEFAULT_INFER_API_VERSION,
    upstreamTimeoutMs: parseUpstreamTimeoutMs(env.UPSTREAM_TIMEOUT_MS || "")
  };
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

function resolveAzureKey(request, cfg) {
  if (cfg.azureKey) return cfg.azureKey;
  const auth = request.headers.get("Authorization") || "";
  return auth.replace(/^Bearer\s+/i, "").trim();
}

async function proxyChatCompletions(request, body, entry, cfg, azureKey) {
  if (entry.backend === "infer") {
    return proxyInference(request, body, entry, cfg, "chat/completions", azureKey);
  }
  return proxyClassic(request, body, entry, cfg, "chat/completions", azureKey);
}

async function proxyResponses(request, body, entry, cfg, azureKey) {
  if (entry.backend !== "oai") {
    return errorResponse(
      400,
      "invalid_request_error",
      `Model '${body.model}' is on backend '${entry.backend}' which does not support /v1/responses`,
      request,
      cfg,
      "model"
    );
  }
  if (!cfg.oaiEndpoint) {
    return errorResponse(500, "proxy_error", "AZURE_OAI_ENDPOINT is not set", request, cfg);
  }

  const apiVersion = entry.apiVersion || cfg.oaiApiVersion;
  const upstream = `${cfg.oaiEndpoint}/openai/responses?api-version=${apiVersion}`;
  const upstreamBody = { ...body, model: entry.deployment };
  return fetchJsonUpstream(request, cfg, upstream, azureKey, upstreamBody);
}

async function proxyClassic(request, body, entry, cfg, endpoint, azureKey) {
  if (entry.backend !== "oai") {
    return errorResponse(
      400,
      "invalid_request_error",
      `Model '${body.model}' is on backend '${entry.backend}' which does not support /${endpoint}`,
      request,
      cfg,
      "model"
    );
  }
  if (!cfg.oaiEndpoint) {
    return errorResponse(500, "proxy_error", "AZURE_OAI_ENDPOINT is not set", request, cfg);
  }

  const apiVersion = entry.apiVersion || cfg.oaiApiVersion;
  const upstream = `${cfg.oaiEndpoint}/openai/deployments/${entry.deployment}/${endpoint}?api-version=${apiVersion}`;
  // Keep `model` in body as the deployment name — harmless for chat/completions,
  // required by some endpoints (e.g. gpt-image-1 images/generations).
  const upstreamBody = { ...body, model: entry.deployment };
  return fetchJsonUpstream(request, cfg, upstream, azureKey, upstreamBody);
}

async function proxyInference(request, body, entry, cfg, endpoint, azureKey) {
  if (!cfg.inferEndpoint) {
    return errorResponse(500, "proxy_error", "AZURE_INFER_ENDPOINT is not set", request, cfg);
  }

  const upstream = `${cfg.inferEndpoint}/models/${endpoint}?api-version=${cfg.inferApiVersion}`;
  const upstreamBody = { ...body, model: entry.deployment };
  return fetchJsonUpstream(request, cfg, upstream, azureKey, upstreamBody);
}

async function fetchJsonUpstream(request, cfg, upstreamUrl, azureKey, body) {
  return fetchUpstream(
    request,
    cfg,
    upstreamUrl,
    azureKey,
    JSON.stringify(body),
    { "Content-Type": "application/json" }
  );
}

async function fetchUpstream(request, cfg, upstreamUrl, azureKey, body, extraHeaders = {}) {
  if (!azureKey) {
    return errorResponse(500, "proxy_error", "No Azure API key available (set AZURE_API_KEY or send Authorization header)", request, cfg);
  }

  const headers = new Headers(extraHeaders);
  headers.set("api-key", azureKey);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), cfg.upstreamTimeoutMs);

  try {
    const resp = await fetch(upstreamUrl, {
      method: "POST",
      headers,
      body,
      signal: controller.signal
    });

    return new Response(resp.body, {
      status: resp.status,
      headers: buildClientResponseHeaders(resp.headers, request, cfg)
    });
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
  } finally {
    clearTimeout(timeoutId);
  }
}

async function proxyMultipart(request, path, cfg) {
  // Parse form to extract `model`, then rebuild (so we can still stream file parts).
  const form = await request.formData();
  const modelName = form.get("model");
  if (typeof modelName !== "string" || !modelName) {
    return errorResponse(400, "invalid_request_error", "Missing 'model' field in form", request, cfg, "model");
  }

  const entry = cfg.mapping[modelName];
  if (!entry) {
    return errorResponse(400, "model_not_found", `Model '${modelName}' is not mapped`, request, cfg, "model");
  }
  if (entry.backend !== "oai") {
    return errorResponse(400, "invalid_request_error", `Model '${modelName}' does not support /${path}`, request, cfg, "model");
  }
  if (!cfg.oaiEndpoint) {
    return errorResponse(500, "proxy_error", "AZURE_OAI_ENDPOINT is not set", request, cfg);
  }

  // Rebuild form without `model` (classic endpoint ignores it; some reject)
  const upstreamForm = new FormData();
  for (const [k, v] of form.entries()) {
    if (k === "model") continue;
    upstreamForm.append(k, v);
  }

  const apiVersion = entry.apiVersion || cfg.oaiApiVersion;
  const upstreamPath = path.replace(/^\//, "");
  const upstream = `${cfg.oaiEndpoint}/openai/deployments/${entry.deployment}/${upstreamPath}?api-version=${apiVersion}`;
  const azureKey = resolveAzureKey(request, cfg);

  return fetchUpstream(request, cfg, upstream, azureKey, upstreamForm);
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
  const data = Object.keys(cfg.mapping).map((id) => ({
    id,
    object: "model",
    created,
    owned_by: cfg.mapping[id].backend === "infer" ? "azure-inference" : "azure-openai"
  }));

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
