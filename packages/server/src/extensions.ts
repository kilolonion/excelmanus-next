import { decryptSecret } from "./crypto.ts";
import {
  createConnection,
  getConnectionRow,
  openConnectionHeaders,
} from "./provider-connections.ts";
// M5 扩展能力的 REST 端点（11 §4）与会话环境装配（04 §7.2–7.3）：
// 规则、记忆、技能、MCP、订阅账号、设置、能力探测与模型目录、工作区、备份与回收站、设备。
// 所有端点挂在主应用的鉴权中间件之后（/api/v1 前缀、Bearer 设备令牌）。

import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { newId, nowIso } from "@excelmanus/core";
import {
  type BackupService,
  runWithHostNativeAccess,
  runWithHostBackupEntryAccess,
  prepareEffectPlan,
  runWithEffectPlan,
  atomicWrite,
  isInsidePath,
  listProtectedRoots,
  type ModelGateway,
  type SessionLog,
  type SyncBus,
} from "@excelmanus/kernel";
import type { McpService } from "@excelmanus/mcp";
import { McpConfigError } from "@excelmanus/mcp";
import type { MemoryService } from "@excelmanus/memory";
import { listRemoteModels, type ModelCatalog, presetFor, probeModel } from "@excelmanus/models";
import {
  BackupPreviewQuery,
  CreateMcpServerBody,
  CreateMemoryBody,
  CreateRuleBody,
  ImportSkillBody,
  OverrideCapabilitiesBody,
  PollLoginBody,
  RULES_TOTAL_MAX_CHARS,
  StartLoginBody,
  UpdateMcpServerBody,
  UpdateMemoryBody,
  UpdateRuleBody,
  UpdateSettingsBody,
  UpdateSkillBody,
} from "@excelmanus/protocol";
import { RuleLimitError, type RuleService } from "@excelmanus/rules";
import { importSkills, SkillImportError, type SkillService } from "@excelmanus/skills";
import { type Context, Hono } from "hono";
import type { z } from "zod";
import { type AccountService, CallbackUnavailableError } from "./accounts.ts";
import { previewBackup } from "./backup-preview.ts";
import { diagnosticRoutes } from "./diagnostics.ts";
import { fileManagementRoutes } from "./files-manage.ts";
import type { SettingsStore } from "./settings.ts";
import {
  type CapabilityRecord,
  createProfile,
  getProfile,
  getProfileRow,
  getSession,
  getWorkspace,
  profileCapabilities,
  type ResolveDeps,
  resolveProfileModel,
  setProfileCapabilities,
} from "./store.ts";

export interface ExtensionDeps {
  dataDir: string;
  db: DatabaseSync;
  masterKey: Buffer;
  bus: SyncBus;
  log: SessionLog;
  gateway: ModelGateway;
  rules: RuleService;
  memory: MemoryService;
  skills: SkillService;
  mcp: McpService;
  accounts: AccountService;
  settings: SettingsStore;
  catalog: ModelCatalog;
  backups: BackupService;
  resolveDeps: ResolveDeps;
  /** 内置示例工作簿目录（首次引导，02 §8）。 */
  samplesDir: string;
  /** 用备份替换工作区文件：已登记的活文档经文档 actor 编排（先检查点，替换后记外部重新加载修订）。 */
  replaceDocumentFile?<T>(
    workspaceId: string,
    workspaceRoot: string,
    path: string,
    replace: () => T,
  ): Promise<T>;
  coordinateFileMoves?: Parameters<typeof fileManagementRoutes>[4];
  emit: (event: string, fields: Record<string, string | number | boolean>) => void;
}

type Fail = (
  c: Context,
  status: 400 | 401 | 403 | 404 | 409 | 413 | 500 | 501 | 502,
  code: string,
  message: string,
  details?: unknown,
) => Response;

const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);

// ---------- 会话环境（系统提示词冻结 + 中途变化追加说明） ----------

export interface SessionEnv {
  skills: { name: string; description: string }[];
  rules: string[];
  hashes: { rules: string; skills: string };
}

export function sessionEnv(
  deps: Pick<ExtensionDeps, "rules" | "skills">,
  workspaceRoot: string,
  sessionId?: string,
): SessionEnv {
  const skills = deps.skills.index(workspaceRoot);
  const rules = deps.rules.enabledTexts(sessionId);
  return { skills, rules, hashes: { rules: hash(rules), skills: hash(skills) } };
}

/** 最近一次告知代理的环境指纹（session.created 或 context.notice 中的 hash）。 */
function lastEnvHash(
  db: DatabaseSync,
  sessionId: string,
  kind: "rules" | "skills",
): string | undefined {
  const notice = db
    .prepare(
      "SELECT json_extract(data, '$.hash') AS h FROM session_log WHERE session_id = ? AND type = 'context.notice' AND json_extract(data, '$.kind') = ? ORDER BY seq DESC LIMIT 1",
    )
    .get(sessionId, kind) as { h: string | null } | undefined;
  if (notice?.h) return notice.h;
  const created = db
    .prepare(
      "SELECT json_extract(data, '$.envHashes') AS h FROM session_log WHERE session_id = ? AND type = 'session.created' LIMIT 1",
    )
    .get(sessionId) as { h: string | null } | undefined;
  if (!created?.h) return undefined;
  return (JSON.parse(created.h) as Record<string, string>)[kind];
}

/**
 * 下一条用户消息前调用：规则或技能状态与上次告知的不同时，追加 context.notice
 * （04 §7.3：不重写冻结的系统提示词）。
 */
