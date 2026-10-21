import {
  ConnectionListResponse,
  ConnectionResponse,
  type CreateProviderConnectionBody,
  type ImportLegacyBody,
  ImportLegacyResponse,
  type UpdateProviderConnectionBody,
} from "./rest.ts";
// 契约客户端：前端/CLI/测试只通过它请求 REST。
// 每个方法对应一个端点，响应都经对应 schema 解析。

import type { z } from "zod";
import {
  type DiagnosticExportBody,
  DiagnosticExportResponse,
  DiagnosticTracesResponse,
} from "./diagnostics.ts";
import {
  AccountListResponse,
  BackupListResponse,
  BackupPreviewResponse,
  type CreateMcpServerBody,
  type CreateMemoryBody,
  type CreateRuleBody,
  DeviceListResponse,
  ImportSkillResponse,
  LoginAttemptResponse,
  McpServerListResponse,
  McpServerResponse,
  McpTestResponse,
  MemoryListResponse,
  MemoryResponse,
  ModelCatalogResponse,
  type OverrideCapabilitiesBody,
  ProbeResponse,
  RemoteModelsResponse,
  RestoreBackupResponse,
  RuleListResponse,
  RuleResponse,
  SampleListResponse,
  SampleResponse,
  SettingsResponse,
  SkillDetailResponse,
  SkillListResponse,
  SkillResponse,
  SwitchAgentModelResponse,
  type UpdateMcpServerBody,
  type UpdateMemoryBody,
  type UpdateRuleBody,
  type UpdateSettingsBody,
  type UpdateWorkspaceBody,
  type Workspace,
  WorkspaceListResponse,
  WorkspaceResponse,
} from "./extensions.ts";
import { type ManageFilesBody, ManageFilesResponse } from "./files.ts";
import { type QaFirstScreenMetricsBody, QaFirstScreenMetricsResponse } from "./qa-first-screen.ts";
import { AttachmentRef } from "./records.ts";
import {
  type ApprovalDecisionBody,
  ApprovalResponse,
  AuthSessionResponse,
  BootstrapResponse,
  CompactResponse,
  type CompareDocsBody,
  CompareDocsResponse,
  type ControlBody,
  ControlResponse,
  type CreateModelProfileBody,
  type CreateSessionBody,
  CreateSessionResponse,
  DispatchResponse,
  DocRevBeforeResponse,
  DocRevisionsResponse,
  DocSnapshotResponse,
  type FeedbackBody,
  FileHistoryResponse,
  FileListResponse,
  HealthResponse,
  type MergeDocsBody,
  MergeDocsResponse,
  OkResponse,
  type OpenDocBody,
  OpenDocResponse,
  ProfileListResponse,
  ProfileResponse,
  ProviderListResponse,
  type QuestionAnswerBody,
  QuestionResponse,
  type RenderDocBody,
  RenderDocResponse,
  type ResolveExternalBody,
  ResolveExternalResponse,
  RestError,
  ResumeResponse,
  type RewindBody,
  RewindResponse,
  type SendMessageBody,
  SendMessageResponse,
  SessionDetailResponse,
  SessionExportJson,
  type SessionListQuery,
  SessionListResponse,
  SessionLogResponse,
  type StopAllBody,
  StopAllResponse,
  StopResponse,
  TestProfileResponse,
  TicketResponse,
  UndoRevisionResponse,
  type UpdateModelProfileBody,
  type UpdateSessionBody,
  UploadResponse,
} from "./rest.ts";
import { protocolVersion } from "./sync.ts";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly requestId?: string;
  constructor(
    status: number,
    code: string,
    message: string,
    opts?: { details?: unknown; requestId?: string },
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = opts?.details;
    this.requestId = opts?.requestId;
  }
}

export interface ApiClient {
  reportFirstScreenMetrics(
    body: QaFirstScreenMetricsBody,
  ): Promise<z.infer<typeof QaFirstScreenMetricsResponse>>;
  renderDoc(
    workspaceId: string,
    docId: string,
    body: z.infer<typeof RenderDocBody>,
  ): Promise<z.infer<typeof RenderDocResponse>>;
  getDiagnosticTraces(sessionId?: string): Promise<z.infer<typeof DiagnosticTracesResponse>>;
  exportDiagnostics(
    body: z.infer<typeof DiagnosticExportBody>,
  ): Promise<z.infer<typeof DiagnosticExportResponse>>;
  health(): Promise<z.infer<typeof HealthResponse>>;
  createBrowserSession(): Promise<z.infer<typeof AuthSessionResponse>>;
  logoutBrowserSession(): Promise<z.infer<typeof OkResponse>>;
  bootstrap(): Promise<z.infer<typeof BootstrapResponse>>;
  createTicket(): Promise<z.infer<typeof TicketResponse>>;

