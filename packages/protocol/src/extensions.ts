// M5 扩展能力的 REST DTO（11 §4、12）：规则、记忆、技能、MCP、订阅账号、设置、能力探测。
// 字段一律 camelCase。

import { z } from "zod";
import { DispatchMode } from "./records.ts";

// ---------- 规则（12 §3） ----------

export const RULE_MAX_CHARS = 2000;
export const RULES_TOTAL_MAX_CHARS = 8000;

export const RuleScope = z.enum(["global", "session"]);
export const Rule = z.object({
  id: z.string(),
  scope: RuleScope,
  sessionId: z.string().nullable(),
  content: z.string(),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Rule = z.infer<typeof Rule>;

export const CreateRuleBody = z.strictObject({
  scope: RuleScope.optional(),
  sessionId: z.string().optional(),
  content: z.string().trim().min(1).max(RULE_MAX_CHARS),
  enabled: z.boolean().optional(),
});
export const UpdateRuleBody = z.strictObject({
  content: z.string().trim().min(1).max(RULE_MAX_CHARS).optional(),
  enabled: z.boolean().optional(),
});
export const RuleListResponse = z.object({
  items: z.array(Rule),
  /** 启用规则总字数与上限（设置页超出提示）。 */
  totalChars: z.int().nonnegative(),
  maxTotalChars: z.int().positive(),
});
export const RuleResponse = z.object({ rule: Rule });

// ---------- 记忆（12 §2） ----------

export const MemoryCategory = z.enum(["preference", "domain", "file", "lesson"]);
export type MemoryCategory = z.infer<typeof MemoryCategory>;
export const Memory = z.object({
  id: z.string(),
  content: z.string(),
  category: MemoryCategory,
  workspaceId: z.string().nullable(),
  sourceSessionId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastUsedAt: z.string().nullable(),
});
export type Memory = z.infer<typeof Memory>;
export const CreateMemoryBody = z.strictObject({
  content: z.string().trim().min(1).max(2000),
  category: MemoryCategory,
  workspaceId: z.string().nullable().optional(),
});
export const UpdateMemoryBody = z.strictObject({
  content: z.string().trim().min(1).max(2000).optional(),
  category: MemoryCategory.optional(),
  workspaceId: z.string().nullable().optional(),
});
export const MemoryListResponse = z.object({ items: z.array(Memory) });
export const MemoryResponse = z.object({ memory: Memory });

// ---------- 技能（12 §1） ----------

export const SkillSource = z.enum(["builtin", "user", "workspace"]);
export const Skill = z.object({
  name: z.string(),
  description: z.string(),
  source: SkillSource,
  enabled: z.boolean(),
  /** requires-tools 全部可用。 */
  available: z.boolean(),
  missingTools: z.array(z.string()),
  userInvocable: z.boolean(),
  modelInvocable: z.boolean(),
  version: z.string().nullable(),
  /** 被更高优先级来源覆盖的同名技能来源。 */
  overrides: z.array(SkillSource),
});
export type Skill = z.infer<typeof Skill>;
export const SkillDetail = Skill.extend({
  body: z.string(),
  resources: z.array(z.string()),
});
export type SkillDetail = z.infer<typeof SkillDetail>;
export const SkillListResponse = z.object({ items: z.array(Skill) });
export const SkillDetailResponse = z.object({ skill: SkillDetail });
export const UpdateSkillBody = z.strictObject({ enabled: z.boolean() });
/** 导入：本地目录（绝对路径）或 github.com 仓库地址；preview=true 只校验与展示正文，不落盘。 */
export const ImportSkillBody = z.strictObject({
  source: z.string().min(1),
  preview: z.boolean().optional(),
});
export const ImportSkillResponse = z.object({
  skills: z.array(SkillDetail),
  imported: z.boolean(),
});

// ---------- MCP（12 §4） ----------

export const McpTransport = z.enum(["stdio", "http"]);
export const McpStatus = z.enum(["disabled", "connecting", "connected", "failed"]);
export const McpServerConfig = z.object({
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  /** 读回时值一律掩码。 */
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  callTimeoutSeconds: z.int().positive().max(3600).optional(),
});
export const McpToolInfo = z.object({
  name: z.string(),
  /** 加入工具列表的名称 mcp__<服务器>__<工具>。 */
  qualifiedName: z.string(),
  description: z.string(),
  readOnly: z.boolean(),
  autoApprove: z.boolean(),
});
export const McpServer = z.object({
  id: z.string(),
  name: z.string(),
  transport: McpTransport,
  config: McpServerConfig,
  enabled: z.boolean(),
  status: McpStatus,
  error: z.string().nullable(),
  tools: z.array(McpToolInfo),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type McpServer = z.infer<typeof McpServer>;
const McpName = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,32}$/, "名称只能包含字母、数字、下划线与连字符（≤32）");
export const CreateMcpServerBody = z.strictObject({
  name: McpName,
  transport: McpTransport,
  config: McpServerConfig,
  enabled: z.boolean().optional(),
});
export const UpdateMcpServerBody = z.strictObject({
  name: McpName.optional(),
  transport: McpTransport.optional(),
  /** env/headers 中值为掩码（••••）的键保留原值。 */
  config: McpServerConfig.optional(),
  enabled: z.boolean().optional(),
  /** 工具级自动批准名单（原始工具名）。 */
  autoApprove: z.array(z.string()).optional(),
});
export const McpServerListResponse = z.object({ items: z.array(McpServer) });
export const McpServerResponse = z.object({ server: McpServer });
export const McpTestResponse = z.object({
  ok: z.boolean(),
  tools: z.array(McpToolInfo).optional(),
  error: z.string().optional(),
});

// ---------- 订阅账号（09 §4） ----------

export const Account = z.object({
  id: z.string(),
  provider: z.string(),
  label: z.string(),
  email: z.string().nullable(),
  plan: z.string().nullable(),
  expiresAt: z.string().nullable(),
  /** 刷新失败时的提示（需重新登录）。 */
  error: z.string().nullable(),
  createdAt: z.string(),
});
export type Account = z.infer<typeof Account>;
export const AccountListResponse = z.object({ items: z.array(Account) });
export const StartLoginBody = z.strictObject({ method: z.enum(["browser", "device"]) });
export const LoginAttempt = z.object({
  attemptId: z.string(),
  method: z.enum(["browser", "device"]),
  status: z.enum(["pending", "succeeded", "failed", "expired"]),
  authorizeUrl: z.string().optional(),
  verificationUrl: z.string().optional(),
  userCode: z.string().optional(),
  error: z.string().optional(),
  account: Account.optional(),
  /** 登录成功后自动创建的模型档案 id。 */
  profileIds: z.array(z.string()).optional(),
});
export type LoginAttempt = z.infer<typeof LoginAttempt>;
export const LoginAttemptResponse = z.object({ attempt: LoginAttempt });
export const PollLoginBody = z.strictObject({ attemptId: z.string() });

// ---------- 设置（10 §3.1、11 §4） ----------

export const AppSettings = z.object({
  /** 新会话默认权限模式（附录 C P-2 建议 standard）。 */
  defaultPermissionMode: z.enum(["confirm", "standard", "auto"]),
  defaultDispatchMode: DispatchMode,
  /** 子代理默认模型档案；空 = 与主对话相同。 */
  subAgentProfileId: z.string().nullable(),
  /** 上下文压缩摘要模型档案；空 = 与主对话相同。 */
  compactionProfileId: z.string().nullable(),
  autoCompact: z.boolean(),
  maxConcurrentSubAgents: z.int().min(1).max(16),
  /** HTTP(S) 代理（09 §7）；空 = 使用系统环境变量。 */
  httpProxy: z.string().nullable(),
  noProxy: z.string().nullable(),
  memoryInjection: z.boolean(),
});
export type AppSettings = z.infer<typeof AppSettings>;
export const SettingsResponse = z.object({
  settings: AppSettings,
  /** 修改后需要重启才生效的键。 */
  restartRequired: z.array(z.string()),
});
export const UpdateSettingsBody = AppSettings.partial().strict();

// ---------- 能力探测（09 §6） ----------

export const CapabilityValue = z.object({
  value: z.boolean().nullable(),
  source: z.enum(["catalog", "probe", "manual"]).nullable(),
  checkedAt: z.string().nullable(),
  detail: z.string().optional(),
});
export const Capabilities = z.object({
  connectivity: CapabilityValue,
  tools: CapabilityValue,
  vision: CapabilityValue,
  reasoning: CapabilityValue,
});
export type Capabilities = z.infer<typeof Capabilities>;
export const ProbeResponse = z.object({ capabilities: Capabilities });
export const OverrideCapabilitiesBody = z.strictObject({
  tools: z.boolean().nullable().optional(),
  vision: z.boolean().nullable().optional(),
  reasoning: z.boolean().nullable().optional(),
});
export const RemoteModelsResponse = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      contextWindow: z.int().positive().optional(),
      maxOutputTokens: z.int().positive().optional(),
    }),
  ),
});
export const ModelCatalogEntry = z.object({
  provider: z.string(),
  model: z.string(),
  name: z.string().optional(),
  contextWindow: z.int().positive().optional(),
  maxOutputTokens: z.int().positive().optional(),
  tools: z.boolean().optional(),
  vision: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  inputPrice: z.number().optional(),
  outputPrice: z.number().optional(),
});
export type ModelCatalogEntry = z.infer<typeof ModelCatalogEntry>;
export const ModelCatalogResponse = z.object({
  items: z.array(ModelCatalogEntry),
  updatedAt: z.string().nullable(),
  source: z.enum(["bundled", "cache"]),
});

// ---------- 工作区（11 §4） ----------

export const Workspace = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  isDefault: z.boolean(),
});
export const WorkspaceListResponse = z.object({ items: z.array(Workspace) });

// ---------- 备份与回收站（11 §4） ----------

export const BackupEntry = z.object({
  id: z.string(),
  originalPath: z.string(),
  kind: z.enum(["backup", "trash"]),
  size: z.number(),
  createdAt: z.string(),
  sessionId: z.string(),
});
export const BackupListResponse = z.object({ items: z.array(BackupEntry) });
