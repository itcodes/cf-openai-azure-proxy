# cf-openai-azure-proxy

<a href="./README_en.md">English</a> |
<a href="./README.md">中文</a>

> 一个运行在 Cloudflare Workers 上的 OpenAI 兼容代理。它把客户端发来的 `/v1/*` 请求通过 Azure 的 OpenAI 兼容 v1 接口转发到 Azure OpenAI / Azure AI Foundry，让只支持 OpenAI API 的客户端也能接入 Azure 上部署的模型。

## 这个项目做什么

很多客户端只支持 OpenAI 风格接口，但不直接支持 Azure OpenAI / Azure AI Foundry。本项目提供一个很轻量的协议转换层：

- 客户端继续按 OpenAI 方式请求 `/v1/chat/completions`、`/v1/responses`、`/v1/embeddings` 等接口
- Cloudflare Worker 把请求转发到 Azure 的 `/openai/v1/*` 接口，客户端的 `model` 直接作为 deployment 名
- 配置了两个 Azure 资源（Azure OpenAI + Azure AI Foundry）时，按模型名决定先打哪个，找不到 deployment 就自动换另一个

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
- 在 Azure 新部署的模型无需改代码或配置，客户端填 deployment 名即可使用
- SSE 流式透传
- 简单客户端鉴权
  - 用 `CLIENT_API_KEYS` 给你的 Worker 再包一层访问控制

## 工作方式

请求链路如下：

```text
OpenAI-compatible client
  -> /v1/chat/completions | /v1/responses | /v1/embeddings | ...
  -> Cloudflare Worker
  -> 校验 Authorization / CLIENT_API_KEYS
  -> 读取 body.model，如有 MODEL_MAPPING 别名则替换 -> deployment 名
  -> 决定先打哪个资源
     - gpt-* / o1 / o3 / text-embedding-* / dall-e-* / whisper / tts-* -> AZURE_OAI_ENDPOINT
     - 其他（grok、deepseek、llama 等）                                -> AZURE_INFER_ENDPOINT
  -> POST {endpoint}/openai/v1/{path}，model = deployment 名
  -> 如果该资源返回 404 / 未知模型，自动换另一个资源重试
  -> 把响应原样返回给客户端
```

成功的资源会在 Worker 实例内记住，所以回退只在第一次多一次往返。

## 环境变量

在 Cloudflare Workers 的 Variables / Secrets 中配置：

| 变量 | 必填 | 说明 |
|---|---|---|
| `AZURE_API_KEY` | 推荐 | Azure API Key。设置后，Worker 用它访问 Azure（两个资源共用同一个 key） |
| `AZURE_OAI_ENDPOINT` | 至少配一个 endpoint | Azure OpenAI 资源，例如 `https://your-resource.cognitiveservices.azure.com` |
| `AZURE_INFER_ENDPOINT` | 至少配一个 endpoint | Azure AI Foundry 资源，例如 `https://your-project.services.ai.azure.com` |
| `CLIENT_API_KEYS` | 推荐 | 逗号分隔，作为客户端访问你这个代理时使用的 key |
| `ALLOWED_ORIGINS` | 否 | 逗号分隔，仅允许这些浏览器来源通过 CORS 访问，例如 `https://chat.example.com` |
| `UPSTREAM_TIMEOUT_MS` | 否 | 上游 Azure 请求超时（毫秒），默认 `120000`。控制的是等待首字节的时间，流式返回开始后不受此限 |
| `MODEL_MAPPING` | 否 | JSON 别名表，见下文。只有客户端用的名字和 deployment 名不一致时才需要 |
| `MODEL_LIST` | 否 | 逗号分隔，`GET /v1/models` 返回的模型列表；不填时使用内置的常见模型列表 |

说明：

- 如果设置了 `CLIENT_API_KEYS`，客户端必须用其中某个 key 访问 Worker
- 如果设置了 `CLIENT_API_KEYS`，也必须同时设置 `AZURE_API_KEY`，避免把客户端 key 错发给 Azure 上游
- 如果没有设置 `CLIENT_API_KEYS`，Worker 会放行客户端请求
- 如果没有设置 `CLIENT_API_KEYS` 且也没有设置 `AZURE_API_KEY`，则会尝试把客户端 `Authorization: Bearer ...` 当作 Azure key 继续透传
- 如果设置了 `ALLOWED_ORIGINS`，只有这些 Origin 的浏览器请求会拿到 CORS 许可；非浏览器客户端不受影响
- 不再需要配置 `api-version`，v1 接口不使用它

## MODEL_MAPPING 格式

可选。key 是客户端使用的模型名，value 可以直接写 deployment 名，也可以写成对象，额外指定先打哪个资源：

```json
{
  "gpt-chat-latest": "gpt-5.5",
  "my-grok": { "deployment": "grok-4-20", "backend": "infer" }
}
```

- `backend: "oai"` 先打 `AZURE_OAI_ENDPOINT`，`backend: "infer"` 先打 `AZURE_INFER_ENDPOINT`
- 不配置时，内置映射只有 `gpt-chat-latest` -> `gpt-5.5` 这一个别名
- 配置 `MODEL_MAPPING` 会替换内置映射
- 映射里的名字也会出现在 `GET /v1/models` 中

