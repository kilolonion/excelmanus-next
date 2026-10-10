// ModelGateway.step 的 AI SDK 7 实现（03 §5.2 窄接口、ADR 0005）。
// 一次 step = 恰好一次 streamText，工具无 execute，stopWhen=stepCountIs(1)，
// maxRetries=0（重试在运行时），onError 由网关接管，非阻塞流式。

import type { ResolvedModel, StepEvent, ToolSpec } from "@excelmanus/protocol";
import type { LanguageModel, ToolSet } from "ai";
import { jsonSchema, stepCountIs, streamText, tool } from "ai";
import { presetFor } from "../presets.ts";
import { resolveLanguageModel } from "../resolve.ts";
import { registerModelSecrets } from "../secrets.ts";
import { MODEL_STRINGS } from "../strings.ts";
import { toModelMessages } from "./convert.ts";
import { classifyError } from "./errors.ts";

export interface StepRequestLike {
  model: ResolvedModel;
  system?: string;
  history: Parameters<typeof toModelMessages>[0];
  tools?: ToolSpec[];
  providerOptions?: Record<string, unknown>;
  signal: AbortSignal;
}

export interface ModelGatewayLike {
  step(req: StepRequestLike): AsyncIterable<StepEvent>;
}

export interface GatewayOptions {
  /** 测试注入：替换模型输出（如 ai/test 的 MockLanguageModel），不替代其他代码。 */
  resolveLanguageModel?: (model: ResolvedModel) => unknown;
}

/** tool 消息内容只能是字符串的适配器（图片需改走 user 消息）。 */
const CHAT_TOOL_STRING_ADAPTERS = new Set(["openai-compatible", "moonshotai"]);

export function createGateway(opts: GatewayOptions = {}): ModelGatewayLike {
  const resolve = opts.resolveLanguageModel ?? resolveLanguageModel;
  return { step: (req) => stepImpl(resolve, req) };
}

function toToolSet(tools: ToolSpec[] | undefined): ToolSet | undefined {
  if (!tools || tools.length === 0) return undefined;
  const set: ToolSet = {};
  for (const t of tools) {
    // 无 execute：工具调用交回自有效果执行器（03 §5.2）。
    set[t.name] = tool({
      description: t.description ?? t.name,
      inputSchema: jsonSchema(t.inputSchema as never),
    });
  }
  return set;
}

