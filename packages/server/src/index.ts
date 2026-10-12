// startServer：数据目录 → 单实例锁 → 主密钥 → SQLite+迁移 → 会话日志+投影 →
// 启动恢复 → 运行时 → REST + 同步通道。只监听 127.0.0.1。

import { mkdirSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nowIso } from "@excelmanus/core";
import { writableFilesModule } from "@excelmanus/files";
import {
  AgentRuntime,
  ApprovalCoordinator,
  agentTools,
  BACKUPS_MIGRATION,
  BackupService,
  BlobStore,
  type CapabilityModule,
  KERNEL_MIGRATIONS,
  kernelProjections,
  LeaseService,
  type ModelGateway,
  openDb,
  QuestionCoordinator,
  recoverInterruptedAgents,
  registerProtectedRoot,
  resolveWorkspacePath,
  SessionLog,
  SyncBus,
  TeamCoordinator,
  type ToolDefinition,
  withResultCursor,
} from "@excelmanus/kernel";
import { MCP_MIGRATION, mcpModule } from "@excelmanus/mcp";
import { MEMORIES_MIGRATION, memoryModule } from "@excelmanus/memory";
import {
  createGateway,
  ModelCatalog,
  redactKnownSecrets,
  redactSecrets,
  registerSecret,
} from "@excelmanus/models";
import type { ResolvedModel, ToolSpec } from "@excelmanus/protocol";
import { RULES_MIGRATION, rulesModule } from "@excelmanus/rules";
import { SandboxPool } from "@excelmanus/sandbox";
import { SKILLS_MIGRATION, skillsModule } from "@excelmanus/skills";
import {
  CHECKPOINT_MIGRATION,
  DOC_OPS_MIGRATION,
  DOC_OPS_REVERTS_MIGRATION,
  DOCUMENTS_MIGRATION,
  type WorkbookModule,
  workbookModule,
  workbookRenderTool,
} from "@excelmanus/workbook";
import { serve } from "@hono/node-server";
import { z } from "zod";
import { AccountService } from "./accounts.ts";
import { createApp } from "./app.ts";
import { workbookChangeSummary } from "./change-summary.ts";
import { decryptSecret, encryptSecret, loadMasterKey } from "./crypto.ts";
import { appendDiagnosticLog } from "./diagnostics.ts";
import {
  appendEnvNotices,
  autoProfilesForAccount,
  effectiveCapabilities,
  extensionRoutes,
  injectedMemoryIds,
  sessionEnv,
} from "./extensions.ts";
import { interactionTools } from "./interactions.ts";
import { acquireInstanceLock } from "./lock.ts";
import { RenderBroker } from "./render.ts";
import { runScriptTool } from "./script.ts";
import { SettingsStore } from "./settings.ts";
import {
  ensureDeviceToken,
  ensureWorkspace,
  type ResolveDeps,
  resolveProfileModel,
  SERVER_MIGRATIONS,
} from "./store.ts";
import { attachSyncChannel } from "./ws.ts";

