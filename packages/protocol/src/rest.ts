// REST DTO（11 §2、§4）。字段一律 camelCase。

import { z } from "zod";
import { JsonObject } from "./neutral.ts";
import {
  AgentRole,
  AgentStatus,
  AttachmentRef,
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
  "forbidden",
  "forbidden_host",
  "forbidden_origin",
  "bad_request",
  "not_found",
  "conflict",
  "payload_too_large",
  "unsupported_media_type",
  "invalid_ticket",
  "not_implemented",
  "bad_gateway",
  "internal",
] as const;

// ---------- 基础 ----------

export const HealthResponse = z.object({
  ok: z.literal(true),
  protocolVersion: z.int(),
  version: z.string(),
});

/** 浏览器本机登录：服务端以 HttpOnly 会话 Cookie 绑定当前设备令牌。 */
export const AuthSessionResponse = z.object({
  authenticated: z.literal(true),
  expiresAt: z.iso.datetime().optional(),
});

export const BootstrapResponse = z.object({
  protocolVersion: z.int(),
  appVersion: z.string(),
  /** 部署形态：本机 Web / 桌面 / 服务器。 */
  shape: z.string(),
  hasModelProfile: z.boolean(),
  modules: z.array(z.string()),
  features: z.record(z.string(), z.boolean()),
  /** 本机数据目录（会话、设置、密钥所在位置），供设置 → 工作区与备份展示（16 §4.3）。 */
  dataDir: z.string().optional(),
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
  "max",
]);
export type ReasoningLevel = z.infer<typeof ReasoningLevel>;

export const ProviderPreset = z.object({
  id: z.string(),
  displayName: z.string(),
  adapter: z.enum([
    "openai",
    "anthropic",
    "deepseek",
    "google",
    "moonshotai",
    "xai",
    "openai-compatible",
    "chatgpt",
  ]),
  defaultBaseUrl: z.string().optional(),
  apiKeyHelpUrl: z.string().optional(),
  directChina: z.boolean().optional(),
  /** 凭据类型：API Key（默认）、订阅账号登录、无需凭据（本机服务）。 */
  auth: z.enum(["api_key", "subscription", "none"]).optional(),
  /** 界面提示（如订阅接口非公开的说明）。 */
  note: z.string().optional(),
  /** 常用模型 ID 建议（不代表能力承诺）。 */
  suggestedModels: z.array(z.string()).optional(),
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
  /** 额外请求头（读回时值为掩码）。 */
  extraHeaders: z.record(z.string(), z.string()).optional(),
  maxConcurrency: z.int().positive().optional(),
  /** 关联的订阅账号（provider=chatgpt 时）。 */
  accountId: z.string().nullable().optional(),
  /** 09 §3 能力：每项 value + source（catalog/probe/manual）。 */
  capabilities: z
    .record(
      z.string(),
      z.object({
        value: z.boolean().nullable(),
        source: z.enum(["catalog", "probe", "manual"]).nullable(),
        checkedAt: z.string().nullable(),
        detail: z.string().optional(),
      }),
    )
    .optional(),
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
  extraHeaders: z.record(z.string(), z.string()).optional(),
  maxConcurrency: z.int().positive().max(64).optional(),
  accountId: z.string().optional(),
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
  /** 值为掩码的键保留原值。 */
  extraHeaders: z.record(z.string(), z.string()).nullable().optional(),
  maxConcurrency: z.int().positive().max(64).nullable().optional(),
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
  workspaceId: z.string().min(1).optional(),
  title: z.string().optional(),
  permissionMode: PermissionMode.optional(),
  modelProfileId: z.string().optional(),
  /** 自动落点复用纯空白会话；显式新建默认不复用。 */
  reuseBlank: z.boolean().optional(),
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

export const SessionListQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  q: z.string().optional(),
  workspaceId: z.string().min(1).optional(),
});

/** 待处理交互（11 §4 `GET /sessions/{id}`）：未决的审批与提问。 */
export const PendingInteraction = z.object({
  id: z.string(),
  kind: z.enum(["approval", "question"]),
  agentId: z.string(),
  toolCallId: z.string().nullable(),
  createdAt: z.string(),
});
export type PendingInteraction = z.infer<typeof PendingInteraction>;

export const SessionDetailResponse = z.object({
  session: SessionSummary,
  agents: z.array(AgentInfo),
  headSeq: z.int().nonnegative(),
  pendingInteractions: z.array(PendingInteraction).optional(),
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
  replacesDispatchId: z.string().min(1).optional(),
  text: z.string().min(1),
  mode: DispatchMode.optional(),
  /** 随消息携带的选区引用（04 §7.3），渲染进该轮用户消息前的 <context> 块。 */
  context: z.array(ContextRef).optional(),
  /** 已经 POST /attachments 上传的图片（04 §4：受理前校验已上传）。 */
  attachments: z.array(AttachmentRef).max(8).optional(),
});
export type SendMessageBody = z.infer<typeof SendMessageBody>;

export const SendMessageResponse = z.object({
  dispatch: Dispatch,
  /** 同 clientMessageId 重复提交时命中已有派发。 */
  deduplicated: z.boolean(),
});

export const DispatchResponse = z.object({ dispatch: Dispatch });

