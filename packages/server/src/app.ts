// REST 网关（11 §2、§4）：/api/v1 前缀、Bearer 设备令牌、请求 ID、统一错误体。

import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { newId, nowIso, parseRange } from "@excelmanus/core";
import {
  type AgentRuntime,
  type ApprovalCoordinator,
  approvalDto,
  buildSystemPrompt,
  type ModelGateway,
  PathSafetyError,
  resolveWorkspacePath,
  type SessionLog,
  type SyncBus,
} from "@excelmanus/kernel";
import { PROVIDER_PRESETS } from "@excelmanus/models";
import type { StepEvent } from "@excelmanus/protocol";
import {
  ApprovalDecisionBody,
  CreateModelProfileBody,
  CreateSessionBody,
  OpenDocBody,
  protocolVersion,
  QuestionAnswerBody,
  SendMessageBody,
  UpdateModelProfileBody,
  UpdateSessionBody,
} from "@excelmanus/protocol";
import type { DocumentService } from "@excelmanus/workbook";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { z } from "zod";
import {
  createProfile,
  defaultProfileId,
  defaultWorkspace,
  deleteProfile,
  deleteSessionData,
  getProfile,
  getSession,
  getWorkspace,
  listAgents,
  listProfiles,
  resolveProfileModel,
  setDefaultProfile,
  sha256,
  updateProfile,
} from "./store.ts";

const APP_VERSION = "0.0.0";
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

export interface AppDeps {
  db: DatabaseSync;
  masterKey: Buffer;
  bus: SyncBus;
  log: SessionLog;
  runtime: AgentRuntime;
  approvals: ApprovalCoordinator;
  gateway: ModelGateway;
  tickets: Map<string, number>;
  ticketTtlMs: number;
  defaultWorkspaceId: string;
  moduleIds: string[];
  /** workbook 模块提供；未装配时 docs/files 路由返回 501。 */
  docService?: DocumentService;
  /** 前端产物目录（packages/web/dist）；设置后非 /api 的 GET 走静态托管 + SPA 回退。 */
  webDist?: string;
  emit: (event: string, fields: Record<string, string | number | boolean>) => void;
  allowedHosts(): Set<string>;
  allowedOrigins(): Set<string>;
}

type SessionRowLike = {
  id: string;
  workspace_id: string;
  title: string | null;
  permission_mode: string;
  created_at: string;
  updated_at: string;
  last_seq: number;
};

function sessionDto(row: SessionRowLike) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    permissionMode: row.permission_mode,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeq: row.last_seq,
  };
}