export interface StartServerOptions {
  /** 数据目录（EXCELMANUS_HOME 或 --data-dir 解析结果）。 */
  dataDir: string;
  port?: number;
  /** 能力模块；默认只装 files。 */
  modules?: CapabilityModule[];
  /** 测试注入：完整替换网关（仍走真实 HTTP/WS/SQLite）。 */
  gateway?: ModelGateway;
  /** 测试注入：只替换模型输出（如 ai/test MockLanguageModel）。 */
  resolveLanguageModel?: (model: ResolvedModel) => unknown;
  retryBaseMs?: number;
  ticketTtlMs?: number;
  /** 同时运行的子代理数上限（05 §8，默认 4；超出排队 FIFO）。 */
  maxConcurrentSubAgents?: number;
  /** 启用自动会话标题（仍受用户设置控制）；应用入口打开，测试默认关闭以免多出模型调用。 */
  autoTitle?: boolean;
  /** 开发模式：放行 Vite dev server（127.0.0.1:5173）的 Origin/Host。 */
  dev?: boolean;
  /** 前端产物目录；默认 <repo>/packages/web/dist。 */
  webDist?: string;
  /** 内置技能目录；默认 <repo>/assets/skills（桌面打包时指向应用资源）。 */
  builtinSkillsDir?: string;
  /** 部署形态（bootstrap.shape）：local-web / desktop。 */
  shape?: string;
  /** 额外允许的 Origin（桌面版 app://excelmanus，13 §1.1）。 */
  extraOrigins?: string[];
  /** 桌面版由主进程经 safeStorage 解出的主密钥（13 §1）；缺省读写 <数据目录>/master.key。 */
  masterKey?: Buffer;
  /** 打包资源位置（桌面安装包）：模型目录快照目录、沙箱 worker 产物。 */
  catalogDir?: string;
  samplesDir?: string;
  sandboxWorkerUrl?: URL;
  /** 系统通知（13 §3）：任务完成、需要审批或回答时回调（桌面主进程在窗口不在前台时弹通知）。 */
  onNotify?(n: {
    kind: "turn_done" | "turn_failed" | "approval" | "question";
    sessionId: string;
    title: string;
    body: string;
  }): void;
  /** 测试注入：OAuth 发行方地址（订阅登录）。 */
  oauthIssuer?: string;
  /** 测试/桌面注入：联网请求使用的 fetch（订阅登录、技能导入）。 */
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

export interface RunningServer {
  url: string;
  port: number;
  token: string;
  dataDir: string;
  workspaceRoot: string;
  /** 是否有代理正在运行（桌面退出确认，13 §2）。 */
  hasRunningAgents(): boolean;
  /** 安装包自检（13 §4.4）：不需要网络与模型；截图由桌面离屏窗口另行检查。 */
  selfTest(samplePath: string): Promise<{ name: string; ok: boolean; detail?: string }[]>;
  /** 工作区内文件的绝对路径（桌面"在 Finder 中显示"，13 §3）；越界抛错。 */
  resolveWorkspaceFile(workspaceId: string, path: string): string;
  /** 截图渲染端是否已连接（桌面自检等待离屏窗口就绪）。 */
  renderAvailable(): boolean;
  /** 直接请求一次截图渲染（自检用）。 */
  renderProbe(): Promise<string>;
  close(): Promise<void>;
}

export async function startServer(opts: StartServerOptions): Promise<RunningServer> {
  const log = opts.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const emit = (event: string, fields: Record<string, string | number | boolean> = {}) => {
    const safe = Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [k, typeof v === "string" ? redactSecrets(v) : v]),
    );
    log(redactSecrets(JSON.stringify({ t: nowIso(), event, ...safe })));
    try {
      appendDiagnosticLog(opts.dataDir, event, safe, redactSecrets);
    } catch {
      // Observability must not turn a successful write into a failed HTTP response.
      log(JSON.stringify({ t: nowIso(), event: "diagnostics.write_failed" }));
    }
  };

  const dataDir = opts.dataDir;
  const workspaceRoot = join(dataDir, "workspace");
  mkdirSync(workspaceRoot, { recursive: true });
  // 数据目录（主密钥、令牌、主库）对代理不可见，只豁免默认工作区子树（03 §13）
  registerProtectedRoot(dataDir, { exempt: workspaceRoot });
  const lock = acquireInstanceLock(dataDir);
  try {
    const masterKey = opts.masterKey ?? loadMasterKey(dataDir);
    // workbook 模块需要 db 句柄建 DocumentService：先按静态迁移清单开库，再建模块。
    const migrations = [
      ...KERNEL_MIGRATIONS,
      ...(opts.modules?.flatMap((m) => m.migrations ?? []) ?? [
        DOCUMENTS_MIGRATION,
        DOC_OPS_MIGRATION,
        BACKUPS_MIGRATION,
        CHECKPOINT_MIGRATION,
        DOC_OPS_REVERTS_MIGRATION,
      ]),
      ...SERVER_MIGRATIONS,
      RULES_MIGRATION,
      MEMORIES_MIGRATION,
      SKILLS_MIGRATION,
      MCP_MIGRATION,
    ];
    const db = openDb(join(dataDir, "excelmanus.db"), migrations);
    const backups = new BackupService(db);
    const blobs = new BlobStore(join(dataDir, "blobs"));
    const leases = new LeaseService(db);
    const files = writableFilesModule(db, backups);
    const workbook = opts.modules
      ? opts.modules.find((m): m is WorkbookModule => m.id === "workbook" && "service" in m)
      : workbookModule(db, backups);
    const interactionModule: CapabilityModule = { id: "interactions", tools: [] };
    const baseModules: CapabilityModule[] =
      opts.modules ?? (workbook ? [files, workbook] : [files]);
    const ws = ensureWorkspace(db, {
      name: "默认工作区",
      path: workspaceRoot,
      isDefault: true,
    });
    const token = ensureDeviceToken(dataDir, db);
    if (!opts.modules) backups.pruneBackups(ws.id, ws.path);

    const bus = new SyncBus();
    const sessionLog = new SessionLog(db, {
      projections: [...kernelProjections(), ...baseModules.flatMap((m) => m.projections ?? [])],
      bus,
      // 10 §4：会话日志写入前按已登记凭据精确脱敏（分支 models-ext-desktop，P0-12）
      redact: redactKnownSecrets,
    });
    const settings = new SettingsStore(db);
    const catalog = new ModelCatalog(join(dataDir, "cache"), opts.catalogDir);
    const rules = rulesModule(db);
    const memory = memoryModule(db, sessionLog);
    // tools 表先建好引用，技能可用性按当前工具目录判定（MCP 连接后也会变化）
    const tools = new Map<string, ToolDefinition>();
    const skills = skillsModule(db, {
      builtinDir:
        opts.builtinSkillsDir ??
        join(dirname(fileURLToPath(import.meta.url)), "../../../assets/skills"),
      userDir: join(dataDir, "skills"),
      toolNames: () => new Set(tools.keys()),
    });
    const specCache = new Map<string, ToolSpec[]>();
    const mcp = mcpModule(db, {
      cipher: {
        seal: (plain) => {
          const { ciphertext, nonce } = encryptSecret(masterKey, plain);
          return `${nonce.toString("base64")}.${ciphertext.toString("base64")}`;
        },
        open: (sealed) => {
          const [n, c] = sealed.split(".");
          const plain = decryptSecret(
            masterKey,
            Buffer.from(c ?? "", "base64"),
            Buffer.from(n ?? "", "base64"),
          );
          // 仅登记该 MCP 值本身；不要把 env/headers 整体伪装成模型 headers，
          // 否则字段名/内容可能污染模型凭据集合（10 §4）。
          registerSecret(plain);
          const bearer = /^\s*\S+\s+(\S+)\s*$/.exec(plain)?.[1];
          if (bearer) registerSecret(bearer);
          return plain;
        },
      },
      onToolsChanged: (defs) => {
        // 12 §4.2：工具列表变化在下一个步骤边界生效（toolSpecsFor 每步读取）
        for (const name of [...tools.keys()]) if (name.startsWith("mcp__")) tools.delete(name);
        for (const d of defs) if (!tools.has(d.name)) tools.set(d.name, d);
        specCache.clear();
      },
      onStatus: (serverId) => bus.publish({ kind: "app", data: { type: "mcp.status", serverId } }),
      log: emit,
    });
    const accounts = new AccountService({
      db,
      masterKey,
      ...(opts.oauthIssuer ? { issuer: opts.oauthIssuer } : {}),
      fetchImpl: opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => settings.fetch()(...a)),
      onLoggedIn: (account) => autoProfilesForAccount(db, masterKey, account.id, account.label),
      log: emit,
    });
    const resolveDeps: ResolveDeps = {
      subscription: (id) => accounts.subscription(id),
      fetch: opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => settings.fetch()(...a)),
      catalog: (provider, model) => catalog.lookup(provider, model),
    };
    const resolveWithCaps = (profileId: string | null) => {
      const r = resolveProfileModel(db, masterKey, profileId, resolveDeps);
      if ("error" in r) return r;
      const vision = effectiveCapabilities(db, catalog, r.profileId).vision.value;
      return vision === false ? { ...r, vision: false } : r;
    };
    const questions = new QuestionCoordinator(db, sessionLog);
    interactionModule.tools = interactionTools(sessionLog, questions);
    const maxConcurrentSubAgents =
      opts.maxConcurrentSubAgents ?? settings.get().maxConcurrentSubAgents;
    const team = new TeamCoordinator(db, sessionLog, leases, maxConcurrentSubAgents);
    team.setDefaultSubAgentProfile(() => settings.get().subAgentProfileId);
    const agentModule: CapabilityModule = { id: "agents", tools: agentTools(team) };
    const modules: CapabilityModule[] = opts.modules
      ? [...baseModules, agentModule, skills, memory, rules, mcp]
      : [...baseModules, interactionModule, agentModule, skills, memory, rules, mcp];
    const approvals = new ApprovalCoordinator(db, sessionLog);
    for (const m of modules) for (const t of m.tools ?? []) tools.set(t.name, t);
    // run_script 属于装配层：要同时组合 workbook 与 files 两个模块（模块互不依赖）
    // 截图渲染（ADR 0010）：经同步通道交给已连接的界面客户端绘制
    const renderBroker = new RenderBroker();
    if (workbook) {
      const renderTool = workbookRenderTool(workbook.service, (layout) =>
        renderBroker.request(layout),
      );
      tools.set(renderTool.name, renderTool as unknown as ToolDefinition);
    }
    const sandbox = new SandboxPool(
      opts.sandboxWorkerUrl ? { workerUrl: opts.sandboxWorkerUrl } : {},
    );
    tools.set("run_script", runScriptTool({ sandbox, documents: workbook?.service, tools, db }));
    const recovered = recoverInterruptedAgents({ db, log: sessionLog, tools });
    if (recovered > 0) emit("agents.recovered", { count: recovered });
    const toolSpecsFor = (role: string): ToolSpec[] => {
      const cached = specCache.get(role);
      if (cached) return cached;
      const specs = [...tools.values()]
        .filter((t) => (t.roles as readonly string[]).includes(role))
        .map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: withResultCursor(
            t.inputJsonSchema ?? (z.toJSONSchema(t.input) as Record<string, unknown>),
          ),
        }));
      specCache.set(role, specs);
      return specs;
    };

    const gateway =
      opts.gateway ?? createGateway({ resolveLanguageModel: opts.resolveLanguageModel });
    const workspaceRowFor = (sessionId: string): { id: string; path: string } | undefined =>
      db
        .prepare(
          "SELECT w.id, w.path FROM sessions s JOIN workspaces w ON w.id = s.workspace_id WHERE s.id = ?",
        )
        .get(sessionId) as { id: string; path: string } | undefined;
    const workspaceRootFor = (sessionId: string): string =>
      workspaceRowFor(sessionId)?.path ?? ws.path;
    const workspaceIdFor = (sessionId: string): string => workspaceRowFor(sessionId)?.id ?? ws.id;
    const runtime = new AgentRuntime({
      db,
      log: sessionLog,
      bus,
      gateway,
      tools,
      toolSpecsFor,
      backups,
      blobs,
      leases,
      approval: approvals,
      question: questions,
      agents: team,
      resolveModel: (agent) => resolveWithCaps(agent.modelProfileId),
      summaryModel: () => {
        const id = settings.get().compactionProfileId;
        if (!id) return undefined;
        const r = resolveWithCaps(id);
        return "error" in r ? undefined : r;
      },
      autoCompact: () => settings.get().autoCompact,
      autoTitle: () => opts.autoTitle === true && settings.get().autoTitle,
      resolveResource: (sessionId, uri) =>
        skills.service.readResource(uri, workspaceRootFor(sessionId)),
      workspaceRoot: workspaceRootFor,
      workspaceId: workspaceIdFor,
      retryBaseMs: opts.retryBaseMs,
      maxConcurrentSubAgents,
      // 完成报告投递后唤醒父代理（05 §4.3）；闭包延迟绑定避免构造顺序问题。
      onInbox: (sessionId, agentId) => runtime.enqueueInbox(sessionId, agentId),
      // 04 §11：每轮变更摘要从 workbook 文档日志生成（分支 agent-control，P1-05）
      ...(workbook ? { changeSummary: workbookChangeSummary(db, workbook.service) } : {}),
    });
    if (workbook) workbook.service.onUserEdit = (edit) => runtime.notifyDocEdited(edit);
    // 05 §9：子代理系统提示词复用 main 的组成（分支 agent-control，P1-10）
    team.setPromptEnv((sessionId) => {
      const env = sessionEnv(
        { rules: rules.service, skills: skills.service },
        workspaceRootFor(sessionId),
        sessionId,
      );
      return { skills: env.skills, rules: env.rules };
    });
    team.bindRuntime(
      (sessionId, agentId, dispatchId, mode) =>
        runtime.enqueue(sessionId, agentId, dispatchId, mode),
      (sessionId, agentId) => runtime.enqueueInbox(sessionId, agentId),
      (sessionId, agentId) => runtime.stop(sessionId, agentId),
      (sessionId, agentId) => runtime.resumeAgent(sessionId, agentId),
    );

    const tickets = new Map<string, number>();
    let port = 0;
    const allowedHosts = () =>
      new Set([
        `127.0.0.1:${port}`,
        `localhost:${port}`,
        ...(opts.dev ? ["127.0.0.1:5173", "localhost:5173"] : []),
      ]);
    const allowedOrigins = () =>
      new Set([
        ...(opts.extraOrigins ?? []),
        `http://127.0.0.1:${port}`,
        `http://localhost:${port}`,
        ...(opts.dev ? ["http://127.0.0.1:5173", "http://localhost:5173"] : []),
      ]);

    const app = createApp({
      renderDocument: (layout) => renderBroker.request(layout),
      validateResponses: opts.dev === true || process.env.NODE_ENV === "test",
      db,
      masterKey,
      bus,
      log: sessionLog,
      runtime,
      approvals,
      team,
      gateway,
      resolveDeps,
      tickets,
      ticketTtlMs: opts.ticketTtlMs ?? 30_000,
      token,
      defaultWorkspaceId: ws.id,
      moduleIds: modules.map((m) => m.id),
      docService: workbook?.service,
      webDist: opts.webDist ?? join(dirname(fileURLToPath(import.meta.url)), "../../web/dist"),
      emit,
      allowedHosts,
      allowedOrigins,
      shape: opts.shape ?? "local-web",
      dataDir: opts.dataDir,
      blobs,
      extensions: (fail) =>
        extensionRoutes(
          {
            dataDir,
            db,
            masterKey,
            bus,
            log: sessionLog,
            gateway,
            rules: rules.service,
            memory: memory.service,
            skills: skills.service,
            mcp: mcp.service,
            accounts,
            settings,
            catalog,
            backups,
            resolveDeps,
            samplesDir:
              opts.samplesDir ?? join(dirname(fileURLToPath(import.meta.url)), "../../../samples"),
            replaceDocumentFile: (workspaceId, root, path, replace) =>
              workbook
                ? workbook.service.replaceFile(workspaceId, root, path, replace)
                : Promise.resolve(replace()),
            emit,
          },
          fail,
        ),
      defaultDispatchMode: () => settings.get().defaultDispatchMode,
      sessionEnv: (root) => ({
        ...sessionEnv({ rules: rules.service, skills: skills.service }, root),
        defaultPermissionMode: settings.get().defaultPermissionMode,
      }),
      prepareMessage: ({ sessionId, workspaceId, workspaceRoot: root, text }) => {
        appendEnvNotices(
          { rules: rules.service, skills: skills.service, log: sessionLog, db },
          sessionId,
          root,
        );
        let skill: { name: string; body: string } | undefined;
        const m = /^\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s|$)/.exec(text.trim());
        if (m?.[1] && skills.service.detail(m[1], root)) {
          const out = skills.service.invoke(m[1], root);
          if ("error" in out) return { error: out.error };
          skill = { name: m[1], body: out.body };
        }
        const memories = settings.get().memoryInjection
          ? memory.service
              .selectForTurn(text, workspaceId, injectedMemoryIds(db, sessionId))
              .map((x) => ({ id: x.id, category: x.category, content: x.content }))
          : [];
        return { text, ...(memories.length > 0 ? { memories } : {}), ...(skill ? { skill } : {}) };
      },
      onSessionDeleted: (sessionId) => rules.service.deleteForSession(sessionId),
    });

    const server = await new Promise<Server>((resolve) => {
      const s = serve({ fetch: app.fetch, port: opts.port ?? 0, hostname: "127.0.0.1" }, () =>
        resolve(s as Server),
      ) as Server;
    });
    port = (server.address() as AddressInfo).port;
    const detach = attachSyncChannel(server, {
      log: sessionLog,
      bus,
      tickets,
      allowedHosts,
      allowedOrigins,
      emit,
      docService: workbook?.service,
      render: renderBroker,
      workspaceRootFor: (docId) => {
        const row = db
          .prepare(
            "SELECT w.path FROM documents d JOIN workspaces w ON w.id = d.workspace_id WHERE d.id = ?",
          )
          .get(docId) as { path: string } | undefined;
        return row?.path;
      },
    });
    const sweeper = setInterval(() => {
      const now = Date.now();
      for (const [k, exp] of tickets) if (exp < now) tickets.delete(k);
    }, 10_000);
    mcp.service.startAll();
    const unNotify = opts.onNotify
      ? bus.subscribe((ev) => {
          if (ev.kind !== "rec") return;
          const r = ev.rec;
          const title =
            (
              db.prepare("SELECT title FROM sessions WHERE id = ?").get(r.sessionId) as
                | { title: string | null }
                | undefined
            )?.title ?? "ExcelManus";
          if (r.agentId === "main" && r.type === "turn.completed")
            opts.onNotify?.({
              kind: "turn_done",
              sessionId: r.sessionId,
              title,
              body: "任务已完成",
            });
          else if (r.agentId === "main" && r.type === "turn.failed")
            opts.onNotify?.({
              kind: "turn_failed",
              sessionId: r.sessionId,
              title,
              body: "任务出错，请查看会话",
            });
          else if (r.type === "approval.requested")
            opts.onNotify?.({
              kind: "approval",
              sessionId: r.sessionId,
              title,
              body: `需要审批：${String(r.data.toolName ?? "")}`,
            });
          else if (r.type === "question.asked")
            opts.onNotify?.({
              kind: "question",
              sessionId: r.sessionId,
              title,
              body: "代理在等待你回答问题",
            });
        })
      : () => {};
    emit("server.listening", { port });
    // 浏览器会话在页面打开后自动建立；启动输出只给出普通地址，不再把令牌放进链接。
    if (opts.log === undefined && process.stdout.isTTY)
      process.stdout.write(`http://127.0.0.1:${port}/\n`);
    else log(`http://127.0.0.1:${port}/`);

    let closePromise: Promise<void> | undefined;
    return {
      url: `http://127.0.0.1:${port}`,
      port,
      token,
      dataDir,
      workspaceRoot: ws.path,
      hasRunningAgents: () =>
        (
          db
            .prepare(
              "SELECT COUNT(*) AS c FROM agents WHERE status IN ('running','blocked','waiting')",
            )
            .get() as {
            c: number;
          }
        ).c > 0,
      resolveWorkspaceFile: (workspaceId, path) => {
        const root =
          workspaceId === ""
            ? ws.path
            : ((
                db.prepare("SELECT path FROM workspaces WHERE id = ?").get(workspaceId) as
                  | { path: string }
                  | undefined
              )?.path ?? ws.path);
        return resolveWorkspacePath(root, path === "" ? "." : path).abs;
      },
      renderAvailable: () => renderBroker.available,
      renderProbe: () =>
        renderBroker.request({
          width: 120,
          height: 40,
          cells: [{ x: 0, y: 0, w: 120, h: 40, text: "自检", align: "center" }],
        }),
      selfTest: async (samplePath) => {
        const results: { name: string; ok: boolean; detail?: string }[] = [];
        const check = async (
          name: string,
          fn: () => Promise<string | undefined> | string | undefined,
        ) => {
          try {
            const detail = await fn();
            results.push({ name, ok: true, ...(detail ? { detail } : {}) });
          } catch (e) {
            results.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) });
          }
        };
        await check("数据库读写", () => {
          settings.patch({ autoCompact: settings.get().autoCompact });
          const n = (
            db.prepare("SELECT COUNT(*) AS c FROM schema_migrations").get() as { c: number }
          ).c;
          if (n === 0) throw new Error("迁移记录为空");
          return `${n} 条迁移`;
        });
        await check("打开并修改示例工作簿", async () => {
          if (!workbook) throw new Error("workbook 模块未装配");
          const { copyFileSync } = await import("node:fs");
          copyFileSync(samplePath, join(ws.path, "self-test.xlsx"));
          const opened = await workbook.service.open(ws.id, ws.path, "self-test.xlsx");
          const first =
            opened.imported.snapshot.sheets[opened.imported.snapshot.sheetOrder[0] ?? ""]?.name ??
            "Sheet1";
          const res = await workbook.service.submit(opened.meta.id, ws.path, {
            baseRev: opened.meta.rev,
            source: { kind: "engine", id: "self-test" },
            ops: [{ op: "cells.set", range: `'${first}'!Z1`, values: [["自检"]] }] as never,
          });
          if (!res.ok) throw new Error(res.message);
          await workbook.service.checkpoint(opened.meta.id, ws.path);
          return `rev ${res.rev}`;
        });
        await check("沙箱脚本", async () => {
          const out = await sandbox.run(
            {
              code: "let s = 0; for (let i = 1; i <= 100; i++) s += i; return s;",
              timeoutMs: 10_000,
              namespaces: {},
            },
            { call: async () => null },
          );
          if (out.kind !== "ok" || out.value !== 5050)
            throw new Error(`结果异常：${JSON.stringify(out)}`);
          return "5050";
        });
        await check("内置技能", () => {
          const n = skills.service.list(ws.path).length;
          if (n === 0) throw new Error("未加载到任务技能");
          const unavailable = skills.service.list(ws.path).filter((s) => !s.available);
          if (unavailable.length > 0)
            throw new Error(`技能依赖不可用：${unavailable.map((s) => s.name).join("、")}`);
          return `${n} 个`;
        });
        await check("模型目录", () => {
          const n = catalog.list().items.length;
          if (n === 0) throw new Error("模型目录为空");
          return `${n} 条`;
        });
        return results;
      },
      close: () => {
        if (!closePromise)
          closePromise = (async () => {
            clearInterval(sweeper);
            unNotify();
            accounts.close();
            detach();
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await runtime.shutdown();
            await mcp.service.close().catch(() => {});
            try {
              await sandbox.close();
              await workbook?.service.close();
            } finally {
              db.close();
              lock.release();
            }
          })();
        return closePromise;
      },
    };
  } catch (err) {
    lock.release();
    throw err;
  }
}