  listProviders(): Promise<z.infer<typeof ProviderListResponse>>;
  listProviderConnections(): Promise<z.infer<typeof ConnectionListResponse>>;
  createProviderConnection(
    body: CreateProviderConnectionBody,
  ): Promise<z.infer<typeof ConnectionResponse>>;
  updateProviderConnection(
    id: string,
    body: UpdateProviderConnectionBody,
  ): Promise<z.infer<typeof ConnectionResponse>>;
  deleteProviderConnection(id: string): Promise<z.infer<typeof OkResponse>>;
  getConnectionModels(id: string): Promise<z.infer<typeof RemoteModelsResponse>>;
  refreshConnectionModels(id: string): Promise<z.infer<typeof RemoteModelsResponse>>;
  listModelProfiles(): Promise<z.infer<typeof ProfileListResponse>>;
  createModelProfile(
    body: z.infer<typeof CreateModelProfileBody>,
  ): Promise<z.infer<typeof ProfileResponse>>;
  getModelProfile(id: string): Promise<z.infer<typeof ProfileResponse>>;
  updateModelProfile(
    id: string,
    body: z.infer<typeof UpdateModelProfileBody>,
  ): Promise<z.infer<typeof ProfileResponse>>;
  deleteModelProfile(id: string): Promise<z.infer<typeof OkResponse>>;
  setDefaultModelProfile(id: string): Promise<z.infer<typeof ProfileResponse>>;
  testModelProfile(id: string): Promise<z.infer<typeof TestProfileResponse>>;

  listSessions(
    opts?: z.infer<typeof SessionListQuery>,
  ): Promise<z.infer<typeof SessionListResponse>>;
  /** idempotencyKey：重试同一次创建时传同一个键，不会建出重复会话（11 §2）。 */
  createSession(
    body: z.infer<typeof CreateSessionBody>,
    opts?: { idempotencyKey?: string },
  ): Promise<z.infer<typeof CreateSessionResponse>>;
  getSession(id: string): Promise<z.infer<typeof SessionDetailResponse>>;
  updateSession(
    id: string,
    body: z.infer<typeof UpdateSessionBody>,
  ): Promise<z.infer<typeof SessionDetailResponse>>;
  deleteSession(id: string): Promise<z.infer<typeof OkResponse>>;
  getSessionLog(
    id: string,
    opts?: { before?: number; limit?: number },
  ): Promise<z.infer<typeof SessionLogResponse>>;

  sendMessage(
    sessionId: string,
    agentId: string,
    body: z.infer<typeof SendMessageBody>,
  ): Promise<z.infer<typeof SendMessageResponse>>;
  cancelDispatch(sessionId: string, dispatchId: string): Promise<z.infer<typeof DispatchResponse>>;
  stopAgent(sessionId: string, agentId: string): Promise<z.infer<typeof StopResponse>>;
  stopAll(
    sessionId: string,
    body?: z.infer<typeof StopAllBody>,
  ): Promise<z.infer<typeof StopAllResponse>>;
  resumeAgent(sessionId: string, agentId: string): Promise<z.infer<typeof ResumeResponse>>;
  compactAgent(sessionId: string, agentId: string): Promise<z.infer<typeof CompactResponse>>;
  /** 从某条用户消息起重新开始（不回滚文件）。 */
  rewindAgent(
    sessionId: string,
    agentId: string,
    body: z.infer<typeof RewindBody>,
  ): Promise<z.infer<typeof RewindResponse>>;
  controlAgent(
    sessionId: string,
    agentId: string,
    body: z.infer<typeof ControlBody>,
  ): Promise<z.infer<typeof ControlResponse>>;
  decideApproval(
    approvalId: string,
    body: z.infer<typeof ApprovalDecisionBody>,
  ): Promise<z.infer<typeof ApprovalResponse>>;
  answerQuestion(
    questionId: string,
    body: z.infer<typeof QuestionAnswerBody>,
  ): Promise<z.infer<typeof QuestionResponse>>;

