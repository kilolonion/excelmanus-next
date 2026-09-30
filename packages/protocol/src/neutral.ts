// 中立模型消息/事件格式（03 §5.2 窄接口、04 §1）。
// 运行时与会话日志只见这些类型；AI SDK 类型只允许出现在 models 包适配层。
// 本文件不得 import 'ai' 或 '@ai-sdk/*'。

import { z } from "zod";

export const JsonObject = z.record(z.string(), z.unknown());
export type JsonObject = z.infer<typeof JsonObject>;

export const ToolCall = z.object({
  id: z.string(),
  name: z.string(),
  args: z.unknown(),
});
export type ToolCall = z.infer<typeof ToolCall>;

/** 发给模型的工具描述：名称 + 说明 + JSON Schema，不含执行函数。 */
export const ToolSpec = z.object({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: JsonObject,
});
export type ToolSpec = z.infer<typeof ToolSpec>;

/** 模型上下文条目（agent_context 投影的 item 格式）。 */
export const ContextItem = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), text: z.string() }),
  z.object({
    kind: z.literal("assistant"),
    text: z.string().optional(),
    reasoning: z.string().optional(),
    /** 提供商原始格式附加数据（04 §10），原样回传。 */
    reasoningProviderOptions: JsonObject.optional(),
    toolCalls: z.array(ToolCall).optional(),
  }),
  z.object({
    kind: z.literal("toolResult"),
    toolCallId: z.string(),
    toolName: z.string(),
    output: z.unknown(),
    isError: z.boolean().optional(),
  }),
]);
export type ContextItem = z.infer<typeof ContextItem>;

export const FinishReason = z.enum([
  "stop",
  "length",
  "content-filter",
  "tool-calls",
  "error",
  "other",
  "unknown",
]);
export type FinishReason = z.infer<typeof FinishReason>;

/** 04 §9 错误分类词表（模型侧，与工具错误码分开命名空间）。 */
export const ErrorKind = z.enum([
  "auth",
  "model_not_found",
  "invalid_request",
  "rate_limit",
  "server_error",
  "network",
  "stream_interrupted",
  "context_overflow",
  "aborted",
  "content_filter",
  "unknown",
]);
export type ErrorKind = z.infer<typeof ErrorKind>;

export const ClassifiedError = z.object({
  kind: ErrorKind,
  retryable: z.boolean(),
  retryAfterMs: z.number().optional(),
  /** 面向用户的安全摘要——不含密钥、请求头。 */
  message: z.string(),
  statusCode: z.number().optional(),
  /** 原始错误体摘要（截断脱敏）。 */
  detail: z.string().optional(),
});
export type ClassifiedError = z.infer<typeof ClassifiedError>;

export const Usage = z.object({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  reasoningTokens: z.number().optional(),
  totalTokens: z.number().optional(),
});
export type Usage = z.infer<typeof Usage>;

/**
 * 已解析的模型（档案 + 解密凭据 + providerOptions）。
 * 只在服务端内存中存在：apiKey 不写入日志、不经 schema 序列化传给前端。
 */
export interface ResolvedModel {
  profileId: string;
  provider: string;
  model: string;
  baseUrl?: string;
  apiKey: string;
  providerOptions?: JsonObject;
  reasoning?: string;
}

/** 网关 → 运行时的流式中立事件（瞬时不入库）。 */
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
  | { kind: "usage"; usage: Usage }
  | { kind: "error"; error: ClassifiedError }
  | { kind: "raw"; value: unknown };