async function* stepImpl(
  resolve: (model: ResolvedModel) => unknown,
  req: StepRequestLike,
): AsyncIterable<StepEvent> {
  let sawContent = false;
  // 10 §4：本次请求的明文凭据登记为待脱敏值（错误文本与会话日志写入前精确替换）
  registerModelSecrets(req.model);
  try {
    let providerOptions = req.providerOptions;
    if (req.model.reasoning === "max") {
      const preset = presetFor(req.model.provider);
      const adapter = preset?.adapter ?? "openai-compatible";
      const key =
        adapter === "openai" || adapter === "chatgpt"
          ? "openai"
          : adapter === "anthropic"
            ? "anthropic"
            : adapter === "openai-compatible"
              ? (preset?.id ?? "custom-openai-compatible").replace(/-([a-z])/g, (_, c: string) =>
                  c.toUpperCase(),
                )
              : undefined;
      if (!key) {
        yield {
          kind: "error",
          error: {
            kind: "invalid_request",
            retryable: false,
            message: MODEL_STRINGS.maxReasoningUnsupported,
          },
        };
        return;
      }
      const current = providerOptions?.[key];
      providerOptions = {
        ...providerOptions,
        [key]: {
          ...(typeof current === "object" && current !== null ? current : {}),
          ...(adapter === "anthropic"
            ? { effort: "max", thinking: { type: "adaptive" } }
            : { reasoningEffort: "max" }),
        },
      };
    }
    const result = streamText({
      model: resolve(req.model) as LanguageModel,
      system: req.system,
      messages: toModelMessages(req.history, {
        vision: req.model.vision,
        toolImagesAsUser: CHAT_TOOL_STRING_ADAPTERS.has(
          presetFor(req.model.provider)?.adapter ?? "openai-compatible",
        ),
      }),
      tools: toToolSet(req.tools),
      abortSignal: req.signal,
      stopWhen: stepCountIs(1),
      // 重试由运行时按 04 §9 策略执行；网关只分类，故关掉 SDK 内部重试。
      maxRetries: 0,
      providerOptions: providerOptions as never,
      // 09 §3：档案默认思考强度（AI SDK 7 统一取值）；未设置时交给提供商默认
      ...(req.model.reasoning !== undefined &&
      req.model.reasoning !== "provider-default" &&
      req.model.reasoning !== "max"
        ? { reasoning: req.model.reasoning as never }
        : {}),
      // 错误已作为 error 事件交给运行时；关闭 SDK 默认的 console.error（会打印请求 URL 等细节）
      onError: () => {},
    });
    for await (const part of abortableStream(result.fullStream, req.signal)) {
      switch (part.type) {
        case "text-delta":
          sawContent = true;
          yield { kind: "text.delta", text: part.text };
          break;
        case "reasoning-delta":
          sawContent = true;
          yield {
            kind: "reasoning.delta",
            text: part.text,
            providerMetadata: part.providerMetadata,
          };
          break;
        case "tool-input-delta":
          sawContent = true;
          yield { kind: "tool.args.delta", toolCallId: part.id, delta: part.delta };
          break;
        case "tool-call": {
          sawContent = true;
          const raw =
            typeof part.input === "string" ? part.input : JSON.stringify(part.input ?? null);
          let args: unknown = null;
          try {
            args = JSON.parse(raw);
          } catch {
            // 解析失败保留 rawArgs 供上层判定
          }
          yield {
            kind: "tool.call",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            args,
            rawArgs: raw,
          };
          break;
        }
        case "finish-step":
          yield {
            kind: "usage",
            usage: {
              inputTokens: part.usage.inputTokens,
              outputTokens: part.usage.outputTokens,
              reasoningTokens: part.usage.outputTokenDetails.reasoningTokens,
            },
          };
          break;
        case "finish":
          yield {
            kind: "finish",
            reason: part.finishReason ?? "unknown",
            rawReason: part.rawFinishReason ?? undefined,
          };
          if (part.totalUsage) {
            yield {
              kind: "usage",
              usage: {
                inputTokens: part.totalUsage.inputTokens,
                outputTokens: part.totalUsage.outputTokens,
                reasoningTokens: part.totalUsage.outputTokenDetails.reasoningTokens,
                totalTokens: part.totalUsage.totalTokens,
              },
            };
          }
          break;
        case "abort":
          yield {
            kind: "error",
            error: { kind: "aborted", retryable: false, message: "aborted by signal" },
          };
          break;
        case "error":
          yield { kind: "error", error: classifyError(part.error, sawContent) };
          break;
        case "raw":
          yield { kind: "raw", value: part.rawValue };
          break;
        default:
          // start / start-step / text-start|end / reasoning-start|end /
          // tool-input-start|end / source / file / tool-approval* 等骨架事件不出中立面。
          break;
      }
    }
  } catch (e) {
    yield { kind: "error", error: classifyError(e, sawContent) };
  }
}

/** A provider can stall before returning its stream or ignore cancellation. Stop
 * consuming independently so late model output cannot keep an actor/database alive.
 * Keep the SDK abort signal too: cooperative transports still cancel their I/O. */
async function* abortableStream<T>(
  stream: ReadableStream<T>,
  signal: AbortSignal,
): AsyncIterable<T> {
  signal.throwIfAborted();
  const reader = stream.getReader();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new DOMException("Model request cancelled", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await Promise.race([reader.read(), aborted]);
      if (next.done) return;
      yield next.value;
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    // Cancellation itself may wait on a non-cooperative provider. Never await it.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
