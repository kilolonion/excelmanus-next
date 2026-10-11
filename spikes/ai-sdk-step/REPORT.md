# M0 Spike 报告：AI SDK 7 单步循环（03 §5.2）

> 结论先行：**`ai@7.0.108` + `@ai-sdk/openai-compatible@3.0.53` 满足"模型网关 = 单步、工具无 execute、运行时只见中立格式"的全部判据**。`criteria.json` 13 个用例（MiMo 真实请求 7 个、mock 6 个）全部通过。MiMo 的 `reasoning_content` 可以流式读出，多轮时也按原字段名回传，中断 6 ms 内结束。只验证了一家提供商，另外三家待补（§5）。

## 0. 摘要表

| 用例 | 判据要点 | 实测 | 判定 |
|---|---|---|---|
| A01 流式纯文本 | ≥2 text.delta、finish=stop、usage>0 | 17 个 delta；首字 3.2 s，总耗时 4.6 s；in 26 / out 46（reasoning 16） | ✅ |
| A02 思考流式 | ≥1 reasoning.delta，与 text 分开 | 4 个 reasoning.delta 在前，14 个 text.delta 在后 | ✅ |
| A03 单步工具调用 | tool.call 通过 schema 校验、finish=tool-calls、底层请求恰好 1 次 | `workbook_read{path,range}`，raw `tool_calls`，calls=1 | ✅ |
| A04 带思考多轮 + 工具结果 | 第 2 步请求带 tool_calls，tool_call_id 配对；回答引用数据 | 请求体中助手消息带 `reasoning_content` 与 `tool_calls`，tool 消息的 id 配对；回答正确引用 Gamma 1530 | ✅ |
| A05 中断 | abort 后 1 s 内结束；无未处理拒绝；后续 step 正常 | abort 后 **6 ms** 以 `error(aborted)` 结束，abort 后没有新 delta；后续 step 成功 | ✅ |
| A06 认证失败 | auth、不可重试、不泄密 | 401 `invalid_key` → `auth`；消息中无请求头和 Key | ✅ |
| A07 模型不存在 | model_not_found 或 invalid_request | MiMo 返回 **400** `Unsupported model …` → `invalid_request`（不是 404） | ✅ |
| M01 429 | rate_limit、retryAfterMs=2000 | ✅ | ✅ |
| M02 流中断 | 3 个 delta 后 stream_interrupted、可重试 | ✅ | ✅ |
| M03 上下文超限 | context_overflow | ✅ | ✅ |
| M04 5xx / 网络 | server_error / network，可重试 | ✅ / ✅ | ✅ |
| M05 中立格式往返 | 转换后 prompt 与预期逐字段一致；思考 providerOptions 保持原位 | ✅ | ✅ |
| 边界 | harness 与中立类型不 import AI SDK | `neutral.ts`、`run-cases.ts`、`index.ts` 零引用；只在 `gateway/`、`fixtures/` 出现 | ✅ |
| 密钥 | 仓库文件中不出现 Key | harness 全目录自检"干净"；录制把 Authorization 与 `sk-*` 替换为 `<redacted>` | ✅ |

环境：macOS arm64，Node v24.1.0；`ai@7.0.108`、`@ai-sdk/openai-compatible@3.0.53`、`@ai-sdk/provider@4.0.17`、`@ai-sdk/provider-utils@5.0.45`、`zod@4.6.5`，全部精确锁定，都是 2026-09-22 之前发布（满足 7 天规则）。模型 `mimo-v2.6-flash`，经 openai-compatible 接入。

## 1. 网关形态（`src/gateway/`）

- `step(req)`：一次调用 = 一次 `streamText`，参数 `stopWhen: stepCountIs(1)`、`maxRetries: 0`（重试归运行时，见 04 §9）、`onError: () => {}`（关掉 SDK 默认的 `console.error`，它会打印请求 URL 等细节）。工具由 `tool({ description, inputSchema: jsonSchema(...) })` 构造，**不带 execute**。
- 事件映射：`text-delta`、`reasoning-delta`（附 providerMetadata）、`tool-input-delta`、`tool-call`、`finish-step`/`finish`（映射为 usage 与 finish）、`abort`、`error`；其余骨架事件不进入中立格式。
- 错误分类（`errors.ts`）：优先看 `APICallError.statusCode`，400 时再按错误体区分 context_overflow、content_filter、invalid_request；非 HTTP 错误中，`TypeError` 加网络关键字归为 network；已输出过内容后出错归为 stream_interrupted。
- 中立转换（`convert.ts`）：`ContextItem`（user / assistant{reasoning, reasoningProviderOptions, text, toolCalls} / toolResult）→ `ModelMessage`。

## 2. 思考内容回传（09 §2 的重点风险）

- MiMo 流里的 `reasoning_content` 被 openai-compatible 识别为 `reasoning-delta`，不需要自己解析 SSE（符合 09 §1 硬性要求）。
- 多轮时，中立格式里 assistant 的 `reasoning` 会被 openai-compatible 写回请求体的 **`reasoning_content`** 字段（A04 录制的请求体为证）。
- 我们**没有**验证 MiMo 是否"要求"必须回传思考：它在有回传的情况下答对了，没有做"不回传"的对照实验。结论只能说：回传路径可用，字段名正确。

## 3. 对架构有影响的发现

1. **录制器不能阻塞原始流**。第一版录制器在把响应交还 SDK 之前先 `await clone.text()`，导致首字节延迟被推到流结束之后，A05 的"abort 后 1 s 内结束"也测不出来（第一版 abort 后约 14 s 才结束，但被错误判为通过）。改为后台读副本、落盘前统一 `settle()` 后，abort 在 6 ms 内结束。**产品中任何录制或观测 fetch 的包装都必须是非阻塞 tee。**
2. **"模型不存在"不一定是 404**：MiMo 返回 400。分类表不能只看状态码；产品中 invalid_request 类错误的界面文案要同时覆盖"模型名错误"的可能。
3. **SDK 默认会 `console.error` 流内错误**（含请求 URL 与响应体）。10 §4 要求日志不出现密钥和提示词正文，因此网关必须传 `onError` 接管。
4. 首字延迟约 2.5–5 s（本地到 MiMo，flash 模型），来自模型服务，与网关无关；01 §5.1 的"服务端额外延迟 ≤ 150 ms"应在 M1 用 mock 模型单独测网关开销。

## 4. 偏离

- 判据要求"一次 step 内底层 doStream 恰好 1 次"：真实提供商用计数 fetch 断言（A03 calls=1），mock 用 `doStreamCalls.length` 断言。A05 的 calls=2 是"中断的那一步 + 判据要求的后续普通 step"，不是同一个 step 发了两次请求。
- 本轮修正了 harness 的两个缺陷，判据本身没改：录制器阻塞（见 §3.1），以及 A05 原先用"总耗时 < 4 s"这种宽松条件判断，改为从真正 abort 的时刻开始计时、超过 1 s 判失败。

## 5. 未验证

`criteria.deferred`：OpenAI（`@ai-sdk/openai`）、Anthropic（`@ai-sdk/anthropic`，思考签名回传）、DeepSeek（`@ai-sdk/deepseek`）。拿到 Key 后用同一 `criteria.json` 补跑；03 §5 与 M0 的"国际、国产各两家"在此之前**不算通过**。

## 6. 复现

```bash
# 需要 ~/.config/excelmanus-next/spike.env（MIMO_API_KEY / MIMO_BASE_URL / MIMO_MODEL）
pnpm --filter @excelmanus-spike/ai-sdk-step run cases   # 约 30 s；→ results/cases.json、fixtures/recordings/*.json
```
