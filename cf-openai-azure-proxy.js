// Cloudflare Workers proxy: OpenAI-compatible -> Azure AI Foundry
// Supports three upstream shapes:
//   1. Classic Azure OpenAI   : {OAI}/openai/deployments/{deployment}/{endpoint}?api-version=...
//   2. Responses API          : {OAI}/openai/responses?api-version=...   (model in body, no deployment in URL)
//   3. Azure Model Inference  : {INFER}/models/{endpoint}?api-version=... (model in body, no deployment in URL)
//
// Required env vars (set in Workers dashboard -> Settings -> Variables):
//   AZURE_API_KEY            (Secret) Shared key for both resources
//   AZURE_OAI_ENDPOINT       e.g. https://yoyo.cognitiveservices.azure.com
//   AZURE_INFER_ENDPOINT     e.g. https://waytoagi.services.ai.azure.com
//   AZURE_OAI_API_VERSION    default 2025-04-01-preview
//   AZURE_INFER_API_VERSION  default 2024-05-01-preview
//   MODEL_MAPPING            JSON string, see DEFAULT_MAPPING below
//   CLIENT_API_KEYS          comma-separated list, e.g. sk-abc,sk-def (optional but recommended)

const DEFAULT_MAPPING = {
  // OpenAI-family on yoyo (classic + responses share the same entry;
  // the proxy picks the upstream path based on which client path was hit)
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

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*"
};

export default {
  async fetch(request, env) {
    try {
      if (request.method === "OPTIONS") {
        return new Response(null, { headers: CORS_HEADERS });
      }

      const cfg = loadConfig(env);
      const url = new URL(request.url);
      let path = url.pathname.replace(/\/+/g, "/");
      if (path.startsWith("/v1/")) path = path.slice(3);

      // Client auth
      const authErr = checkClientAuth(request, cfg);
      if (authErr) return authErr;

      // Routes that don't need model lookup
      if (path === "/models" && request.method === "GET") {
        return listModels(cfg);
      }

      // Multipart routes (audio + image edits) — must not json-parse the body
      if (path === "/audio/transcriptions" || path === "/audio/translations" ||
          path === "/images/edits" || path === "/images/variations") {
        return proxyMultipart(request, path, cfg);
      }

      // JSON routes
      if (request.method !== "POST") {
        return errorResponse(404, "not_found", `No handler for ${request.method} ${path}`);
      }

      const body = await request.json().catch(() => null);
      if (!body) return errorResponse(400, "invalid_request_error", "Request body must be valid JSON");

      const modelName = body.model;
      if (!modelName) return errorResponse(400, "invalid_request_error", "Missing 'model' field in request body");

      const entry = cfg.mapping[modelName];
      if (!entry) return errorResponse(400, "model_not_found", `Model '${modelName}' is not mapped. Update MODEL_MAPPING env var.`);

      // Route by client path + backend
      const azureKey = resolveAzureKey(request, cfg);
      if (path === "/chat/completions") {
        return proxyChatCompletions(body, entry, cfg, azureKey);
      }
      if (path === "/responses") {
        return proxyResponses(body, entry, cfg, azureKey);
      }
      if (path === "/completions") {
        return proxyClassic(body, entry, cfg, "completions", azureKey);
      }
      if (path === "/embeddings") {
        if (entry.backend === "infer") return proxyInference(body, entry, cfg, "embeddings", azureKey);
        return proxyClassic(body, entry, cfg, "embeddings", azureKey);
      }
      if (path === "/images/generations") {
        return proxyClassic(body, entry, cfg, "images/generations", azureKey);
      }
      if (path === "/audio/speech") {
        return proxyClassic(body, entry, cfg, "audio/speech", azureKey);
      }

      return errorResponse(404, "not_found", `Unsupported path: ${url.pathname}`);
    } catch (e) {
      return errorResponse(500, "proxy_error", e.message || String(e));
    }
  }
};

function loadConfig(env) {
  let mapping = DEFAULT_MAPPING;
  if (env.MODEL_MAPPING) {
    try {
      mapping = JSON.parse(env.MODEL_MAPPING);
    } catch (e) {
      throw new Error("MODEL_MAPPING is not valid JSON: " + e.message);
    }
  }

  const clientKeys = (env.CLIENT_API_KEYS || "")
    .split(",").map(s => s.trim()).filter(Boolean);

  return {
    mapping,
    clientKeys,
    azureKey: env.AZURE_API_KEY || "",
    oaiEndpoint: stripTrailingSlash(env.AZURE_OAI_ENDPOINT || ""),
    inferEndpoint: stripTrailingSlash(env.AZURE_INFER_ENDPOINT || ""),
    oaiApiVersion: env.AZURE_OAI_API_VERSION || "2025-04-01-preview",
    inferApiVersion: env.AZURE_INFER_API_VERSION || "2024-05-01-preview"
  };
}

