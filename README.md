# cf-openai-azure-proxy

<a href="./README_en.md">English</a> |
<a href="./README.md">中文</a>

> 跑在 **Cloudflare Workers** 上的代理，把 **OpenAI 兼容接口** 转成 **Azure AI Foundry** 的请求。让所有支持 OpenAI 的客户端软件都能直接用你的 Azure 模型。

## 它能做什么

Azure AI Foundry 暴露的是**三种互不相同**的 API：经典 Azure OpenAI、新版 Responses API、Azure AI Model Inference（跑 Grok / DeepSeek / Llama 等非 OpenAI 模型）。

这个代理把它们统一到 OpenAI 的 `/v1/*` 规范，任何 OpenAI 客户端（NextChat、LobeChat、Cherry Studio、ChatBox、Zed、Cursor、VS Code Copilot 替代插件等）都能直接用。

## 特性

- ✅ `/v1/chat/completions` — 自动路由到经典 chat（GPT-4o、o1、gpt-5.4…）或 Model Inference（Grok、DeepSeek、Llama…）
- ✅ `/v1/responses` — Azure OpenAI Responses API（推理模型的新调用形态）
- ✅ `/v1/embeddings` / `/v1/images/generations` / `/v1/audio/{speech,transcriptions,translations}` / `/v1/images/edits`
- ✅ `/v1/models` — 自动从 mapping 生成列表
- ✅ 客户端 API Key 白名单，Azure 密钥不暴露给客户端
- ✅ SSE 流式响应原生透传（无降速）
- ✅ 同一个 Worker 同时代理**两个 Azure 资源**（OpenAI 资源 + Model Inference 资源）

---

## 快速开始（5 分钟）

### 1. 在 Cloudflare 部署 Worker

**方式 A — 控制台粘贴**（零依赖，推荐新手）