  openDoc(
    workspaceId: string,
    body: z.infer<typeof OpenDocBody>,
  ): Promise<z.infer<typeof OpenDocResponse>>;
  getDocSnapshot(workspaceId: string, docId: string): Promise<z.infer<typeof DocSnapshotResponse>>;
  getDocRevBefore(
    workspaceId: string,
    docId: string,
    rev: number,
  ): Promise<z.infer<typeof DocRevBeforeResponse>>;
  sendFeedback(sessionId: string, body: z.infer<typeof FeedbackBody>): Promise<{ ok: true }>;
  exportSessionJson(sessionId: string): Promise<z.infer<typeof SessionExportJson>>;
  mergeDocs(workspaceId: string, body: MergeDocsBody): Promise<z.infer<typeof MergeDocsResponse>>;
  compareDocs(
    workspaceId: string,
    body: z.infer<typeof CompareDocsBody>,
  ): Promise<z.infer<typeof CompareDocsResponse>>;
  listDocRevisions(
    workspaceId: string,
    docId: string,
    opts?: { limit?: number; before?: number },
  ): Promise<z.infer<typeof DocRevisionsResponse>>;
  undoDocRevision(
    workspaceId: string,
    docId: string,
    rev: number,
  ): Promise<z.infer<typeof UndoRevisionResponse>>;
  /** 外部修改冲突二选一（07 §5）。 */
  resolveDocExternal(
    workspaceId: string,
    docId: string,
    body: z.infer<typeof ResolveExternalBody>,
  ): Promise<z.infer<typeof ResolveExternalResponse>>;
  manageFiles(
    workspaceId: string,
    body: ManageFilesBody,
  ): Promise<z.infer<typeof ManageFilesResponse>>;
  listFiles(workspaceId: string, path?: string): Promise<z.infer<typeof FileListResponse>>;
  importLegacy(
    workspaceId: string,
    body: z.infer<typeof ImportLegacyBody>,
  ): Promise<z.infer<typeof ImportLegacyResponse>>;
  createFile(workspaceId: string, path: string): Promise<z.infer<typeof UploadResponse>>;
  fileHistory(workspaceId: string, path: string): Promise<z.infer<typeof FileHistoryResponse>>;
  /** multipart 单文件上传；file 为浏览器 File 或 {name, data}。 */
  uploadFile(
    workspaceId: string,
    file: { name: string; data: Blob | ArrayBuffer | Uint8Array; path?: string },
  ): Promise<z.infer<typeof UploadResponse>>;
  /** 上传图片附件（POST /attachments，内容寻址去重）；返回可放进消息的附件引用。 */
  uploadAttachment(file: { name: string; data: Blob }): Promise<AttachmentRef>;
  /** 取附件内容（带令牌，调用方转 object URL 显示缩略图）。 */
  getDocImage(workspaceId: string, docId: string, sheetId: string, imageId: string): Promise<Blob>;
  getAttachment(sha256: string): Promise<Blob>;

