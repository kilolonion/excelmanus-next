// 契约客户端：前端/CLI/测试只通过它请求 REST。
// 每个方法对应一个端点，响应都经对应 schema 解析。

import type { z } from "zod";
import {
  BootstrapResponse,
  type CreateModelProfileBody,
  type CreateSessionBody,
  CreateSessionResponse,
  DocSnapshotResponse,
  FileListResponse,
  HealthResponse,
  OkResponse,
  type OpenDocBody,
  OpenDocResponse,
  ProfileListResponse,
  ProfileResponse,
  ProviderListResponse,
  RestError,
  type SendMessageBody,
  SendMessageResponse,
  SessionDetailResponse,
  SessionListResponse,
  SessionLogResponse,
  StopResponse,
  TestProfileResponse,
  TicketResponse,
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
  health(): Promise<z.infer<typeof HealthResponse>>;
  bootstrap(): Promise<z.infer<typeof BootstrapResponse>>;
  createTicket(): Promise<z.infer<typeof TicketResponse>>;

  listProviders(): Promise<z.infer<typeof ProviderListResponse>>;
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

  listSessions(opts?: {
    cursor?: string;
    limit?: number;
  }): Promise<z.infer<typeof SessionListResponse>>;
  createSession(
    body: z.infer<typeof CreateSessionBody>,
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
  stopAgent(sessionId: string, agentId: string): Promise<z.infer<typeof StopResponse>>;

  openDoc(
    workspaceId: string,
    body: z.infer<typeof OpenDocBody>,
  ): Promise<z.infer<typeof OpenDocResponse>>;
  getDocSnapshot(workspaceId: string, docId: string): Promise<z.infer<typeof DocSnapshotResponse>>;
  listFiles(workspaceId: string, path?: string): Promise<z.infer<typeof FileListResponse>>;
  /** multipart 单文件上传；file 为浏览器 File 或 {name, data}。 */
  uploadFile(
    workspaceId: string,
    file: { name: string; data: Blob | ArrayBuffer | Uint8Array },
  ): Promise<z.infer<typeof UploadResponse>>;
}

export function createApiClient(
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): ApiClient {
  const base = baseUrl.replace(/\/+$/, "");

  async function call<S extends z.ZodType<unknown>>(
    schema: S,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<z.infer<S>> {
    const res = await fetchImpl(`${base}/api/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
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

  const qs = (params: Record<string, string | number | undefined>) => {
    const p = Object.entries(params).filter(([, v]) => v !== undefined);
    return p.length
      ? `?${p.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&")}`
      : "";
  };

  return {
    health: () => call(HealthResponse, "GET", "/health"),
    bootstrap: () => call(BootstrapResponse, "GET", "/bootstrap"),
    createTicket: () => call(TicketResponse, "POST", "/sync/ticket"),

    listProviders: () => call(ProviderListResponse, "GET", "/providers"),
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
        `/sessions${qs({ cursor: opts?.cursor, limit: opts?.limit })}`,
      ),
    createSession: (body) => call(CreateSessionResponse, "POST", "/sessions", body),
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
    stopAgent: (sessionId, agentId) =>
      call(StopResponse, "POST", `/sessions/${sessionId}/agents/${agentId}/stop`),

    openDoc: (workspaceId, body) =>
      call(OpenDocResponse, "POST", `/workspaces/${workspaceId}/docs/open`, body),
    getDocSnapshot: (workspaceId, docId) =>
      call(DocSnapshotResponse, "GET", `/workspaces/${workspaceId}/docs/${docId}/snapshot`),
    listFiles: (workspaceId, path) =>
      call(FileListResponse, "GET", `/workspaces/${workspaceId}/files${qs({ path })}`),
    uploadFile: async (workspaceId, file) => {
      const fd = new FormData();
      const blob =
        file.data instanceof Blob
          ? file.data
          : new Blob([
              file.data instanceof Uint8Array ? (file.data as unknown as ArrayBuffer) : file.data,
            ]);
      fd.append("file", blob, file.name);
      const res = await fetchImpl(`${base}/api/v1/workspaces/${workspaceId}/files/upload`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
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
  };
}

export { protocolVersion };
