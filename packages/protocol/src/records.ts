// 会话日志记录类型（11 §3.5）与统一工具结果（06 §2.3）。
// LogRecord 是 session_log 行的形状，也是同步通道 rec 消息中的 record。

import { z } from "zod";
import { FileIntentMeta } from "./files.ts";
import { ClassifiedError, JsonObject, ToolCall, Usage } from "./neutral.ts";

// ---------- 06 §2.3 统一工具结果 ----------

export const ToolResultStatus = z.enum(["ok", "error", "partial", "not_executed", "uncertain"]);
export type ToolResultStatus = z.infer<typeof ToolResultStatus>;

export const ToolError = z.object({
  /** 06 §9 错误码词表。 */
  code: z.string(),
  /** 给模型看的中文说明。 */
  message: z.string(),
  /** 下一步建议。 */
  hint: z.string().optional(),
  /** 参数错误时的字段路径。 */
  field: z.string().optional(),
  retryable: z.boolean(),
});
export type ToolError = z.infer<typeof ToolError>;

export const ToolResult = z.object({
  status: ToolResultStatus,
  /** 工具特定内容。 */
  data: z.unknown().optional(),
  error: ToolError.optional(),
  /** 文本文件的内容哈希。 */
  versions: z.record(z.string(), z.string()).optional(),
  /** 相关活文档的当前修订号。 */
  docRevs: z.record(z.string(), z.number()).optional(),
  /** 写入类工具实际落盘的变更摘要。 */
  changes: z.unknown().optional(),
  truncated: z.object({ shown: z.number(), total: z.number(), cursor: z.string() }).optional(),
  /** 需要进入模型视觉输入的图片。 */
  images: z.array(z.object({ mediaType: z.string(), data: z.string() })).optional(),
});
export type ToolResult = z.infer<typeof ToolResult>;

/** 06 §9 工具错误码词表【硬性：统一词表，新增需登记】。 */
export const TOOL_ERROR_CODES = [
  "INVALID_ARGUMENT",
  "NOT_FOUND",
  "OUT_OF_WORKSPACE",
  "VERSION_CONFLICT",
  "FILE_LEASED",
  "APPROVAL_DENIED",
  "UNSUPPORTED_FEATURE",
  "LIMIT_EXCEEDED",
  "TIMEOUT",
  "CANCELLED",
  "SANDBOX_ERROR",
  "FORMULA_ERROR",
  "EXTERNAL_ERROR",
  "INTERNAL",
] as const;
export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

// ---------- 记录公共字段 ----------

export const PermissionMode = z.enum(["confirm", "standard", "auto"]);
export type PermissionMode = z.infer<typeof PermissionMode>;

/** 审批决定的持久化形式。REST 同时接受 approve/deny 别名。 */
export const ApprovalDecision = z.enum(["approved", "denied"]);
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;
export const ApprovalEffect = z.enum([
  "read",
  "write",
  "destructive",
  "external",
  "interactive",
  "agent",
  "state",
]);
export type ApprovalEffect = z.infer<typeof ApprovalEffect>;

export const DispatchStatus = z.enum(["accepted", "queued", "applied", "cancelled", "failed"]);
export type DispatchStatus = z.infer<typeof DispatchStatus>;

/** 用户消息派发策略（04 §4.1）。 */
export const DispatchMode = z.enum(["steer", "interrupt", "queue"]);
export type DispatchMode = z.infer<typeof DispatchMode>;

export const AgentRole = z.enum(["main", "lead", "worker", "reader"]);
export type AgentRole = z.infer<typeof AgentRole>;

export const ReplayKind = z.enum(["safe", "unsafe", "unknown"]);
export type ReplayKind = z.infer<typeof ReplayKind>;

export const AgentStatus = z.enum([
  "idle",
  "running",
  "waiting",
  "blocked",
  "paused",
  "interrupted",
  "failed",
  "closed",
]);
export type AgentStatus = z.infer<typeof AgentStatus>;

// ---------- 各类记录的 data schema ----------

/** 随消息携带的选区上下文引用（04 §7.3）：渲染为该轮用户消息前的 <context> 块。 */
export const ContextRef = z.object({
  docId: z.string(),
  rev: z.int().nonnegative(),
  range: z.string(),
});
export type ContextRef = z.infer<typeof ContextRef>;

