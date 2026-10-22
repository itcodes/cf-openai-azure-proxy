import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../cf-openai-azure-proxy.js";

const OAI = "https://oai.example.com";
const INFER = "https://infer.example.com";
const ENV = {
  AZURE_API_KEY: "azure-key",
  AZURE_OAI_ENDPOINT: OAI,
  AZURE_INFER_ENDPOINT: INFER,
  CLIENT_API_KEYS: "sk-test"
};

let calls;
let responder;
let logs;

beforeEach(() => {
  calls = [];
  logs = [];
  console.log = (line) => logs.push(JSON.parse(line));
  responder = () => Response.json({ ok: true });
  globalThis.fetch = async (url, init) => {
    const call = { url, init, body: init.body };
    calls.push(call);
    return responder(call);
  };
});

function post(path, body, headers = {}) {
  return new Request(`https://proxy.example.com${path}`, {
    method: "POST",
    headers: { Authorization: "Bearer sk-test", "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

const sentModel = (call) => JSON.parse(call.body).model;

test("unmapped OpenAI-family model passes through to the OAI resource", async () => {
  const resp = await worker.fetch(post("/v1/chat/completions", { model: "gpt-9", messages: [] }), ENV);
  assert.equal(resp.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${OAI}/openai/v1/chat/completions`);
  assert.equal(sentModel(calls[0]), "gpt-9");
  assert.equal(calls[0].init.headers.get("api-key"), "azure-key");
});

test("non-OpenAI model goes to the inference resource first", async () => {
  await worker.fetch(post("/v1/chat/completions", { model: "grok-9" }), ENV);
  assert.equal(calls[0].url, `${INFER}/openai/v1/chat/completions`);
});

const ALIAS_ENV = { ...ENV, MODEL_MAPPING: JSON.stringify({ "gpt-chat-latest": "gpt-5.5" }) };

test("MODEL_MAPPING alias is rewritten to its deployment", async () => {
  await worker.fetch(post("/v1/responses", { model: "gpt-chat-latest", input: "hi" }), ALIAS_ENV);
  assert.equal(calls[0].url, `${OAI}/openai/v1/responses`);
  assert.equal(sentModel(calls[0]), "gpt-5.5");
});

test("MODEL_MAPPING object entry can pin the backend", async () => {
  const env = { ...ENV, MODEL_MAPPING: JSON.stringify({ mine: { deployment: "gpt-x", backend: "infer" } }) };
  await worker.fetch(post("/v1/chat/completions", { model: "mine" }), env);
  assert.equal(calls[0].url, `${INFER}/openai/v1/chat/completions`);
  assert.equal(sentModel(calls[0]), "gpt-x");
});

test("missing deployment falls back to the other resource and is remembered", async () => {
  responder = ({ url }) => url.startsWith(OAI)
    ? Response.json({ error: { code: "DeploymentNotFound" } }, { status: 404 })
    : Response.json({ ok: true });

  const first = await worker.fetch(post("/v1/chat/completions", { model: "gpt-oss-1" }), ENV);
  assert.equal(first.status, 200);
  assert.deepEqual(calls.map((c) => c.url.split("/openai")[0]), [OAI, INFER]);

  calls = [];
  await worker.fetch(post("/v1/chat/completions", { model: "gpt-oss-1" }), ENV);
  assert.deepEqual(calls.map((c) => c.url.split("/openai")[0]), [INFER]);
});

test("unknown-model 400 triggers fallback, other 400s do not", async () => {
  responder = ({ url }) => url.startsWith(INFER)
    ? Response.json({ error: { code: "unknown_model" } }, { status: 400 })
    : Response.json({ ok: true });
  const resp = await worker.fetch(post("/v1/chat/completions", { model: "mystery-1" }), ENV);
  assert.equal(resp.status, 200);
  assert.equal(calls.length, 2);

  calls = [];
  responder = () => Response.json({ error: { code: "invalid_prompt" } }, { status: 400 });
  const bad = await worker.fetch(post("/v1/chat/completions", { model: "mystery-2" }), ENV);
  assert.equal(bad.status, 400);
  assert.equal(calls.length, 1);
  assert.equal((await bad.json()).error.code, "invalid_prompt");
});

test("last resource's 404 is returned to the client", async () => {
  responder = () => Response.json({ error: { code: "DeploymentNotFound" } }, { status: 404 });
  const resp = await worker.fetch(post("/v1/chat/completions", { model: "nowhere" }), ENV);
  assert.equal(resp.status, 404);
  assert.equal(calls.length, 2);
  assert.equal((await resp.json()).error.code, "DeploymentNotFound");
});

test("only one endpoint configured means no fallback", async () => {
  responder = () => new Response("nope", { status: 404 });
  const env = { ...ENV, AZURE_INFER_ENDPOINT: "" };
  await worker.fetch(post("/v1/chat/completions", { model: "grok-9" }), env);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${OAI}/openai/v1/chat/completions`);
});

test("multipart requests send the deployment name in the form", async () => {
  const form = new FormData();
  form.append("model", "gpt-chat-latest");
  form.append("file", new Blob(["audio"]), "a.wav");
  const req = new Request("https://proxy.example.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: "Bearer sk-test" },
    body: form
  });
  await worker.fetch(req, ALIAS_ENV);
  assert.equal(calls[0].url, `${OAI}/openai/v1/audio/transcriptions`);
  assert.equal(calls[0].body.get("model"), "gpt-5.5");
  assert.ok(calls[0].body.get("file"));
});

test("upstream headers are filtered", async () => {
  responder = () => new Response("{}", {
    headers: { "content-type": "application/json", "x-ms-region": "eastus", "x-ratelimit-remaining-tokens": "10" }
  });
  const resp = await worker.fetch(post("/v1/embeddings", { model: "text-embedding-3-small", input: "x" }), ENV);
  assert.equal(resp.headers.get("x-ms-region"), null);
  assert.equal(resp.headers.get("x-ratelimit-remaining-tokens"), "10");
});

test("upstream timeout returns 504", async () => {
  globalThis.fetch = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
  const resp = await worker.fetch(post("/v1/chat/completions", { model: "gpt-9" }), { ...ENV, UPSTREAM_TIMEOUT_MS: "10" });
  assert.equal(resp.status, 504);
});

test("invalid client key is rejected before any upstream call", async () => {
  const resp = await worker.fetch(post("/v1/chat/completions", { model: "gpt-9" }, { Authorization: "Bearer wrong" }), ENV);
  assert.equal(resp.status, 401);
  assert.equal(calls.length, 0);
});

test("unsupported path is a 404", async () => {
  const resp = await worker.fetch(post("/v1/openai/deployments/x/chat/completions", { model: "gpt-9" }), ENV);
  assert.equal(resp.status, 404);
  assert.equal(calls.length, 0);
});

test("GET /v1/models lists aliases plus MODEL_LIST", async () => {
  const req = () => new Request("https://proxy.example.com/v1/models", { headers: { Authorization: "Bearer sk-test" } });
  const ids = async (env) => (await (await worker.fetch(req(), env)).json()).data.map((m) => m.id);
  assert.deepEqual(await ids({ ...ENV, MODEL_LIST: "a,b" }), ["a", "b"]);
  assert.deepEqual(await ids({ ...ALIAS_ENV, MODEL_LIST: "a,b" }), ["gpt-chat-latest", "a", "b"]);
});

const A = "https://a.openai.azure.com";
const B = "https://b.cognitiveservices.azure.com";
const F = "https://f.services.ai.azure.com";
const MULTI = {
  CLIENT_API_KEYS: "sk-test",
  AZURE_ENDPOINTS: `${F}|key-f, ${A}/|key-a\n${B}|key-b`
};
const hosts = () => calls.map((c) => c.url.split("/openai")[0]);

test("AZURE_ENDPOINTS: OpenAI-family models try OpenAI resources first, each with its own key", async () => {
  responder = () => Response.json({ error: { code: "DeploymentNotFound" } }, { status: 404 });
  await worker.fetch(post("/v1/chat/completions", { model: "gpt-multi-1" }), MULTI);
  assert.deepEqual(hosts(), [A, B, F]);
  assert.deepEqual(calls.map((c) => c.init.headers.get("api-key")), ["key-a", "key-b", "key-f"]);
});

test("AZURE_ENDPOINTS: other models try Foundry resources first", async () => {
  responder = () => Response.json({ error: { code: "DeploymentNotFound" } }, { status: 404 });
  await worker.fetch(post("/v1/chat/completions", { model: "grok-multi-1" }), MULTI);
  assert.deepEqual(hosts(), [F, A, B]);
});

test("AZURE_ENDPOINTS: the resource that served a deployment is tried first next time", async () => {
  responder = ({ url }) => url.startsWith(B)
    ? Response.json({ ok: true })
    : Response.json({ error: { code: "DeploymentNotFound" } }, { status: 404 });
  await worker.fetch(post("/v1/chat/completions", { model: "gpt-multi-2" }), MULTI);
  assert.deepEqual(hosts(), [A, B]);

  calls = [];
  await worker.fetch(post("/v1/chat/completions", { model: "gpt-multi-2" }), MULTI);
  assert.deepEqual(hosts(), [B]);
});

test("MODEL_MAPPING endpoint pins a specific resource", async () => {
  const env = { ...MULTI, MODEL_MAPPING: JSON.stringify({ special: { deployment: "gpt-x", endpoint: "b.cognitiveservices" } }) };
  await worker.fetch(post("/v1/chat/completions", { model: "special" }), env);
  assert.deepEqual(hosts(), [B]);
});

test("AZURE_ENDPOINTS entries without a key fall back to AZURE_API_KEY, legacy vars are appended", async () => {
  responder = () => Response.json({ error: { code: "DeploymentNotFound" } }, { status: 404 });
  const env = { CLIENT_API_KEYS: "sk-test", AZURE_API_KEY: "shared", AZURE_ENDPOINTS: A, AZURE_INFER_ENDPOINT: F };
  await worker.fetch(post("/v1/chat/completions", { model: "gpt-multi-3" }), env);
  assert.deepEqual(hosts(), [A, F]);
  assert.deepEqual(calls.map((c) => c.init.headers.get("api-key")), ["shared", "shared"]);
});

test("CLIENT_API_KEYS requires a key for every endpoint", async () => {
  const resp = await worker.fetch(post("/v1/chat/completions", { model: "gpt-9" }), { CLIENT_API_KEYS: "sk-test", AZURE_ENDPOINTS: `${A}|k,${B}` });
  assert.equal(resp.status, 500);
  assert.match((await resp.json()).error.message, /AZURE_API_KEY/);
  assert.equal(calls.length, 0);
});

test("invalid endpoint URL is a config error", async () => {
  const resp = await worker.fetch(post("/v1/chat/completions", { model: "gpt-9" }), { AZURE_API_KEY: "k", AZURE_ENDPOINTS: "not a url" });
  assert.equal(resp.status, 500);
  assert.match((await resp.json()).error.message, /Invalid Azure endpoint URL/);
});

const hostsOf = () => calls.map((c) => c.url.split("/openai")[0]);
const notFound = () => Response.json({ error: { code: "DeploymentNotFound" } }, { status: 404 });

test("429 on one resource fails over to the next", async () => {
  responder = ({ url }) => url.startsWith(OAI)
    ? Response.json({ error: { code: "429" } }, { status: 429, headers: { "retry-after": "5" } })
    : Response.json({ ok: true });
  const resp = await worker.fetch(post("/v1/responses", { model: "gpt-busy-1", input: "hi" }), ENV);
  assert.equal(resp.status, 200);
  assert.deepEqual(hostsOf(), [OAI, INFER]);
});

test("5xx followed by a missing deployment returns the 5xx, not the 404", async () => {
  responder = ({ url }) => url.startsWith(OAI)
    ? Response.json({ error: { code: "ServiceUnavailable" } }, { status: 503 })
    : notFound();
  const resp = await worker.fetch(post("/v1/chat/completions", { model: "gpt-busy-2" }), ENV);
  assert.equal(resp.status, 503);
  assert.equal((await resp.json()).error.code, "ServiceUnavailable");
});

test("429 with a single resource is returned as-is", async () => {
  responder = () => Response.json({ error: { code: "429" } }, { status: 429, headers: { "retry-after": "7" } });
  const resp = await worker.fetch(post("/v1/chat/completions", { model: "gpt-busy-3" }), { ...ENV, AZURE_INFER_ENDPOINT: "" });
  assert.equal(resp.status, 429);
  assert.equal(resp.headers.get("retry-after"), "7");
  assert.equal(calls.length, 1);
});

test("network error on one resource fails over to the next", async () => {
  responder = ({ url }) => {
    if (url.startsWith(OAI)) throw new TypeError("fetch failed");
    return Response.json({ ok: true });
  };
  const resp = await worker.fetch(post("/v1/chat/completions", { model: "gpt-busy-4" }), ENV);
  assert.equal(resp.status, 200);
  assert.deepEqual(logs.at(-1).attempts, ["oai.example.com:network_error", "infer.example.com:200"]);
});

test("a rate-limited resource is not remembered as the working one", async () => {
  responder = ({ url }) => url.startsWith(OAI) ? new Response("busy", { status: 429 }) : Response.json({ ok: true });
  await worker.fetch(post("/v1/chat/completions", { model: "gpt-busy-5" }), ENV);
  calls = [];
  responder = () => Response.json({ ok: true });
  await worker.fetch(post("/v1/chat/completions", { model: "gpt-busy-5" }), ENV);
  assert.deepEqual(hostsOf(), [INFER]);
});

test("each upstream request logs one line without keys or content", async () => {
  responder = ({ url }) => url.startsWith(OAI) ? notFound() : Response.json({ ok: true });
  const env = { ...ENV, CLIENT_API_KEYS: "sk-other,sk-test" };
  await worker.fetch(post("/v1/chat/completions", { model: "gpt-log-1", messages: [{ role: "user", content: "secret prompt" }] }), env);
  assert.equal(logs.length, 1);
  const line = logs[0];
  assert.equal(line.path, "/chat/completions");
  assert.equal(line.model, "gpt-log-1");
  assert.equal(line.client, "key#2");
  assert.equal(line.status, 200);
  assert.equal(line.endpoint, "infer.example.com");
  assert.deepEqual(line.attempts, ["oai.example.com:404", "infer.example.com:200"]);
  assert.equal(typeof line.ttfb_ms, "number");
  const raw = JSON.stringify(line);
  assert.ok(!raw.includes("sk-test") && !raw.includes("azure-key") && !raw.includes("secret prompt"));
});

test("rejected client keys are logged", async () => {
  await worker.fetch(post("/v1/chat/completions", { model: "gpt-9" }, { Authorization: "Bearer wrong" }), ENV);
  assert.deepEqual(logs, [{ path: "/chat/completions", status: 401, error: "invalid_client_key" }]);
});
