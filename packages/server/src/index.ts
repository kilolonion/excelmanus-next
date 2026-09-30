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
  type CapabilityModule,
  KERNEL_MIGRATIONS,
  kernelProjections,
  LeaseService,
  type ModelGateway,
  openDb,
  QuestionCoordinator,
  recoverInterruptedAgents,
  SessionLog,
  SyncBus,
  TeamCoordinator,
  type ToolDefinition,
} from "@excelmanus/kernel";
import { createGateway } from "@excelmanus/models";
import type { ResolvedModel, ToolSpec } from "@excelmanus/protocol";
import { SandboxPool } from "@excelmanus/sandbox";
import {
  CHECKPOINT_MIGRATION,
  DOC_OPS_MIGRATION,
  DOCUMENTS_MIGRATION,
  type WorkbookModule,
  workbookModule,
} from "@excelmanus/workbook";
import { serve } from "@hono/node-server";
import { z } from "zod";
import { createApp } from "./app.ts";
import { loadMasterKey } from "./crypto.ts";
import { interactionTools } from "./interactions.ts";
import { acquireInstanceLock } from "./lock.ts";
import { runScriptTool } from "./script.ts";
import { ensureDeviceToken, ensureWorkspace, resolveProfileModel } from "./store.ts";
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
  /** 开发模式：放行 Vite dev server（127.0.0.1:5173）的 Origin/Host。 */
  dev?: boolean;
  /** 前端产物目录；默认 <repo>/packages/web/dist。 */
  webDist?: string;
  log?: (line: string) => void;
}

export interface RunningServer {
  url: string;
  port: number;
  token: string;
  dataDir: string;
  workspaceRoot: string;
  close(): Promise<void>;
}

export async function startServer(opts: StartServerOptions): Promise<RunningServer> {
  const log = opts.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const emit = (event: string, fields: Record<string, string | number | boolean> = {}) =>
    log(JSON.stringify({ t: nowIso(), event, ...fields }));

  const dataDir = opts.dataDir;
  const workspaceRoot = join(dataDir, "workspace");
  mkdirSync(workspaceRoot, { recursive: true });
  const lock = acquireInstanceLock(dataDir);
  try {
    const masterKey = loadMasterKey(dataDir);
    // workbook 模块需要 db 句柄建 DocumentService：先按静态迁移清单开库，再建模块。
    const migrations = [
      ...KERNEL_MIGRATIONS,
      ...(opts.modules?.flatMap((m) => m.migrations ?? []) ?? [
        DOCUMENTS_MIGRATION,
        DOC_OPS_MIGRATION,
        BACKUPS_MIGRATION,
        CHECKPOINT_MIGRATION,
      ]),
    ];
    const db = openDb(join(dataDir, "excelmanus.db"), migrations);
    const backups = new BackupService(db);
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
    });
    const questions = new QuestionCoordinator(db, sessionLog);
    interactionModule.tools = interactionTools(sessionLog, questions);
    const team = new TeamCoordinator(db, sessionLog, leases);
    const agentModule: CapabilityModule = { id: "agents", tools: agentTools(team) };
    const modules: CapabilityModule[] = opts.modules
      ? [...baseModules, agentModule]
      : [...baseModules, interactionModule, agentModule];
    const approvals = new ApprovalCoordinator(db, sessionLog);
    const tools = new Map<string, ToolDefinition>();
    for (const m of modules) for (const t of m.tools ?? []) tools.set(t.name, t);
    // run_script 属于装配层：要同时组合 workbook 与 files 两个模块（模块互不依赖）
    const sandbox = new SandboxPool();
    tools.set("run_script", runScriptTool({ sandbox, documents: workbook?.service, tools, db }));
    const recovered = recoverInterruptedAgents({ db, log: sessionLog, tools });
    if (recovered > 0) emit("agents.recovered", { count: recovered });
    const specCache = new Map<string, ToolSpec[]>();
    const toolSpecsFor = (role: string): ToolSpec[] => {
      const cached = specCache.get(role);
      if (cached) return cached;
      const specs = [...tools.values()]
        .filter((t) => (t.roles as readonly string[]).includes(role))
        .map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: z.toJSONSchema(t.input) as Record<string, unknown>,
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
      leases,
      approval: approvals,
      question: questions,
      agents: team,
      resolveModel: (agent) => {
        const r = resolveProfileModel(db, masterKey, agent.modelProfileId);
        return r;
      },
      workspaceRoot: workspaceRootFor,
      workspaceId: workspaceIdFor,
      retryBaseMs: opts.retryBaseMs,
    });
    team.bindRuntime(
      (sessionId, agentId, dispatchId, mode) =>
        runtime.enqueue(sessionId, agentId, dispatchId, mode),
      (sessionId, agentId) => runtime.enqueueInbox(sessionId, agentId),
      (sessionId, agentId) => runtime.stop(sessionId, agentId),
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
        `http://127.0.0.1:${port}`,
        `http://localhost:${port}`,
        ...(opts.dev ? ["http://127.0.0.1:5173", "http://localhost:5173"] : []),
      ]);

    const app = createApp({
      db,
      masterKey,
      bus,
      log: sessionLog,
      runtime,
      approvals,
      gateway,
      tickets,
      ticketTtlMs: opts.ticketTtlMs ?? 30_000,
      defaultWorkspaceId: ws.id,
      moduleIds: modules.map((m) => m.id),
      docService: workbook?.service,
      webDist: opts.webDist ?? join(dirname(fileURLToPath(import.meta.url)), "../../web/dist"),
      emit,
      allowedHosts,
      allowedOrigins,
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
    emit("server.listening", { port });
    log(`http://127.0.0.1:${port}/#token=${token}`);

    return {
      url: `http://127.0.0.1:${port}`,
      port,
      token,
      dataDir,
      workspaceRoot: ws.path,
      close: async () => {
        clearInterval(sweeper);
        detach();
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
        try {
          await sandbox.close();
          await workbook?.service.close();
        } finally {
          db.close();
          lock.release();
        }
      },
    };
  } catch (err) {
    lock.release();
    throw err;
  }
}
