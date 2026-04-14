# cf-openai-azure-proxy

<a href="./README_en.md">English</a> |
<a href="./README.md">中文</a>

> 大多数 OpenAI 客户端不支持 Azure OpenAI / Azure AI Foundry，但 Azure 的申请和绑卡都非常简单，并且还提供了免费的额度。此脚本使用免费的 Cloudflare Worker 作为代理，使得支持 OpenAI 的客户端可以直接使用 Azure AI Foundry 上的各种模型（包括 OpenAI 系、Grok、DeepSeek、Llama 等）。

### 支持模型:
- GPT 系列（GPT-4o、GPT-5.4、o1、o3 等）
- 图像生成（DALL-E-3、gpt-image-1、gpt-image-1.5）
- Embeddings（text-embedding-3-small / large）
- 语音（Whisper、TTS）
- Grok 系列（通过 Azure AI Model Inference）
- DeepSeek / Llama 等第三方模型（通过 Azure AI Model Inference）

模型子类添加非常容易, 参考下面的使用说明。

### 项目说明:
- 我没有服务器可以使用吗?
    - 这段脚本跑在 Cloudflare Worker, 不需要服务器, 不需要绑卡, 每天 10W 次请求 免费
- 我没有自己的域名可以使用吗?
    - 也可以, 参考: https://github.com/haibbo/cf-openai-azure-proxy/issues/3
- 同时支持哪些 Azure 接口形态？
    - 经典 Azure OpenAI（`/openai/deployments/{name}/*`）
    - Responses API（`/openai/responses`，对应客户端的 `/v1/responses`）
    - Azure AI Model Inference（`/models/*`，跑 Grok/DeepSeek/Llama 等非 OpenAI 模型）
- 一个 Worker 能不能同时代理多个 Azure 资源？
    - 可以。本项目设计成 `AZURE_OAI_ENDPOINT`（OpenAI 资源）+ `AZURE_INFER_ENDPOINT`（AI Foundry 第三方模型资源）并存
- 流式响应支持吗？
    - 支持。SSE 原生透传，无人为延迟
- 项目也支持 Docker 部署（基于 wrangler）

### 部署
代理 OpenAI 的请求到 Azure AI Foundry，代码部署步骤：

1. 注册并登录到 Cloudflare 账户
2. 创建一个新的 Cloudflare Worker
3. 将 [cf-openai-azure-proxy.js](./cf-openai-azure-proxy.js) 复制并粘贴到 Cloudflare Worker 编辑器中
4. 通过环境变量配置 `AZURE_OAI_ENDPOINT`、`AZURE_API_KEY` 等（详见下方"使用说明"）
5. 保存并部署 Cloudflare Worker
6. **可选**绑定自定义域名: 在 Worker 详情页 -> Trigger -> Custom Domains 中为这个 Worker 添加一个自定义域名，参考 https://github.com/haibbo/cf-openai-azure-proxy/issues/3

也可以用 wrangler CLI 部署：

```bash
npm i -g wrangler
wrangler login
wrangler secret put AZURE_API_KEY
wrangler secret put CLIENT_API_KEYS
wrangler deploy
```

### 使用说明

先得到 Azure 资源名和各个 deployment 名, 登录到 Azure AI Foundry 后台查看。

#### 环境变量列表

| 变量 | 必填 | 说明 |
|---|---|---|
| `AZURE_API_KEY` | ✅ | Azure 密钥（Secret） |
| `AZURE_OAI_ENDPOINT` | ✅ | 例 `https://yoyo.cognitiveservices.azure.com` |
| `AZURE_INFER_ENDPOINT` | 用 Grok/DeepSeek 才要 | 例 `https://waytoagi.services.ai.azure.com` |
| `CLIENT_API_KEYS` | 推荐 | 逗号分隔，例 `sk-mykey1,sk-mykey2` |
| `AZURE_OAI_API_VERSION` | ⬜ | 默认 `2025-04-01-preview` |
| `AZURE_INFER_API_VERSION` | ⬜ | 默认 `2024-05-01-preview` |
| `MODEL_MAPPING` | ⬜ | JSON 字符串，不填用代码内置默认映射 |

<img width="777" src="https://user-images.githubusercontent.com/1295315/233384224-aa6581f0-26a4-49cf-ae25-4dfb466143da.png" alt="env" />

#### 这里有两种做法:

- 直接修改代码顶部 `DEFAULT_MAPPING` 的值, 如:

```js
const DEFAULT_MAPPING = {
  "gpt-4o":       { backend: "oai",   deployment: "gpt-4o" },
  "gpt-5.4":      { backend: "oai",   deployment: "gpt-5.4" },
  "dall-e-3":     { backend: "oai",   deployment: "dall-e-3" },
  "grok-4-20":    { backend: "infer", deployment: "grok-4-20" },
  "deepseek-r1":  { backend: "infer", deployment: "deepseek-r1" },
};
// 其他的 map 规则直接按这样的格式续写即可
// backend: "oai" 走 Azure OpenAI，"infer" 走 Azure AI Model Inference
```

- 或者通过 cloudflare worker 控制台, 进入 Workers script > Settings > Variables and Secrets, 把整个 JSON 作为 `MODEL_MAPPING` 变量填进去。

### 客户端
以 OpenCat 为例: 自定义 API 域名填写绑定的域名（加 `/v1` 后缀），API Key 填 `CLIENT_API_KEYS` 里你自己设的某个 `sk-xxx`：

<img width="339" src="https://user-images.githubusercontent.com/1295315/229820705-ab2ad1d1-8795-4670-97b4-16a0f9fdebba.png" alt="opencat" />

对于支持 Responses API 的新版客户端（Cherry Studio、ChatWise 等），同样填上面的 base URL 即可，代理会自动把 `/v1/responses` 转给 Azure。

我已经尝试了多种客户端, 如果遇到其他客户端有问题, 欢迎创建 issue。