  // ---------- M5 扩展 ----------
  getSettings(): Promise<z.infer<typeof SettingsResponse>>;
  updateSettings(
    body: z.infer<typeof UpdateSettingsBody>,
  ): Promise<z.infer<typeof SettingsResponse>>;
  listRules(sessionId?: string): Promise<z.infer<typeof RuleListResponse>>;
  createRule(body: z.infer<typeof CreateRuleBody>): Promise<z.infer<typeof RuleResponse>>;
  updateRule(
    id: string,
    body: z.infer<typeof UpdateRuleBody>,
  ): Promise<z.infer<typeof RuleResponse>>;
  deleteRule(id: string): Promise<z.infer<typeof OkResponse>>;
  listMemories(query?: string): Promise<z.infer<typeof MemoryListResponse>>;
  createMemory(body: z.infer<typeof CreateMemoryBody>): Promise<z.infer<typeof MemoryResponse>>;
  updateMemory(
    id: string,
    body: z.infer<typeof UpdateMemoryBody>,
  ): Promise<z.infer<typeof MemoryResponse>>;
  deleteMemory(id: string): Promise<z.infer<typeof OkResponse>>;
  listSkills(): Promise<z.infer<typeof SkillListResponse>>;
  getSkill(name: string): Promise<z.infer<typeof SkillDetailResponse>>;
  setSkillEnabled(name: string, enabled: boolean): Promise<unknown>;
  importSkill(source: string, preview: boolean): Promise<z.infer<typeof ImportSkillResponse>>;
  deleteSkill(name: string): Promise<z.infer<typeof OkResponse>>;
  listMcpServers(): Promise<z.infer<typeof McpServerListResponse>>;
  createMcpServer(
    body: z.infer<typeof CreateMcpServerBody>,
  ): Promise<z.infer<typeof McpServerResponse>>;
  updateMcpServer(
    id: string,
    body: z.infer<typeof UpdateMcpServerBody>,
  ): Promise<z.infer<typeof McpServerResponse>>;
  deleteMcpServer(id: string): Promise<z.infer<typeof OkResponse>>;
  testMcpServer(id: string): Promise<z.infer<typeof McpTestResponse>>;
  reloadMcpServers(): Promise<z.infer<typeof OkResponse>>;
  listAccounts(): Promise<z.infer<typeof AccountListResponse>>;
  startLogin(
    provider: string,
    method: "browser" | "device",
  ): Promise<z.infer<typeof LoginAttemptResponse>>;
  pollLogin(provider: string, attemptId: string): Promise<z.infer<typeof LoginAttemptResponse>>;
  deleteAccount(id: string): Promise<z.infer<typeof OkResponse>>;
  probeProfile(id: string): Promise<z.infer<typeof ProbeResponse>>;
  getCapabilities(id: string): Promise<z.infer<typeof ProbeResponse>>;
  overrideCapabilities(
    id: string,
    body: z.infer<typeof OverrideCapabilitiesBody>,
  ): Promise<z.infer<typeof ProbeResponse>>;
  listRemoteModels(id: string): Promise<z.infer<typeof RemoteModelsResponse>>;
  listProviderModels(
    providerId: string,
    body: { apiKey?: string; baseUrl?: string; accountId?: string },
  ): Promise<z.infer<typeof RemoteModelsResponse>>;
  getModelCatalog(provider?: string): Promise<z.infer<typeof ModelCatalogResponse>>;
  refreshModelCatalog(): Promise<z.infer<typeof ModelCatalogResponse>>;
  switchAgentModel(
    sessionId: string,
    agentId: string,
    body: { modelProfileId?: string; modelName?: string },
  ): Promise<{ ok: true; modelProfileId: string; name: string }>;
  listWorkspaces(): Promise<z.infer<typeof WorkspaceListResponse>>;
  addWorkspace(path: string, name?: string): Promise<{ workspace: z.infer<typeof Workspace> }>;
  removeWorkspace(id: string): Promise<z.infer<typeof OkResponse>>;
  updateWorkspace(
    id: string,
    body: UpdateWorkspaceBody,
  ): Promise<{ workspace: z.infer<typeof Workspace> }>;
  reorderWorkspaces(ids: string[]): Promise<z.infer<typeof WorkspaceListResponse>>;
  listDevices(): Promise<z.infer<typeof DeviceListResponse>>;
  revokeDevice(id: string): Promise<z.infer<typeof OkResponse>>;
  listBackups(
    workspaceId: string,
    kind: "backups" | "trash",
  ): Promise<z.infer<typeof BackupListResponse>>;
  restoreBackup(
    workspaceId: string,
    kind: "backups" | "trash",
    id: string,
  ): Promise<{ ok: true; path: string }>;
  deleteBackup(
    workspaceId: string,
    kind: "backups" | "trash",
    id: string,
  ): Promise<z.infer<typeof OkResponse>>;
  listSamples(): Promise<{ items: string[] }>;
  addSample(workspaceId: string, name: string): Promise<{ path: string }>;
  /** 带令牌的下载地址不放 URL：调用方用此方法取 Blob。 */
  downloadBackup(workspaceId: string, kind: "backups" | "trash", id: string): Promise<Blob>;
  previewBackup(
    workspaceId: string,
    kind: "backups" | "trash",
    id: string,
    options?: { sheetId?: string; row?: number; column?: number },
  ): Promise<BackupPreviewResponse>;
  /** 下载工作区文件（GET /workspaces/{id}/files/download?path=）。 */
  downloadFile(workspaceId: string, path: string): Promise<Blob>;
  /** 导出会话 Markdown（GET /sessions/{id}/export）。 */
  exportSession(sessionId: string): Promise<Blob>;
}

