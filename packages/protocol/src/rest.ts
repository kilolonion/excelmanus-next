// REST DTO（11 §2、§4）。字段一律 camelCase。

import { z } from "zod";
import { JsonObject } from "./neutral.ts";
import {
  AgentRole,
  AgentStatus,
  ContextRef,
  DispatchMode,
  DispatchStatus,
  LogRecord,
  PermissionMode,
} from "./records.ts";
import { ErrorBody } from "./sync.ts";

// ---------- 错误 ----------

export const RestError = z.object({
  error: ErrorBody.extend({
    requestId: z.string(),
    details: z.unknown().optional(),
  }),
});
export type RestError = z.infer<typeof RestError>;

/** REST 错误码词表（与工具错误码、模型错误 kind 分开）。 */
export const REST_ERROR_CODES = [
  "unauthorized",
  "forbidden_host",
  "forbidden_origin",
  "bad_request",
  "not_found",
  "conflict",
  "payload_too_large",
  "invalid_ticket",
  "not_implemented",
  "internal",
] as const;

// ---------- 基础 ----------

export const HealthResponse = z.object({
  ok: z.literal(true),
  protocolVersion: z.int(),
  version: z.string(),
});

export const BootstrapResponse = z.object({
  protocolVersion: z.int(),
  appVersion: z.string(),
  /** 部署形态：本机 Web / 桌面 / 服务器。 */
  shape: z.string(),
  hasModelProfile: z.boolean(),
  modules: z.array(z.string()),
  features: z.record(z.string(), z.boolean()),
});

export const TicketResponse = z.object({
  ticket: z.string(),
  expiresAt: z.iso.datetime(),
});

// ---------- 模型档案 ----------