function agentDto(row: {
  id: string;
  session_id: string;
  parent_id: string | null;
  name: string | null;
  role: string;
  status: string;
  model_profile_id: string | null;
}) {
  return {
    id: row.id,
    sessionId: row.session_id,
    parentId: row.parent_id,
    name: row.name,
    role: row.role,
    status: row.status,
    modelProfileId: row.model_profile_id,
  };
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const { db, emit } = deps;

  const fail = (
    c: Context,
    status: 400 | 401 | 403 | 404 | 409 | 413 | 500 | 501 | 502,
    code: string,
    message: string,
    details?: unknown,
  ) =>
    c.json(
      {
        error: {
          code,
          message,
          ...(details !== undefined ? { details } : {}),
          requestId: c.get("requestId" as never) as string,
        },
      },
      status,
    );

  const parse = <S extends z.ZodType<unknown>>(
    schema: S,
    data: unknown,
  ): z.infer<S> | { issues: unknown } => {
    const r = schema.safeParse(data);
    return r.success ? (r.data as z.infer<S>) : { issues: r.error.issues };
  };

  app.use("*", async (c, next) => {
    const requestId = c.req.header("x-request-id") ?? randomUUID();
    c.set("requestId" as never, requestId as never);
    c.header("X-Request-Id", requestId);
    if (!deps.allowedHosts().has(c.req.header("host") ?? "")) {
      emit("http.rejected", { requestId, reason: "host" });
      return fail(c, 403, "forbidden_host", "Host 不被允许");
    }
    const origin = c.req.header("origin");
    if (origin !== undefined && !deps.allowedOrigins().has(origin)) {
      emit("http.rejected", { requestId, reason: "origin" });
      return fail(c, 403, "forbidden_origin", "Origin 不被允许");
    }
    const len = Number(c.req.header("content-length") ?? 0);
    const upload =
      c.req.method === "POST" && /^\/api\/v1\/workspaces\/[^/]+\/files\/upload$/.test(c.req.path);
    const maxSize = upload ? MAX_UPLOAD_BYTES + 64 * 1024 : MAX_BODY_BYTES;
    if (len > maxSize) {
      return fail(c, 413, "payload_too_large", "请求体超过大小上限");
    }
    // 只对 /api/ 要求令牌；前端静态资源可被无令牌加载（令牌在 URL fragment，不进请求）
    if (c.req.path.startsWith("/api/") && c.req.path !== "/api/v1/health") {
      const auth = c.req.header("authorization") ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      const device = token
        ? db
            .prepare("SELECT id FROM devices WHERE token_hash = ? AND revoked_at IS NULL")
            .get(sha256(token))
        : undefined;
      if (!device) {
        emit("http.rejected", { requestId, reason: "auth" });
        return fail(c, 401, "unauthorized", "设备令牌无效");
      }
    }
    const limitedResponse = await bodyLimit({
      maxSize,
      onError: (c) => fail(c, 413, "payload_too_large", "请求体超过大小上限"),
    })(c, next);
    if (limitedResponse instanceof Response) return limitedResponse;
    emit("http", {
      requestId,
      method: c.req.method,
      route: c.req.routePath,
      status: c.res.status,
    });
  });

  // ---------- 基础 ----------

  app.get("/api/v1/health", (c) => c.json({ ok: true, protocolVersion, version: APP_VERSION }));

  app.get("/api/v1/bootstrap", (c) => {
    const hasModelProfile =
      (db.prepare("SELECT COUNT(*) AS c FROM model_profiles").get() as { c: number }).c > 0;
    return c.json({
      protocolVersion,
      appVersion: APP_VERSION,
      shape: "local-web",
      hasModelProfile,
      modules: deps.moduleIds,
      features: {},
    });
  });

  app.post("/api/v1/sync/ticket", (c) => {
    const ticket = randomBytes(32).toString("base64url");
    const expires = Date.now() + deps.ticketTtlMs;
    deps.tickets.set(sha256(ticket), expires);
    return c.json({ ticket, expiresAt: new Date(expires).toISOString() });
  });

  app.get("/api/v1/providers", (c) => c.json({ items: PROVIDER_PRESETS }));

  // ---------- 模型档案 ----------

  app.get("/api/v1/model-profiles", (c) => c.json({ items: listProfiles(db, deps.masterKey) }));

  app.post("/api/v1/model-profiles", async (c) => {
    const body = parse(CreateModelProfileBody, await c.req.json().catch(() => null));
    if ("issues" in body) return fail(c, 400, "bad_request", "请求体不合法", body.issues);
    if (!PROVIDER_PRESETS.some((p) => p.id === body.provider)) {
      return fail(c, 400, "bad_request", `未知提供商：${body.provider}`);
    }
    const dupe = db.prepare("SELECT id FROM model_profiles WHERE name = ?").get(body.name);
    if (dupe) return fail(c, 409, "conflict", `档案名 ${body.name} 已存在`);
    const profile = createProfile(db, deps.masterKey, body);
    emit("profile.created", { profileId: profile.id, provider: profile.provider });
    return c.json({ profile }, 201);
  });

  app.get("/api/v1/model-profiles/:id", (c) => {
    const profile = getProfile(db, deps.masterKey, c.req.param("id"));
    if (!profile) return fail(c, 404, "not_found", "模型档案不存在");
    return c.json({ profile });
  });

  app.patch("/api/v1/model-profiles/:id", async (c) => {
    const body = parse(UpdateModelProfileBody, await c.req.json().catch(() => null));
    if ("issues" in body) return fail(c, 400, "bad_request", "请求体不合法", body.issues);
    const profile = updateProfile(db, deps.masterKey, c.req.param("id"), body);
    if (!profile) return fail(c, 404, "not_found", "模型档案不存在");
    return c.json({ profile });
  });

  app.delete("/api/v1/model-profiles/:id", (c) => {
    if (!deleteProfile(db, c.req.param("id"))) {
      return fail(c, 404, "not_found", "模型档案不存在");
    }
    return c.json({ ok: true });
  });

  app.post("/api/v1/model-profiles/:id/default", (c) => {
    const id = c.req.param("id");
    if (!getProfile(db, deps.masterKey, id)) {
      return fail(c, 404, "not_found", "模型档案不存在");
    }
    setDefaultProfile(db, id);
    return c.json({ profile: getProfile(db, deps.masterKey, id) });
  });

  app.post("/api/v1/model-profiles/:id/test", async (c) => {
    const resolved = resolveProfileModel(db, deps.masterKey, c.req.param("id"));
    if ("error" in resolved) {
      return c.json({
        ok: false,
        error: { kind: resolved.error.kind, message: resolved.error.message },
      });
    }
    const t0 = performance.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    try {
      let error: StepEvent | undefined;
      for await (const ev of deps.gateway.step({
        model: resolved,
        history: [{ kind: "user", text: "只回复 OK" }],
        signal: ctrl.signal,
      })) {
        if (ev.kind === "error") error = ev;
      }
      if (error && error.kind === "error") {
        return c.json({
          ok: false,
          latencyMs: Math.round(performance.now() - t0),
          error: { kind: error.error.kind, message: error.error.message },
        });
      }
      return c.json({ ok: true, latencyMs: Math.round(performance.now() - t0) });
    } finally {
      clearTimeout(timer);
    }
  });

  // ---------- 会话 ----------

  app.get("/api/v1/sessions", (c) => {
    const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
    const cursor = c.req.query("cursor");
    let rows: SessionRowLike[];
    if (cursor !== undefined) {
      const sep = cursor.indexOf("~");
      const u = cursor.slice(0, sep);
      const id = cursor.slice(sep + 1);
      rows = db
        .prepare(
          `SELECT * FROM sessions WHERE (updated_at < ? OR (updated_at = ? AND id < ?))
           ORDER BY updated_at DESC, id DESC LIMIT ?`,
        )
        .all(u, u, id, limit + 1) as unknown as SessionRowLike[];
    } else {
      rows = db
        .prepare("SELECT * FROM sessions ORDER BY updated_at DESC, id DESC LIMIT ?")
        .all(limit + 1) as unknown as SessionRowLike[];
    }
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    const nextCursor = rows.length > limit && last ? `${last.updated_at}~${last.id}` : undefined;
    return c.json({
      items: items.map(sessionDto),
      ...(nextCursor !== undefined ? { nextCursor } : {}),
    });
  });

  app.post("/api/v1/sessions", async (c) => {
    const body = parse(CreateSessionBody, await c.req.json().catch(() => null));
    if ("issues" in body) return fail(c, 400, "bad_request", "请求体不合法", body.issues);
    const ws =
      body.workspaceId !== undefined ? getWorkspace(db, body.workspaceId) : defaultWorkspace(db);
    if (!ws) return fail(c, 400, "bad_request", "工作区不存在");
    const sessionId = newId("ses");
    const permissionMode = body.permissionMode ?? "standard";
    const modelProfileId = body.modelProfileId ?? defaultProfileId(db);
    const systemPrompt = buildSystemPrompt({
      workspaceName: ws.name,
      permissionMode,
      date: nowIso().slice(0, 10),
    });
    deps.log.append(sessionId, null, [
      {
        type: "session.created",
        data: { workspaceId: ws.id, title: body.title ?? null, permissionMode },
      },
    ]);
    deps.log.append(sessionId, "main", [
      {
        type: "agent.spawned",
        data: {
          role: "main",
          name: "主代理",
          modelProfileId,
          systemPrompt,
        },
      },
    ]);
    deps.bus.publish({ kind: "app", data: { type: "session.created", sessionId } });
    const row = getSession(db, sessionId);
    if (!row) return fail(c, 500, "internal", "会话创建失败");
    return c.json(
      { session: sessionDto(row), agents: listAgents(db, sessionId).map(agentDto) },
      201,
    );
  });

  app.get("/api/v1/sessions/:id", (c) => {
    const row = getSession(db, c.req.param("id"));
    if (!row) return fail(c, 404, "not_found", "会话不存在");
    return c.json({
      session: sessionDto(row),
      agents: listAgents(db, row.id).map(agentDto),
      headSeq: row.last_seq,
    });
  });

  app.patch("/api/v1/sessions/:id", async (c) => {
    const row = getSession(db, c.req.param("id"));
    if (!row) return fail(c, 404, "not_found", "会话不存在");
    const body = parse(UpdateSessionBody, await c.req.json().catch(() => null));
    if ("issues" in body) return fail(c, 400, "bad_request", "请求体不合法", body.issues);
    deps.log.append(row.id, null, [
      {
        type: "session.updated",
        data: {
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(body.permissionMode !== undefined ? { permissionMode: body.permissionMode } : {}),
        },
      },
    ]);
    const updated = getSession(db, row.id);
    if (!updated) return fail(c, 500, "internal", "会话更新失败");
    return c.json({
      session: sessionDto(updated),
      agents: listAgents(db, row.id).map(agentDto),
      headSeq: updated.last_seq,
    });
  });

  app.delete("/api/v1/sessions/:id", (c) => {
    const row = getSession(db, c.req.param("id"));
    if (!row) return fail(c, 404, "not_found", "会话不存在");
    for (const a of listAgents(db, row.id)) deps.runtime.stop(row.id, a.id);
    deleteSessionData(db, row.id);
    deps.bus.publish({ kind: "app", data: { type: "session.deleted", sessionId: row.id } });
    return c.json({ ok: true });
  });

  // ---------- 审批 ----------

  app.post("/api/v1/approvals/:id", async (c) => {
    const body = parse(ApprovalDecisionBody, await c.req.json().catch(() => null));
    if ("issues" in body) return fail(c, 400, "bad_request", "请求体不合法", body.issues);
    const raw = body.decision;
    const decision = raw === "approve" || raw === "approved" ? "approved" : "denied";
    const pending = deps.approvals.get(c.req.param("id"));
    if (!pending) return fail(c, 404, "not_found", "审批不存在");
    try {
      const out = deps.runtime.decideApproval(
        c.req.param("id"),
        decision,
        body.reason,
        body.remember ?? false,
      );
      return c.json({ approval: approvalDto(out.row), idempotent: out.idempotent });
    } catch (e) {
      return fail(c, 409, "conflict", e instanceof Error ? e.message : "审批无法处理");
    }
  });

  app.get("/api/v1/sessions/:id/approvals", (c) => {
    const row = getSession(db, c.req.param("id"));
    if (!row) return fail(c, 404, "not_found", "会话不存在");
    return c.json({ items: deps.approvals.pendingForSession(row.id).map(approvalDto) });
  });

  app.post("/api/v1/questions/:id", async (c) => {
    const body = parse(QuestionAnswerBody, await c.req.json().catch(() => null));
    if ("issues" in body) return fail(c, 400, "bad_request", "请求体不合法", body.issues);
    const row = db
      .prepare(
        "SELECT id, session_id, agent_id, status FROM pending_interactions WHERE id = ? AND kind = 'question'",
      )
      .get(c.req.param("id")) as
      | { id: string; session_id: string; agent_id: string; status: string }
      | undefined;
    if (!row) return fail(c, 404, "not_found", "问题不存在");
    try {
      const out = deps.runtime.answerQuestion(c.req.param("id"), body.answer, body.rev);
      return c.json({
        question: {
          id: c.req.param("id"),
          sessionId: row.session_id,
          agentId: row.agent_id,
          status: out.row.status,
        },
        idempotent: out.idempotent,
      });
    } catch (e) {
      return fail(c, 409, "conflict", e instanceof Error ? e.message : "问题无法处理");
    }
  });

  app.get("/api/v1/sessions/:id/log", (c) => {
    const row = getSession(db, c.req.param("id"));
    if (!row) return fail(c, 404, "not_found", "会话不存在");
    const beforeQ = c.req.query("before");
    const before = beforeQ !== undefined && beforeQ !== "" ? Number(beforeQ) : undefined;
    if (before !== undefined && !Number.isInteger(before)) {
      return fail(c, 400, "bad_request", "before 必须是整数游标");
    }
    const limit = Math.min(Number(c.req.query("limit") ?? 200), 500);
    return c.json({ items: deps.log.readBefore(row.id, before, limit) });
  });

  // ---------- 派发消息 / 停止 ----------

  app.post("/api/v1/sessions/:id/agents/:agentId/messages", async (c) => {
    const sessionId = c.req.param("id");
    const agentId = c.req.param("agentId");
    const row = getSession(db, sessionId);
    if (!row) return fail(c, 404, "not_found", "会话不存在");
    const agent = db
      .prepare("SELECT * FROM agents WHERE session_id = ? AND id = ?")
      .get(sessionId, agentId) as { status: string; closed_at: string | null } | undefined;
    if (!agent) return fail(c, 404, "not_found", "代理不存在");
    if (agent.status === "closed" || agent.closed_at !== null) {
      return fail(c, 409, "conflict", "代理已关闭");
    }
    const body = parse(SendMessageBody, await c.req.json().catch(() => null));
    if ("issues" in body) return fail(c, 400, "bad_request", "请求体不合法", body.issues);
    const mode = body.mode ?? "steer";

    // 重启后仍 blocked（持久化待审批/待回答）：steer/queue 持久化为 queued 挂起，
    // 等审批决定后由运行时继续；interrupt 以"用户发送了新指令"拒绝待审批后开新一轮
    //（04 §4.1）。待回答 ask_user 不能被打断，保持冲突。
    let blockedPending: { id: string; kind: string } | undefined;
    const blockedIdle = agent.status === "blocked" && !deps.runtime.isRunning(sessionId, agentId);
    if (blockedIdle) {
      blockedPending = db
        .prepare(
          "SELECT id, kind FROM pending_interactions WHERE session_id = ? AND agent_id = ? AND status = 'pending' ORDER BY created_at LIMIT 1",
        )
        .get(sessionId, agentId) as { id: string; kind: string } | undefined;
      if (mode === "interrupt" && blockedPending?.kind !== "approval") {
        return fail(c, 409, "conflict", "代理正在等待用户回答");
      }
    }

    // 幂等：同 clientMessageId 同内容返回原记录，不同内容返回冲突（04 §4.3）
    const existing = db
      .prepare(
        "SELECT d.*, m.data AS msg FROM dispatches d LEFT JOIN session_log m ON m.session_id = d.session_id AND m.type = 'user.message' AND json_extract(m.data, '$.dispatchId') = d.id WHERE d.session_id = ? AND d.agent_id = ? AND d.client_message_id = ?",
      )
      .get(sessionId, agentId, body.clientMessageId) as
      | { id: string; status: string; mode: string; msg: string | null }
      | undefined;
    if (existing) {
      const old = existing.msg
        ? (JSON.parse(existing.msg) as { text?: string; context?: unknown; mode?: string })
        : undefined;
      if (
        old?.text !== body.text ||
        JSON.stringify(old.context ?? []) !== JSON.stringify(body.context ?? []) ||
        (old.mode ?? "steer") !== mode
      ) {
        return fail(c, 409, "conflict", "clientMessageId 已使用且内容不同");
      }
      return c.json({
        dispatch: {
          id: existing.id,
          sessionId,
          agentId,
          clientMessageId: body.clientMessageId,
          mode: existing.mode,
          status: existing.status,
        },
        deduplicated: true,
      });
    }

    for (const ref of body.context ?? []) {
      const document = db
        .prepare("SELECT workspace_id FROM documents WHERE id = ?")
        .get(ref.docId) as { workspace_id: string } | undefined;
      if (!document || document.workspace_id !== row.workspace_id || !deps.docService) {
        return fail(c, 400, "bad_request", "选区引用的文档不属于当前工作区");
      }
      const workspace = getWorkspace(db, row.workspace_id);
      if (!workspace) return fail(c, 400, "bad_request", "工作区不存在");
      try {
        const { meta, snapshot } = await deps.docService.snapshot(ref.docId, workspace.path);
        if (meta.rev !== ref.rev) return fail(c, 409, "conflict", "选区修订已变化，请重新选择区域");
        const range = parseRange(ref.range);
        if (
          range.sheet &&
          !Object.values(snapshot.sheets).some((sheet) => sheet.name === range.sheet)
        ) {
          return fail(c, 400, "bad_request", "选区引用的工作表不存在");
        }
      } catch {
        return fail(c, 400, "bad_request", "选区引用无效，请重新打开文档并选择区域");
      }
    }

    const dispatchId = newId("dsp");
    const running = deps.runtime.isRunning(sessionId, agentId);
    // 挂起语义：运行中或等待审批/回答期间受理的消息都先记 queued（04 §4.1/§4.2）
    const initialStatus = running || blockedIdle ? "queued" : "accepted";
    deps.log.append(sessionId, agentId, [
      {
        type: "user.message",
        data: {
          dispatchId,
          clientMessageId: body.clientMessageId,
          text: body.text,
          mode,
          ...(body.context !== undefined ? { context: body.context } : {}),
        },
      },
      {
        type: "dispatch.updated",
        data: { dispatchId, status: initialStatus },
      },
    ]);
    if (blockedIdle && mode === "interrupt" && blockedPending !== undefined) {
      // 待审批被新指令打断：视为拒绝，resumePersistedApproval 收口旧轮后 pump 开新轮
      deps.runtime.decideApproval(blockedPending.id, "denied", "用户发送了新指令");
    }
    deps.runtime.enqueue(sessionId, agentId, dispatchId, mode);
    return c.json(
      {
        dispatch: {
          id: dispatchId,
          sessionId,
          agentId,
          clientMessageId: body.clientMessageId,
          mode,
          status: initialStatus,
        },
        deduplicated: false,
      },
      201,
    );
  });

  app.post("/api/v1/sessions/:id/agents/:agentId/stop", (c) => {
    const sessionId = c.req.param("id");
    const agentId = c.req.param("agentId");
    const row = getSession(db, sessionId);
    if (!row) return fail(c, 404, "not_found", "会话不存在");
    const agent = db
      .prepare("SELECT id FROM agents WHERE session_id = ? AND id = ?")
      .get(sessionId, agentId);
    if (!agent) return fail(c, 404, "not_found", "代理不存在");
    const stopped = deps.runtime.stop(sessionId, agentId);
    return c.json({ ok: true, stopped });
  });

  /** 停止该会话全部运行中的代理（11 §147）。 */
  app.post("/api/v1/sessions/:id/stop-all", (c) => {
    const sessionId = c.req.param("id");
    const row = getSession(db, sessionId);
    if (!row) return fail(c, 404, "not_found", "会话不存在");
    const stopped = listAgents(db, sessionId)
      .map((a) => a.id)
      .filter((id) => deps.runtime.stop(sessionId, id));
    return c.json({ ok: true, stopped });
  });

  /** 撤回未应用的派发（04 §4.3）：accepted/queued → cancelled；已 cancelled 幂等返回。 */
  app.delete("/api/v1/sessions/:id/dispatches/:dispatchId", (c) => {
    const sessionId = c.req.param("id");
    const dispatchId = c.req.param("dispatchId");
    const row = getSession(db, sessionId);
    if (!row) return fail(c, 404, "not_found", "会话不存在");
    const dto = (d: {
      id: string;
      session_id: string;
      agent_id: string;
      client_message_id: string;
      mode: string;
      status: string;
    }) => ({
      id: d.id,
      sessionId: d.session_id,
      agentId: d.agent_id,
      clientMessageId: d.client_message_id,
      mode: d.mode,
      status: d.status,
    });
    const existing = db
      .prepare("SELECT * FROM dispatches WHERE id = ? AND session_id = ?")
      .get(dispatchId, sessionId) as
      | {
          id: string;
          session_id: string;
          agent_id: string;
          client_message_id: string;
          mode: string;
          status: string;
        }
      | undefined;
    if (!existing) return fail(c, 404, "not_found", "派发不存在");
    if (existing.status === "cancelled") return c.json({ dispatch: dto(existing) });
    if (existing.status !== "accepted" && existing.status !== "queued") {
      return fail(c, 409, "conflict", "派发已应用，无法撤回");
    }
    deps.log.append(sessionId, existing.agent_id, [
      { type: "dispatch.updated", data: { dispatchId, status: "cancelled" } },
    ]);
    deps.runtime.cancelDispatch(sessionId, existing.agent_id, dispatchId);
    const updated = db
      .prepare("SELECT * FROM dispatches WHERE id = ?")
      .get(dispatchId) as typeof existing;
    return c.json({ dispatch: dto(updated ?? existing) });
  });

  /** 继续（04 §4.2/§8.3）：恢复挂起派发；无挂起且代理 interrupted 时开一轮继续轮。 */
  app.post("/api/v1/sessions/:id/agents/:agentId/resume", (c) => {
    const sessionId = c.req.param("id");
    const agentId = c.req.param("agentId");
    const row = getSession(db, sessionId);
    if (!row) return fail(c, 404, "not_found", "会话不存在");
    const agent = db
      .prepare("SELECT id FROM agents WHERE session_id = ? AND id = ?")
      .get(sessionId, agentId);
    if (!agent) return fail(c, 404, "not_found", "代理不存在");
    if (deps.runtime.isRunning(sessionId, agentId)) {
      return fail(c, 409, "conflict", "代理正在运行");
    }
    const out = deps.runtime.resumeAgent(sessionId, agentId);
    return c.json({ ok: true, resumed: out.resumed, started: out.started });
  });

  /** 手动压缩（04 §6.3、11 §4）：运行中排期到下一步边界，空闲立即执行。 */
  app.post("/api/v1/sessions/:id/agents/:agentId/compact", async (c) => {
    const sessionId = c.req.param("id");
    const agentId = c.req.param("agentId");
    const row = getSession(db, sessionId);
    if (!row) return fail(c, 404, "not_found", "会话不存在");
    const agent = db
      .prepare("SELECT id, status FROM agents WHERE session_id = ? AND id = ?")
      .get(sessionId, agentId) as { id: string; status: string } | undefined;
    if (!agent) return fail(c, 404, "not_found", "代理不存在");
    if (agent.status === "closed") return fail(c, 409, "conflict", "代理已关闭");
    try {
      return c.json(await deps.runtime.compact(sessionId, agentId));
    } catch (err) {
      emit("compaction.failed", {
        sessionId,
        agentId,
        trigger: "manual",
        message: err instanceof Error ? err.message : String(err),
      });
      return fail(c, 502, "compaction_failed", "上下文压缩失败，请重试");
    }
  });

  // ---------- 工作区文档与文件（modules/workbook 的活文档只读面） ----------

  const docMeta = (m: {
    id: string;
    workspaceId: string;
    path: string;
    kind: string;
    checkpointRev?: number;
    checkpointError?: string;
    rev: number;
    createdAt: string;
  }) => ({
    id: m.id,
    workspaceId: m.workspaceId,
    path: m.path,
    kind: m.kind,
    checkpointRev: m.checkpointRev,
    checkpointError: m.checkpointError,
    rev: m.rev,
    createdAt: m.createdAt,
  });

  const docErr = (c: Context, e: unknown) => {
    if (e instanceof PathSafetyError) {
      return e.code === "NOT_FOUND"
        ? fail(c, 404, "not_found", e.message)
        : fail(c, 403, "forbidden", e.message);
    }
    return fail(c, 400, "bad_request", e instanceof Error ? e.message : String(e));
  };

  app.post("/api/v1/workspaces/:id/docs/open", async (c) => {
    const svc = deps.docService;
    if (!svc) return fail(c, 501, "not_implemented", "workbook 模块未装配");
    const wsRow = getWorkspace(db, c.req.param("id"));
    if (!wsRow) return fail(c, 404, "not_found", "工作区不存在");
    const body = parse(OpenDocBody, await c.req.json().catch(() => null));
    if ("issues" in body) return fail(c, 400, "bad_request", "请求体不合法", body.issues);
    try {
      const { meta } = await svc.open(wsRow.id, wsRow.path, body.path);
      return c.json({ document: docMeta(meta) });
    } catch (e) {
      return docErr(c, e);
    }
  });

  app.get("/api/v1/workspaces/:id/docs/:docId/snapshot", async (c) => {
    const svc = deps.docService;
    if (!svc) return fail(c, 501, "not_implemented", "workbook 模块未装配");
    const wsRow = getWorkspace(db, c.req.param("id"));
    if (!wsRow) return fail(c, 404, "not_found", "工作区不存在");
    const docRow = db
      .prepare("SELECT workspace_id FROM documents WHERE id = ?")
      .get(c.req.param("docId")) as { workspace_id: string } | undefined;
    if (!docRow || docRow.workspace_id !== wsRow.id) return fail(c, 404, "not_found", "文档不存在");
    try {
      const { meta, snapshot } = await svc.snapshot(c.req.param("docId"), wsRow.path);
      if (meta.workspaceId !== wsRow.id) return fail(c, 404, "not_found", "文档不存在");
      return c.json({ document: docMeta(meta), snapshot });
    } catch (e) {
      return docErr(c, e);
    }
  });

  app.get("/api/v1/workspaces/:id/files", (c) => {
    const wsRow = getWorkspace(db, c.req.param("id"));
    if (!wsRow) return fail(c, 404, "not_found", "工作区不存在");
    const rel = c.req.query("path") ?? "";
    try {
      const { abs, rel: safeRel } = resolveWorkspacePath(wsRow.path, rel === "" ? "." : rel);
      const st = statSync(abs);
      if (!st.isDirectory()) return fail(c, 400, "bad_request", "不是目录");
      const items = readdirSync(abs, { withFileTypes: true })
        .filter((d) => !d.name.startsWith("."))
        .flatMap((d) => {
          const entryRel = safeRel === "" ? d.name : `${safeRel}/${d.name}`;
          let size: number | undefined;
          let modifiedAt: string | undefined;
          let kind: "file" | "dir";
          try {
            const entry = resolveWorkspacePath(wsRow.path, entryRel);
            const s = statSync(entry.abs);
            if (s.isFile()) size = s.size;
            modifiedAt = s.mtime.toISOString();
            kind = s.isDirectory() ? "dir" : "file";
          } catch {
            return [];
          }
          return [
            {
              name: d.name,
              path: entryRel,
              kind,
              ...(size !== undefined ? { size } : {}),
              ...(modifiedAt !== undefined ? { modifiedAt } : {}),
            },
          ];
        })
        .sort((a, b) =>
          a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1,
        );
      return c.json({ path: safeRel, items });
    } catch (e) {
      return docErr(c, e);
    }
  });

  app.post("/api/v1/workspaces/:id/files/upload", async (c) => {
    const wsRow = getWorkspace(db, c.req.param("id"));
    if (!wsRow) return fail(c, 404, "not_found", "工作区不存在");
    const body = await c.req.parseBody().catch(() => null);
    const file = body?.file;
    if (!(file instanceof File)) return fail(c, 400, "bad_request", "缺少 file 字段");
    if (file.size > MAX_UPLOAD_BYTES) {
      return fail(c, 413, "payload_too_large", "文件超过 200MB 上限");
    }
    const name = basename(file.name || "unnamed");
    if (name.startsWith(".")) return fail(c, 400, "bad_request", "文件名不合法");
    const dir = typeof body?.path === "string" ? body.path : "";
    const bytes = Buffer.from(await file.arrayBuffer());
    try {
      const { abs } = resolveWorkspacePath(wsRow.path, dir === "" ? `${name}` : `${dir}/${name}`);
      writeFileSync(abs, bytes, { flag: "wx" });
      const { rel } = resolveWorkspacePath(wsRow.path, dir === "" ? `${name}` : `${dir}/${name}`);
      return c.json({ path: rel, size: file.size }, 201);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") {
        return fail(c, 409, "conflict", "同名文件已存在，请更换文件名后上传");
      }
      return docErr(c, e);
    }
  });

  // ---------- 前端静态托管（生产：server 直接提供 packages/web/dist） ----------
  const webDist = deps.webDist;
  if (webDist !== undefined && existsSync(join(webDist, "index.html"))) {
    const distRoot = realpathSync(webDist);
    const MIME: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".woff2": "font/woff2",
      ".map": "application/json",
      ".ico": "image/x-icon",
    };
    app.get("*", (c) => {
      const p = decodeURIComponent(c.req.path);
      if (p.startsWith("/api/")) return fail(c, 404, "not_found", "端点不存在");
      // 防穿越：拼进 dist 后必须仍在 dist 内
      const target = resolve(distRoot, p.replace(/^\/+/, ""));
      const outside = (path: string) => {
        const rel = relative(distRoot, path);
        return isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`);
      };
      if (outside(target)) return fail(c, 403, "forbidden", "非法路径");
      if (existsSync(target) && outside(realpathSync(target)))
        return fail(c, 403, "forbidden", "非法路径");
      const file =
        existsSync(target) && statSync(target).isFile() ? target : join(webDist, "index.html"); // SPA 回退
      const body = readFileSync(file);
      return c.body(body, 200, {
        "content-type": MIME[extname(file)] ?? "application/octet-stream",
      });
    });
  }

  app.notFound((c) => fail(c, 404, "not_found", "端点不存在"));

  app.onError((err, c) => {
    emit("http.error", {
      requestId: c.get("requestId" as never) as string,
      name: err.name,
    });
    return fail(c, 500, "internal", "内部错误");
  });

  return app;
}