export function createApiClient(
  baseUrl: string,
  token: string | null = null,
  fetchImpl: typeof fetch = fetch,
): ApiClient {
  const base = baseUrl.replace(/\/+$/, "");

  async function call<S extends z.ZodType<unknown>>(
    schema: S,
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<z.infer<S>> {
    const res = await fetchImpl(`${base}/api/v1${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...extraHeaders,
      },
      credentials: token ? "omit" : "include",
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const parsed = RestError.safeParse(json);
      const e = parsed.success ? parsed.data.error : undefined;
      throw new ApiError(
        res.status,
        e?.code ?? `http_${res.status}`,
        e?.message ?? `HTTP ${res.status}`,
        { details: e?.details, requestId: e?.requestId },
      );
    }
    return schema.parse(json) as z.infer<S>;
  }

  /** 二进制下载：错误体仍按契约 RestError 解析。 */
  async function blobOf(path: string): Promise<Blob> {
    const res = await fetchImpl(`${base}/api/v1${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
      credentials: token ? "omit" : "include",
    });
    if (!res.ok) {
      const parsed = RestError.safeParse(await res.json().catch(() => null));
      const e = parsed.success ? parsed.data.error : undefined;
      throw new ApiError(
        res.status,
        e?.code ?? `http_${res.status}`,
        e?.message ?? `HTTP ${res.status}`,
        { details: e?.details, requestId: e?.requestId },
      );
    }
    return res.blob();
  }

  const qs = (params: Record<string, string | number | undefined>) => {
    const p = Object.entries(params).filter(([, v]) => v !== undefined);
    return p.length
      ? `?${p.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&")}`
      : "";
  };

  return {
    getSettings: () => call(SettingsResponse, "GET", "/settings"),
    updateSettings: (body) => call(SettingsResponse, "PATCH", "/settings", body),
    listRules: (sessionId) => call(RuleListResponse, "GET", `/rules${qs({ sessionId })}`),
    createRule: (body) => call(RuleResponse, "POST", "/rules", body),
    updateRule: (id, body) => call(RuleResponse, "PATCH", `/rules/${id}`, body),
    deleteRule: (id) => call(OkResponse, "DELETE", `/rules/${id}`),
    listMemories: (q) => call(MemoryListResponse, "GET", `/memories${qs({ q })}`),
    createMemory: (body) => call(MemoryResponse, "POST", "/memories", body),
    updateMemory: (id, body) => call(MemoryResponse, "PATCH", `/memories/${id}`, body),
    deleteMemory: (id) => call(OkResponse, "DELETE", `/memories/${id}`),
    listSkills: () => call(SkillListResponse, "GET", "/skills"),
    getSkill: (name) => call(SkillDetailResponse, "GET", `/skills/${encodeURIComponent(name)}`),
    setSkillEnabled: (name, enabled) =>
      call(SkillResponse, "PATCH", `/skills/${encodeURIComponent(name)}`, { enabled }),
    importSkill: (source, preview) =>
      call(ImportSkillResponse, "POST", "/skills/import", { source, preview }),
    deleteSkill: (name) => call(OkResponse, "DELETE", `/skills/${encodeURIComponent(name)}`),
    listMcpServers: () => call(McpServerListResponse, "GET", "/mcp-servers"),
    createMcpServer: (body) => call(McpServerResponse, "POST", "/mcp-servers", body),
    updateMcpServer: (id, body) => call(McpServerResponse, "PATCH", `/mcp-servers/${id}`, body),
    deleteMcpServer: (id) => call(OkResponse, "DELETE", `/mcp-servers/${id}`),
    testMcpServer: (id) => call(McpTestResponse, "POST", `/mcp-servers/${id}/test`),
    reloadMcpServers: () => call(OkResponse, "POST", "/mcp-servers/reload"),
    listAccounts: () => call(AccountListResponse, "GET", "/accounts"),
    startLogin: (provider, method) =>
      call(LoginAttemptResponse, "POST", `/accounts/${provider}/login`, { method }),
    pollLogin: (provider, attemptId) =>
      call(LoginAttemptResponse, "POST", `/accounts/${provider}/login/poll`, { attemptId }),
    deleteAccount: (id) => call(OkResponse, "DELETE", `/accounts/${id}`),
    probeProfile: (id) => call(ProbeResponse, "POST", `/model-profiles/${id}/probe`),
    getCapabilities: (id) => call(ProbeResponse, "GET", `/model-profiles/${id}/capabilities`),
    overrideCapabilities: (id, body) =>
      call(ProbeResponse, "PATCH", `/model-profiles/${id}/capabilities`, body),
    listRemoteModels: (id) => call(RemoteModelsResponse, "POST", `/model-profiles/${id}/models`),
    listProviderModels: (providerId, body) =>
      call(RemoteModelsResponse, "POST", `/providers/${providerId}/models`, body),
    getModelCatalog: (provider) =>
      call(ModelCatalogResponse, "GET", `/model-catalog${qs({ provider })}`),
    refreshModelCatalog: () => call(ModelCatalogResponse, "POST", "/model-catalog/refresh"),
    switchAgentModel: (sessionId, agentId, body) =>
      call(SwitchAgentModelResponse, "PATCH", `/sessions/${sessionId}/agents/${agentId}`, body),
    listWorkspaces: () => call(WorkspaceListResponse, "GET", "/workspaces"),
    addWorkspace: (path, name) =>
      call(WorkspaceResponse, "POST", "/workspaces", {
        path,
        ...(name ? { name } : {}),
      }),
    removeWorkspace: (id) => call(OkResponse, "DELETE", `/workspaces/${id}`),
    updateWorkspace: (id, body) => call(WorkspaceResponse, "PATCH", `/workspaces/${id}`, body),
    reorderWorkspaces: (ids) => call(WorkspaceListResponse, "PUT", "/workspaces/order", { ids }),
    listDevices: () => call(DeviceListResponse, "GET", "/devices"),
    revokeDevice: (id) => call(OkResponse, "POST", `/devices/${encodeURIComponent(id)}/revoke`),
    listBackups: (workspaceId, kind) =>
      call(BackupListResponse, "GET", `/workspaces/${workspaceId}/${kind}`),
    previewBackup: (workspaceId, kind, id, options) =>
      call(
        BackupPreviewResponse,
        "GET",
        `/workspaces/${workspaceId}/${kind}/${id}/preview${qs(options ?? {})}`,
      ),
    restoreBackup: (workspaceId, kind, id) =>
      call(RestoreBackupResponse, "POST", `/workspaces/${workspaceId}/${kind}/${id}/restore`),
    deleteBackup: (workspaceId, kind, id) =>
      call(OkResponse, "DELETE", `/workspaces/${workspaceId}/${kind}/${id}`),
    listSamples: () => call(SampleListResponse, "GET", "/samples"),
    addSample: (workspaceId, name) =>
      call(
        SampleResponse,
        "POST",
        `/workspaces/${workspaceId}/samples/${encodeURIComponent(name)}`,
      ),
    downloadBackup: async (workspaceId, kind, id) => {
      const res = await fetchImpl(
        `${base}/api/v1/workspaces/${workspaceId}/${kind}/${id}/download`,
        {
          headers: token ? { authorization: `Bearer ${token}` } : undefined,
          credentials: token ? "omit" : "include",
        },
      );
      if (!res.ok) throw new ApiError(res.status, `http_${res.status}`, `HTTP ${res.status}`);
      return res.blob();
    },
    downloadFile: (workspaceId, path) =>
      blobOf(`/workspaces/${workspaceId}/files/download${qs({ path })}`),
    exportSession: (sessionId) => blobOf(`/sessions/${sessionId}/export`),

    health: () => call(HealthResponse, "GET", "/health"),
    createBrowserSession: () => call(AuthSessionResponse, "POST", "/auth/session"),
    logoutBrowserSession: () => call(OkResponse, "POST", "/auth/logout"),
    bootstrap: () => call(BootstrapResponse, "GET", "/bootstrap"),
    createTicket: () => call(TicketResponse, "POST", "/sync/ticket"),

    listProviders: () => call(ProviderListResponse, "GET", "/providers"),
    listProviderConnections: () => call(ConnectionListResponse, "GET", "/provider-connections"),
    createProviderConnection: (body) =>
      call(ConnectionResponse, "POST", "/provider-connections", body),
    updateProviderConnection: (id, body) =>
      call(ConnectionResponse, "PATCH", `/provider-connections/${id}`, body),
    deleteProviderConnection: (id) => call(OkResponse, "DELETE", `/provider-connections/${id}`),
    getConnectionModels: (id) =>
      call(RemoteModelsResponse, "GET", `/provider-connections/${id}/models`),
    refreshConnectionModels: (id) =>
      call(RemoteModelsResponse, "POST", `/provider-connections/${id}/models`),
    listModelProfiles: () => call(ProfileListResponse, "GET", "/model-profiles"),
    createModelProfile: (body) => call(ProfileResponse, "POST", "/model-profiles", body),
    getModelProfile: (id) => call(ProfileResponse, "GET", `/model-profiles/${id}`),
    updateModelProfile: (id, body) => call(ProfileResponse, "PATCH", `/model-profiles/${id}`, body),
    deleteModelProfile: (id) => call(OkResponse, "DELETE", `/model-profiles/${id}`),
    setDefaultModelProfile: (id) => call(ProfileResponse, "POST", `/model-profiles/${id}/default`),
    testModelProfile: (id) => call(TestProfileResponse, "POST", `/model-profiles/${id}/test`),

    listSessions: (opts) =>
      call(
        SessionListResponse,
        "GET",
        `/sessions${qs({ cursor: opts?.cursor, limit: opts?.limit, q: opts?.q, workspaceId: opts?.workspaceId })}`,
      ),
    createSession: (body, opts) =>
      call(
        CreateSessionResponse,
        "POST",
        "/sessions",
        body,
        opts?.idempotencyKey ? { "idempotency-key": opts.idempotencyKey } : undefined,
      ),
    getSession: (id) => call(SessionDetailResponse, "GET", `/sessions/${id}`),
    updateSession: (id, body) => call(SessionDetailResponse, "PATCH", `/sessions/${id}`, body),
    deleteSession: (id) => call(OkResponse, "DELETE", `/sessions/${id}`),
    getSessionLog: (id, opts) =>
      call(
        SessionLogResponse,
        "GET",
        `/sessions/${id}/log${qs({ before: opts?.before, limit: opts?.limit })}`,
      ),

    sendMessage: (sessionId, agentId, body) =>
      call(SendMessageResponse, "POST", `/sessions/${sessionId}/agents/${agentId}/messages`, body),
    cancelDispatch: (sessionId, dispatchId) =>
      call(DispatchResponse, "DELETE", `/sessions/${sessionId}/dispatches/${dispatchId}`),
    stopAgent: (sessionId, agentId) =>
      call(StopResponse, "POST", `/sessions/${sessionId}/agents/${agentId}/stop`),
    stopAll: (sessionId, body) =>
      call(StopAllResponse, "POST", `/sessions/${sessionId}/stop-all`, body ?? {}),
    resumeAgent: (sessionId, agentId) =>
      call(ResumeResponse, "POST", `/sessions/${sessionId}/agents/${agentId}/resume`),
    compactAgent: (sessionId, agentId) =>
      call(CompactResponse, "POST", `/sessions/${sessionId}/agents/${agentId}/compact`),
    rewindAgent: (sessionId, agentId, body) =>
      call(RewindResponse, "POST", `/sessions/${sessionId}/agents/${agentId}/rewind`, body),
    controlAgent: (sessionId, agentId, body) =>
      call(ControlResponse, "POST", `/sessions/${sessionId}/agents/${agentId}/control`, body),
    decideApproval: (approvalId, body) =>
      call(ApprovalResponse, "POST", `/approvals/${approvalId}`, body),
    answerQuestion: (questionId, body) =>
      call(QuestionResponse, "POST", `/questions/${questionId}`, body),

    openDoc: (workspaceId, body) =>
      call(OpenDocResponse, "POST", `/workspaces/${workspaceId}/docs/open`, body),
    getDocSnapshot: (workspaceId, docId) =>
      call(DocSnapshotResponse, "GET", `/workspaces/${workspaceId}/docs/${docId}/snapshot`),
    getDocRevBefore: (workspaceId, docId, rev) =>
      call(
        DocRevBeforeResponse,
        "GET",
        `/workspaces/${workspaceId}/docs/${docId}/revs/${rev}/before`,
      ),
    sendFeedback: (sessionId, body) =>
      call(OkResponse, "POST", `/sessions/${sessionId}/feedback`, body),
    exportSessionJson: (sessionId) =>
      call(SessionExportJson, "GET", `/sessions/${sessionId}/export/json`),
    mergeDocs: (workspaceId, body) =>
      call(MergeDocsResponse, "POST", `/workspaces/${workspaceId}/docs/merge`, body),
    compareDocs: (workspaceId, body) =>
      call(CompareDocsResponse, "POST", `/workspaces/${workspaceId}/docs/compare`, body),
    listDocRevisions: (workspaceId, docId, opts) =>
      call(
        DocRevisionsResponse,
        "GET",
        `/workspaces/${workspaceId}/docs/${docId}/revs${qs({ limit: opts?.limit, before: opts?.before })}`,
      ),
    undoDocRevision: (workspaceId, docId, rev) =>
      call(
        UndoRevisionResponse,
        "POST",
        `/workspaces/${workspaceId}/docs/${docId}/revs/${rev}/undo`,
      ),
    resolveDocExternal: (workspaceId, docId, body) =>
      call(
        ResolveExternalResponse,
        "POST",
        `/workspaces/${workspaceId}/docs/${docId}/external`,
        body,
      ),
    manageFiles: (workspaceId, body) =>
      call(ManageFilesResponse, "POST", `/workspaces/${workspaceId}/files/manage`, body),
    renderDoc: (workspaceId, docId, body) =>
      call(RenderDocResponse, "POST", `/workspaces/${workspaceId}/docs/${docId}/render`, body),
    getDiagnosticTraces: (sessionId) =>
      call(DiagnosticTracesResponse, "GET", `/diagnostics/traces${qs({ sessionId })}`),
    exportDiagnostics: (body) =>
      call(DiagnosticExportResponse, "POST", "/diagnostics/export", body),
    reportFirstScreenMetrics: (body) =>
      call(QaFirstScreenMetricsResponse, "POST", "/qa/first-screen-metrics", body),
    listFiles: (workspaceId, path) =>
      call(FileListResponse, "GET", `/workspaces/${workspaceId}/files${qs({ path })}`),
    getDocImage: (workspaceId, docId, sheetId, imageId) =>
      blobOf(
        `/workspaces/${workspaceId}/docs/${docId}/images/${encodeURIComponent(imageId)}?sheetId=${encodeURIComponent(sheetId)}`,
      ),
    importLegacy: (workspaceId, body) =>
      call(ImportLegacyResponse, "POST", `/workspaces/${workspaceId}/files/import-legacy`, body),
    createFile: (workspaceId, path) =>
      call(UploadResponse, "POST", `/workspaces/${workspaceId}/files/new`, { path }),
    fileHistory: (workspaceId, path) =>
      call(FileHistoryResponse, "GET", `/workspaces/${workspaceId}/files/history${qs({ path })}`),
    uploadFile: async (workspaceId, file) => {
      const fd = new FormData();
      const blob =
        file.data instanceof Blob
          ? file.data
          : new Blob([
              file.data instanceof Uint8Array ? (file.data as unknown as ArrayBuffer) : file.data,
            ]);
      fd.append("file", blob, file.name);
      if (file.path !== undefined) fd.append("path", file.path);
      const res = await fetchImpl(`${base}/api/v1/workspaces/${workspaceId}/files/upload`, {
        method: "POST",
        headers: token ? { authorization: `Bearer ${token}` } : undefined,
        credentials: token ? "omit" : "include",
        body: fd,
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const parsed = RestError.safeParse(json);
        const e = parsed.success ? parsed.data.error : undefined;
        throw new ApiError(
          res.status,
          e?.code ?? `http_${res.status}`,
          e?.message ?? `HTTP ${res.status}`,
          { details: e?.details, requestId: e?.requestId },
        );
      }
      return UploadResponse.parse(json);
    },
    uploadAttachment: async (file) => {
      const fd = new FormData();
      fd.append("file", file.data, file.name);
      const res = await fetchImpl(`${base}/api/v1/attachments`, {
        method: "POST",
        headers: token ? { authorization: `Bearer ${token}` } : undefined,
        credentials: token ? "omit" : "include",
        body: fd,
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const parsed = RestError.safeParse(json);
        const e = parsed.success ? parsed.data.error : undefined;
        throw new ApiError(
          res.status,
          e?.code ?? `http_${res.status}`,
          e?.message ?? `HTTP ${res.status}`,
          { details: e?.details, requestId: e?.requestId },
        );
      }
      return AttachmentRef.parse((json as { attachment?: unknown } | null)?.attachment);
    },
    getAttachment: (sha256) => blobOf(`/attachments/${sha256}`),
  };
}

export { protocolVersion };