export const ReasoningLevel = z.enum([
  "provider-default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);
export type ReasoningLevel = z.infer<typeof ReasoningLevel>;

export const ProviderPreset = z.object({
  id: z.string(),
  displayName: z.string(),
  adapter: z.enum(["openai", "anthropic", "deepseek", "openai-compatible"]),
  defaultBaseUrl: z.string().optional(),
  apiKeyHelpUrl: z.string().optional(),
  directChina: z.boolean().optional(),
});
export type ProviderPreset = z.infer<typeof ProviderPreset>;

export const ModelProfile = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  model: z.string(),
  baseUrl: z.string().optional(),
  hasCredential: z.boolean(),
  /** API Key 读回只返回掩码（10 §4）。 */
  apiKeyMasked: z.string().nullable(),
  contextWindow: z.int().positive().nullable().optional(),
  maxOutputTokens: z.int().positive().nullable().optional(),
  reasoning: ReasoningLevel.optional(),
  providerOptions: JsonObject.optional(),
  isDefault: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ModelProfile = z.infer<typeof ModelProfile>;

export const CreateModelProfileBody = z.strictObject({
  name: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  contextWindow: z.int().positive().optional(),
  maxOutputTokens: z.int().positive().optional(),
  reasoning: ReasoningLevel.optional(),
  providerOptions: JsonObject.optional(),
  isDefault: z.boolean().optional(),
});
export type CreateModelProfileBody = z.infer<typeof CreateModelProfileBody>;

export const UpdateModelProfileBody = z.strictObject({
  name: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  baseUrl: z.string().nullable().optional(),
  /** 省略=不变；空字符串=清除凭据；其他值=替换凭据。 */
  apiKey: z.string().optional(),
  contextWindow: z.int().positive().nullable().optional(),
  maxOutputTokens: z.int().positive().nullable().optional(),
  reasoning: ReasoningLevel.nullable().optional(),
  providerOptions: JsonObject.nullable().optional(),
});
export type UpdateModelProfileBody = z.infer<typeof UpdateModelProfileBody>;

export const TestProfileResponse = z.object({
  ok: z.boolean(),
  latencyMs: z.number().optional(),
  error: z.object({ kind: z.string(), message: z.string() }).optional(),
});

// ---------- 会话 ----------

export const SessionSummary = z.object({
  id: z.string(),
  workspaceId: z.string(),
  title: z.string().nullable(),
  permissionMode: PermissionMode,
  createdAt: z.string(),
  updatedAt: z.string(),
  lastSeq: z.int().nonnegative(),
});
export type SessionSummary = z.infer<typeof SessionSummary>;

export const AgentInfo = z.object({
  id: z.string(),
  sessionId: z.string(),
  parentId: z.string().nullable(),
  name: z.string().nullable(),
  role: AgentRole,
  status: AgentStatus,
  modelProfileId: z.string().nullable(),
});
export type AgentInfo = z.infer<typeof AgentInfo>;

export const CreateSessionBody = z.strictObject({
  workspaceId: z.string().optional(),
  title: z.string().optional(),
  permissionMode: PermissionMode.optional(),
  modelProfileId: z.string().optional(),
});
export type CreateSessionBody = z.infer<typeof CreateSessionBody>;

export const UpdateSessionBody = z.strictObject({
  title: z.string().optional(),
  permissionMode: PermissionMode.optional(),
});

export const SessionListResponse = z.object({
  items: z.array(SessionSummary),
  nextCursor: z.string().optional(),
});

export const SessionDetailResponse = z.object({
  session: SessionSummary,
  agents: z.array(AgentInfo),
  headSeq: z.int().nonnegative(),
});

export const CreateSessionResponse = z.object({
  session: SessionSummary,
  agents: z.array(AgentInfo),
});

export const SessionLogResponse = z.object({
  items: z.array(LogRecord),
});

export const Dispatch = z.object({
  id: z.string(),
  sessionId: z.string(),
  agentId: z.string(),
  clientMessageId: z.string(),
  mode: DispatchMode,
  status: DispatchStatus,
});
export type Dispatch = z.infer<typeof Dispatch>;

export const SendMessageBody = z.strictObject({
  clientMessageId: z.string().min(1).max(128),
  text: z.string().min(1),
  mode: DispatchMode.optional(),
  /** 随消息携带的选区引用（04 §7.3），渲染进该轮用户消息前的 <context> 块。 */
  context: z.array(ContextRef).optional(),
});
export type SendMessageBody = z.infer<typeof SendMessageBody>;

export const SendMessageResponse = z.object({
  dispatch: Dispatch,
  /** 同 clientMessageId 重复提交时命中已有派发。 */
  deduplicated: z.boolean(),
});

export const StopResponse = z.object({ ok: z.literal(true), stopped: z.boolean() });

export const ProviderListResponse = z.object({
  items: z.array(ProviderPreset),
});

export const ProfileListResponse = z.object({
  items: z.array(ModelProfile),
});

export const ProfileResponse = z.object({ profile: ModelProfile });

export const OkResponse = z.object({ ok: z.literal(true) });

// ---------- 工作区文档（活文档只读快照）与文件 ----------

export const DocKind = z.enum(["xlsx", "csv"]);
export type DocKind = z.infer<typeof DocKind>;

export const DocumentInfo = z.object({
  id: z.string(),
  workspaceId: z.string(),
  path: z.string(),
  kind: DocKind,
  rev: z.int().nonnegative(),
  createdAt: z.string(),
});
export type DocumentInfo = z.infer<typeof DocumentInfo>;

export const OpenDocBody = z.strictObject({ path: z.string().min(1) });
export type OpenDocBody = z.infer<typeof OpenDocBody>;

export const OpenDocResponse = z.object({ document: DocumentInfo });

/** snapshot = Univer IWorkbookData（07 §3 快照定影：结构化 JSON，逐字节无关）。 */
export const DocSnapshotResponse = z.object({
  document: DocumentInfo,
  snapshot: JsonObject,
});

export const FileEntry = z.object({
  name: z.string(),
  /** 工作区相对路径（POSIX 分隔符）。 */
  path: z.string(),
  kind: z.enum(["file", "dir"]),
  size: z.number().nonnegative().optional(),
  modifiedAt: z.string().optional(),
});
export type FileEntry = z.infer<typeof FileEntry>;

export const FileListResponse = z.object({
  path: z.string(),
  items: z.array(FileEntry),
});

export const UploadResponse = z.object({
  path: z.string(),
  size: z.number().nonnegative(),
});
