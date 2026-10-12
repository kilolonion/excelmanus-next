/** REST schema 的公开注册表：OpenAPI 与服务端响应验证共用，DTO 不在网关重新定义。 */
import { z } from "zod";
import * as diagnostics from "./diagnostics.ts";
import * as extensions from "./extensions.ts";
import { ManageFilesBody, ManageFilesResponse } from "./files.ts";
import * as rest from "./rest.ts";

export interface HttpContract {
  method: "get" | "post" | "put" | "patch" | "delete";
  path: string;
  response: z.ZodType;
  body?: z.ZodType;
  responseMediaType?: string;
  bodyMediaType?: string;
}
export const httpContracts: HttpContract[] = [
  { method: "get", path: "/mcp-servers/{id}", response: extensions.McpServerResponse },
  { method: "get", path: "/model-profiles/{id}", response: rest.ProfileResponse },
  { method: "post", path: "/model-profiles/{id}/default", response: rest.ProfileResponse },
  { method: "get", path: "/sessions/{id}/approvals", response: rest.ApprovalListResponse },
  {
    method: "get",
    path: "/sessions/{id}/export",
    response: extensions.BinaryResponse,
    responseMediaType: "text/markdown",
  },
  {
    method: "post",
    path: "/attachments",
    response: rest.AttachmentUploadResponse,
    body: extensions.UploadFileBody,
    bodyMediaType: "multipart/form-data",
  },
  {
    method: "get",
    path: "/attachments/{sha}",
    response: extensions.BinaryResponse,
    responseMediaType: "application/octet-stream",
  },
  {
    method: "get",
    path: "/workspaces/{id}/files/download",
    response: extensions.BinaryResponse,
    responseMediaType: "application/octet-stream",
  },
  {
    method: "post",
    path: "/workspaces",
    body: extensions.CreateWorkspaceBody,
    response: extensions.WorkspaceResponse,
  },
  {
    method: "patch",
    path: "/workspaces/{id}",
    body: extensions.UpdateWorkspaceBody,
    response: extensions.WorkspaceResponse,
  },
  {
    method: "put",
    path: "/workspaces/order",
    body: extensions.WorkspaceOrderBody,
    response: extensions.WorkspaceListResponse,
  },
  { method: "delete", path: "/workspaces/{id}", response: rest.OkResponse },
  {
    method: "patch",
    path: "/skills/{name}",
    body: extensions.UpdateSkillBody,
    response: extensions.SkillResponse,
  },
  { method: "delete", path: "/skills/{name}", response: rest.OkResponse },
  { method: "post", path: "/accounts/{id}/refresh", response: extensions.AccountResponse },
  {
    method: "post",
    path: "/providers/{id}/models",
    body: extensions.ProviderModelsBody,
    response: extensions.RemoteModelsResponse,
  },
  { method: "get", path: "/model-catalog", response: extensions.ModelCatalogResponse },
  { method: "post", path: "/model-catalog/refresh", response: extensions.ModelCatalogResponse },
  {
    method: "patch",
    path: "/sessions/{id}/agents/{agentId}",
    body: extensions.SwitchAgentModelBody,
    response: extensions.SwitchAgentModelResponse,
  },
  { method: "get", path: "/samples", response: extensions.SampleListResponse },
  { method: "post", path: "/workspaces/{id}/samples/{name}", response: extensions.SampleResponse },
  { method: "get", path: "/devices", response: extensions.DeviceListResponse },
  { method: "post", path: "/devices/{id}/revoke", response: rest.OkResponse },
  {
    method: "post",
    path: "/workspaces/{id}/docs/{docId}/render",
    body: rest.RenderDocBody,
    response: rest.RenderDocResponse,
  },
  { method: "get", path: "/diagnostics/traces", response: diagnostics.DiagnosticTracesResponse },
  {
    method: "post",
    path: "/diagnostics/export",
    body: diagnostics.DiagnosticExportBody,
    response: diagnostics.DiagnosticExportResponse,
  },
  {
    method: "post",
    path: "/workspaces/{id}/docs/compare",
    body: rest.CompareDocsBody,
    response: rest.CompareDocsResponse,
  },
  {
    method: "get",
    path: "/workspaces/{id}/docs/{docId}/revs",
    response: rest.DocRevisionsResponse,
  },
  {
    method: "post",
    path: "/workspaces/{id}/docs/{docId}/revs/{rev}/undo",
    response: rest.UndoRevisionResponse,
  },
  {
    method: "post",
    path: "/sessions/{id}/feedback",
    body: rest.FeedbackBody,
    response: rest.OkResponse,
  },
  { method: "get", path: "/sessions/{id}/export/json", response: rest.SessionExportJson },
  { method: "get", path: "/health", response: rest.HealthResponse },
  { method: "post", path: "/auth/session", response: rest.AuthSessionResponse },
  { method: "post", path: "/auth/logout", response: rest.OkResponse },
  { method: "get", path: "/bootstrap", response: rest.BootstrapResponse },
  { method: "post", path: "/sync/ticket", response: rest.TicketResponse },
  { method: "get", path: "/sessions", response: rest.SessionListResponse },
  {
    method: "post",
    path: "/sessions",
    body: rest.CreateSessionBody,
    response: rest.CreateSessionResponse,
  },
  { method: "get", path: "/sessions/{id}", response: rest.SessionDetailResponse },
  {
    method: "patch",
    path: "/sessions/{id}",
    body: rest.UpdateSessionBody,
    response: rest.SessionDetailResponse,
  },
  { method: "delete", path: "/sessions/{id}", response: rest.OkResponse },
  { method: "get", path: "/sessions/{id}/log", response: rest.SessionLogResponse },
  {
    method: "post",
    path: "/sessions/{id}/agents/{agentId}/messages",
    body: rest.SendMessageBody,
    response: rest.SendMessageResponse,
  },
  {
    method: "delete",
    path: "/sessions/{id}/dispatches/{dispatchId}",
    response: rest.DispatchResponse,
  },
  { method: "post", path: "/sessions/{id}/agents/{agentId}/stop", response: rest.StopResponse },
  { method: "post", path: "/sessions/{id}/agents/{agentId}/resume", response: rest.ResumeResponse },
  {
    method: "post",
    path: "/sessions/{id}/agents/{agentId}/compact",
    response: rest.CompactResponse,
  },
  {
    method: "post",
    path: "/sessions/{id}/agents/{agentId}/rewind",
    body: rest.RewindBody,
    response: rest.RewindResponse,
  },
  {
    method: "post",
    path: "/sessions/{id}/agents/{agentId}/control",
    body: rest.ControlBody,
    response: rest.ControlResponse,
  },
  {
    method: "post",
    path: "/sessions/{id}/stop-all",
    body: rest.StopAllBody,
    response: rest.StopAllResponse,
  },
  {
    method: "post",
    path: "/approvals/{id}",
    body: rest.ApprovalDecisionBody,
    response: rest.ApprovalResponse,
  },
  {
    method: "post",
    path: "/questions/{id}",
    body: rest.QuestionAnswerBody,
    response: rest.QuestionResponse,
  },
  { method: "get", path: "/providers", response: rest.ProviderListResponse },
  { method: "get", path: "/model-profiles", response: rest.ProfileListResponse },
  {
    method: "post",
    path: "/model-profiles",
    body: rest.CreateModelProfileBody,
    response: rest.ProfileResponse,
  },
  {
    method: "patch",
    path: "/model-profiles/{id}",
    body: rest.UpdateModelProfileBody,
    response: rest.ProfileResponse,
  },
  { method: "delete", path: "/model-profiles/{id}", response: rest.OkResponse },
  { method: "post", path: "/model-profiles/{id}/test", response: rest.TestProfileResponse },
  { method: "post", path: "/model-profiles/{id}/probe", response: extensions.ProbeResponse },
  { method: "get", path: "/model-profiles/{id}/capabilities", response: extensions.ProbeResponse },
  {
    method: "patch",
    path: "/model-profiles/{id}/capabilities",
    body: extensions.OverrideCapabilitiesBody,
    response: extensions.ProbeResponse,
  },
  {
    method: "post",
    path: "/model-profiles/{id}/models",
    response: extensions.RemoteModelsResponse,
  },
  { method: "get", path: "/settings", response: extensions.SettingsResponse },
  {
    method: "patch",
    path: "/settings",
    body: extensions.UpdateSettingsBody,
    response: extensions.SettingsResponse,
  },
  { method: "get", path: "/workspaces", response: extensions.WorkspaceListResponse },
  { method: "get", path: "/workspaces/{id}/files", response: rest.FileListResponse },
  {
    method: "post",
    path: "/workspaces/{id}/files/new",
    body: rest.NewFileBody,
    response: rest.UploadResponse,
  },
  { method: "get", path: "/workspaces/{id}/files/history", response: rest.FileHistoryResponse },
  {
    method: "post",
    path: "/workspaces/{id}/files/upload",
    response: rest.UploadResponse,
    body: extensions.UploadFileBody,
    bodyMediaType: "multipart/form-data",
  },
  {
    method: "post",
    path: "/workspaces/{id}/files/manage",
    body: ManageFilesBody,
    response: ManageFilesResponse,
  },
  {
    method: "post",
    path: "/workspaces/{id}/docs/open",
    body: rest.OpenDocBody,
    response: rest.OpenDocResponse,
  },
  {
    method: "get",
    path: "/workspaces/{id}/docs/{docId}/snapshot",
    response: rest.DocSnapshotResponse,
  },
  {
    method: "get",
    path: "/workspaces/{id}/docs/{docId}/revs/{rev}/before",
    response: rest.DocRevBeforeResponse,
  },
  {
    method: "post",
    path: "/workspaces/{id}/docs/{docId}/external",
    body: rest.ResolveExternalBody,
    response: rest.ResolveExternalResponse,
  },
  ...(["backups", "trash"] as const).flatMap((kind): HttpContract[] => [
    { method: "get", path: `/workspaces/{id}/${kind}`, response: extensions.BackupListResponse },
    {
      method: "post",
      path: `/workspaces/{id}/${kind}/{backupId}/restore`,
      response: extensions.RestoreBackupResponse,
    },
    {
      method: "get",
      path: `/workspaces/{id}/${kind}/{backupId}/download`,
      response: extensions.BinaryResponse,
      responseMediaType: "application/octet-stream",
    },
    { method: "delete", path: `/workspaces/{id}/${kind}/{backupId}`, response: rest.OkResponse },
  ]),
  ...(
    [
      [
        "rules",
        extensions.RuleListResponse,
        extensions.RuleResponse,
        extensions.CreateRuleBody,
        extensions.UpdateRuleBody,
      ],
      [
        "memories",
        extensions.MemoryListResponse,
        extensions.MemoryResponse,
        extensions.CreateMemoryBody,
        extensions.UpdateMemoryBody,
      ],
      [
        "mcp-servers",
        extensions.McpServerListResponse,
        extensions.McpServerResponse,
        extensions.CreateMcpServerBody,
        extensions.UpdateMcpServerBody,
      ],
    ] as const
  ).flatMap(([path, list, response, create, update]): HttpContract[] => [
    { method: "get", path: `/${path}`, response: list },
    { method: "post", path: `/${path}`, body: create, response },
    { method: "patch", path: `/${path}/{id}`, body: update, response },
    { method: "delete", path: `/${path}/{id}`, response: rest.OkResponse },
  ]),
  { method: "get", path: "/skills", response: extensions.SkillListResponse },
  { method: "get", path: "/skills/{name}", response: extensions.SkillDetailResponse },
  {
    method: "post",
    path: "/skills/import",
    body: extensions.ImportSkillBody,
    response: extensions.ImportSkillResponse,
  },
  { method: "get", path: "/accounts", response: extensions.AccountListResponse },
  {
    method: "post",
    path: "/accounts/{provider}/login",
    body: extensions.StartLoginBody,
    response: extensions.LoginAttemptResponse,
  },
  {
    method: "post",
    path: "/accounts/{provider}/login/poll",
    body: extensions.PollLoginBody,
    response: extensions.LoginAttemptResponse,
  },
  { method: "delete", path: "/accounts/{id}", response: rest.OkResponse },
  { method: "post", path: "/mcp-servers/{id}/test", response: extensions.McpTestResponse },
  { method: "post", path: "/mcp-servers/reload", response: rest.OkResponse },
];