export function appendEnvNotices(
  deps: Pick<ExtensionDeps, "rules" | "skills" | "log" | "db">,
  sessionId: string,
  workspaceRoot: string,
): void {
  const env = sessionEnv(deps, workspaceRoot, sessionId);
  const records: { type: string; data: unknown }[] = [];
  if (lastEnvHash(deps.db, sessionId, "rules") !== env.hashes.rules) {
    records.push({
      type: "context.notice",
      data: {
        kind: "rules",
        hash: env.hashes.rules,
        text:
          env.rules.length > 0
            ? `用户规则已更新，此后以下列规则为准（替代之前的规则）：\n${env.rules.map((r) => `- ${r}`).join("\n")}`
            : "用户已清空全部规则，此前的用户规则不再适用。",
      },
    });
  }
  if (lastEnvHash(deps.db, sessionId, "skills") !== env.hashes.skills) {
    records.push({
      type: "context.notice",
      data: {
        kind: "skills",
        hash: env.hashes.skills,
        text:
          env.skills.length > 0
            ? `可用技能已更新，此后以下列技能为准：\n${env.skills.map((s) => `- ${s.name}：${s.description}`).join("\n")}`
            : "当前没有可用技能。",
      },
    });
  }
  if (records.length > 0) deps.log.append(sessionId, null, records);
}

/** 本会话已注入过的记忆 id（从日志推导，重建一致）。 */
export function injectedMemoryIds(db: DatabaseSync, sessionId: string): Set<string> {
  const rows = db
    .prepare(
      "SELECT json_extract(data, '$.memories') AS m FROM session_log WHERE session_id = ? AND type = 'user.message' AND json_extract(data, '$.memories') IS NOT NULL",
    )
    .all(sessionId) as { m: string }[];
  const out = new Set<string>();
  for (const r of rows) for (const m of JSON.parse(r.m) as { id: string }[]) out.add(m.id);
  return out;
}

// ---------- 能力判定（09 §6：运行时据此裁剪） ----------

const CAP_KEYS = ["connectivity", "tools", "vision", "reasoning"] as const;

export function effectiveCapabilities(
  db: DatabaseSync,
  catalog: ModelCatalog,
  profileId: string,
): Record<(typeof CAP_KEYS)[number], CapabilityRecord> {
  const row = getProfileRow(db, profileId);
  const stored = row ? profileCapabilities(row) : {};
  const entry = row ? catalog.lookup(row.provider, row.model) : undefined;
  const fromCatalog = (v: boolean | undefined): CapabilityRecord =>
    v === undefined
      ? { value: null, source: null, checkedAt: null }
      : { value: v, source: "catalog", checkedAt: null };
  const base: Record<string, CapabilityRecord> = {
    connectivity: { value: null, source: null, checkedAt: null },
    tools: fromCatalog(entry?.tools),
    vision: fromCatalog(entry?.vision),
    reasoning: fromCatalog(entry?.reasoning),
  };
  // 优先级：manual > probe > catalog
  for (const k of CAP_KEYS) {
    const s = stored[k];
    const m = stored[`${k}:manual`];
    if (m && m.value !== null) base[k] = m;
    // 09 §1"未知就是未知"：探测未得出结论（value=null）不覆盖目录证据（P1-44 最小插入）
    else if (s && (s.value !== null || base[k]?.value === null)) base[k] = s;
  }
  return base as Record<(typeof CAP_KEYS)[number], CapabilityRecord>;
}

// ---------- 路由 ----------