1. 登录 [Cloudflare](https://dash.cloudflare.com) → **Workers & Pages** → **Create** → **Hello World** 模板
2. 把 [`cf-openai-azure-proxy.js`](./cf-openai-azure-proxy.js) 全部内容粘贴覆盖默认代码 → **Save and Deploy**

**方式 B — wrangler CLI**（可复现、可版本化）

```bash
npm i -g wrangler
wrangler login

# 修改 wrangler.toml 里的 AZURE_OAI_ENDPOINT / AZURE_INFER_ENDPOINT 为你自己的
wrangler secret put AZURE_API_KEY        # 粘贴 Azure key
wrangler secret put CLIENT_API_KEYS      # 粘贴 sk-xxx,sk-yyy (自己随便编)
# 可选：wrangler secret put MODEL_MAPPING

wrangler deploy
```

### 2. 配置环境变量

进入 Worker → **Settings → Variables and Secrets**，设置：

| 变量 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `AZURE_API_KEY` | Secret | ✅ | Azure Foundry 密钥 |
| `AZURE_OAI_ENDPOINT` | Text | ✅ | 例 `https://yoyo.cognitiveservices.azure.com` |
| `AZURE_INFER_ENDPOINT` | Text | 用 Grok/DeepSeek 等才必填 | 例 `https://waytoagi.services.ai.azure.com` |
| `CLIENT_API_KEYS` | Secret | 推荐 | `sk-xxx,sk-yyy`（不设则客户端可直连 Azure key） |
| `AZURE_OAI_API_VERSION` | Text | ⬜ | 默认 `2025-04-01-preview` |
| `AZURE_INFER_API_VERSION` | Text | ⬜ | 默认 `2024-05-01-preview` |
| `MODEL_MAPPING` | Secret/Text | ⬜ | JSON；不填用代码内置映射 |

### 3. 客户端接入

在任意支持 OpenAI 的软件里填：

- **Base URL** / **API 地址**：`https://<你的worker>.workers.dev/v1`
- **API Key**：`CLIENT_API_KEYS` 里你自己设的某个 `sk-xxx`

### 4. 测试一下

```bash
curl https://<你的worker>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer sk-xxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}'
```

---

## MODEL_MAPPING 详解

内置默认映射已覆盖常见模型（见 [源码顶部](./cf-openai-azure-proxy.js)）。如果你的 Azure deployment 名字和模型名不一致，或要加新模型，就通过 `MODEL_MAPPING` 环境变量覆盖。

格式：

```json
{
  "客户端看到的模型名": {
    "backend": "oai" 或 "infer",
    "deployment": "Azure 里的 deployment 名",
    "apiVersion": "可选，覆盖这个模型专用的 api-version"
  }
}
```

完整示例：

```json
{
  "gpt-5.4":                { "backend":"oai",   "deployment":"gpt-5.4" },
  "gpt-4o":                 { "backend":"oai",   "deployment":"gpt-4o" },
  "gpt-4o-mini":            { "backend":"oai",   "deployment":"gpt-4o-mini" },
  "o1":                     { "backend":"oai",   "deployment":"o1" },
  "o3-mini":                { "backend":"oai",   "deployment":"o3-mini" },
  "gpt-image-1":            { "backend":"oai",   "deployment":"gpt-image-1",   "apiVersion":"2024-02-01" },
  "gpt-image-1.5":          { "backend":"oai",   "deployment":"gpt-image-1.5", "apiVersion":"2024-02-01" },
  "dall-e-3":               { "backend":"oai",   "deployment":"dall-e-3" },
  "text-embedding-3-small": { "backend":"oai",   "deployment":"text-embedding-3-small" },
  "text-embedding-3-large": { "backend":"oai",   "deployment":"text-embedding-3-large" },
  "whisper-1":              { "backend":"oai",   "deployment":"whisper-1" },
  "tts-1":                  { "backend":"oai",   "deployment":"tts-1" },
  "grok-4-20":              { "backend":"infer", "deployment":"grok-4-20" },
  "grok-3":                 { "backend":"infer", "deployment":"grok-3" },
  "deepseek-r1":            { "backend":"infer", "deployment":"deepseek-r1" },
  "deepseek-v3":            { "backend":"infer", "deployment":"deepseek-v3" },
  "llama-3.3-70b":          { "backend":"infer", "deployment":"llama-3.3-70b" }
}
```

**backend 说明**：
- `oai` — 走 `AZURE_OAI_ENDPOINT`，支持 chat/completions + responses + images + embeddings + audio
- `infer` — 走 `AZURE_INFER_ENDPOINT`，支持 chat/completions + embeddings（Grok / DeepSeek / Llama 等）

---

## 请求路由表

| 客户端请求 | backend | 上游 URL |
|---|---|---|
| `POST /v1/chat/completions` | `oai` | `{OAI}/openai/deployments/{depl}/chat/completions` |
| `POST /v1/chat/completions` | `infer` | `{INFER}/models/chat/completions` |
| `POST /v1/responses` | `oai` | `{OAI}/openai/responses` |
| `POST /v1/completions` | `oai` | `{OAI}/openai/deployments/{depl}/completions` |
| `POST /v1/embeddings` | `oai` / `infer` | 同上两种形态之一 |
| `POST /v1/images/generations` | `oai` | `{OAI}/openai/deployments/{depl}/images/generations` |
| `POST /v1/images/edits` | `oai` | 同上（multipart 透传） |
| `POST /v1/audio/speech` | `oai` | `{OAI}/openai/deployments/{depl}/audio/speech` |
| `POST /v1/audio/transcriptions` | `oai` | 同上（multipart 透传） |
| `POST /v1/audio/translations` | `oai` | 同上（multipart 透传） |
| `GET /v1/models` | — | 本地从 mapping 生成 |

---

## FAQ / 常见问题

**Q：需要服务器吗？**
不需要。Cloudflare Workers 是 Serverless，免费额度 10 万请求/天，个人使用绰绰有余。

**Q：`404 Deployment Not Found`？**
`MODEL_MAPPING` 里的 `deployment` 和 Azure Foundry 控制台里的实际 deployment 名字不一致。到 Foundry → **Deployments** 页核对名字。

**Q：`/v1/responses` 报 404？**
你的 Azure OpenAI 资源没开 Next-gen v1 API 功能。去 Azure Portal → OpenAI 资源 → **Features** 里开启。

**Q：`gpt-image-1.5` 报 `Unsupported api-version`？**
gpt-image 系列需要特定 api-version，已在默认 mapping 里设 `"apiVersion":"2024-02-01"`。如果你在 Foundry 里看到的是别的版本，就在 `MODEL_MAPPING` 里覆盖。

**Q：两个 Azure 资源 key 不同怎么办？**
当前版本共用一个 `AZURE_API_KEY`。如果需要两个 key，改一下代码里 `doFetch` 的 key 来源（按 backend 分）即可。

**Q：想让客户端软件发现所有可用模型？**
大多数软件会请求 `/v1/models`。代理会自动从 `MODEL_MAPPING` 生成列表，客户端可直接看到。

**Q：流式响应不工作？**
Cloudflare Workers 原生支持 SSE 透传。如果客户端收不到流，检查：① 客户端是否真的发了 `"stream":true`；② Worker 前是否有自定义域名 + CDN 缓存（应关闭该路径的缓存）。

**Q：代理会存请求日志吗？**
代码本身不存。Cloudflare Workers 的 observability 面板可以看到实时日志（已在 `wrangler.toml` 开启）。

---

## License

MIT