function stripTrailingSlash(s) { return s.replace(/\/+$/, ""); }

function checkClientAuth(request, cfg) {
  // If no CLIENT_API_KEYS configured, allow through (legacy mode: client supplies Azure key).
  if (cfg.clientKeys.length === 0) return null;
  const auth = request.headers.get("Authorization") || "";
  const key = auth.replace(/^Bearer\s+/i, "").trim();
  if (!key || !cfg.clientKeys.includes(key)) {
    return errorResponse(401, "invalid_api_key", "Invalid API key");
  }
  return null;
}

function resolveAzureKey(request, cfg) {
  if (cfg.azureKey) return cfg.azureKey;
  const auth = request.headers.get("Authorization") || "";
  return auth.replace(/^Bearer\s+/i, "").trim();
}

async function proxyChatCompletions(body, entry, cfg, azureKey) {
  if (entry.backend === "infer") {
    return proxyInference(body, entry, cfg, "chat/completions", azureKey);
  }
  return proxyClassic(body, entry, cfg, "chat/completions", azureKey);
}

async function proxyResponses(body, entry, cfg, azureKey) {
  if (entry.backend !== "oai") {
    return errorResponse(400, "invalid_request_error",
      `Model '${body.model}' is on backend '${entry.backend}' which does not support /v1/responses`);
  }
  const apiVersion = entry.apiVersion || cfg.oaiApiVersion;
  const upstream = `${cfg.oaiEndpoint}/openai/responses?api-version=${apiVersion}`;
  const upstreamBody = { ...body, model: entry.deployment };
  return doFetch(upstream, upstreamBody, azureKey);
}

async function proxyClassic(body, entry, cfg, endpoint, azureKey) {
  if (entry.backend !== "oai") {
    return errorResponse(400, "invalid_request_error",
      `Model '${body.model}' is on backend '${entry.backend}' which does not support /${endpoint}`);
  }
  const apiVersion = entry.apiVersion || cfg.oaiApiVersion;
  const upstream = `${cfg.oaiEndpoint}/openai/deployments/${entry.deployment}/${endpoint}?api-version=${apiVersion}`;
  // Keep `model` in body as the deployment name — harmless for chat/completions,
  // required by some endpoints (e.g. gpt-image-1 images/generations).
  const upstreamBody = { ...body, model: entry.deployment };
  return doFetch(upstream, upstreamBody, azureKey);
}

async function proxyInference(body, entry, cfg, endpoint, azureKey) {
  if (!cfg.inferEndpoint) {
    return errorResponse(500, "proxy_error", "AZURE_INFER_ENDPOINT is not set");
  }
  const upstream = `${cfg.inferEndpoint}/models/${endpoint}?api-version=${cfg.inferApiVersion}`;
  const upstreamBody = { ...body, model: entry.deployment };
  return doFetch(upstream, upstreamBody, azureKey);
}

async function doFetch(upstreamUrl, body, azureKey) {
  if (!azureKey) {
    return errorResponse(500, "proxy_error", "No Azure API key available (set AZURE_API_KEY or send Authorization header)");
  }
  const resp = await fetch(upstreamUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": azureKey,
      "Authorization": `Bearer ${azureKey}`
    },
    body: JSON.stringify(body)
  });

  const headers = new Headers(resp.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  // Streams: let Workers pipe the body through natively.
  return new Response(resp.body, { status: resp.status, headers });
}

async function proxyMultipart(request, path, cfg) {
  // Parse form to extract `model`, then rebuild (so we can still stream file parts).
  const form = await request.formData();
  const modelName = form.get("model");
  if (!modelName) return errorResponse(400, "invalid_request_error", "Missing 'model' field in form");
  const entry = cfg.mapping[modelName];
  if (!entry) return errorResponse(400, "model_not_found", `Model '${modelName}' is not mapped`);
  if (entry.backend !== "oai") {
    return errorResponse(400, "invalid_request_error", `Model '${modelName}' does not support /${path}`);
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

  const resp = await fetch(upstream, {
    method: "POST",
    headers: { "api-key": azureKey, "Authorization": `Bearer ${azureKey}` },
    body: upstreamForm
  });
  const headers = new Headers(resp.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(resp.body, { status: resp.status, headers });
}

function listModels(cfg) {
  const data = Object.keys(cfg.mapping).map(id => ({
    id,
    object: "model",
    created: 1677610602,
    owned_by: cfg.mapping[id].backend === "infer" ? "azure-inference" : "azure-openai"
  }));
  return new Response(JSON.stringify({ object: "list", data }, null, 2), {
    headers: { "Content-Type": "application/json", ...CORS_HEADERS }
  });
}

function errorResponse(status, type, message) {
  return new Response(
    JSON.stringify({ error: { message, type, code: type } }),
    { status, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
  );
}