export function extensionRoutes(deps: ExtensionDeps, fail: Fail): Hono {
  const app = new Hono();
  app.route("/", diagnosticRoutes(deps.db, fail, deps.dataDir));
  app.route(
    "/",
    fileManagementRoutes(deps.db, deps.backups, deps.bus, fail, deps.coordinateFileMoves),
  );
  const { db } = deps;
  const parse = <S extends z.ZodType<unknown>>(
    schema: S,
    data: unknown,
  ): z.infer<S> | { issues: unknown } => {
    const r = schema.safeParse(data);
    return r.success ? (r.data as z.infer<S>) : { issues: r.error.issues };
  };
  const body = async (c: Context) => c.req.json().catch(() => null);
  const appEvent = (type: string, extra: Record<string, unknown> = {}) =>
    deps.bus.publish({ kind: "app", data: { type, ...extra } });
  const defaultRoot = (): string =>
    (
      db.prepare("SELECT path FROM workspaces ORDER BY is_default DESC, sort LIMIT 1").get() as
        | { path: string }
        | undefined
    )?.path ?? "";
  const rootFor = (workspaceId?: string): string =>
    (workspaceId ? getWorkspace(db, workspaceId)?.path : undefined) ?? defaultRoot();

  // ----- 设置 -----
  app.get("/settings", (c) => c.json({ settings: deps.settings.get(), restartRequired: [] }));
  app.patch("/settings", async (c) => {
    const b = parse(UpdateSettingsBody, await body(c));
    if ("issues" in b) return fail(c, 400, "bad_request", "请求体不合法", b.issues);
    if (b.httpProxy) {
      try {
        const u = new URL(b.httpProxy);
        if (!["http:", "https:"].includes(u.protocol)) throw new Error();
      } catch {
        return fail(c, 400, "bad_request", "代理地址应为 http(s)://主机:端口");
      }
    }
    for (const k of ["subAgentProfileId", "compactionProfileId"] as const) {
      const v = b[k];
      if (v && !getProfileRow(db, v)) return fail(c, 400, "bad_request", "指定的模型档案不存在");
    }
    const out = deps.settings.patch(b);
    appEvent("settings.changed");
    return c.json(out);
  });

  // ----- 规则 -----
  const ruleList = (sessionId?: string) => ({
    items: sessionId ? deps.rules.list(sessionId) : deps.rules.list(),
    totalChars: deps.rules.totalChars(sessionId),
    maxTotalChars: RULES_TOTAL_MAX_CHARS,
  });
  app.get("/rules", (c) => c.json(ruleList(c.req.query("sessionId") || undefined)));
  app.post("/rules", async (c) => {
    const b = parse(CreateRuleBody, await body(c));
    if ("issues" in b) return fail(c, 400, "bad_request", "请求体不合法", b.issues);
    const scope = b.scope ?? (b.sessionId ? "session" : "global");
    if (scope === "session" && (!b.sessionId || !getSession(db, b.sessionId)))
      return fail(c, 400, "bad_request", "会话不存在");
    try {
      const rule = deps.rules.create({
        scope,
        sessionId: b.sessionId,
        content: b.content,
        enabled: b.enabled,
      });
      appEvent("rules.changed");
      return c.json({ rule }, 201);
    } catch (e) {
      if (e instanceof RuleLimitError) return fail(c, 400, "bad_request", e.message);
      throw e;
    }
  });
  app.patch("/rules/:id", async (c) => {
    const b = parse(UpdateRuleBody, await body(c));
    if ("issues" in b) return fail(c, 400, "bad_request", "请求体不合法", b.issues);
    try {
      const rule = deps.rules.update(c.req.param("id"), b);
      if (!rule) return fail(c, 404, "not_found", "规则不存在");
      appEvent("rules.changed");
      return c.json({ rule });
    } catch (e) {
      if (e instanceof RuleLimitError) return fail(c, 400, "bad_request", e.message);
      throw e;
    }
  });
  app.delete("/rules/:id", (c) => {
    if (!deps.rules.delete(c.req.param("id"))) return fail(c, 404, "not_found", "规则不存在");
    appEvent("rules.changed");
    return c.json({ ok: true });
  });

  // ----- 记忆 -----
  app.get("/memories", (c) =>
    c.json({
      items: deps.memory.list({
        query: c.req.query("q") || undefined,
        workspaceId: c.req.query("workspaceId") || undefined,
      }),
    }),
  );
  app.post("/memories", async (c) => {
    const b = parse(CreateMemoryBody, await body(c));
    if ("issues" in b) return fail(c, 400, "bad_request", "请求体不合法", b.issues);
    if (b.workspaceId && !getWorkspace(db, b.workspaceId))
      return fail(c, 400, "bad_request", "工作区不存在");
    const memory = deps.memory.create({
      content: b.content,
      category: b.category,
      workspaceId: b.workspaceId ?? null,
    });
    return c.json({ memory }, 201);
  });
  app.patch("/memories/:id", async (c) => {
    const b = parse(UpdateMemoryBody, await body(c));
    if ("issues" in b) return fail(c, 400, "bad_request", "请求体不合法", b.issues);
    const memory = deps.memory.update(c.req.param("id"), b);
    if (!memory) return fail(c, 404, "not_found", "记忆不存在");
    return c.json({ memory });
  });
  app.delete("/memories/:id", (c) => {
    if (!deps.memory.delete(c.req.param("id"))) return fail(c, 404, "not_found", "记忆不存在");
    appEvent("memories.changed");
    return c.json({ ok: true });
  });

  // ----- 技能 -----
  app.get("/skills", (c) =>
    c.json({ items: deps.skills.list(rootFor(c.req.query("workspaceId"))) }),
  );
  app.get("/skills/:name", (c) => {
    const skill = deps.skills.detail(c.req.param("name"), rootFor(c.req.query("workspaceId")));
    if (!skill) return fail(c, 404, "not_found", "技能不存在");
    return c.json({ skill });
  });
  app.patch("/skills/:name", async (c) => {
    const b = parse(UpdateSkillBody, await body(c));
    if ("issues" in b) return fail(c, 400, "bad_request", "请求体不合法", b.issues);
    const root = rootFor(c.req.query("workspaceId"));
    const skill = deps.skills.setEnabled(c.req.param("name"), b.enabled, root);
    if (!skill) return fail(c, 404, "not_found", "技能不存在");
    appEvent("skills.changed");
    return c.json({ skill });
  });
  app.post("/skills/import", async (c) => {
    const b = parse(ImportSkillBody, await body(c));
    if ("issues" in b) return fail(c, 400, "bad_request", "请求体不合法", b.issues);
    if (!/^https?:\/\//.test(b.source) && !isAbsolute(b.source))
      return fail(c, 400, "bad_request", "本地目录请填写绝对路径");
    try {
      const skills = await importSkills({
        source: b.source,
        userDir: deps.skills.userDir,
        preview: b.preview ?? false,
        fetchImpl: deps.settings.fetch(),
      });
      const known = new Set(deps.skills.list(defaultRoot()).map((s) => s.name));
      if (!b.preview) appEvent("skills.changed");
      return c.json({
        imported: !b.preview,
        skills: skills.map((s) => {
          const listed = deps.skills.detail(s.name, defaultRoot());
          const missing = deps.skills.missingTools(
            s,
            [...s.files.entries()]
              .filter(([name]) => name !== "SKILL.md" && name.endsWith(".md"))
              .map(([, bytes]) => new TextDecoder().decode(bytes)),
          );
          return (
            (!b.preview && listed) || {
              name: s.name,
              description: s.description,
              source: "user" as const,
              enabled: true,
              available: missing.length === 0,
              missingTools: missing,
              userInvocable: s.userInvocable,
              modelInvocable: s.modelInvocable,
              version: s.version,
              overrides: known.has(s.name) ? (["builtin"] as const).slice() : [],
              body: s.body,
              resources: [...s.files.keys()].filter((f) => f !== "SKILL.md").sort(),
            }
          );
        }),
      });
    } catch (e) {
      if (e instanceof SkillImportError) return fail(c, 400, "bad_request", e.message);
      return fail(c, 502, "bad_gateway", `导入失败：${e instanceof Error ? e.message : String(e)}`);
    }
  });
  app.delete("/skills/:name", (c) => {
    if (!deps.skills.deleteUserSkill(c.req.param("name")))
      return fail(c, 404, "not_found", "只能删除用户导入的技能");
    appEvent("skills.changed");
    return c.json({ ok: true });
  });

  // ----- MCP -----
  const mcpErr = (c: Context, e: unknown) => {
    if (e instanceof McpConfigError) return fail(c, 400, "bad_request", e.message);
    throw e;
  };
  app.get("/mcp-servers", (c) => c.json({ items: deps.mcp.list() }));
  app.post("/mcp-servers", async (c) => {
    const b = parse(CreateMcpServerBody, await body(c));
    if ("issues" in b) return fail(c, 400, "bad_request", "请求体不合法", b.issues);
    try {
      const server = deps.mcp.create(b);
      deps.emit("mcp.created", { transport: b.transport });
      return c.json({ server }, 201);
    } catch (e) {
      return mcpErr(c, e);
    }
  });
  app.get("/mcp-servers/:id", (c) => {
    const server = deps.mcp.get(c.req.param("id"));
    if (!server) return fail(c, 404, "not_found", "服务器不存在");
    return c.json({ server });
  });
  app.patch("/mcp-servers/:id", async (c) => {
    const b = parse(UpdateMcpServerBody, await body(c));
    if ("issues" in b) return fail(c, 400, "bad_request", "请求体不合法", b.issues);
    try {
      const server = deps.mcp.update(c.req.param("id"), b);
      if (!server) return fail(c, 404, "not_found", "服务器不存在");
      return c.json({ server });
    } catch (e) {
      return mcpErr(c, e);
    }
  });
  app.delete("/mcp-servers/:id", async (c) => {
    if (!(await deps.mcp.delete(c.req.param("id"))))
      return fail(c, 404, "not_found", "服务器不存在");
    return c.json({ ok: true });
  });
  app.post("/mcp-servers/:id/test", async (c) => {
    if (!deps.mcp.get(c.req.param("id"))) return fail(c, 404, "not_found", "服务器不存在");
    return c.json(await deps.mcp.test(c.req.param("id")));
  });
  app.post("/mcp-servers/reload", async (c) => {
    await deps.mcp.reload();
    return c.json({ ok: true });
  });

  // ----- 订阅账号 -----
  app.get("/accounts", (c) => c.json({ items: deps.accounts.list() }));
  app.post("/accounts/:provider/login", async (c) => {
    if (c.req.param("provider") !== "chatgpt")
      return fail(c, 404, "not_found", "不支持的订阅提供商");
    const b = parse(StartLoginBody, await body(c));
    if ("issues" in b) return fail(c, 400, "bad_request", "请求体不合法", b.issues);
    try {
      return c.json({ attempt: await deps.accounts.start(b.method) });
    } catch (e) {
      if (e instanceof CallbackUnavailableError) return fail(c, 409, "conflict", e.message);
      return fail(c, 502, "bad_gateway", e instanceof Error ? e.message : String(e));
    }
  });
  app.post("/accounts/:provider/login/poll", async (c) => {
    const b = parse(PollLoginBody, await body(c));
    if ("issues" in b) return fail(c, 400, "bad_request", "请求体不合法", b.issues);
    try {
      const attempt = await deps.accounts.poll(b.attemptId);
      if (!attempt) return fail(c, 404, "not_found", "登录请求不存在或已过期");
      if (attempt.status === "succeeded") appEvent("accounts.changed");
      return c.json({ attempt });
    } catch (e) {
      return fail(c, 502, "bad_gateway", e instanceof Error ? e.message : String(e));
    }
  });
  app.post("/accounts/:id/refresh", async (c) => {
    if (!deps.accounts.get(c.req.param("id"))) return fail(c, 404, "not_found", "账号不存在");
    try {
      await deps.accounts.refresh(c.req.param("id"));
      return c.json({ account: deps.accounts.get(c.req.param("id")) });
    } catch (e) {
      return fail(c, 502, "bad_gateway", e instanceof Error ? e.message : String(e));
    }
  });
  app.delete("/accounts/:id", (c) => {
    if (!deps.accounts.delete(c.req.param("id"))) return fail(c, 404, "not_found", "账号不存在");
    appEvent("accounts.changed");
    return c.json({ ok: true });
  });

  // ----- 能力探测、远端模型、模型目录 -----
  app.post("/model-profiles/:id/probe", async (c) => {
    const id = c.req.param("id");
    const row = getProfileRow(db, id);
    if (!row) return fail(c, 404, "not_found", "模型档案不存在");
    const resolved = resolveProfileModel(db, deps.masterKey, id, deps.resolveDeps);
    if ("error" in resolved) return fail(c, 400, "bad_request", resolved.error.message);
    appEvent("probe.started", { profileId: id });
    const r = await probeModel(
      deps.gateway,
      resolved,
      presetFor(row.provider)?.adapter ?? "openai-compatible",
    );
    const at = nowIso();
    const caps = profileCapabilities(row);
    for (const k of CAP_KEYS) {
      const item = r[k];
      caps[k] = {
        value: item.value,
        source: item.value === null ? null : "probe",
        checkedAt: at,
        ...(item.detail ? { detail: item.detail } : {}),
      };
    }
    setProfileCapabilities(db, id, caps);
    appEvent("probe.finished", { profileId: id });
    return c.json({ capabilities: effectiveCapabilities(db, deps.catalog, id) });
  });
  app.get("/model-profiles/:id/capabilities", (c) => {
    if (!getProfileRow(db, c.req.param("id"))) return fail(c, 404, "not_found", "模型档案不存在");
    return c.json({ capabilities: effectiveCapabilities(db, deps.catalog, c.req.param("id")) });
  });
  app.patch("/model-profiles/:id/capabilities", async (c) => {
    const id = c.req.param("id");
    const row = getProfileRow(db, id);
    if (!row) return fail(c, 404, "not_found", "模型档案不存在");
    const b = parse(OverrideCapabilitiesBody, await body(c));
    if ("issues" in b) return fail(c, 400, "bad_request", "请求体不合法", b.issues);
    const caps = profileCapabilities(row);
    for (const [k, v] of Object.entries(b)) {
      if (v === undefined) continue;
      if (v === null) delete caps[`${k}:manual`];
      else caps[`${k}:manual`] = { value: v, source: "manual", checkedAt: nowIso() };
    }
    setProfileCapabilities(db, id, caps);
    return c.json({ capabilities: effectiveCapabilities(db, deps.catalog, id) });
  });
  app.get("/provider-connections/:id/models", (c) => {
    const row = getConnectionRow(db, c.req.param("id"));
    if (!row) return fail(c, 404, "not_found", "供应商连接不存在");
    return c.json({
      items: row.models_cache ? JSON.parse(row.models_cache) : [],
      updatedAt: row.models_updated_at,
    });
  });
  app.post("/provider-connections/:id/models", async (c) => {
    const row = getConnectionRow(db, c.req.param("id"));
    if (!row) return fail(c, 404, "not_found", "供应商连接不存在");
    try {
      const credential = row.credential_id
        ? (db
            .prepare("SELECT kind,ciphertext,nonce FROM credentials WHERE id=?")
            .get(row.credential_id) as
            | { kind: string; ciphertext: Uint8Array; nonce: Uint8Array }
            | undefined)
        : undefined;
      const subscription =
        credential?.kind === "oauth" && row.credential_id
          ? deps.resolveDeps.subscription?.(row.credential_id)
          : undefined;
      const apiKey =
        credential && credential.kind !== "oauth"
          ? decryptSecret(
              deps.masterKey,
              Buffer.from(credential.ciphertext),
              Buffer.from(credential.nonce),
            )
          : "";
      const items = await listRemoteModels({
        profileId: "",
        provider: row.provider,
        model: "",
        apiKey,
        ...(row.base_url ? { baseUrl: row.base_url } : {}),
        ...(subscription ? { subscription } : {}),
        extraHeaders: openConnectionHeaders(deps.masterKey, row.extra_headers),
        fetch: deps.resolveDeps.fetch ?? deps.settings.fetch(),
      });
      const updatedAt = nowIso();
      // A refresh started before a connection edit must not repopulate its invalidated cache.
      const updated = db
        .prepare(
          "UPDATE provider_connections SET models_cache=?,models_updated_at=? WHERE id=? AND updated_at=?",
        )
        .run(JSON.stringify(items), updatedAt, row.id, row.updated_at);
      if (!updated.changes) return fail(c, 409, "conflict", "连接已变更，请重新刷新模型列表");
      return c.json({ items, updatedAt });
    } catch (e) {
      return fail(
        c,
        502,
        "bad_gateway",
        `拉取模型列表失败：${e instanceof Error ? e.message : String(e)}`,
      );
    }
  });
  app.post("/model-profiles/:id/models", async (c) => {
    const resolved = resolveProfileModel(db, deps.masterKey, c.req.param("id"), deps.resolveDeps);
    if ("error" in resolved) return fail(c, 400, "bad_request", resolved.error.message);
    try {
      return c.json({ items: await listRemoteModels(resolved) });
    } catch (e) {
      return fail(
        c,
        502,
        "bad_gateway",
        `拉取模型列表失败：${e instanceof Error ? e.message : String(e)}`,
      );
    }
  });
  /** 未保存档案前按表单拉取远端模型列表（11 §4 POST /providers/{id}/models）。 */
  app.post("/providers/:id/models", async (c) => {
    const preset = presetFor(c.req.param("id"));
    if (!preset) return fail(c, 404, "not_found", "未知提供商");
    const b = ((await body(c)) ?? {}) as { apiKey?: string; baseUrl?: string; accountId?: string };
    const sub = b.accountId ? deps.resolveDeps.subscription?.(b.accountId) : undefined;
    try {
      const items = await listRemoteModels({
        profileId: "",
        provider: preset.id,
        model: "",
        apiKey: typeof b.apiKey === "string" ? b.apiKey : "",
        ...(typeof b.baseUrl === "string" && b.baseUrl !== "" ? { baseUrl: b.baseUrl } : {}),
        ...(sub ? { subscription: sub } : {}),
        fetch: deps.settings.fetch(),
      });
      return c.json({ items });
    } catch (e) {
      return fail(
        c,
        502,
        "bad_gateway",
        `拉取模型列表失败：${e instanceof Error ? e.message : String(e)}`,
      );
    }
  });
  app.get("/model-catalog", (c) => c.json(deps.catalog.list(c.req.query("provider") || undefined)));
  app.post("/model-catalog/refresh", async (c) => {
    try {
      await deps.catalog.refresh(deps.settings.fetch());
      return c.json(deps.catalog.list());
    } catch (e) {
      return fail(
        c,
        502,
        "bad_gateway",
        `刷新模型目录失败（不影响使用）：${e instanceof Error ? e.message : String(e)}`,
      );
    }
  });

  // ----- 工作区 -----
  const wsDto = (r: { id: string; name: string; path: string; is_default: number }) => ({
    id: r.id,
    name: r.name,
    path: r.path,
    isDefault: r.is_default === 1,
  });
  // 列表顺序即侧栏顺序：用户拖动排序后按 sort 排，默认工作区不再强制置顶
  const listWorkspacesDto = () =>
    (
      db.prepare("SELECT * FROM workspaces ORDER BY sort, created_at").all() as {
        id: string;
        name: string;
        path: string;
        is_default: number;
      }[]
    ).map(wsDto);
  app.get("/workspaces", (c) => c.json({ items: listWorkspacesDto() }));
  app.put("/workspaces/order", async (c) => {
    const b = ((await body(c)) ?? {}) as { ids?: unknown };
    if (!Array.isArray(b.ids) || b.ids.length === 0 || b.ids.some((id) => typeof id !== "string"))
      return fail(c, 400, "bad_request", "请提供工作区顺序");
    const wanted = [...new Set(b.ids as string[])];
    const known = (
      db.prepare("SELECT id FROM workspaces ORDER BY sort, created_at").all() as { id: string }[]
    ).map((r) => r.id);
    const order = [
      ...wanted.filter((id) => known.includes(id)),
      ...known.filter((id) => !wanted.includes(id)),
    ];
    const update = db.prepare("UPDATE workspaces SET sort = ? WHERE id = ?");
    db.exec("BEGIN");
    try {
      order.forEach((id, index) => {
        update.run(index + 1, id);
      });
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    appEvent("workspaces.changed");
    return c.json({ items: listWorkspacesDto() });
  });
  /** 最近存在祖先取磁盘规范路径（大小写、符号链接归一），其余段原样拼接。 */
  const canonicalDir = (p: string): string => {
    const tail: string[] = [];
    let cur = resolve(p);
    for (;;) {
      try {
        return join(realpathSync.native(cur), ...tail.reverse());
      } catch {
        const parent = dirname(cur);
        if (parent === cur) return resolve(p);
        tail.push(basename(cur));
        cur = parent;
      }
    }
  };
  app.post("/workspaces", async (c) => {
    const b = ((await body(c)) ?? {}) as { path?: unknown; name?: unknown };
    if (typeof b.path !== "string" || !isAbsolute(b.path))
      return fail(c, 400, "bad_request", "请填写文件夹的绝对路径");
    // 先求规范路径再校验重叠，校验通过才创建目录（附录 C：工作区不得包含数据目录或其他工作区）
    const path = canonicalDir(b.path);
    const registered = (
      db.prepare("SELECT name, path FROM workspaces").all() as { name: string; path: string }[]
    ).map((w) => ({ name: w.name, path: canonicalDir(w.path) }));
    if (registered.some((w) => w.path === path)) return fail(c, 409, "conflict", "该文件夹已登记");
    for (const prot of listProtectedRoots()) {
      if (isInsidePath(path, prot))
        return fail(c, 409, "conflict", "工作区不能包含应用数据目录，请选择更具体的文件夹");
      if (isInsidePath(prot, path)) return fail(c, 409, "conflict", "工作区不能位于应用数据目录内");
    }
    const nested = registered.find((w) => isInsidePath(w.path, path) || isInsidePath(path, w.path));
    if (nested)
      return fail(c, 409, "conflict", `与已登记的工作区「${nested.name}」互相包含，不能重复登记`);
    if (!existsSync(path)) mkdirSync(path, { recursive: true });
    if (!statSync(path).isDirectory()) return fail(c, 400, "bad_request", "路径不是文件夹");
    const id = newId("wks");
    const name =
      typeof b.name === "string" && b.name.trim() !== "" ? b.name.trim() : basename(path);
    const sort = (
      db.prepare("SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM workspaces").get() as { s: number }
    ).s;
    db.prepare(
      "INSERT INTO workspaces (id, name, path, is_default, sort, created_at) VALUES (?, ?, ?, 0, ?, ?)",
    ).run(id, name, path, sort, nowIso());
    appEvent("workspaces.changed");
    return c.json({ workspace: wsDto({ id, name, path, is_default: 0 }) }, 201);
  });
  app.patch("/workspaces/:id", async (c) => {
    const ws = getWorkspace(db, c.req.param("id"));
    if (!ws) return fail(c, 404, "not_found", "工作区不存在");
    const b = ((await body(c)) ?? {}) as { name?: unknown; isDefault?: unknown };
    if (typeof b.name === "string" && b.name.trim() !== "")
      db.prepare("UPDATE workspaces SET name = ? WHERE id = ?").run(b.name.trim(), ws.id);
    if (b.isDefault === true) {
      db.exec("UPDATE workspaces SET is_default = 0");
      db.prepare("UPDATE workspaces SET is_default = 1 WHERE id = ?").run(ws.id);
    }
    appEvent("workspaces.changed");
    return c.json({ workspace: wsDto(getWorkspace(db, ws.id) as never) });
  });
  app.delete("/workspaces/:id", (c) => {
    const ws = getWorkspace(db, c.req.param("id"));
    if (!ws) return fail(c, 404, "not_found", "工作区不存在");
    if (ws.is_default === 1) return fail(c, 409, "conflict", "默认工作区不能删除登记");
    const used = db.prepare("SELECT 1 FROM sessions WHERE workspace_id = ? LIMIT 1").get(ws.id);
    if (used) return fail(c, 409, "conflict", "仍有会话使用该工作区，请先删除这些会话");
    // 只删除登记，不删除磁盘上的文件
    db.prepare("DELETE FROM workspaces WHERE id = ?").run(ws.id);
    appEvent("workspaces.changed");
    return c.json({ ok: true });
  });

  // ----- 备份与回收站 -----
  const backupRoutes = (kind: "backup" | "trash", seg: string) => {
    app.get(`/workspaces/:id/${seg}`, (c) => {
      const ws = getWorkspace(db, c.req.param("id"));
      if (!ws) return fail(c, 404, "not_found", "工作区不存在");
      // 手动编辑的备份沿用连接 ID 分组；用真实修订来源确认，不能把未知会话都当作手动操作。
      const hasDocOps = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'doc_ops'").get();
      const manualSources = new Set(
        hasDocOps
          ? db
              .prepare(`SELECT DISTINCT o.source_id FROM doc_ops o
              JOIN documents d ON d.id = o.doc_id
              WHERE d.workspace_id = ? AND o.source_kind = 'user'`)
              .all(ws.id)
              .map((r) => String(r.source_id))
          : [],
      );
      return c.json({
        items: deps.backups.listEntries(ws.id, kind).map((b) => ({
          id: b.id,
          originalPath: b.originalPath,
          kind: b.kind as "backup" | "trash",
          size: b.size,
          createdAt: b.createdAt,
          sessionId: b.sessionId,
          ...(b.agentId === "user" || b.sessionId === "user" || manualSources.has(b.sessionId)
            ? { sourceKind: "user" as const }
            : {}),
        })),
      });
    });
    app.get(`/workspaces/:id/${seg}/:entryId/preview`, (c) => {
      const ws = getWorkspace(db, c.req.param("id"));
      if (!ws) return fail(c, 404, "not_found", "工作区不存在");
      const query = BackupPreviewQuery.safeParse(c.req.query());
      if (!query.success) return fail(c, 400, "invalid_input", "预览页码不合法");
      try {
        const { name, bytes } = deps.backups.readEntry(ws.id, ws.path, c.req.param("entryId"));
        return c.json(previewBackup(name, bytes, query.data));
      } catch (e) {
        return fail(c, 400, "invalid_input", e instanceof Error ? e.message : "无法预览备份");
      }
    });
    app.get(`/workspaces/:id/${seg}/:entryId/download`, (c) => {
      const ws = getWorkspace(db, c.req.param("id"));
      if (!ws) return fail(c, 404, "not_found", "工作区不存在");
      try {
        const { name, bytes } = deps.backups.readEntry(ws.id, ws.path, c.req.param("entryId"));
        return c.body(new Uint8Array(bytes), 200, {
          "content-type": "application/octet-stream",
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        });
      } catch (e) {
        return fail(c, 404, "not_found", e instanceof Error ? e.message : String(e));
      }
    });
    app.post(`/workspaces/:id/${seg}/:entryId/restore`, async (c) => {
      const ws = getWorkspace(db, c.req.param("id"));
      if (!ws) return fail(c, 404, "not_found", "工作区不存在");
      try {
        const entryId = c.req.param("entryId");
        const restore = () =>
          deps.backups.restoreEntry(
            { workspaceId: ws.id, workspaceRoot: ws.path, sessionId: "user", agentId: "user" },
            entryId,
          );
        const target = deps.backups.entryPath(ws.id, entryId);
        // 07 §7.3：已打开的文档由文档 actor 编排替换（先检查点，失败则 409），不再吞错
        const out = await runWithHostNativeAccess(
          {db,workspaceId:ws.id,workspaceRoot:ws.path,operationId:newId("manual")},
          () => runWithHostBackupEntryAccess(
            {db,workspaceRoot:ws.path,workspaceId:ws.id,entryId,operation:"restore"},
            () => target !== undefined && deps.replaceDocumentFile
              ? deps.replaceDocumentFile(ws.id, ws.path, target, restore)
              : restore(),
          ),
        );
        appEvent("files.changed", { workspaceId: ws.id });
        return c.json({
          ok: true,
          path: out.path,
          ...(out.backupOfCurrent ? { backupOfCurrent: out.backupOfCurrent.id } : {}),
        });
      } catch (e) {
        const code = (e as { code?: string }).code;
        return fail(
          c,
          code === "NOT_FOUND" ? 404 : 409,
          code === "NOT_FOUND" ? "not_found" : "conflict",
          e instanceof Error ? e.message : String(e),
        );
      }
    });
    app.delete(`/workspaces/:id/${seg}/:entryId`, (c) => {
      const ws = getWorkspace(db, c.req.param("id"));
      if (!ws) return fail(c, 404, "not_found", "工作区不存在");
      const entryId=c.req.param("entryId");
      try {
        const removed=runWithHostNativeAccess({db,workspaceId:ws.id,workspaceRoot:ws.path,operationId:newId("manual")},()=>
          runWithHostBackupEntryAccess({db,workspaceRoot:ws.path,workspaceId:ws.id,entryId,operation:"remove"},()=>
            deps.backups.removeEntry(ws.id,ws.path,entryId)));
        if(!removed)return fail(c,404,"not_found","记录不存在");
        return c.json({ok:true});
      }catch(error){return fail(c,409,"conflict",error instanceof Error?error.message:String(error));}
    });
  };
  backupRoutes("backup", "backups");
  backupRoutes("trash", "trash");

  // ----- 切换代理模型（09 §3：/model <名称> 或模型选择器） -----
  app.patch("/sessions/:id/agents/:agentId", async (c) => {
    const sessionId = c.req.param("id");
    const agentId = c.req.param("agentId");
    const agent = db
      .prepare("SELECT id, status FROM agents WHERE session_id = ? AND id = ?")
      .get(sessionId, agentId) as { id: string; status: string } | undefined;
    if (!agent) return fail(c, 404, "not_found", "代理不存在");
    const b = ((await body(c)) ?? {}) as { modelProfileId?: unknown; modelName?: unknown };
    let profileId: string | null = null;
    if (typeof b.modelProfileId === "string") profileId = b.modelProfileId;
    else if (typeof b.modelName === "string") {
      const row = db
        .prepare("SELECT id FROM model_profiles WHERE name = ?")
        .get(b.modelName.trim()) as { id: string } | undefined;
      if (!row) return fail(c, 404, "not_found", `找不到名为「${b.modelName}」的模型档案`);
      profileId = row.id;
    } else return fail(c, 400, "bad_request", "请提供 modelProfileId 或 modelName");
    const row = getProfileRow(db, profileId);
    if (!row) return fail(c, 404, "not_found", "模型档案不存在");
    if (effectiveCapabilities(db, deps.catalog, profileId).tools.value === false)
      return fail(c, 409, "conflict", "该模型不支持工具调用，不能作为代理模型（09 §6）");
    deps.log.append(sessionId, agentId, [
      { type: "agent.updated", data: { modelProfileId: profileId } },
    ]);
    return c.json({ ok: true, modelProfileId: profileId, name: row.name });
  });

  // ----- 示例工作簿（02 §8 首次引导） -----
  app.get("/samples", (c) =>
    c.json({
      items: existsSync(deps.samplesDir)
        ? readdirSync(deps.samplesDir).filter((f) =>
            [".xlsx", ".csv"].includes(extname(f).toLowerCase()),
          )
        : [],
    }),
  );
  app.post("/workspaces/:id/samples/:name", (c) => {
    const ws = getWorkspace(db, c.req.param("id"));
    if (!ws) return fail(c, 404, "not_found", "工作区不存在");
    const name = basename(c.req.param("name"));
    const src = join(deps.samplesDir, name);
    let fd: number | undefined;
    try {
      // The configured sample directory is a host asset boundary, not a task read grant.
      // Read a stable regular file descriptor; never follow an asset symlink.
      fd = openSync(src, constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = fstatSync(fd, {bigint:true});
      if(!before.isFile() || before.nlink !== 1n) throw new Error("示例必须是独立的普通文件");
      const bytes = readFileSync(fd);
      const after = fstatSync(fd, {bigint:true}), current = lstatSync(src, {bigint:true});
      if(!current.isFile() || current.nlink !== 1n || before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs ||
        current.dev !== after.dev || current.ino !== after.ino)
        throw new Error("示例身份在读取期间发生变化");
      const ext = extname(name);
      let target = name;
      for (let i = 2; existsSync(join(ws.path, target)); i++)
        target = `${name.slice(0, -ext.length)} (${i})${ext}`;
      runWithHostNativeAccess({db,workspaceId:ws.id,workspaceRoot:ws.path,operationId:newId("manual")},()=>{
        const permit=prepareEffectPlan({workspaceRoot:ws.path,atomicScope:"single-resource",effects:[{operation:"create",path:target}]});
        runWithEffectPlan(permit,()=>atomicWrite(ws.path,target,bytes,null));
      });
      appEvent("files.changed", { workspaceId: ws.id });
      return c.json({ path: target }, 201);
    } catch(error) {
      const code=(error as NodeJS.ErrnoException).code;
      return fail(c,code==="ENOENT"?404:409,code==="ENOENT"?"not_found":"conflict",error instanceof Error?error.message:String(error));
    } finally { if(fd !== undefined) closeSync(fd); }
  });

  // ----- 设备 -----
  app.get("/devices", (c) =>
    c.json({
      items: (
        db
          .prepare(
            "SELECT id, name, kind, created_at, last_seen_at, revoked_at FROM devices ORDER BY created_at",
          )
          .all() as Record<string, string | null>[]
      ).map((d) => ({
        id: d.id,
        name: d.name,
        kind: d.kind,
        createdAt: d.created_at,
        lastSeenAt: d.last_seen_at,
        revokedAt: d.revoked_at,
      })),
    }),
  );
  app.post("/devices/:id/revoke", (c) => {
    const d = db.prepare("SELECT kind FROM devices WHERE id = ?").get(c.req.param("id")) as
      | { kind: string }
      | undefined;
    if (!d) return fail(c, 404, "not_found", "设备不存在");
    if (d.kind === "local") return fail(c, 409, "conflict", "不能吊销本机设备");
    db.prepare("UPDATE devices SET revoked_at = ? WHERE id = ?").run(nowIso(), c.req.param("id"));
    return c.json({ ok: true });
  });

  return app;
}

/** 订阅登录成功后自动创建模型档案（09 §4.1）；同账号已有档案时不重复创建。 */
export function autoProfilesForAccount(
  db: DatabaseSync,
  masterKey: Buffer,
  accountId: string,
  label: string,
): string[] {
  let connection = db
    .prepare("SELECT id FROM provider_connections WHERE credential_id=?")
    .get(accountId) as { id: string } | undefined;
  if (!connection)
    connection = createConnection(db, masterKey, {
      name: label || "ChatGPT",
      provider: "chatgpt",
      accountId,
    });
  const existing = db
    .prepare("SELECT id FROM model_profiles WHERE connection_id=?")
    .all(connection.id) as { id: string }[];
  if (existing.length > 0) return existing.map((r) => r.id);
  const models = presetFor("chatgpt")?.suggestedModels ?? ["gpt-5.1-codex"];
  const out: string[] = [];
  for (const model of models) {
    let name = `ChatGPT · ${model}`;
    if (db.prepare("SELECT 1 FROM model_profiles WHERE name = ?").get(name))
      name = `${name}（${label}）`;
    if (db.prepare("SELECT 1 FROM model_profiles WHERE name = ?").get(name)) continue;
    out.push(createProfile(db, masterKey, { name, connectionId: connection.id, model }).id);
  }
  return out;
}

export { getProfile };
