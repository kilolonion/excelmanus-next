// REST 网关（11 §2、§4）：/api/v1 前缀、Bearer 设备令牌/浏览器会话 Cookie、请求 ID、统一错误体。

import { randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  createReadStream,
  existsSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import { newId, nowIso, parseRange } from "@excelmanus/core";
import {
  type AgentRuntime,
  type ApprovalCoordinator,
  approvalDto,
  type BlobStore,
  buildSystemPrompt,
  type ModelGateway,
  PathSafetyError,
  resolveWorkspacePath,
  type SessionLog,
  type SyncBus,
  type TeamCoordinator,
} from "@excelmanus/kernel";
import { PROVIDER_PRESETS, redactSecrets } from "@excelmanus/models";
import type { StepEvent } from "@excelmanus/protocol";
import {
  ApprovalDecisionBody,
  ControlBody,
  CreateModelProfileBody,
  CreateSessionBody,
  createOpenApiDocument,
  findHttpContract,
  OpenDocBody,
  protocolVersion,
  QuestionAnswerBody,
  RenderDocBody,
  type RenderLayout,
  ResolveExternalBody,
  SendMessageBody,
  SessionListQuery,
  SessionLogQuery,
  UpdateModelProfileBody,
  UpdateSessionBody,
} from "@excelmanus/protocol";
import { buildLayout, type DocumentService } from "@excelmanus/workbook";
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
  type ResolveDeps,
  resolveProfileModel,
  setDefaultProfile,
  sha256,
  updateProfile,
} from "./store.ts";

const APP_VERSION = "0.0.0";
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

export interface AppDeps {
  renderDocument?(layout: RenderLayout): Promise<string>;
  validateResponses?: boolean;
  db: DatabaseSync;
  masterKey: Buffer;
  bus: SyncBus;
  log: SessionLog;
  runtime: AgentRuntime;
  approvals: ApprovalCoordinator;
  /** 代理团队协调（05 §11 用户控制入口）。 */
  team: TeamCoordinator;
  gateway: ModelGateway;
  /** 解析档案的外部依赖（订阅令牌、代理 fetch、目录）；测试连接与运行时共用（09 §4、§7）。 */
  resolveDeps?: ResolveDeps;
  tickets: Map<string, number>;
  ticketTtlMs: number;
  /** 当前本机设备令牌，仅用于在同源登录请求中签发 HttpOnly Cookie。 */
  token: string;
  defaultWorkspaceId: string;
  moduleIds: string[];
  /** workbook 模块提供；未装配时 docs/files 路由返回 501。 */
  docService?: DocumentService;
  /** 前端产物目录（packages/web/dist）；设置后非 /api 的 GET 走静态托管 + SPA 回退。 */
  webDist?: string;
  emit: (event: string, fields: Record<string, string | number | boolean>) => void;
  allowedHosts(): Set<string>;
  allowedOrigins(): Set<string>;
  /** 部署形态（bootstrap.shape）。 */
  shape?: string;
  /** 附件内容寻址存储（10 §2 blobs）。 */
  blobs?: BlobStore;
  /** 本机数据目录（只回给已鉴权的本机客户端）。 */
  dataDir?: string;
  /** M5 扩展端点（规则/记忆/技能/MCP/账号/设置等），挂在鉴权之后。 */
  extensions?(fail: FailFn): Hono;
  defaultDispatchMode?(): "steer" | "interrupt" | "queue";
  /** 新会话冻结系统提示词所需的环境（技能索引、规则）与默认权限模式。 */
  sessionEnv?(workspaceRoot: string): {
    skills: { name: string; description: string }[];
    rules: string[];
    hashes: Record<string, string>;
    defaultPermissionMode: "confirm" | "standard" | "auto";
  };
  /**
   * 受理用户消息前：追加环境变化说明，选出相关记忆，解析 /<技能名>。
   * 返回 error 时拒绝（如技能不存在）。
   */
  prepareMessage?(input: {
    sessionId: string;
    agentId: string;
    workspaceId: string;
    workspaceRoot: string;
    text: string;
  }):
    | {
        text: string;
        memories?: { id: string; category: string; content: string }[];
        skill?: { name: string; body: string };
      }
    | { error: string };
  /** 会话删除后的附带清理（会话规则）。 */
  onSessionDeleted?(sessionId: string): void;
}

