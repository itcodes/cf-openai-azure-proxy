# cf-openai-azure-proxy

<a href="./README_en.md">English</a> |
<a href="./README.md">中文</a>

> 一个运行在 Cloudflare Workers 上的 OpenAI 兼容代理。它把客户端发来的 `/v1/*` 请求转成 Azure OpenAI / Azure AI Foundry 可接受的上游请求，让只支持 OpenAI API 的客户端也能接入 Azure 上部署的模型。

## 这个项目做什么

很多客户端只支持 OpenAI 风格接口，但不直接支持 Azure OpenAI / Azure AI Foundry。本项目提供一个很轻量的协议转换层：

- 客户端继续按 OpenAI 方式请求 `/v1/chat/completions`、`/v1/responses`、`/v1/embeddings` 等接口
- Cloudflare Worker 根据 `model` 字段查找映射关系
- 再把请求转发到 Azure OpenAI 或 Azure AI Model Inference

它是一个无状态代理，不是聊天应用本体，也不包含数据库、计费、用户系统或管理后台。

## 当前支持的能力

- OpenAI 兼容入口
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
- Azure OpenAI 经典接口
  - `/openai/deployments/{deployment}/*`
- Azure OpenAI Responses API
  - `/openai/responses`
- Azure AI Model Inference
  - `/models/*`
- SSE 流式透传
- 简单客户端鉴权
  - 用 `CLIENT_API_KEYS` 给你的 Worker 再包一层访问控制

## 支持的模型类型

默认映射里已经给了这些示例：

- GPT 系列
  - `gpt-5.4`
  - `gpt-4o`
  - `gpt-4o-mini`
  - `o1`
  - `o3-mini`
- 图像
  - `gpt-image-1`
  - `gpt-image-1.5`
  - `dall-e-3`
- Embeddings
  - `text-embedding-3-small`
  - `text-embedding-3-large`
- 语音
  - `whisper-1`
  - `tts-1`
- Azure AI Foundry 第三方模型
  - `grok-4-20`
  - `grok-3`
  - `deepseek-r1`
  - `deepseek-v3`
  - `llama-3.3-70b`

实际可用模型取决于你在 Azure 中部署了什么，以及 `MODEL_MAPPING` 如何配置。

## 工作方式

请求链路如下：

```text
OpenAI-compatible client
  -> /v1/chat/completions | /v1/responses | /v1/embeddings | ...
  -> Cloudflare Worker
  -> 校验 Authorization / CLIENT_API_KEYS
  -> 读取 body.model
  -> 根据 MODEL_MAPPING 找到 backend + deployment
  -> 转发到对应 Azure 上游
     - backend=oai   -> {AZURE_OAI_ENDPOINT}/openai/...
     - backend=infer -> {AZURE_INFER_ENDPOINT}/models/...
  -> 把响应原样返回给客户端
```

## 环境变量

在 Cloudflare Workers 的 Variables / Secrets 中配置：

| 变量 | 必填 | 说明 |
|---|---|---|
| `AZURE_API_KEY` | 推荐 | Azure API Key。设置后，Worker 用它访问 Azure |
| `AZURE_OAI_ENDPOINT` | 使用 Azure OpenAI 时必填 | 例如 `https://your-resource.cognitiveservices.azure.com` |
| `AZURE_INFER_ENDPOINT` | 使用 Azure AI Model Inference 时必填 | 例如 `https://your-project.services.ai.azure.com` |
| `CLIENT_API_KEYS` | 推荐 | 逗号分隔，作为客户端访问你这个代理时使用的 key |
| `AZURE_OAI_API_VERSION` | 否 | 默认 `2025-04-01-preview` |
| `AZURE_INFER_API_VERSION` | 否 | 默认 `2024-05-01-preview` |
| `MODEL_MAPPING` | 否 | JSON 字符串；不填时使用代码内置默认映射 |

说明：

- 如果设置了 `CLIENT_API_KEYS`，客户端必须用其中某个 key 访问 Worker
- 如果没有设置 `CLIENT_API_KEYS`，Worker 会放行客户端请求
- 如果同时也没有设置 `AZURE_API_KEY`，则会尝试把客户端 `Authorization: Bearer ...` 当作 Azure key 继续透传

## MODEL_MAPPING 格式

`MODEL_MAPPING` 是一个 JSON 对象，key 是客户端使用的模型名，value 描述这个模型要转发到哪个 Azure 后端和 deployment。

示例：

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

规则：

- `backend: "oai"` 表示走 Azure OpenAI
- `backend: "infer"` 表示走 Azure AI Model Inference
- `deployment` 填你在 Azure 中实际创建的 deployment 名
- 可选 `apiVersion` 可覆盖默认 API 版本

## 部署方式

当前推荐方式是直接用 Wrangler 部署 Cloudflare Worker。

### 1. 准备项目

```bash
npm i -g wrangler
wrangler login
```

### 2. 配置变量

`wrangler.toml` 中的 `[vars]` 可放非敏感配置，例如：

```toml
[vars]
AZURE_OAI_ENDPOINT      = "https://your-resource.cognitiveservices.azure.com"
AZURE_INFER_ENDPOINT    = "https://your-project.services.ai.azure.com"
AZURE_OAI_API_VERSION   = "2025-04-01-preview"
AZURE_INFER_API_VERSION = "2024-05-01-preview"
```

敏感信息使用 secret：

```bash
wrangler secret put AZURE_API_KEY
wrangler secret put CLIENT_API_KEYS
wrangler secret put MODEL_MAPPING
```

### 3. 部署

```bash
wrangler deploy
```

部署完成后，会拿到一个 Worker URL。把 `{WORKER_URL}/v1` 配到你的 OpenAI 兼容客户端即可。

## 客户端怎么填

以 OpenAI 兼容客户端为例：

- Base URL: `https://your-worker.your-subdomain.workers.dev/v1`
- API Key: `CLIENT_API_KEYS` 中你自定义的某个 key

对于支持新版 Responses API 的客户端，同样填这个 Base URL 即可，代理会把 `/v1/responses` 自动转给 Azure 的 `/openai/responses`。

## 注意事项

- `GET /v1/models` 返回的是映射表里的模型列表，不是 Azure 自动探测结果
- 只有配置了相应 endpoint 和 deployment 的模型才能真正调用成功
- 本项目默认只做协议转换和透传，不做重试、缓存、配额、审计或多租户管理
- 仓库也提供 Docker 镜像，主要用于本地运行 `wrangler dev --local`；部署到 Cloudflare 仍推荐直接使用 Wrangler

## 主要文件

- [cf-openai-azure-proxy.js](./cf-openai-azure-proxy.js): 当前主 Worker 实现
- [wrangler.toml](./wrangler.toml): Worker 配置
- [cf-openai-palm-proxy.js](./cf-openai-palm-proxy.js): 早期 PaLM 代理脚本，和当前 Azure 主实现无关

## License

[MIT](./LICENSE)
