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
import { classifyError, incompleteStreamError } from "./errors.ts";

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
  /** 单次模型流无事件等待上限；持续输出的长思考不受影响。 */
  idleTimeoutMs?: number;
  /** 测试注入：替换模型输出（如 ai/test 的 MockLanguageModel），不替代其他代码。 */
  resolveLanguageModel?: (model: ResolvedModel) => unknown;
}

/** tool 消息内容只能是字符串的适配器（图片需改走 user 消息）。 */
const CHAT_TOOL_STRING_ADAPTERS = new Set(["openai-compatible", "moonshotai"]);

export function createGateway(opts: GatewayOptions = {}): ModelGatewayLike {
  const resolve = opts.resolveLanguageModel ?? resolveLanguageModel;
  return { step: (req) => stepImpl(resolve, req, opts.idleTimeoutMs ?? 180_000) };
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
  idleTimeoutMs: number,
): AsyncIterable<StepEvent> {
  let sawContent = false;
  let sawFailure = false;
  let sawFinish = false;
  const transportAbort = new AbortController();
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
      maxOutputTokens: req.model.maxOutputTokens,
      model: resolve(req.model) as LanguageModel,
      system: req.system,
      messages: toModelMessages(req.history, {
        vision: req.model.vision,
        deliveryCatalog: req.tools?.some(tool => tool.name === "deliver") === true,
        toolImagesAsUser: CHAT_TOOL_STRING_ADAPTERS.has(
          presetFor(req.model.provider)?.adapter ?? "openai-compatible",
        ),
      }),
      tools: toToolSet(req.tools),
      abortSignal: AbortSignal.any([req.signal, transportAbort.signal]),
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
    for await (const part of abortableStream(result.fullStream, req.signal, idleTimeoutMs, () =>
      transportAbort.abort(),
    )) {
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
        case "tool-input-start":
          // 只转发工具名，界面据此提前画出"正在准备调用某工具"；不算已产出内容。
          yield {
            kind: "tool.args.delta",
            toolCallId: part.id,
            toolName: part.toolName,
            delta: "",
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
          let inputError: string | undefined;
          try {
            args = JSON.parse(raw);
          } catch (error) {
            const position =
              error instanceof Error ? /position (\d+)/.exec(error.message)?.[1] : undefined;
            inputError = `工具参数 JSON 无法解析（${raw.length} 字符${position ? `，错误位置 ${position}` : ""}），可能缺少闭合符号或包含未转义文本。请修正参数后重新提交；该调用尚未执行。`;
          }
          yield {
            kind: "tool.call",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            args,
            rawArgs: raw,
            ...(inputError ? { inputError } : {}),
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
          // SDK 会在错误后仍发 finish(error)，不能把它变成成功的结束事件。
          if (sawFailure) break;
          if (
            !part.finishReason ||
            part.finishReason === "error" ||
            (part.finishReason === "other" && !part.rawFinishReason?.trim())
          ) {
            sawFailure = true;
            yield { kind: "error", error: incompleteStreamError() };
            break;
          }
          sawFinish = true;
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
          sawFailure = true;
          yield {
            kind: "error",
            error: { kind: "aborted", retryable: false, message: "aborted by signal" },
          };
          break;
        case "error":
          sawFailure = true;
          yield { kind: "error", error: classifyError(part.error, sawContent) };
          break;
        case "raw":
          yield { kind: "raw", value: part.rawValue };
          break;
        default:
          // start / start-step / text-start|end / reasoning-start|end /
          // tool-input-end / source / file / tool-approval* 等骨架事件不出中立面。
          break;
      }
    }
    if (!sawFinish && !sawFailure) {
      yield { kind: "error", error: incompleteStreamError() };
    }
  } catch (e) {
    if (e instanceof ModelIdleError) {
      yield {
        kind: "error",
        error: {
          kind: sawContent ? "stream_interrupted" : "network",
          retryable: false,
          message: e.message,
        },
      };
      return;
    }
    yield { kind: "error", error: classifyError(e, sawContent) };
  }
}

class ModelIdleError extends Error {
  constructor(ms: number) {
    super(
      `模型连续 ${Math.ceil(ms / 1000)} 秒未返回数据，已结束本次等待。未执行尚未完整生成的工具调用；可以重试或更换模型。`,
    );
  }
}

/** A provider can stall before returning its stream or ignore cancellation. Stop
 * consuming independently so late model output cannot keep an actor/database alive.
 * Keep the SDK abort signal too: cooperative transports still cancel their I/O. */
async function* abortableStream<T>(
  stream: ReadableStream<T>,
  signal: AbortSignal,
  idleTimeoutMs: number,
  onIdle: () => void,
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
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new ModelIdleError(idleTimeoutMs));
          onIdle();
        }, idleTimeoutMs);
      });
      const next = await Promise.race([reader.read(), aborted, idle]).finally(() =>
        clearTimeout(timer),
      );
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