export const StopResponse = z.object({ ok: z.literal(true), stopped: z.boolean() });

/** 停止会话全部运行中代理（11 §147）：stopped 为实际被停止的 agentId。 */
export const StopAllResponse = z.object({ ok: z.literal(true), stopped: z.array(z.string()) });

/** 继续：重新入队挂起派发的数量与是否实际开轮（04 §4.2、§8.3）。 */
export const ResumeResponse = z.object({
  ok: z.literal(true),
  resumed: z.int().nonnegative(),
  started: z.boolean(),
});

/** 手动压缩：空闲立即压缩，运行中排期到下一步边界（04 §6.3、11 §4）。 */
export const CompactResponse = z.object({
  compacted: z.boolean(),
  scheduled: z.boolean(),
});

/** 用户控制代理（05 §11、11 §150）：pause/resume/close，返回动作后状态。 */
export const ControlBody = z.strictObject({
  action: z.enum(["pause", "resume", "close"]),
});
export type ControlBody = z.infer<typeof ControlBody>;

export const ControlResponse = z.object({ ok: z.literal(true), status: z.string() });

/** 审批决定：兼容 UI 发送的 approve/deny 与日志中的过去式。 */
export const ApprovalDecisionBody = z.strictObject({
  decision: z.enum(["approve", "approved", "deny", "denied"]),
  reason: z.string().max(2000).optional(),
  remember: z.boolean().optional(),
});
export type ApprovalDecisionBody = z.infer<typeof ApprovalDecisionBody>;

export const ApprovalResponse = z.object({
  approval: z.object({
    id: z.string(),
    sessionId: z.string(),
    agentId: z.string(),
    toolCallId: z.string(),
    toolName: z.string(),
    status: z.enum(["pending", "approved", "denied"]),
    decision: z.enum(["approved", "denied"]).optional(),
    reason: z.string().nullable().optional(),
  }),
  idempotent: z.boolean().optional(),
});

export const QuestionAnswerBody = z.strictObject({
  answer: z.unknown(),
  rev: z.int().nonnegative().optional(),
});
export type QuestionAnswerBody = z.infer<typeof QuestionAnswerBody>;
export const QuestionResponse = z.object({
  question: z.object({
    id: z.string(),
    sessionId: z.string(),
    agentId: z.string(),
    status: z.enum(["pending", "approved"]),
  }),
  idempotent: z.boolean().optional(),
});

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
  checkpointRev: z.int().nonnegative().optional(),
  checkpointError: z.string().optional(),
  /** 文件在外部被修改且应用中有未写回修订：写回已暂停，等用户二选一（07 §5）。 */
  externalConflict: z.boolean().optional(),
  rev: z.int().nonnegative(),
  createdAt: z.string(),
});
export type DocumentInfo = z.infer<typeof DocumentInfo>;

/**
 * 外部修改冲突的用户选择（07 §5、03 §3.2）：keepApp = 保留应用中的版本（外部版本存入备份区）；
 * loadExternal = 载入外部版本（应用中的版本存入备份区）。两者都记一条外部重新加载修订。
 */
export const ResolveExternalBody = z.strictObject({
  choice: z.enum(["keepApp", "loadExternal"]),
});
export type ResolveExternalBody = z.infer<typeof ResolveExternalBody>;

export const ResolveExternalResponse = z.object({
  document: DocumentInfo,
  /** 另一份版本在备份区中的记录。 */
  backupId: z.string(),
  backupPath: z.string(),
});

export const OpenDocBody = z.strictObject({ path: z.string().min(1) });
export type OpenDocBody = z.infer<typeof OpenDocBody>;

export const OpenDocResponse = z.object({ document: DocumentInfo });

/** snapshot = Univer IWorkbookData（07 §3 快照定影：结构化 JSON，逐字节无关）。 */
export const DocSnapshotResponse = z.object({
  document: DocumentInfo,
  snapshot: JsonObject,
});

/**
 * 某修订的"修改前的值"（07 §7.4）：由该修订的逆操作得出，只含数据单元格。
 * value 为 null 表示修改前该格为空；truncated 表示超过上限只返回了前若干格。
 */
export const DocRevBeforeResponse = z.object({
  docId: z.string(),
  rev: z.int().positive(),
  cells: z.array(
    z.object({
      sheet: z.string(),
      row: z.int().nonnegative(),
      col: z.int().nonnegative(),
      value: z.union([z.string(), z.number(), z.boolean()]).nullable(),
      formula: z.string().optional(),
    }),
  ),
  truncated: z.boolean(),
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

export const RenderDocBody = z.strictObject({
  sheet: z.string().optional(),
  range: z.string().optional(),
  rev: z.int().nonnegative().optional(),
});
export const RenderDocResponse = z.object({
  docId: z.string(),
  rev: z.int(),
  range: z.string(),
  png: z.string(),
  limitations: z.array(z.string()),
  size: z.object({ width: z.number(), height: z.number() }),
});

export const SessionLogQuery = z.strictObject({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .default(200)
    .transform((value) => Math.min(value, 500)),
});

export const ApprovalListResponse = z.object({ items: z.array(ApprovalResponse.shape.approval) });
export const AttachmentUploadResponse = z.object({ attachment: AttachmentRef });