export function findHttpContract(method: string, path: string): HttpContract | undefined {
  return httpContracts.find(
    (route) =>
      route.method === method.toLowerCase() &&
      new RegExp(`^${route.path.replace(/\{[^}]+\}/g, "[^/]+")}$`).test(path),
  );
}

export function createOpenApiDocument(version: string) {
  const schemas: Record<string, unknown> = {};
  const names = new Map<z.ZodType, string>();
  for (const [name, value] of Object.entries({
    ...rest,
    ...diagnostics,
    ...extensions,
    ManageFilesBody,
    ManageFilesResponse,
  })) {
    if (value instanceof z.ZodType) {
      names.set(value, name);
      schemas[name] = z.toJSONSchema(value, { unrepresentable: "any", io: "input" });
    }
  }
  const ref = (schema: z.ZodType) => {
    const name = names.get(schema);
    if (!name) throw new Error("Unregistered REST schema");
    return { $ref: `#/components/schemas/${name}` };
  };
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of httpContracts) {
    const operation = {
      parameters: [...route.path.matchAll(/\{([^}]+)\}/g)].map((m) => ({
        name: m[1],
        in: "path",
        required: true,
        schema: { type: "string" },
      })),
      ...(route.body
        ? {
            requestBody: {
              required: true,
              content: { [route.bodyMediaType ?? "application/json"]: { schema: ref(route.body) } },
            },
          }
        : {}),
      responses: {
        "200": {
          description: "成功",
          content: {
            [route.responseMediaType ?? "application/json"]: { schema: ref(route.response) },
          },
        },
        "201": {
          description: "创建成功（创建类端点）",
          content: {
            [route.responseMediaType ?? "application/json"]: { schema: ref(route.response) },
          },
        },
        default: {
          description: "错误",
          content: { "application/json": { schema: ref(rest.RestError) } },
        },
      },
      ...(route.path === "/health" ? { security: [] } : {}),
    };
    const methods = paths[route.path] ?? {};
    methods[route.method] = operation;
    paths[route.path] = methods;
  }
  return {
    openapi: "3.1.0",
    info: { title: "ExcelManus API", version },
    servers: [{ url: "/api/v1" }],
    paths,
    security: [{ bearerAuth: [] }],
    components: { schemas, securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
  };
}