export const RECORD_DATA_SCHEMAS = {
  "session.created": z.object({
    workspaceId: z.string(),
    title: z.string().nullable().optional(),
    permissionMode: PermissionMode,
  }),
  "session.updated": z.object({
    title: z.string().optional(),
    permissionMode: PermissionMode.optional(),
  }),
  "agent.spawned": z.object({
    role: AgentRole,
    parentId: z.string().nullable().optional(),
    name: z.string().optional(),
    modelProfileId: z.string().nullable().optional(),
    task: z.string().optional(),
    files: z.array(z.string()).optional(),
    budget: JsonObject.optional(),
    /** 会话创建时生成一次并冻结的系统提示词（04 §7.3），存于 agents 投影。 */
    systemPrompt: z.string().optional(),
  }),
  "agent.status": z.object({ status: AgentStatus }),
  "inbox.sent": z.object({
    messageId: z.string(),
    fromAgentId: z.string(),
    toAgentId: z.string(),
    kind: z.enum(["agent", "report", "notice", "user"]),
    message: z.string(),
    urgent: z.boolean().optional(),
  }),
  "inbox.delivered": z.object({
    messageId: z.string(),
    toAgentId: z.string(),
  }),
  "user.message": z.object({
    dispatchId: z.string(),
    clientMessageId: z.string(),
    text: z.string(),
    mode: DispatchMode.optional(),
    /** 本轮变化的上下文（04 §7.3），进入上下文时包进 <context> 块。 */
    context: z.array(ContextRef).optional(),
  }),
  "dispatch.updated": z.object({
    dispatchId: z.string(),
    status: DispatchStatus,
  }),
  "turn.started": z.object({ turnId: z.string() }),
  "turn.completed": z.object({
    turnId: z.string(),
    reason: z.string(),
    usage: Usage.optional(),
  }),
  "turn.failed": z.object({ turnId: z.string(), error: ClassifiedError }),
  "turn.interrupted": z.object({ turnId: z.string() }),
  "step.started": z.object({
    turnId: z.string(),
    stepId: z.string(),
    step: z.number().int().positive(),
    model: z.string(),
  }),
  "model.output": z.object({
    stepId: z.string(),
    text: z.string().optional(),
    reasoning: z.string().optional(),
    reasoningProviderOptions: JsonObject.optional(),
    toolCalls: z.array(ToolCall).optional(),
  }),
  "attempt.discarded": z.object({ stepId: z.string() }),
  "tool.intent": z.object({
    stepId: z.string(),
    toolCallId: z.string(),
    toolName: z.string(),
    args: z.unknown(),
    targets: z.array(z.string()),
    replay: ReplayKind,
    intentMeta: FileIntentMeta.optional(),
  }),
  "tool.result": z.object({
    toolCallId: z.string(),
    toolName: z.string(),
    status: ToolResultStatus,
    result: ToolResult,
  }),
  "approval.requested": z.object({
    approvalId: z.string(),
    toolCallId: z.string(),
    toolName: z.string(),
    args: z.unknown(),
    targets: z.array(z.string()),
    effect: ApprovalEffect,
    spec: z.record(z.string(), z.unknown()).optional(),
  }),
  "approval.decided": z.object({
    approvalId: z.string(),
    decision: ApprovalDecision,
    reason: z.string().optional(),
    remember: z.boolean().optional(),
  }),
  "question.asked": z.object({
    questionId: z.string(),
    questionType: z.enum(["choice", "text", "range_confirm", "range_pick", "change_confirm"]),
    spec: z.record(z.string(), z.unknown()),
  }),
  "question.answered": z.object({
    questionId: z.string(),
    answer: z.unknown(),
    rev: z.number().int().nonnegative().optional(),
  }),
  "ui.present": z.object({ payload: z.unknown() }),
  "todo.set": z.object({ items: z.array(z.record(z.string(), z.unknown())) }),
  "todo.updated": z.object({
    todoId: z.string().optional(),
    status: z.string().optional(),
    result: z.unknown().optional(),
  }),
  "change.summary": z.object({
    docId: z.string().optional(),
    docRevs: z.record(z.string(), z.number()).optional(),
    changes: z.unknown(),
    toolCallId: z.string().optional(),
  }),
  "retry.scheduled": z.object({
    attempt: z.number().int().positive(),
    waitMs: z.number(),
    reason: z.string(),
  }),
  "error.guidance": z.object({
    kind: z.string(),
    message: z.string(),
    actions: z.array(z.string()),
  }),
  "usage.updated": z.object({
    turnId: z.string().optional(),
    usage: Usage,
    cumulative: Usage.optional(),
    /** 运行时累计预算计数（模型 token 之外的步数/工具调用）。 */
    steps: z.number().int().nonnegative().optional(),
    toolCalls: z.number().int().nonnegative().optional(),
    /** 当前上下文占用（04 §6.1）；window 未知为 null。 */
    context: z
      .object({ tokens: z.int(), window: z.int().nullable(), estimated: z.boolean() })
      .optional(),
  }),
  /** 上下文压缩记录（04 §6.3）；agent_context 投影标记被摘要取代的条目。 */
  compaction: z.object({
    trigger: z.enum(["auto", "manual", "overflow"]),
    summary: z.string(),
    /** 保留原文尾部第一条条目的 from_seq；null = 不保留原文。 */
    keepFromSeq: z.int().nullable(),
    beforeTokens: z.int(),
    afterTokens: z.int(),
    /** true 表示 token 数为字符估算而非提供商报告。 */
    estimated: z.boolean(),
  }),
} satisfies Record<string, z.ZodType<unknown>>;

export type RecordType = keyof typeof RECORD_DATA_SCHEMAS;

export type LogData<T extends RecordType> = z.infer<(typeof RECORD_DATA_SCHEMAS)[T]>;

/** 校验记录 data；已知类型严格校验，未知类型原样通过（向前兼容模块新记录）。 */
export function parseRecordData(type: string, data: unknown): unknown {
  const schema = (RECORD_DATA_SCHEMAS as Record<string, z.ZodType<unknown>>)[type];
  if (!schema) return data;
  return schema.parse(data);
}

export const LogRecord = z.object({
  seq: z.number().int().positive(),
  sessionId: z.string(),
  agentId: z.string().nullable(),
  type: z.string().min(1),
  data: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime(),
});
export type LogRecord = z.infer<typeof LogRecord>;
