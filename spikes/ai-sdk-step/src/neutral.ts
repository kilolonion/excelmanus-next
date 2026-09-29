// 中立消息/事件类型——03 §5.2 窄接口的运行时侧契约。
// 本文件不得 import 'ai' 或 '@ai-sdk/*'：运行时与日志只见这些类型。

export type JsonObject = Record<string, unknown>;

/** 模型句柄对运行时是不透明的；网关内部再转回 AI SDK 类型。 */
export type ModelHandle = { readonly __modelHandle: unique symbol };

export interface ToolSpec {
  name: string;
  description?: string;
  /** JSON Schema（draft-07 兼容对象）。 */
  inputSchema: JsonObject;
}

export type ContextItem =
  | { kind: "user"; text: string }
  | {
      kind: "assistant";
      text?: string;
      reasoning?: string;
      /** 提供商原始格式附加数据（04 §10），原样回传。 */
      reasoningProviderOptions?: JsonObject;
      toolCalls?: Array<{ id: string; name: string; args: unknown }>;
    }
  | {
      kind: "toolResult";
      toolCallId: string;
      toolName: string;
      output: unknown;
      isError?: boolean;
    };

export type FinishReason =
  | "stop"
  | "length"
  | "content-filter"
  | "tool-calls"
  | "error"
  | "other"
  | "unknown";

export type ErrorKind =
  | "auth"
  | "model_not_found"
  | "invalid_request"
  | "rate_limit"
  | "server_error"
  | "network"
  | "stream_interrupted"
  | "context_overflow"
  | "aborted"
  | "content_filter"
  | "unknown";

export interface ClassifiedError {
  kind: ErrorKind;
  retryable: boolean;
  retryAfterMs?: number;
  /** 面向用户的安全摘要——不含密钥、请求头。 */
  message: string;
  statusCode?: number;
  /** 原始错误体摘要（截断脱敏）。 */
  detail?: string;
}

export interface UsageInfo {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
}

export type StepEvent =
  | { kind: "text.delta"; text: string }
  | { kind: "reasoning.delta"; text: string; providerMetadata?: unknown }
  | { kind: "tool.args.delta"; toolCallId: string; delta: string }
  | {
      kind: "tool.call";
      toolCallId: string;
      toolName: string;
      /** 已按 JSON 解析的参数；解析失败时 args=null 且 rawArgs 保留原文。 */
      args: unknown;
      rawArgs: string;
    }
  | { kind: "finish"; reason: FinishReason; rawReason?: string }
  | { kind: "usage"; usage: UsageInfo }
  | { kind: "error"; error: ClassifiedError }
  | { kind: "raw"; value: unknown };

export interface StepRequest {
  model: ModelHandle;
  system?: string;
  history: ContextItem[];
  tools?: ToolSpec[];
  signal: AbortSignal;
  /** 透传给提供商的选项（openai-compatible 的 providerOptions）。 */
  providerOptions?: JsonObject;
}

export interface ModelGateway {
  step(req: StepRequest): AsyncIterable<StepEvent>;
}
