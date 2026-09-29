// ModelGateway.step 的 AI SDK 7 实现（03 §5.2 窄接口）。
// 一次 step = 恰好一次 streamText，工具无 execute，stopWhen=stepCountIs(1)
// 保证只生成一步；harness 侧用 doStreamCalls/fetch 计数复核。

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel, ToolSet } from "ai";
import { jsonSchema, stepCountIs, streamText, tool } from "ai";
import type { ModelGateway, ModelHandle, StepEvent, StepRequest, ToolSpec } from "../neutral.ts";
import { toModelMessages } from "./convert.ts";
import { classifyError } from "./errors.ts";

export function createGateway(model: ModelHandle): ModelGateway {
  return { step: (req) => stepImpl(model, req) };
}

export function createMimoModel(opts: {
  baseURL: string;
  apiKey: string;
  modelId: string;
  fetch?: typeof globalThis.fetch;
}): ModelHandle {
  const provider = createOpenAICompatible({
    name: "mimo",
    baseURL: opts.baseURL,
    apiKey: opts.apiKey,
    includeUsage: true,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  return provider.chatModel(opts.modelId) as unknown as ModelHandle;
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

async function* stepImpl(model: ModelHandle, req: StepRequest): AsyncIterable<StepEvent> {
  let sawContent = false;
  try {
    const result = streamText({
      model: model as unknown as LanguageModel,
      system: req.system,
      messages: toModelMessages(req.history),
      tools: toToolSet(req.tools),
      abortSignal: req.signal,
      stopWhen: stepCountIs(1),
      // 重试由运行时按 04 §9 策略执行；网关只分类，故关掉 SDK 内部重试。
      maxRetries: 0,
      providerOptions: req.providerOptions as never,
      // 错误已作为 error 事件交给运行时；关闭 SDK 默认的 console.error（会打印请求 URL 等细节）
      onError: () => {},
    });
    for await (const part of result.fullStream) {
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