export type FailFn = (
  c: Context,
  status: 400 | 401 | 403 | 404 | 409 | 413 | 500 | 501 | 502,
  code: string,
  message: string,
  details?: unknown,
) => Response;

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

  const redactValue = (value: unknown): unknown => {
    if (typeof value === "string") return redactSecrets(value);
    if (Array.isArray(value)) return value.map(redactValue);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [
          redactSecrets(k),
          redactValue(v),
        ]),
      );
    }
    return value;
  };

  const fail = (
    c: Context,
    status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 500 | 501 | 502,
    code: string,
    message: string,
    details?: unknown,
  ) =>
    c.json(
      {
        error: {
          code,
          message: redactSecrets(message),
          ...(details !== undefined ? { details: redactValue(details) } : {}),
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

  // 桌面版（13 §1.1）：前端来自 app://excelmanus，跨源访问 127.0.0.1 后端。
  // 只对白名单中的非 http 源回 CORS 头；预检不需要令牌。
  const corsOrigin = (origin: string | undefined) =>
    origin !== undefined && !origin.startsWith("http") && deps.allowedOrigins().has(origin)
      ? origin
      : undefined;
  app.use("*", async (c, next) => {
    const origin = corsOrigin(c.req.header("origin"));
    if (origin !== undefined) {
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Vary", "Origin");
      if (c.req.method === "OPTIONS") {
        c.header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
        c.header(
          "Access-Control-Allow-Headers",
          "authorization, content-type, x-request-id, idempotency-key",
        );
        c.header("Access-Control-Max-Age", "600");
        return c.body(null, 204);
      }
    }
    await next();
  });

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
    // 浏览器首次打开时通过同源 POST 建立 HttpOnly 会话；其他 API 仍要求令牌。
    const browserSessionRoute =
      c.req.path === "/api/v1/auth/session" || c.req.path === "/api/v1/auth/logout";
    if (c.req.path.startsWith("/api/") && c.req.path !== "/api/v1/health" && !browserSessionRoute) {
      const auth = c.req.header("authorization") ?? "";
      const cookie = c.req.header("cookie") ?? "";
      const cookieToken = /(?:^|;\s*)excelmanus_session=([^;]+)/.exec(cookie)?.[1] ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : cookieToken;
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

  // ---------- 幂等（11 §2：创建类请求接受 Idempotency-Key；P1-40） ----------
  // 进程内保存 24 小时；同一键 + 同一请求体重放首次的成功响应，同一键不同请求体返回 409；
  // 首次未成功（非 2xx）不缓存，允许用同一键重试。
  const IDEMPOTENT_CREATE =
    /^\/api\/v1\/(sessions|model-profiles|rules|memories|mcp-servers|workspaces)$/;
  const IDEMPOTENCY_TTL_MS = 24 * 3600_000;
  const MAX_IDEMPOTENCY_ENTRIES = 1000;
  type IdemResult = { status: number; body: string; contentType: string } | undefined;
  const idempotency = new Map<
    string,
    { bodyHash: string; at: number; done: Promise<IdemResult> }
  >();
  app.use("/api/v1/*", async (c, next) => {
    const key = c.req.header("idempotency-key");
    if (c.req.method !== "POST" || key === undefined || !IDEMPOTENT_CREATE.test(c.req.path)) {
      return next();
    }
    if (key === "" || key.length > 200) {
      return fail(c, 400, "bad_request", "Idempotency-Key 长度应为 1–200");
    }
    const bodyHash = sha256(await c.req.raw.clone().text());
    const now = Date.now();
    for (const [k, v] of idempotency) {
      if (now - v.at > IDEMPOTENCY_TTL_MS || idempotency.size > MAX_IDEMPOTENCY_ENTRIES) {
        idempotency.delete(k);
      } else break;
    }
    const slot = `${c.req.path}\n${key}`;
    const hit = idempotency.get(slot);
    if (hit) {
      if (hit.bodyHash !== bodyHash) {
        return fail(c, 409, "conflict", "Idempotency-Key 已用于内容不同的请求");
      }
      const prev = await hit.done;
      if (prev) {
        return new Response(prev.body, {
          status: prev.status,
          headers: { "content-type": prev.contentType, "idempotent-replayed": "true" },
        });
      }
    }
    let settle: (r: IdemResult) => void = () => {};
    idempotency.set(slot, {
      bodyHash,
      at: now,
      done: new Promise<IdemResult>((r) => {
        settle = r;
      }),
    });
    try {
      await next();
    } finally {
      const res = c.res;
      if (res.status >= 200 && res.status < 300) {
        settle({
          status: res.status,
          body: await res.clone().text(),
          contentType: res.headers.get("content-type") ?? "application/json",
        });
      } else {
        idempotency.delete(slot);
        settle(undefined);
      }
    }
  });

  if (deps.validateResponses) {
    app.use("/api/v1/*", async (c, next) => {
      await next();
      if (
        c.res.status < 200 ||
        c.res.status >= 300 ||
        !c.res.headers.get("content-type")?.includes("application/json")
      )
        return;
      const contract = findHttpContract(c.req.method, c.req.path.slice("/api/v1".length));
      if (!contract) return;
      const body: unknown = await c.res.clone().json();
      if (!contract.response.safeParse(body).success) {
        emit("http.contract_invalid", { method: c.req.method, route: contract.path });
        c.res = fail(c, 500, "internal", "响应不符合接口契约");
      }
    });
  }

  // ---------- 基础 ----------

  app.get("/api/v1/health", (c) => c.json({ ok: true, protocolVersion, version: APP_VERSION }));

  // 本机 Web 登录：令牌只在服务端启动时生成，浏览器通过受 Origin/Host 保护的同源请求
  // 换成 HttpOnly Cookie；令牌不会进入 URL、localStorage、前端状态或日志。
  app.post("/api/v1/auth/session", (c) => {
    const origin = c.req.header("origin");
    if (origin === undefined || !deps.allowedOrigins().has(origin)) {
      return fail(c, 403, "forbidden_origin", "登录请求来源不被允许");
    }
    const auth = c.req.header("authorization") ?? "";
    const current = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const device = current
      ? db
          .prepare("SELECT id FROM devices WHERE token_hash = ? AND revoked_at IS NULL")
          .get(sha256(current))
      : undefined;
    if (current !== "" && !device) return fail(c, 401, "unauthorized", "设备会话已失效");
    c.header(
      "Set-Cookie",
      `excelmanus_session=${deps.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800`,
    );
    return c.json({
      authenticated: true,
      expiresAt: new Date(Date.now() + 8 * 3600_000).toISOString(),
    });
  });

  app.post("/api/v1/auth/logout", (c) => {
    c.header("Set-Cookie", "excelmanus_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
    return c.json({ ok: true });
  });

  const openApi = createOpenApiDocument(APP_VERSION);
  app.get("/api/docs", (c) => c.json(openApi));

  app.get("/api/v1/bootstrap", (c) => {
    const hasModelProfile =
      (db.prepare("SELECT COUNT(*) AS c FROM model_profiles").get() as { c: number }).c > 0;
    return c.json({
      protocolVersion,
      appVersion: APP_VERSION,
      shape: deps.shape ?? "local-web",
      hasModelProfile,
      modules: deps.moduleIds,
      ...(deps.dataDir !== undefined ? { dataDir: deps.dataDir } : {}),
      features: {
        subscriptionLogin: deps.extensions !== undefined,
        skills: deps.extensions !== undefined,
        memory: deps.extensions !== undefined,
        mcp: deps.extensions !== undefined,
      },
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
    const resolved = resolveProfileModel(db, deps.masterKey, c.req.param("id"), deps.resolveDeps);
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
    const query = parse(SessionListQuery, c.req.query());
    if ("issues" in query) return fail(c, 400, "bad_request", "查询参数不合法", query.issues);
    const limit = query.limit ?? 50;
    const cursor = query.cursor;
    // 11 §4 会话列表搜索：按标题子串匹配（不区分大小写，% _ 按字面匹配）
    const q = query.q?.trim() ?? "";
    const like = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    const search = `${q === "" ? "" : "AND COALESCE(title, '') LIKE ? ESCAPE '\\'"} ${query.workspaceId === undefined ? "" : "AND workspace_id = ?"}`;
    const searchArgs = [
      ...(q === "" ? [] : [like]),
      ...(query.workspaceId === undefined ? [] : [query.workspaceId]),
    ];
    let rows: SessionRowLike[];
    if (cursor !== undefined) {
      const sep = cursor.indexOf("~");
      const u = cursor.slice(0, sep);
      const id = cursor.slice(sep + 1);
      rows = db
        .prepare(
          `SELECT * FROM sessions WHERE (updated_at < ? OR (updated_at = ? AND id < ?)) ${search}
           ORDER BY updated_at DESC, id DESC LIMIT ?`,
        )
        .all(u, u, id, ...searchArgs, limit + 1) as unknown as SessionRowLike[];
    } else {
      rows = db
        .prepare(
          `SELECT * FROM sessions WHERE 1 = 1 ${search} ORDER BY updated_at DESC, id DESC LIMIT ?`,
        )
        .all(...searchArgs, limit + 1) as unknown as SessionRowLike[];
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
    if (body.reuseBlank) {
      if (
        body.title !== undefined ||
        body.permissionMode !== undefined ||
        body.modelProfileId !== undefined
      )
        return fail(c, 400, "bad_request", "复用空白会话时不能指定标题、权限或模型档案");
      const blank = db
        .prepare(`
        SELECT s.* FROM sessions s
        WHERE s.workspace_id = ? AND (s.title IS NULL OR s.title = '')
          AND NOT EXISTS (
            SELECT 1 FROM session_log l WHERE l.session_id = s.id
            AND l.type NOT IN ('session.created', 'agent.spawned')
          )
          AND (SELECT COUNT(*) FROM agents a WHERE a.session_id = s.id) = 1
          AND EXISTS (SELECT 1 FROM agents a WHERE a.session_id = s.id AND a.id = 'main' AND a.status = 'idle')
        ORDER BY s.updated_at DESC, s.id DESC LIMIT 1
      `)
        .get(ws.id) as SessionRowLike | undefined;
      if (blank)
        return c.json({
          session: sessionDto(blank),
          agents: listAgents(db, blank.id).map(agentDto),
        });
    }
    const sessionId = newId("ses");
    const env = deps.sessionEnv?.(ws.path);
    const permissionMode = body.permissionMode ?? env?.defaultPermissionMode ?? "standard";
    if (body.modelProfileId !== undefined && !getProfile(db, deps.masterKey, body.modelProfileId)) {
      return fail(c, 400, "bad_request", "模型档案不存在");
    }
    const modelProfileId = body.modelProfileId ?? defaultProfileId(db);
    const systemPrompt = buildSystemPrompt({
      workspaceName: ws.name,
      permissionMode,
      date: nowIso().slice(0, 10),
      ...(env ? { skills: env.skills, rules: env.rules } : {}),
    });
    deps.log.append(sessionId, null, [
      {
        type: "session.created",
        data: {
          workspaceId: ws.id,
          title: body.title ?? null,
          permissionMode,
          ...(env ? { envHashes: env.hashes } : {}),
        },
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
    const pending = db
      .prepare(
        `SELECT id, kind, agent_id, tool_call_id, created_at FROM pending_interactions
         WHERE session_id = ? AND status = 'pending' ORDER BY created_at, id`,
      )
      .all(row.id) as {
      id: string;
      kind: "approval" | "question";
      agent_id: string;
      tool_call_id: string | null;
      created_at: string;
    }[];
    return c.json({
      session: sessionDto(row),
      agents: listAgents(db, row.id).map(agentDto),
      headSeq: row.last_seq,
      // 11 §4：待处理交互（P1-40）
      pendingInteractions: pending.map((p) => ({
        id: p.id,
        kind: p.kind,
        agentId: p.agent_id,
        toolCallId: p.tool_call_id,
        createdAt: p.created_at,
      })),
    });
  });

  // 11 §4 会话导出 Markdown（P1-40）：用户消息、代理回复、工具调用摘要与失败原因；
  // 不含思考内容与工具参数/结果正文。
  app.get("/api/v1/sessions/:id/export", (c) => {
    const row = getSession(db, c.req.param("id"));
    if (!row) return fail(c, 404, "not_found", "会话不存在");
    const names = new Map(listAgents(db, row.id).map((a) => [a.id, a.name ?? a.id]));
    const title = row.title ?? "未命名会话";
    const lines: string[] = [`# ${title}`, "", `导出时间：${nowIso()}`, ""];
    for (let after = 0; ; ) {
      const batch = deps.log.readAfter(row.id, after, 500);
      if (batch.length === 0) break;
      for (const rec of batch) {
        const d = rec.data as Record<string, unknown>;
        const who = names.get(rec.agentId ?? "") ?? rec.agentId ?? "";
        if (rec.type === "user.message" && typeof d.text === "string") {
          lines.push(`## 用户 → ${who}`, "", d.text, "");
        } else if (rec.type === "model.output" && typeof d.text === "string" && d.text !== "") {
          lines.push(`## ${who}`, "", d.text, "");
        } else if (rec.type === "tool.result") {
          lines.push(`> 工具 \`${String(d.toolName)}\`：${String(d.status)}`, "");
        } else if (rec.type === "turn.failed") {
          const err = d.error as { message?: string } | undefined;
          // 修复前落库的失败原因可能含明文凭据（P0-12），导出时再按格式正则兜底
          lines.push(`> 本轮失败：${redactSecrets(err?.message ?? "")}`, "");
        }
      }
      after = batch[batch.length - 1]?.seq ?? after;
    }
    const filename = `${title.replace(/[\\/:*?"<>|\r\n]/g, "_").slice(0, 80)}.md`;
    return new Response(lines.join("\n"), {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="session.md"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      },
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

  app.delete("/api/v1/sessions/:id", async (c) => {
    const row = getSession(db, c.req.param("id"));
    if (!row) return fail(c, 404, "not_found", "会话不存在");
    // 05 §11：先停止全部代理并等待 actor 收尾，再在同一事务删除日志与全部投影。
    const { stillRunning } = await deps.runtime.closeSession(row.id);
    if (stillRunning.length > 0) {
      deps.emit("session.close_timeout", { sessionId: row.id, agentIds: stillRunning.join(",") });
    }
    deleteSessionData(deps.log, row.id);
    deps.onSessionDeleted?.(row.id);
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
    const query = SessionLogQuery.safeParse(c.req.query());
    if (!query.success) return fail(c, 400, "bad_request", "日志分页参数无效");
    return c.json({ items: deps.log.readBefore(row.id, query.data.before, query.data.limit) });
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
    const mode = body.mode ?? deps.defaultDispatchMode?.() ?? "steer";

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

    // 同幂等键不因当前默认策略变化而改变已受理结果。
    const deduplicate = () => {
      const existing = db
        .prepare(
          "SELECT d.*, m.data AS msg FROM dispatches d LEFT JOIN session_log m ON m.session_id = d.session_id AND m.type = 'user.message' AND json_extract(m.data, '$.dispatchId') = d.id WHERE d.session_id = ? AND d.agent_id = ? AND d.client_message_id = ?",
        )
        .get(sessionId, agentId, body.clientMessageId) as
        | { id: string; status: string; mode: string; msg: string | null }
        | undefined;
      if (existing) {
        const old = existing.msg
          ? (JSON.parse(existing.msg) as {
              text?: string;
              context?: unknown;
              mode?: string;
              replacesDispatchId?: string;
            })
          : undefined;
        if (
          old?.text !== body.text ||
          JSON.stringify(old.context ?? []) !== JSON.stringify(body.context ?? []) ||
          JSON.stringify((old as { attachments?: unknown }).attachments ?? []) !==
            JSON.stringify(body.attachments ?? []) ||
          (body.mode !== undefined && (old.mode ?? "steer") !== mode) ||
          old.replacesDispatchId !== body.replacesDispatchId
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

      return undefined;
    };
    const previous = deduplicate();
    if (previous) return previous;

    // 04 §4：附件在受理前校验已上传
    for (const a of body.attachments ?? []) {
      if (!deps.blobs?.has(a.sha256)) return fail(c, 400, "bad_request", "附件不存在，请重新上传");
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

    const committedDuringValidation = deduplicate();
    if (committedDuringValidation) return committedDuringValidation;

    let prepared: {
      text: string;
      memories?: { id: string; category: string; content: string }[];
      skill?: { name: string; body: string };
    } = { text: body.text };
    if (deps.prepareMessage) {
      const workspace = getWorkspace(db, row.workspace_id);
      const out = deps.prepareMessage({
        sessionId,
        agentId,
        workspaceId: row.workspace_id,
        workspaceRoot: workspace?.path ?? "",
        text: body.text,
      });
      if ("error" in out) return fail(c, 400, "bad_request", out.error);
      prepared = out;
    }

    // 最后一次 await 之后重新检查，检查与日志事务之间没有异步让出。
    if (body.replacesDispatchId) {
      const replaced = db
        .prepare("SELECT agent_id, status FROM dispatches WHERE id = ? AND session_id = ?")
        .get(body.replacesDispatchId, sessionId) as
        | { agent_id: string; status: string }
        | undefined;
      if (!replaced || replaced.agent_id !== agentId)
        return fail(c, 404, "not_found", "待处理消息不存在");
      if (replaced.status !== "accepted" && replaced.status !== "queued") {
        return fail(c, 409, "conflict", "消息已生效或已删除，无法替换");
      }
    }
    const dispatchId = newId("dsp");
    const running = deps.runtime.isRunning(sessionId, agentId);
    // 挂起语义：运行中或等待审批/回答期间受理的消息都先记 queued（04 §4.1/§4.2）
    const initialStatus = running || blockedIdle ? "queued" : "accepted";
    deps.log.append(sessionId, agentId, [
      ...(body.replacesDispatchId
        ? [
            {
              type: "dispatch.updated" as const,
              data: { dispatchId: body.replacesDispatchId, status: "cancelled" as const },
            },
          ]
        : []),
      {
        type: "user.message",
        data: {
          dispatchId,
          clientMessageId: body.clientMessageId,
          ...(body.replacesDispatchId ? { replacesDispatchId: body.replacesDispatchId } : {}),
          text: body.text,
          mode,
          ...(body.context !== undefined ? { context: body.context } : {}),
          ...(body.attachments !== undefined && body.attachments.length > 0
            ? { attachments: body.attachments }
            : {}),
          ...(prepared.memories && prepared.memories.length > 0
            ? { memories: prepared.memories }
            : {}),
          ...(prepared.skill ? { skill: prepared.skill } : {}),
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
    if (body.replacesDispatchId)
      deps.runtime.cancelDispatch(sessionId, agentId, body.replacesDispatchId);
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
    // 05 §11"停止全部"：在跑的轮中止、闸门排队的子代理撤出、之后的报告不唤醒代理。
    const stopped = deps.runtime.stopAll(sessionId);
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

  /** 用户控制代理（05 §11、11 §150）：pause/resume/close；main 不能 close，pause 等同 stop。 */
  app.post("/api/v1/sessions/:id/agents/:agentId/control", async (c) => {
    const sessionId = c.req.param("id");
    const agentId = c.req.param("agentId");
    const row = getSession(db, sessionId);
    if (!row) return fail(c, 404, "not_found", "会话不存在");
    const body = parse(ControlBody, await c.req.json().catch(() => null));
    if ("issues" in body) return fail(c, 400, "bad_request", "请求体不合法", body.issues);
    const out = deps.team.controlByUser(sessionId, agentId, body.action);
    if ("error" in out) {
      const code = out.error.error?.code;
      return fail(
        c,
        code === "NOT_FOUND" ? 404 : 409,
        code === "NOT_FOUND" ? "not_found" : "conflict",
        out.error.error?.message ?? "操作失败",
      );
    }
    return c.json({ ok: true, status: out.status });
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
    externalConflict?: boolean;
    rev: number;
    createdAt: string;
  }) => ({
    id: m.id,
    workspaceId: m.workspaceId,
    path: m.path,
    kind: m.kind,
    checkpointRev: m.checkpointRev,
    checkpointError: m.checkpointError,
    ...(m.externalConflict ? { externalConflict: true } : {}),
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

  // 07 §5 外部修改冲突二选一（branch doc-lifecycle 插入）：另一份版本存入备份区并记外部重新加载修订
  app.post("/api/v1/workspaces/:id/docs/:docId/external", async (c) => {
    const svc = deps.docService;
    if (!svc) return fail(c, 501, "not_implemented", "workbook 模块未装配");
    const wsRow = getWorkspace(db, c.req.param("id"));
    if (!wsRow) return fail(c, 404, "not_found", "工作区不存在");
    const docRow = db
      .prepare("SELECT workspace_id FROM documents WHERE id = ?")
      .get(c.req.param("docId")) as { workspace_id: string } | undefined;
    if (!docRow || docRow.workspace_id !== wsRow.id) return fail(c, 404, "not_found", "文档不存在");
    const body = parse(ResolveExternalBody, await c.req.json().catch(() => null));
    if ("issues" in body) return fail(c, 400, "bad_request", "请求体不合法", body.issues);
    try {
      const { meta, backup } = await svc.resolveExternal(
        c.req.param("docId"),
        wsRow.path,
        body.choice,
      );
      return c.json({
        document: docMeta(meta),
        backupId: backup.id,
        backupPath: backup.backupPath,
      });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "VERSION_CONFLICT" || code === "INVALID_ARGUMENT")
        return fail(c, 409, "conflict", (e as Error).message);
      return docErr(c, e);
    }
  });

  app.post("/api/v1/workspaces/:id/docs/:docId/render", async (c) => {
    const svc = deps.docService;
    if (!svc) return fail(c, 501, "not_implemented", "workbook 模块未装配");
    const workspace = getWorkspace(db, c.req.param("id"));
    const docId = c.req.param("docId");
    const row = db.prepare("SELECT workspace_id FROM documents WHERE id = ?").get(docId) as
      | { workspace_id: string }
      | undefined;
    if (!workspace || !row || row.workspace_id !== workspace.id)
      return fail(c, 404, "not_found", "文档不存在");
    const body = RenderDocBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return fail(c, 400, "bad_request", "截图参数无效");
    try {
      const { meta, snapshot } = await svc.snapshot(docId, workspace.path);
      if (body.data.rev !== undefined && body.data.rev !== meta.rev)
        return fail(c, 409, "conflict", "只能渲染当前修订，请重新读取工作簿");
      let sheetName = body.data.sheet;
      try {
        if (body.data.range) sheetName = parseRange(body.data.range).sheet ?? sheetName;
      } catch {
        return fail(c, 400, "bad_request", "截图区域无效");
      }
      const sheet = sheetName
        ? Object.values(snapshot.sheets).find(
            (item) => item.name === sheetName || item.id === sheetName,
          )
        : snapshot.sheets[snapshot.sheetOrder[0] ?? ""];
      if (!sheet) return fail(c, 404, "not_found", "工作表不存在");
      const output = buildLayout(
        snapshot,
        sheet as Parameters<typeof buildLayout>[1],
        body.data.range,
      );
      let png: string;
      try {
        if (!deps.renderDocument) throw new Error("没有可用的渲染端");
        png = await deps.renderDocument(output.layout);
      } catch {
        return fail(c, 502, "bad_gateway", "截图失败：请保持工作台打开并确认渲染端已连接");
      }
      return c.json({
        docId,
        rev: meta.rev,
        range: output.range,
        png,
        limitations: output.limitations,
        size: { width: output.layout.width, height: output.layout.height },
      });
    } catch (error) {
      return docErr(c, error);
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

  // 07 §7.4：修订的"修改前的值"取自 doc_ops.inverse 中的 set-range-values（精确且无需读文件）
  app.get("/api/v1/workspaces/:id/docs/:docId/revs/:rev/before", async (c) => {
    const svc = deps.docService;
    if (!svc) return fail(c, 501, "not_implemented", "workbook 模块未装配");
    const wsRow = getWorkspace(db, c.req.param("id"));
    if (!wsRow) return fail(c, 404, "not_found", "工作区不存在");
    const docId = c.req.param("docId");
    const rev = Number(c.req.param("rev"));
    if (!Number.isInteger(rev) || rev <= 0) return fail(c, 400, "bad_request", "修订号不合法");
    const docRow = db.prepare("SELECT workspace_id FROM documents WHERE id = ?").get(docId) as
      | { workspace_id: string }
      | undefined;
    if (!docRow || docRow.workspace_id !== wsRow.id) return fail(c, 404, "not_found", "文档不存在");
    const op = db
      .prepare("SELECT inverse, write_set FROM doc_ops WHERE doc_id = ? AND rev = ?")
      .get(docId, rev) as { inverse: string | null; write_set: string } | undefined;
    if (!op) return fail(c, 404, "not_found", "修订不存在");
    let sheetNames: Record<string, string> = {};
    try {
      const { snapshot } = await svc.snapshot(docId, wsRow.path);
      const sheets = (snapshot as { sheets?: Record<string, { name?: string }> }).sheets ?? {};
      sheetNames = Object.fromEntries(
        Object.entries(sheets).map(([id, sh]) => [id, sh.name ?? id]),
      );
    } catch (e) {
      return docErr(c, e);
    }
    type Cell = { v?: unknown; f?: unknown } | null | undefined;
    const LIMIT = 500;
    const cells: {
      sheet: string;
      row: number;
      col: number;
      value: string | number | boolean | null;
      formula?: string;
    }[] = [];
    let truncated = false;
    const push = (sheetId: string, r: number, col: number, cell: Cell) => {
      if (cells.length >= LIMIT) {
        truncated = true;
        return;
      }
      const v = cell?.v;
      cells.push({
        sheet: sheetNames[sheetId] ?? sheetId,
        row: r,
        col,
        value: typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : null,
        ...(typeof cell?.f === "string" ? { formula: cell.f } : {}),
      });
    };
    let inv: {
      mutations?: { id?: string; params?: { subUnitId?: string; cellValue?: unknown } }[];
      snapshot?: { sheets?: Record<string, { cellData?: Record<string, Record<string, Cell>> }> };
    } = {};
    try {
      inv = op.inverse ? (JSON.parse(op.inverse) as typeof inv) : {};
    } catch {
      inv = {};
    }
    if (Array.isArray(inv.mutations)) {
      // 数据级逆操作：set-range-values 里就是修改前的单元格（null = 原为空）
      for (const m of inv.mutations) {
        if (m.id !== "sheet.mutation.set-range-values") continue;
        const cv = (m.params?.cellValue ?? {}) as Record<string, Record<string, Cell>>;
        for (const [r, row] of Object.entries(cv))
          for (const [col, cell] of Object.entries(row))
            push(m.params?.subUnitId ?? "", Number(r), Number(col), cell);
      }
    } else if (inv.snapshot?.sheets) {
      // 结构型修订存的是修改前快照：按写集取出对应单元格
      let ranges: { sheetId: string; r0: number; c0: number; r1: number; c1: number }[] = [];
      try {
        ranges = (JSON.parse(op.write_set) as { ranges?: typeof ranges }).ranges ?? [];
      } catch {
        ranges = [];
      }
      for (const rg of ranges) {
        const cd = inv.snapshot.sheets[rg.sheetId]?.cellData ?? {};
        for (let r = rg.r0; r <= rg.r1 && !truncated; r++)
          for (let col = rg.c0; col <= rg.c1 && !truncated; col++)
            push(rg.sheetId, r, col, cd[String(r)]?.[String(col)]);
      }
    }
    return c.json({ docId, rev, cells, truncated });
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

  // ---------- 附件（11 §4 `POST /attachments`）：图片，内容寻址去重 ----------
  const IMAGE_MAGIC: [string, (b: Buffer) => boolean][] = [
    [
      "image/png",
      (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ],
    ["image/jpeg", (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
    ["image/gif", (b) => b.subarray(0, 6).toString("ascii").startsWith("GIF8")],
    [
      "image/webp",
      (b) =>
        b.subarray(0, 4).toString("ascii") === "RIFF" &&
        b.subarray(8, 12).toString("ascii") === "WEBP",
    ],
  ];
  const sniffImage = (b: Buffer) => IMAGE_MAGIC.find(([, ok]) => ok(b))?.[0];
  const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

  app.post("/api/v1/attachments", async (c) => {
    const blobs = deps.blobs;
    if (!blobs) return fail(c, 501, "not_implemented", "附件存储未装配");
    const body = await c.req.parseBody().catch(() => null);
    const file = body?.file;
    if (!(file instanceof File)) return fail(c, 400, "bad_request", "缺少 file 字段");
    if (file.size > MAX_ATTACHMENT_BYTES) {
      return fail(c, 413, "payload_too_large", "图片超过 10MB 上限");
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    // 按内容判定类型，不信任客户端声明（防止把其他内容伪装成图片）
    const mediaType = sniffImage(bytes);
    if (!mediaType)
      return fail(c, 415, "unsupported_media_type", "只支持 PNG、JPEG、GIF、WebP 图片");
    const sha256 = blobs.put(bytes);
    return c.json(
      {
        attachment: {
          sha256,
          mediaType,
          name: basename(file.name || "image").slice(0, 255),
          size: bytes.length,
        },
      },
      201,
    );
  });

  app.get("/api/v1/attachments/:sha", (c) => {
    const bytes = deps.blobs?.get(c.req.param("sha"));
    if (!bytes) return fail(c, 404, "not_found", "附件不存在");
    const mediaType = sniffImage(bytes);
    if (!mediaType) return fail(c, 404, "not_found", "附件不存在");
    return new Response(bytes, {
      headers: {
        "content-type": mediaType,
        "x-content-type-options": "nosniff",
        "cache-control": "private, max-age=31536000, immutable",
      },
    });
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
  // 11 §4 `GET /files/download?path=`（P1-40）：下载工作区内文件（workbook_export/present 产出）。
  // 与代理文件工具同一路径校验：不出工作区、不跟随外指符号链接、.excelmanus/ 不可见。
  app.get("/api/v1/workspaces/:id/files/download", (c) => {
    const wsRow = getWorkspace(db, c.req.param("id"));
    if (!wsRow) return fail(c, 404, "not_found", "工作区不存在");
    const rel = c.req.query("path") ?? "";
    if (rel === "") return fail(c, 400, "bad_request", "缺少 path");
    try {
      const { abs, rel: safeRel } = resolveWorkspacePath(wsRow.path, rel);
      // 先以 O_NOFOLLOW 打开再 fstat：校验与读取针对同一个文件，避免校验后被换成符号链接
      const fd = openSync(abs, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      const st = fstatSync(fd);
      if (!st.isFile()) {
        closeSync(fd);
        return fail(c, 400, "bad_request", "不是文件");
      }
      const name = basename(safeRel);
      return new Response(Readable.toWeb(createReadStream("", { fd })) as ReadableStream, {
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(st.size),
          "x-content-type-options": "nosniff",
          "content-disposition": `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(name)}`,
        },
      });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return fail(c, 404, "not_found", "文件不存在");
      if (code === "ELOOP") return fail(c, 403, "forbidden", "不跟随符号链接");
      return docErr(c, e);
    }
  });

  if (deps.extensions) app.route("/api/v1", deps.extensions(fail));
  if (deps.validateResponses) {
    // Inspect actual mounted Hono routes, including dynamically mounted extensions.
    const missing = app.routes.filter(
      (route) =>
        route.method !== "ALL" &&
        route.path.startsWith("/api/v1/") &&
        !findHttpContract(route.method, route.path.slice(7)),
    );
    if (missing.length)
      throw new Error(
        `Missing REST contracts: ${missing.map((route) => `${route.method} ${route.path}`).join(", ")}`,
      );
  }

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
