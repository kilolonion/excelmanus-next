# 0005 模型网关采用 AI SDK 7 单步 streamText，错误只分类不重试

- 状态：已接受（提供商覆盖部分待补）
- 日期：2026-09-29

## 背景

03 §5.2【推荐】：模型网关用 Vercel AI SDK 7，只用单步能力；工具不提供 `execute`；运行时与日志只见中立格式。M0 要求在国际与国产各两个提供商上验证流式、工具调用、思考回传、中断。证据：`spikes/ai-sdk-step/REPORT.md`、`criteria.json`（负责人编写的判据）、`results/cases.json`、`fixtures/recordings/`。

实测结果：13/13 通过（MiMo `mimo-v2.6-flash` 经 `@ai-sdk/openai-compatible` 发起真实请求 7 个，mock 6 个）。

## 选项

- A：按 03 §5.2 使用 AI SDK 7 单步（采用）。
- B：自己实现各家协议。违反 09 §1 硬性要求（协议适配用成熟库），排除。

## 决定

1. 依赖精确锁定：`ai@7.0.108`、`@ai-sdk/openai-compatible@3.0.53`、`@ai-sdk/provider@4.0.17`、`@ai-sdk/provider-utils@5.0.45`、`zod@4.6.5`。其他官方 provider 包（`@ai-sdk/openai`、`@ai-sdk/anthropic`、`@ai-sdk/deepseek`）接入时，版本必须与这组 provider/provider-utils 一致。
2. `ModelGateway.step()` 的实现约束（spike 的 `src/gateway/` 迁入 `packages/models`）：
   - 一次 step = 一次 `streamText`，参数 `stopWhen: stepCountIs(1)`、`maxRetries: 0`、`onError` 由网关接管。
   - 工具只传 `description` 与 `inputSchema`，不传 `execute`。
   - 中立事件种类：`text.delta`、`reasoning.delta`（带 providerMetadata）、`tool.args.delta`、`tool.call`、`usage`、`finish`、`error`。
3. **错误只分类，重试在运行时**（04 §9）。分类词表：`auth`、`model_not_found`、`invalid_request`、`rate_limit`（带 `retryAfterMs`）、`server_error`、`network`、`stream_interrupted`、`context_overflow`、`aborted`、`content_filter`、`unknown`。登记到 06 的错误码词表时，与工具错误码分开命名空间。
4. **思考内容**：中立 `ContextItem` 里 assistant 的 `reasoning` 与 `reasoningProviderOptions` 原样保存（10 §3.3 `agent_context`），由 provider 包负责回传（MiMo 实测回传为 `reasoning_content`）。
5. **包装 fetch（录制、观测、限流）必须是非阻塞 tee**，不能在把响应交给 SDK 前读完响应体。

## 后果

- 正面：协议解析与思考回传由官方包负责；网关代码约 300 行，事件映射与分类都可单测。
- 负面 / 代价：AI SDK 7 小版本发布频繁（一周多个版本）。锁定版本后，升级时必须重跑 `criteria.json` 与各提供商的回放夹具。
- 需要跟进的事项：
  - **OpenAI、Anthropic、DeepSeek 未验证**（没有 Key）。拿到 Key 后用同一 `criteria.json` 补跑，重点看 Anthropic 思考签名与 DeepSeek `reasoning_content` 的回传。在此之前，M0 中的"国际与国产各两个提供商"不算通过，附录 C T-7 保持打开。
  - MiMo 的"模型不存在"返回 400 而不是 404：界面上 invalid_request 类错误的指引要把"检查模型名"列为可能原因。
  - 01 §5.1"服务端额外延迟 ≤ 150 ms"在 M1 用 mock 模型单独测量。

## 验收标准符合性

- 03 §5.2 单步 + 无 execute + 中立格式：A03（底层请求恰好 1 次）、边界检查（中立文件零 AI SDK 引用）、M05（中立格式往返）。
- 04 §8.4 流中断、§9 错误分类：M01–M04、A06、A07。
- 04 §10 思考内容：A02、A04、M05。
- 14 §3.2 提供商回归：`fixtures/recordings/` 已包含 MiMo 的脱敏夹具；产品中的回放测试直接使用这些文件。
