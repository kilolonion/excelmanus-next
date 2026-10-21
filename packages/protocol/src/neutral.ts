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
  inputError: z.string().optional(),
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
  z.object({
    kind: z.literal("user"),
    text: z.string(),
    /** 图片附件引用；data 只在调用模型前由运行时临时填入（base64），不进 agent_context。 */
    images: z
      .array(z.object({ sha256: z.string(), mediaType: z.string(), data: z.string().optional() }))
      .optional(),
  }),
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

/** 持久化给客户端的错误指引（与 turn.failed 的分类错误分开）。 */
export const ErrorGuidance = z.object({
  kind: z.string(),
  message: z.string(),
  actions: z.array(z.string()),
  /** 服务端已确认可由用户重新发起请求；缺失表示未知。 */
  retryable: z.boolean().optional(),
});
export type ErrorGuidance = z.infer<typeof ErrorGuidance>;

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
  /** 模型上下文窗口 token 数；档案未配置时缺省（04 §6.1）。 */
  contextWindow?: number;
  maxOutputTokens?: number;
  providerOptions?: JsonObject;
  reasoning?: string;
  /** 额外请求头（09 §3 extraHeaders）。 */
  extraHeaders?: Record<string, string>;
  /** 订阅账号（09 §4）：每次请求前取有效访问令牌（必要时自动刷新）。 */
  subscription?: {
    accessToken(): Promise<string>;
    accountId?: string;
  };
  /** 视觉能力（09 §6）：false 时图片不发送给模型。 */
  vision?: boolean;
  /** 代理设置（09 §7）：由装配层注入的 fetch。 */
  fetch?: typeof fetch;
}

/** 网关 → 运行时的流式中立事件（瞬时不入库）。 */
export type StepEvent =
  | { kind: "text.delta"; text: string }
  | { kind: "reasoning.delta"; text: string; providerMetadata?: unknown }
  /** 工具参数分片；首个分片（提供商的 tool-input-start）带工具名、delta 可为空。 */
  | { kind: "tool.args.delta"; toolCallId: string; toolName?: string; delta: string }
  | {
      kind: "tool.call";
      toolCallId: string;
      toolName: string;
      /** 已按 JSON 解析的参数；解析失败时 args=null 且 rawArgs 保留原文。 */
      args: unknown;
      rawArgs: string;
      /** 参数 JSON 损坏时的诊断，不丢失为普通 null 参数错误。 */
      inputError?: string;
    }
  | { kind: "finish"; reason: FinishReason; rawReason?: string }
  | { kind: "usage"; usage: Usage }
  | { kind: "error"; error: ClassifiedError }
  | { kind: "raw"; value: unknown };
