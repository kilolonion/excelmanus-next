// REST DTO（11 §2、§4）。字段一律 camelCase。

import { z } from "zod";
import { JsonObject } from "./neutral.ts";
import {
  AgentRole,
  AgentStatus,
  AttachmentRef,
  ChatMode,
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

export const ProviderConnection = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  baseUrl: z.string().optional(),
  hasCredential: z.boolean(),
  apiKeyMasked: z.string().nullable(),
  accountId: z.string().nullable(),
  extraHeaders: z.record(z.string(), z.string()).optional(),
  modelCount: z.int().nonnegative(),
  modelsUpdatedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProviderConnection = z.infer<typeof ProviderConnection>;
export const CreateProviderConnectionBody = z.strictObject({
  name: z.string().trim().min(1),
  provider: z.string().min(1),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  extraHeaders: z.record(z.string(), z.string()).optional(),
  accountId: z.string().optional(),
});
export type CreateProviderConnectionBody = z.infer<typeof CreateProviderConnectionBody>;
export const UpdateProviderConnectionBody = z.strictObject({
  name: z.string().trim().min(1).optional(),
  baseUrl: z.string().nullable().optional(),
  apiKey: z.string().optional(),
  extraHeaders: z.record(z.string(), z.string()).nullable().optional(),
});
export type UpdateProviderConnectionBody = z.infer<typeof UpdateProviderConnectionBody>;
export const ConnectionResponse = z.object({ connection: ProviderConnection });
export const ConnectionListResponse = z.object({ items: z.array(ProviderConnection) });

export const ModelProfile = z.object({
  id: z.string(),
  connectionId: z.string(),
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
  capabilityOverrides: z
    .object({
      tools: z.boolean().nullable().optional(),
      vision: z.boolean().nullable().optional(),
      reasoning: z.boolean().nullable().optional(),
    })
    .optional(),
  name: z.string().min(1).optional(),
  connectionId: z.string().min(1),
  model: z.string().trim().min(1),
  contextWindow: z.int().positive().optional(),
  maxOutputTokens: z.int().positive().optional(),
  reasoning: ReasoningLevel.optional(),
  providerOptions: JsonObject.optional(),
  maxConcurrency: z.int().positive().max(64).optional(),
  isDefault: z.boolean().optional(),
});
export type CreateModelProfileBody = z.infer<typeof CreateModelProfileBody>;
export const UpdateModelProfileBody = z.strictObject({
  name: z.string().min(1).optional(),
  connectionId: z.string().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  contextWindow: z.int().positive().nullable().optional(),
  maxOutputTokens: z.int().positive().nullable().optional(),
  reasoning: ReasoningLevel.nullable().optional(),
  providerOptions: JsonObject.nullable().optional(),
  maxConcurrency: z.int().positive().max(64).nullable().optional(),
});
export type UpdateModelProfileBody = z.infer<typeof UpdateModelProfileBody>;

export const TestProfileResponse = z.object({
  ok: z.boolean(),
  latencyMs: z.number().optional(),
  error: z.object({ kind: z.string(), message: z.string() }).optional(),
});

// ---------- 会话 ----------

/** 会话列表上的活动摘要：侧栏据此标出运行中 / 待审批 / 待回答的会话。 */
export const SessionActivity = z.object({
  /** 有代理在运行、排队、等待子代理或等待交互。 */
  busy: z.boolean(),
  pendingApprovals: z.int().nonnegative(),
  pendingQuestions: z.int().nonnegative(),
});
export type SessionActivity = z.infer<typeof SessionActivity>;

export const SessionSummary = z.object({
  id: z.string(),
  workspaceId: z.string(),
  title: z.string().nullable(),
  permissionMode: PermissionMode,
  createdAt: z.string(),
  updatedAt: z.string(),
  lastSeq: z.int().nonnegative(),
  activity: SessionActivity,
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

export const SendMessageBody = z
  .strictObject({
    clientMessageId: z.string().min(1).max(128),
    replacesDispatchId: z.string().min(1).optional(),
    text: z.string(),
    mode: DispatchMode.optional(),
    /** 只读问答 / 计划模式：这条消息引起的轮次里代理不能写入。 */
    chatMode: ChatMode.optional(),
    /** 随消息携带的选区引用（04 §7.3），渲染进该轮用户消息前的 <context> 块。 */
    context: z.array(ContextRef).optional(),
    /** 已经 POST /attachments 上传的图片（04 §4：受理前校验已上传）。 */
    attachments: z.array(AttachmentRef).max(8).optional(),
  })
  .refine((body) => body.text.trim().length > 0 || (body.attachments?.length ?? 0) > 0, {
    message: "请输入文字或添加图片附件",
    path: ["text"],
  });
export type SendMessageBody = z.infer<typeof SendMessageBody>;

export const SendMessageResponse = z.object({
  dispatch: Dispatch,
  /** 同 clientMessageId 重复提交时命中已有派发。 */
  deduplicated: z.boolean(),
});

export const DispatchResponse = z.object({ dispatch: Dispatch });

export const StopResponse = z.object({ ok: z.literal(true), stopped: z.boolean() });

/** scope=subagents 只停子代理，主代理继续。 */
export const StopAllBody = z.strictObject({ scope: z.enum(["all", "subagents"]).optional() });

/** 停止会话全部运行中代理（11 §147）：stopped 为实际被停止的 agentId。 */
export const StopAllResponse = z.object({ ok: z.literal(true), stopped: z.array(z.string()) });

/** 继续：重新入队挂起派发的数量与是否实际开轮（04 §4.2、§8.3）。 */
export const ResumeResponse = z.object({
  ok: z.literal(true),
  resumed: z.int().nonnegative(),
  started: z.boolean(),
});

/**
 * 从某条用户消息起重新开始（编辑重发 / 重试 / 回到某一轮）。代理必须空闲；该消息及其后的对话
 * 不再进入模型上下文，仍未应用的排队消息一并撤回。文件不回滚。
 */
export const RewindBody = z.strictObject({ dispatchId: z.string().min(1) });
export type RewindBody = z.infer<typeof RewindBody>;
export const RewindResponse = z.object({
  ok: z.literal(true),
  fromSeq: z.int().positive(),
  /** 被一并撤回的排队派发。 */
  cancelled: z.array(z.string()),
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

/** 对代理回复（model.output 的 seq）点赞/点踩，可附说明；rating=null 撤回。 */
export const FeedbackBody = z.strictObject({
  seq: z.int().positive(),
  rating: z.enum(["up", "down"]).nullable(),
  comment: z.string().max(2000).optional(),
});

/** 会话完整导出（JSON）：会话、代理与全部日志记录。 */
export const SessionExportJson = z.object({
  exportedAt: z.string(),
  session: SessionSummary,
  agents: z.array(AgentInfo),
  records: z.array(LogRecord),
});

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

/** 工作簿变更摘要（区域为 A1，含表名）。 */
export const DocChanges = z.object({
  cellsBySheet: z.record(z.string(), z.number()),
  ranges: z.array(z.string()),
  structural: z.array(z.string()),
  added: z.array(z.string()),
});

/** 修订列表（撤销面板）：新到旧，不含公式重算修订。 */
export const DocRevision = z.object({
  rev: z.int().positive(),
  source: z.object({ kind: z.string(), id: z.string().nullable() }),
  sessionId: z.string().nullable(),
  createdAt: z.string(),
  changes: DocChanges,
  /** 这是对哪个修订的撤销。 */
  reverts: z.int().nullable(),
  /** 已被哪个修订撤销。 */
  revertedBy: z.int().nullable(),
});
export type DocRevision = z.infer<typeof DocRevision>;
export const DocRevisionsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  before: z.coerce.number().int().positive().optional(),
});
export const DocRevisionsResponse = z.object({
  docId: z.string(),
  headRev: z.int().nonnegative(),
  items: z.array(DocRevision),
});
/** 撤销一次修订：回退作为新修订提交；之后有修订改到同一区域时 409。 */
export const UndoRevisionResponse = z.object({
  docId: z.string(),
  rev: z.int().positive(),
  reverted: z.int().positive(),
  changes: DocChanges,
});

/** 两个工作簿并排对比：按表名配对逐格比较值与公式（不比较样式）。 */
const DocSide = z.union([
  z.strictObject({ path: z.string().min(1) }),
  z.strictObject({ docId: z.string().min(1) }),
]);
export const CompareDocsBody = z.strictObject({
  left: DocSide,
  right: DocSide,
  limit: z.int().min(1).max(5000).optional(),
});
const CompareValue = z
  .object({
    value: z.union([z.string(), z.number(), z.boolean()]).nullable(),
    formula: z.string().optional(),
  })
  .nullable();
export const CompareDocsResponse = z.object({
  left: z.object({ docId: z.string(), path: z.string(), rev: z.int().nonnegative() }),
  right: z.object({ docId: z.string(), path: z.string(), rev: z.int().nonnegative() }),
  sheets: z.array(
    z.object({
      name: z.string(),
      status: z.enum(["both", "leftOnly", "rightOnly"]),
      /** 差异格总数（cells 可能被截断）。 */
      changed: z.int().nonnegative(),
      cells: z.array(
        z.object({
          cell: z.string(),
          kind: z.enum(["added", "deleted", "modified"]),
          left: CompareValue,
          right: CompareValue,
        }),
      ),
    }),
  ),
  truncated: z.boolean(),
});

/** 将对比中勾选的内容从 source 写入 target；双方版本必须仍与预览一致。 */
export const MergeDocsBody = z.strictObject({
  sourceDocId: z.string().min(1),
  targetDocId: z.string().min(1),
  sourceRev: z.int().nonnegative(),
  targetRev: z.int().nonnegative(),
  cells: z
    .array(
      z.strictObject({
        sheet: z.string().min(1).max(31),
        cell: z.string().regex(/^[A-Z]{1,3}[1-9][0-9]{0,6}$/),
      }),
    )
    .min(1)
    .max(2000),
});
export type MergeDocsBody = z.infer<typeof MergeDocsBody>;
export const MergeDocsResponse = z.object({
  docId: z.string(),
  rev: z.int().nonnegative(),
  changes: DocChanges,
});

export const FileEntry = z.object({
  name: z.string(),
  /** 工作区相对路径（POSIX 分隔符）。 */
  path: z.string(),
  kind: z.enum(["file", "dir"]),
  size: z.number().nonnegative().optional(),
  modifiedAt: z.string().optional(),
  /** 最近一次在工作台打开的时间（只有打开过的表格有），供按最近使用排序。 */
  openedAt: z.string().optional(),
});
export type FileEntry = z.infer<typeof FileEntry>;

/** 新建空文件：.xlsx 建一张空表，.csv/.txt/.md 建空文本；已存在则 409。 */
export const NewFileBody = z.strictObject({ path: z.string().min(1) });

/** 文件来源与事件历史（新到旧）。 */
export const FileEvent = z.object({
  at: z.string(),
  kind: z.enum(["created", "modified", "backup", "trashed"]),
  /** user / agent / script / external；备份与回收站事件为 null。 */
  source: z.string().nullable(),
  sessionId: z.string().nullable(),
  sessionTitle: z.string().nullable(),
  agentId: z.string().nullable(),
  rev: z.int().optional(),
  changes: DocChanges.optional(),
  backupId: z.string().optional(),
});
export type FileEvent = z.infer<typeof FileEvent>;
export const FileHistoryResponse = z.object({
  path: z.string(),
  docId: z.string().nullable(),
  events: z.array(FileEvent),
});

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

export const ImportLegacyBody = z.strictObject({
  source: z.string().min(1),
  destination: z.string().min(1),
});
export const ImportLegacyResponse = UploadResponse.extend({ warnings: z.array(z.string()) });
