# cf-openai-azure-proxy

<a href="./README_en.md">English</a> |
<a href="./README.md">中文</a>

> 一个跑在 Cloudflare Workers 上的代理，把 **OpenAI 兼容接口** 转到 **Azure AI Foundry**。支持三种上游形态：经典 Azure OpenAI、Responses API、Azure AI Model Inference（Grok/DeepSeek/Llama 等）。

## 特性

- ✅ `/v1/chat/completions` — 经典 chat（GPT-4o、o1 等）+ Model Inference（Grok、DeepSeek 等）
- ✅ `/v1/responses` — Azure OpenAI Responses API（gpt-5.4 等）
- ✅ `/v1/completions`、`/v1/embeddings`、`/v1/images/generations`、`/v1/audio/{speech,transcriptions,translations}`、`/v1/images/edits`
- ✅ `/v1/models` — 根据 `MODEL_MAPPING` 自动列出
- ✅ 客户端 API Key 白名单（`CLIENT_API_KEYS`），Azure 密钥不暴露给客户端
- ✅ 流式响应原生透传（SSE）
- ✅ 支持同一个 Worker 同时代理**两个 Azure 资源**（一个 OpenAI、一个 Model Inference）

## 部署

### 方式一：控制台粘贴

1. 登录 Cloudflare → Workers & Pages → Create Worker
2. 把 [`cf-openai-azure-proxy.js`](./cf-openai-azure-proxy.js) 整个内容粘贴进去
3. 部署后进入 **Settings → Variables**，配置下面的环境变量
4. 可选：绑定自定义域名

### 方式二：wrangler CLI

```bash
npm i -g wrangler
wrangler login

# 编辑 wrangler.toml 里的 endpoint
wrangler secret put AZURE_API_KEY       # 粘贴你的 Azure key
wrangler secret put CLIENT_API_KEYS     # 粘贴 sk-xxx,sk-yyy
wrangler secret put MODEL_MAPPING       # 粘贴 JSON 字符串

wrangler deploy
```

## 环境变量

| 变量 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `AZURE_API_KEY` | Secret | ✅ | Azure Foundry 密钥（两个资源共用） |
| `AZURE_OAI_ENDPOINT` | Var | ✅ | Azure OpenAI 资源根 URL，例如 `https://yoyo.cognitiveservices.azure.com` |
| `AZURE_INFER_ENDPOINT` | Var | 用到 Grok/DeepSeek 等才必填 | 例如 `https://waytoagi.services.ai.azure.com` |
| `AZURE_OAI_API_VERSION` | Var | ⬜ | 默认 `2025-04-01-preview` |
| `AZURE_INFER_API_VERSION` | Var | ⬜ | 默认 `2024-05-01-preview` |
| `MODEL_MAPPING` | Var/Secret | ⬜ | JSON 字符串；不填则用代码内置默认映射 |
| `CLIENT_API_KEYS` | Secret | ⬜ | 逗号分隔的客户端 key；不填则透传客户端 Authorization 直连 Azure |

### `MODEL_MAPPING` 示例

```json
{
  "gpt-5.4":        { "backend": "oai",   "deployment": "gpt-5.4" },
  "gpt-4o":         { "backend": "oai",   "deployment": "gpt-4o" },
  "gpt-image-1.5":  { "backend": "oai",   "deployment": "gpt-image-1.5", "apiVersion": "2024-02-01" },
  "dall-e-3":       { "backend": "oai",   "deployment": "dall-e-3" },
  "text-embedding-3-small": { "backend": "oai", "deployment": "text-embedding-3-small" },
  "whisper-1":      { "backend": "oai",   "deployment": "whisper" },

  "grok-4-20":      { "backend": "infer", "deployment": "grok-4-20" },
  "deepseek-r1":    { "backend": "infer", "deployment": "DeepSeek-R1" },
  "deepseek-v3":    { "backend": "infer", "deployment": "DeepSeek-V3" }
}
```

字段说明：
- `backend`：`oai` 走 `AZURE_OAI_ENDPOINT`（支持 chat/completions + responses + images + embeddings + audio）；`infer` 走 `AZURE_INFER_ENDPOINT`（仅支持 chat/completions + embeddings）
- `deployment`：你在 Azure Foundry 里创建 deployment 时填的名字
- `apiVersion`：可选，覆盖这个模型专用的 api-version（比如 `gpt-image-1.5` 用 `2024-02-01`）

## 客户端接入

在任何支持 OpenAI API 的软件里：

- **Base URL**：`https://<your-worker>.workers.dev/v1`
- **API Key**：`CLIENT_API_KEYS` 里你自己设的那个 `sk-xxx`（如果没开白名单，就填 Azure key）

对于支持 Responses API 的客户端（新版 Cherry Studio、ChatWise、OpenAI SDK ≥ 1.x 的 responses 调用），同一个 base URL 即可，`model` 填 `gpt-5.4` 这种，走的是 `/v1/responses`。

## 请求路由表

| 客户端请求 | Model 在 mapping 的 backend | 上游 URL |
|---|---|---|
| `POST /v1/chat/completions` | `oai` | `{OAI}/openai/deployments/{depl}/chat/completions` |
| `POST /v1/chat/completions` | `infer` | `{INFER}/models/chat/completions` |
| `POST /v1/responses` | `oai` | `{OAI}/openai/responses` |
| `POST /v1/images/generations` | `oai` | `{OAI}/openai/deployments/{depl}/images/generations` |
| `POST /v1/embeddings` | `oai` / `infer` | 同上两种之一 |
| `POST /v1/audio/*` | `oai` | `{OAI}/openai/deployments/{depl}/audio/*`（multipart 透传） |
| `GET /v1/models` | — | 本地从 mapping 生成 |

## License

MIT