## 部署方式

推荐先走 Cloudflare Dashboard 手动部署，第一次上手最直观；`Wrangler` 更适合后续更新、版本化配置和本地调试。

### 方式一：Cloudflare Dashboard 手动部署（推荐）

#### 1. 创建 Worker

- 登录 Cloudflare Dashboard
- 进入 Workers & Pages
- 新建一个 Worker

#### 2. 复制脚本

把仓库里的 [cf-openai-azure-proxy.js](./cf-openai-azure-proxy.js) 全部复制到 Cloudflare Worker 编辑器中，覆盖默认示例代码。

#### 3. 配置 Variables 和 Secrets

在 Worker 的 Settings / Variables 中配置这些值：

- 非敏感变量可直接添加为普通变量
  - `AZURE_OAI_ENDPOINT`
  - `AZURE_INFER_ENDPOINT`
  - `MODEL_LIST`（可选）
- 敏感变量建议添加为 secret
  - `AZURE_API_KEY`
  - `CLIENT_API_KEYS`
  - `MODEL_MAPPING`

可以先只配最小必需项：

- `AZURE_API_KEY`
- `AZURE_OAI_ENDPOINT` 或 `AZURE_INFER_ENDPOINT`
- `CLIENT_API_KEYS`（建议）

如果需要模型别名，再额外配置 `MODEL_MAPPING`。

#### 4. 部署并拿到地址

保存并部署后，Cloudflare 会给你一个 Worker URL。

把下面这个地址填到你的 OpenAI 兼容客户端里：

```text
https://your-worker.your-subdomain.workers.dev/v1
```

如果你有自己的域名，也可以在 Worker 的域名 / 路由设置里绑定自定义域名，再把 `https://your-domain/v1` 配给客户端。

### 方式二：Wrangler CLI 部署（可选）

`Wrangler` 不是必须的。它的作用是把“在网页里复制代码、手动填变量、点击发布”的流程改成命令行方式，更适合反复更新。

这个仓库里：

- [wrangler.toml](./wrangler.toml) 指定了入口文件 `main = "cf-openai-azure-proxy.js"`
- 执行 `wrangler deploy` 时，会把 [cf-openai-azure-proxy.js](./cf-openai-azure-proxy.js) 上传成 Worker
- `[vars]` 中的非敏感变量会一并带上
- `AZURE_API_KEY`、`CLIENT_API_KEYS`、`MODEL_MAPPING` 这类敏感值仍建议用 secret

#### 1. 安装并登录

```bash
npm i -g wrangler
wrangler login
```

#### 2. 配置变量

`wrangler.toml` 中的 `[vars]` 可放非敏感配置，例如：

```toml
[vars]
MODEL_LIST              = "gpt-5.5,gpt-5.4,grok-4-20,deepseek-r1"
ALLOWED_ORIGINS         = "https://chat.example.com"
UPSTREAM_TIMEOUT_MS     = "120000"
```

如果你的仓库是公开的，不要把 Azure endpoint 写进 `wrangler.toml`，改用下面的 secret 设置。

敏感信息使用 secret：

```bash
wrangler secret put AZURE_OAI_ENDPOINT
wrangler secret put AZURE_INFER_ENDPOINT
wrangler secret put AZURE_API_KEY
wrangler secret put CLIENT_API_KEYS
wrangler secret put MODEL_MAPPING
```

#### 3. 部署

```bash
wrangler deploy
```

部署完成后，同样把 `{WORKER_URL}/v1` 配到你的 OpenAI 兼容客户端即可。

## 客户端怎么填

以 OpenAI 兼容客户端为例：

- Base URL: `https://your-worker.your-subdomain.workers.dev/v1`
- API Key: `CLIENT_API_KEYS` 中你自定义的某个 key

对于支持新版 Responses API 的客户端，同样填这个 Base URL 即可，代理会把 `/v1/responses` 转给 Azure 的 `/openai/v1/responses`。

## 注意事项

- 手动部署和 Wrangler 部署的运行效果是一样的，区别主要在发布方式
- `GET /v1/models` 返回的是 `MODEL_MAPPING` 的 key 加上 `MODEL_LIST`，不是 Azure 自动探测结果（列出 deployment 需要 Azure 管理凭据，API key 做不到）。不在列表里的模型照样能调用
- 只有在 Azure 中实际部署了的模型才能调用成功
- 代理默认只透传一小部分安全响应头，不会把 Azure 的 `x-ms-*`、`apim-*` 等内部头原样暴露给客户端
- 本项目默认只做协议转换和透传，除上面的资源回退外，不做重试、缓存、配额、审计或多租户管理
- 仓库也提供 Docker 镜像，但它运行的是 `wrangler dev --local`，定位是本地调试，不建议当生产部署方式使用

## 主要文件

- [cf-openai-azure-proxy.js](./cf-openai-azure-proxy.js): 当前主 Worker 实现
- [wrangler.toml](./wrangler.toml): Worker 配置
- [cf-openai-palm-proxy.js](./cf-openai-palm-proxy.js): 早期 PaLM 代理脚本，和当前 Azure 主实现无关

## License

[MIT](./LICENSE)
