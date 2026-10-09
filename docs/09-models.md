# 09 模型与提供商

## 1. 原则

- 提供商协议适配**用成熟库**（Vercel AI SDK 7 及其官方 provider 包），不自己实现协议【硬性】。
- 所有提供商相关代码集中在 `models` 包的模型网关后面（[03 §5.2](03-architecture.md#52-决定推荐)），运行时与数据库只见中立格式。
- 能力以**证据**为准：官方元数据、实测探测、用户手动覆盖三类来源分开记录；未知就是未知，不假定支持。

## 2. 提供商映射【推荐】

| 提供商 | 适配包 | 说明 |
| --- | --- | --- |
| OpenAI | `@ai-sdk/openai` | 默认 Responses API；可选 Chat Completions |
| Anthropic | `@ai-sdk/anthropic` | 支持提示词缓存（`cacheControl`） |
| Google Gemini | `@ai-sdk/google` | |
| DeepSeek | `@ai-sdk/deepseek` | 官方包处理 `reasoning_content` 回传 |
| Kimi（Moonshot） | `@ai-sdk/moonshotai` | |
| 通义千问、智谱、豆包、MiniMax、小米 MiMo 等国产服务 | `@ai-sdk/openai-compatible` | 按提供商配置兼容参数；若有维护良好的社区包且支持 AI SDK 7，可在 ADR 中替换 |
| OpenRouter | `@ai-sdk/openai-compatible` 或其官方社区包（实现时核实 v7 兼容性） | |
| xAI 等其他官方支持的提供商 | 对应 `@ai-sdk/*` 官方包（实现时核实） | |
| 任意 OpenAI 兼容接口（Ollama、vLLM、LM Studio、自建网关） | `@ai-sdk/openai-compatible` | 用户填写 Base URL |
| ChatGPT/Codex 订阅 | 见 §4 | |

**提供商预设**是产品自有的一张小表：显示名、图标、默认 Base URL、使用的适配包、兼容参数、获取密钥的帮助链接、中国大陆是否可直连。新增提供商只改这张表（及必要的兼容参数），不改运行时。

2026-10-02 按用户要求导入一代项目的提供商品牌 SVG 素材，统一经前端 `Icon.tsx` 渲染。对话模型选择器（当前值及选项）、空白会话模型状态、设置档案、提供商/模型候选、用途分配、订阅账号和团队档案标识使用实际档案的 `provider` 对应 Logo；ChatGPT 使用 OpenAI Logo。自定义兼容接口与未知提供商使用中性备用素材，不根据模型名猜测提供商。素材本地打包、离线加载；单色图标适配深色主题，彩色素材保留原色。接入来源与验收见 [提供商 Logo 验收](acceptance/provider-logos-2026-10-02.md)。

**多轮思考内容回传**因提供商与路由而异（2026-09 核实：DeepSeek 官方包对新模型回传 `reasoning_content`；经 openai-compatible 路由曾出现回传缺陷）。因此每个预设都必须有录制回放的回归测试，覆盖"带思考的多轮 + 工具调用"（[14 §3](14-quality.md#3-测试分层)）。

## 3. 模型档案

| 字段 | 说明 |
| --- | --- |
| `id` / `name` | 名称由用户填写，唯一 |
| `provider` | 预设 ID 或 `custom-openai-compatible` |
| `model` | 模型 ID |
| `baseUrl` | 可覆盖预设 |
| `credentialRef` | 指向加密存储的 API Key 或订阅账号 |
| `contextWindow` / `maxOutputTokens` | 默认来自模型目录，可覆盖 |
| `reasoning` | 默认思考强度：`provider-default`（默认）/ `none`（无）/ `minimal` / `low` / `medium` / `high` / `xhigh` / `max`（最高）；前七项使用 AI SDK 7 统一取值，`max` 见下述适配 |
| `capabilities` | 工具调用、视觉、思考：每项记录 `value` 与 `source`（`catalog` / `probe` / `manual`）及时间 |
| `extraHeaders` / `providerOptions` | 高级选项，折叠显示 |
| `maxConcurrency` | 该档案同时进行的请求数上限（默认 4，防止多个子代理同时触发限流） |

用途分配（设置 → 模型）：主对话（必填）、子代理默认（默认同主对话）、上下文压缩摘要（默认同主对话；建议选便宜的模型）、标题生成（可选）。

2026-10-02 用户要求将入口文案缩短为「默认」「无」，并新增独立的「最高」等级。`max` 超出当前锁定 SDK 的统一 reasoning 枚举，由 models 适配层通过官方 providerOptions 传递：OpenAI/ChatGPT 为 `openai.reasoningEffort=max`，Anthropic 为 `anthropic.effort=max` + adaptive thinking，OpenAI 兼容接口为对应提供商 camelCase 命名空间的 `reasoningEffort=max`（自定义接口为 `customOpenaiCompatible`），覆盖原有低等级选项。其余适配器显式返回 invalid_request，不静默降级。具体模型是否接受 max 由提供商决定。

同日用户追加要求移除 minimal 的默认展示。聊天和设置中心统一提供「默认、无、低、中、高、极高、最高」七个选择；协议保留 minimal 以读取已有配置，已有值只显示为「最少（已保存）」，不加入可选列表，不自动改写已有档案。

用户可在对话中用 `/model <名称>` 或模型选择器切换当前会话的主模型。

模型设置页面可参考 [16 §4](16-design-reference.md#4-设置中心参考) 的档案、用途分配和能力来源表达；页面按实际 schema 和探测结果设计，草案中的型号、价格、配额和延迟均为示例，不定义默认值或能力承诺。

## 4. ChatGPT/Codex 订阅登录

### 4.1 要求【硬性】

- 两种登录方式：浏览器授权（PKCE，本机回调）与设备码（远程或无法打开浏览器时）。
- 令牌加密存储（[10 §4](10-data.md#4-密钥硬性)），自动刷新；刷新失败时界面提示重新登录。
- 界面明确标注：这是通过订阅账号访问的非公开接口，可用模型以登录后的发现结果为准，接口可能变化。
- 登录成功后自动创建对应的模型档案（可删除、可改名）。

### 4.2 实现【推荐】

2026-09 社区已有面向 AI SDK 7 的 ChatGPT/Codex 订阅 provider（如 `@grikomsn/ai-sdk-provider-chatgpt-oauth`：PKCE、可自定义凭据存储；以及另外两个更早期的包），但都处于早期（发布不久、使用者很少）。做法：

1. M0 评估上述候选：是否支持自定义凭据存储（必须，凭据要存进我们的加密库）、模型发现、流式工具调用、思考摘要。
2. 满足要求则**锁定精确版本**使用，并将其包在我们的 `SubscriptionProvider` 接口之后。
3. 都不满足时，写一个薄适配：OAuth 流程由我们的认证模块处理（标准 PKCE 与设备码流程），请求使用官方 `@ai-sdk/openai` 的 Responses 实现，通过自定义 `baseURL` 与 `fetch` 注入订阅接口所需的请求头与参数约束。适配代码限制在约 300 行以内，协议解析仍由官方包完成。

### 4.3 其他订阅（P2）

Claude Pro/Max、GitHub Copilot、国产订阅（如腾讯系、阿里系编程订阅）等，走同一个 `SubscriptionProvider` 接口接入。v1 不实现。

## 5. 模型目录

- 【推荐】使用 **models.dev**（MIT 许可的开源模型元数据库，提供上下文窗口、输出上限、价格、模态、工具调用与思考能力；有静态 JSON API，opencode 在使用）。
- 构建时下载一份快照打包进应用（离线可用）；设置中可手动"刷新模型目录"联网更新；更新失败不影响使用。
- 产品维护一个小的覆盖文件，用于补充 models.dev 缺失或不准确的条目（尤其国产模型），覆盖文件中的每一条注明来源链接与核实日期。
- 目录只提供默认值与"官方声明"类证据；实际能力以探测和用户覆盖为准。

## 6. 能力探测【推荐】

添加档案或手动触发时运行，结果缓存，键为 `(提供商, Base URL, 模型, 凭据指纹)`——凭据变化则缓存失效。

| 能力 | 方法 | 判定 |
| --- | --- | --- |
| 连通 | 发送"只回复 OK" | 收到回复 |
| 工具调用 | 提供一个合成工具，要求模型调用并回传一个随机标记 | 收到合法的工具调用且参数中包含该标记 |
| 视觉 | 生成一张随机排列的色块图片，要求模型按顺序说出颜色 | 顺序全部正确（随机生成，防止盲猜） |
| 思考 | 请求开启思考 | 返回中出现思考内容 |

- 探测不执行任何真实工具，单项超时 20 秒。
- 探测结果在界面显示（✓ / ✗ / 未知），用户可手动覆盖（记为 `manual`）。
- 运行时据此裁剪：不支持工具调用的模型不能作为代理模型（界面阻止并说明）；不支持视觉时 `workbook_render` 不出现在工具列表，图片附件不发送。

## 7. 其他

- **连接测试**与**拉取远端模型列表**（调用提供商的模型列表接口，按提供商使用正确的鉴权头）。
- **代理设置**：支持系统代理环境变量与设置中的 HTTP(S) 代理（通过自定义 `fetch` 注入），可设置不走代理的地址。
- **费用估算**：按模型目录价格和实际用量估算，界面标注"估算"。
- **限流**：按档案的 `maxConcurrency` 排队；收到 429 时按 `Retry-After` 退避（[04 §9](04-agent-runtime.md#9-错误与重试)）。
