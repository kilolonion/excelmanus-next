// modules/mcp：MCP 客户端（12 §4）。stdio 与 Streamable HTTP 两种传输，只用 tools 能力。
// 工具以 mcp__<服务器>__<工具> 命名加入工具列表；readOnlyHint=true 为 read，其余为 external
// （按权限模式审批，可按工具加入自动批准名单）。启动时后台连接已启用的服务器，失败指数
// 退避重连；工具列表变化经 onToolsChanged 交给装配层，运行时在下一步骤边界使用新列表。
// 敏感字段（env / headers 的值）由装配层提供的 cipher 加密存储，读接口只返回掩码。

import { createHash } from "node:crypto";
import { newId, nowIso } from "@excelmanus/core";
import { currentToolAccess, hasTaskContractRequirement, type CapabilityModule, type DatabaseSync, type Migration, type ToolDefinition } from "@excelmanus/kernel";
import type { McpServer, ToolResult } from "@excelmanus/protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export const MCP_MIGRATION: Migration = {
  id: "mcp/001-servers",
  sql: `
CREATE TABLE mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  transport TEXT NOT NULL CHECK (transport IN ('stdio','http')),
  config TEXT NOT NULL CHECK (json_valid(config)),
  enabled INTEGER NOT NULL DEFAULT 1,
  auto_approve TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(auto_approve)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
};

export const MASK = "••••";
const CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_CALL_TIMEOUT_S = 60;
const MAX_RESULT_CHARS = 16_000;
const MAX_BACKOFF_MS = 60_000;

/**
 * stdio 子进程的 PATH（12 §4.1）：在继承的 PATH 之后补上常见的用户级命令目录。
 * macOS 从 Finder/Dock 启动的 GUI 进程只有 /usr/bin:/bin:/usr/sbin:/sbin，npx/uvx 及其
 * shebang 依赖的 node/python 都在这些目录里。导出供测试。
 */
export function stdioPath(
  inherited: string | undefined,
  platform: NodeJS.Platform = process.platform,
  home: string | undefined = process.env.HOME,
): string {
  const delimiter = platform === "win32" ? ";" : ":";
  const parts = (inherited ?? "").split(delimiter).filter(Boolean);
  if (platform !== "win32") {
    const extra = [
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
      ...(home
        ? [
            `${home}/.local/bin`,
            `${home}/.volta/bin`,
            `${home}/.bun/bin`,
            `${home}/.cargo/bin`,
            `${home}/.deno/bin`,
          ]
        : []),
    ];
    for (const d of extra) if (!parts.includes(d)) parts.push(d);
  }
  return parts.join(delimiter);
}

export interface SecretCipher {
  seal(plain: string): string;
  open(sealed: string): string;
}

export interface McpConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  callTimeoutSeconds?: number;
}

interface ServerRow {
  id: string;
  name: string;
  transport: "stdio" | "http";
  config: string;
  enabled: number;
  auto_approve: string;
  created_at: string;
  updated_at: string;
}

interface RemoteTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; title?: string };
}

interface Conn {
  status: "disabled" | "connecting" | "connected" | "failed";
  error: string | null;
  client?: Client;
  tools: RemoteTool[];
  attempt: number;
  timer?: ReturnType<typeof setTimeout>;
  /** 每次重连递增，旧连接的回调据此失效。 */
  generation: number;
}

/** mcp__<服务器>__<工具>：只含 [A-Za-z0-9_-]，超过 64 字符时截断并附短哈希保证唯一。 */
export function qualifiedToolName(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");
  const full = `mcp__${clean(server)}__${clean(tool)}`;
  if (full.length <= 64) return full;
  const hash = createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 8);
  return `${full.slice(0, 64 - 9)}_${hash}`;
}

function describeError(err: unknown, cfg: McpConfig, transport: string): string {
  const e = err as NodeJS.ErrnoException;
  if (
    transport === "stdio" &&
    (e?.code === "ENOENT" || /ENOENT|spawn .* ENOENT/.test(String(e?.message)))
  ) {
    return `找不到命令「${cfg.command ?? ""}」：请先在本机安装（如 Node.js 的 npx、Python 的 uvx），或填写命令的绝对路径`;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > 300 ? `${msg.slice(0, 300)}…` : msg;
}

export interface McpServiceOptions {
  cipher: SecretCipher;
  /** 工具列表变化（连接/断开/list_changed）。 */
  onToolsChanged(tools: ToolDefinition[]): void;
  /** 状态变化（设置页经 app 主题刷新）。 */
  onStatus?(serverId: string): void;
  log?(event: string, fields: Record<string, string | number | boolean>): void;
}

export class McpService {
  private readonly db: DatabaseSync;
  private readonly opts: McpServiceOptions;
  private readonly conns = new Map<string, Conn>();
  private closed = false;

  constructor(db: DatabaseSync, opts: McpServiceOptions) {
    this.db = db;
    this.opts = opts;
  }

  // ---------- 存储 ----------

  private row(id: string): ServerRow | undefined {
    return this.db.prepare("SELECT * FROM mcp_servers WHERE id = ?").get(id) as
      | ServerRow
      | undefined;
  }

  private rows(): ServerRow[] {
    return this.db
      .prepare("SELECT * FROM mcp_servers ORDER BY created_at")
      .all() as unknown as ServerRow[];
  }

  /** 解密后的完整配置（只在进程内使用）。 */
  private configOf(row: ServerRow): McpConfig {
    const raw = JSON.parse(row.config) as McpConfig;
    const open = (rec?: Record<string, string>) =>
      rec
        ? Object.fromEntries(
            Object.entries(rec).map(([k, v]) => {
              try {
                return [k, this.opts.cipher.open(v)];
              } catch {
                return [k, ""];
              }
            }),
          )
        : undefined;
    return { ...raw, env: open(raw.env), headers: open(raw.headers) };
  }

  private sealConfig(cfg: McpConfig, previous?: McpConfig): McpConfig {
    const seal = (
      rec: Record<string, string> | undefined,
      prev: Record<string, string> | undefined,
    ) =>
      rec
        ? Object.fromEntries(
            Object.entries(rec).map(([k, v]) => [
              k,
              this.opts.cipher.seal(v === MASK && prev?.[k] !== undefined ? prev[k] : v),
            ]),
          )
        : undefined;
    const out: McpConfig = {
      ...cfg,
      env: seal(cfg.env, previous?.env),
      headers: seal(cfg.headers, previous?.headers),
    };
    if (out.env === undefined) delete out.env;
    if (out.headers === undefined) delete out.headers;
    return out;
  }

  private autoApproveOf(row: ServerRow): string[] {
    try {
      return JSON.parse(row.auto_approve) as string[];
    } catch {
      return [];
    }
  }

  private validate(transport: "stdio" | "http", cfg: McpConfig): void {
    if (transport === "stdio" && !cfg.command?.trim())
      throw new McpConfigError("stdio 服务器需要填写命令");
    if (transport === "http") {
      let u: URL;
      try {
        u = new URL(cfg.url ?? "");
      } catch {
        throw new McpConfigError("HTTP 服务器需要填写合法的 URL");
      }
      if (u.protocol !== "http:" && u.protocol !== "https:")
        throw new McpConfigError("URL 只支持 http/https");
    }
  }

  dto(row: ServerRow): McpServer {
    const cfg = JSON.parse(row.config) as McpConfig;
    const mask = (rec?: Record<string, string>) =>
      rec ? Object.fromEntries(Object.keys(rec).map((k) => [k, MASK])) : undefined;
    const conn = this.conns.get(row.id);
    const auto = new Set(this.autoApproveOf(row));
    return {
      id: row.id,
      name: row.name,
      transport: row.transport,
      config: {
        ...cfg,
        ...(cfg.env ? { env: mask(cfg.env) } : {}),
        ...(cfg.headers ? { headers: mask(cfg.headers) } : {}),
      },
      enabled: row.enabled === 1,
      status: row.enabled === 1 ? (conn?.status ?? "connecting") : "disabled",
      error: conn?.error ?? null,
      tools: (conn?.tools ?? []).map((t) => ({
        name: t.name,
        qualifiedName: qualifiedToolName(row.name, t.name),
        description: t.description ?? "",
        readOnly: t.annotations?.readOnlyHint === true,
        autoApprove: auto.has(t.name),
      })),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  list(): McpServer[] {
    return this.rows().map((r) => this.dto(r));
  }

  get(id: string): McpServer | undefined {
    const r = this.row(id);
    return r ? this.dto(r) : undefined;
  }

  create(input: {
    name: string;
    transport: "stdio" | "http";
    config: McpConfig;
    enabled?: boolean;
  }): McpServer {
    this.validate(input.transport, input.config);
    if (this.db.prepare("SELECT 1 FROM mcp_servers WHERE name = ?").get(input.name))
      throw new McpConfigError(`名称 ${input.name} 已存在`);
    const id = newId("mcp");
    const now = nowIso();
    this.db
      .prepare(
        "INSERT INTO mcp_servers (id, name, transport, config, enabled, auto_approve, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '[]', ?, ?)",
      )
      .run(
        id,
        input.name,
        input.transport,
        JSON.stringify(this.sealConfig(input.config)),
        input.enabled === false ? 0 : 1,
        now,
        now,
      );
    if (input.enabled !== false) this.connect(id);
    return this.get(id) as McpServer;
  }

  update(
    id: string,
    patch: {
      name?: string;
      transport?: "stdio" | "http";
      config?: McpConfig;
      enabled?: boolean;
      autoApprove?: string[];
    },
  ): McpServer | undefined {
    const row = this.row(id);
    if (!row) return undefined;
    const transport = patch.transport ?? row.transport;
    const prev = this.configOf(row);
    const cfg = patch.config ?? prev;
    this.validate(transport, patch.config ? { ...cfg } : prev);
    if (
      patch.name &&
      patch.name !== row.name &&
      this.db.prepare("SELECT 1 FROM mcp_servers WHERE name = ?").get(patch.name)
    )
      throw new McpConfigError(`名称 ${patch.name} 已存在`);
    const reconnect =
      patch.config !== undefined ||
      patch.transport !== undefined ||
      patch.name !== undefined ||
      patch.enabled !== undefined;
    this.db
      .prepare(
        "UPDATE mcp_servers SET name = ?, transport = ?, config = ?, enabled = ?, auto_approve = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        patch.name ?? row.name,
        transport,
        patch.config ? JSON.stringify(this.sealConfig(patch.config, prev)) : row.config,
        patch.enabled === undefined ? row.enabled : patch.enabled ? 1 : 0,
        patch.autoApprove ? JSON.stringify(patch.autoApprove) : row.auto_approve,
        nowIso(),
        id,
      );
    if (reconnect) {
      void this.disconnect(id).then(() => {
        if (this.row(id)?.enabled === 1) this.connect(id);
        else this.emitTools();
      });
    }
    return this.get(id);
  }

  async delete(id: string): Promise<boolean> {
    if (!this.row(id)) return false;
    this.db.prepare("DELETE FROM mcp_servers WHERE id = ?").run(id);
    await this.disconnect(id);
    this.conns.delete(id);
    this.emitTools();
    return true;
  }

  // ---------- 连接 ----------

  /** 应用启动：后台连接全部已启用服务器（不阻塞启动）。 */
  startAll(): void {
    for (const r of this.rows()) if (r.enabled === 1) this.connect(r.id);
  }

  /** POST /reload：断开并重连全部。 */
  async reload(): Promise<void> {
    await Promise.all([...this.conns.keys()].map((id) => this.disconnect(id)));
    this.conns.clear();
    this.emitTools();
    this.startAll();
  }

  private async openClient(
    row: ServerRow,
    onClose?: () => void,
    onToolsListChanged?: () => void,
  ): Promise<{ client: Client; tools: RemoteTool[]; stderr: () => string }> {
    const cfg = this.configOf(row);
    let stderrTail = "";
    const client = new Client({ name: "excelmanus", version: "0.0.0" }, { capabilities: {} });
    const transport =
      row.transport === "stdio"
        ? new StdioClientTransport({
            command: cfg.command ?? "",
            args: cfg.args ?? [],
            env: (() => {
              const base = getDefaultEnvironment();
              const pathKey = Object.keys(base).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
              return { ...base, [pathKey]: stdioPath(base[pathKey]), ...(cfg.env ?? {}) };
            })(),
            ...(cfg.cwd ? { cwd: cfg.cwd } : {}),
            stderr: "pipe",
          })
        : new StreamableHTTPClientTransport(new URL(cfg.url ?? ""), {
            requestInit: { headers: cfg.headers ?? {} },
          });
    if (transport instanceof StdioClientTransport) {
      transport.stderr?.on("data", (chunk: Buffer) => {
        stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-800);
      });
    }
    client.onclose = () => onClose?.();
    if (onToolsListChanged)
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => onToolsListChanged());
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("连接超时（15 秒）")), CONNECT_TIMEOUT_MS).unref(),
    );
    try {
      await Promise.race([client.connect(transport), timeout]);
      const listed = await client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS });
      return { client, tools: listed.tools as RemoteTool[], stderr: () => stderrTail };
    } catch (err) {
      await client.close().catch(() => {});
      const tail = stderrTail.trim().split("\n").slice(-3).join(" ").trim();
      throw new Error(
        `${describeError(err, cfg, row.transport)}${tail ? `（服务器输出：${tail.slice(0, 300)}）` : ""}`,
      );
    }
  }

  private connect(id: string): void {
    if (this.closed) return;
    const row = this.row(id);
    if (!row || row.enabled !== 1) return;
    const prev = this.conns.get(id);
    if (prev?.timer) clearTimeout(prev.timer);
    const conn: Conn = {
      status: "connecting",
      error: null,
      tools: [],
      attempt: prev?.attempt ?? 0,
      generation: (prev?.generation ?? 0) + 1,
    };
    this.conns.set(id, conn);
    this.opts.onStatus?.(id);
    const gen = conn.generation;
    const alive = () => this.conns.get(id)?.generation === gen && !this.closed;
    void this.openClient(
      row,
      () => {
        if (!alive()) return;
        conn.status = "failed";
        conn.error = "连接已断开";
        conn.client = undefined;
        conn.tools = [];
        this.emitTools();
        this.scheduleRetry(id, conn);
      },
      () => {
        if (!alive() || !conn.client) return;
        void conn.client
          .listTools()
          .then((r) => {
            if (!alive()) return;
            conn.tools = r.tools as RemoteTool[];
            this.emitTools();
          })
          .catch(() => {});
      },
    )
      .then(({ client, tools }) => {
        if (!alive()) {
          void client.close().catch(() => {});
          return;
        }
        conn.client = client;
        conn.tools = tools;
        conn.status = "connected";
        conn.error = null;
        conn.attempt = 0;
        this.opts.log?.("mcp.connected", { server: row.name, tools: tools.length });
        this.emitTools();
      })
      .catch((err: unknown) => {
        if (!alive()) return;
        conn.status = "failed";
        conn.error = err instanceof Error ? err.message : String(err);
        this.opts.log?.("mcp.failed", { server: row.name });
        this.opts.onStatus?.(id);
        this.scheduleRetry(id, conn);
      });
  }

  private scheduleRetry(id: string, conn: Conn): void {
    if (this.closed) return;
    conn.attempt += 1;
    const wait = Math.min(1000 * 2 ** (conn.attempt - 1), MAX_BACKOFF_MS);
    conn.timer = setTimeout(() => this.connect(id), wait);
    conn.timer.unref?.();
  }

  private async disconnect(id: string): Promise<void> {
    const conn = this.conns.get(id);
    if (!conn) return;
    if (conn.timer) clearTimeout(conn.timer);
    conn.generation += 1;
    const client = conn.client;
    conn.client = undefined;
    conn.tools = [];
    conn.status = "disabled";
    await client?.close().catch(() => {});
  }

  /** POST /{id}/test：用当前保存的配置临时连接一次，列出工具后断开。 */
  async test(id: string): Promise<{ ok: boolean; tools?: McpServer["tools"]; error?: string }> {
    const row = this.row(id);
    if (!row) return { ok: false, error: "服务器不存在" };
    try {
      const { client, tools } = await this.openClient(row);
      await client.close().catch(() => {});
      const auto = new Set(this.autoApproveOf(row));
      return {
        ok: true,
        tools: tools.map((t) => ({
          name: t.name,
          qualifiedName: qualifiedToolName(row.name, t.name),
          description: t.description ?? "",
          readOnly: t.annotations?.readOnlyHint === true,
          autoApprove: auto.has(t.name),
        })),
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ---------- 工具桥接 ----------

  /** 当前全部已连接服务器的工具定义。 */
  toolDefinitions(): ToolDefinition[] {
    const out: ToolDefinition[] = [];
    for (const row of this.rows()) {
      const conn = this.conns.get(row.id);
      if (!conn || conn.status !== "connected") continue;
      const cfg = JSON.parse(row.config) as McpConfig;
      for (const t of conn.tools)
        out.push(this.toolDef(row.id, row.name, t, cfg.callTimeoutSeconds));
    }
    return out;
  }

  private emitTools(): void {
    this.opts.onToolsChanged(this.toolDefinitions());
    for (const id of this.conns.keys()) this.opts.onStatus?.(id);
  }

  private toolDef(
    serverId: string,
    serverName: string,
    tool: RemoteTool,
    timeoutS?: number,
  ): ToolDefinition {
    const readOnly = tool.annotations?.readOnlyHint === true;
    const timeoutMs = (timeoutS ?? DEFAULT_CALL_TIMEOUT_S) * 1000;
    const schema = { type: "object", properties: {}, ...tool.inputSchema };
    return {
      name: qualifiedToolName(serverName, tool.name),
      title: `${serverName} · ${tool.annotations?.title ?? tool.name}`,
      description: `［MCP 服务器 ${serverName}］${tool.description ?? tool.name}`.slice(0, 2000),
      input: z.record(z.string(), z.unknown()) as z.ZodType<unknown>,
      inputJsonSchema: schema,
      output: z.unknown(),
      effect: readOnly ? "read" : "external",
      externalTransport: true,
      targets: () => [],
      replay: readOnly ? "safe" : "unknown",
      timeoutMs,
      // 06 §8：reader 只能用只读 MCP 工具
      roles: readOnly ? ["main", "lead", "worker", "reader"] : ["main", "lead", "worker"],
      autoApproved: () => {
        const row = this.row(serverId);
        return row ? this.autoApproveOf(row).includes(tool.name) : false;
      },
      execute: async (args, ctx) => {
        const access=currentToolAccess() ?? ctx.access;
        const contractRequired=access
          ? hasTaskContractRequirement(access.db,access.sessionId,access.originAgentId,access.originTurnId)
          : hasTaskContractRequirement(this.db,ctx.sessionId,ctx.agentId,ctx.turnId ?? "missing-tool-turn");
        if(contractRequired)return {status:"error",error:{code:"UNSUPPORTED_FEATURE",
          message:"当前任务不支持向外部MCP服务传送业务参数；只读提示或普通批准不能授予外发权限。",retryable:false}};
        const conn = this.conns.get(serverId);
        if (!conn?.client || conn.status !== "connected") {
          return mcpError(
            `MCP 服务器 ${serverName} 未连接${conn?.error ? `：${conn.error}` : ""}`,
            true,
          );
        }
        try {
          const res = await conn.client.callTool(
            { name: tool.name, arguments: (args ?? {}) as Record<string, unknown> },
            undefined,
            { signal: ctx.signal, timeout: timeoutMs },
          );
          return toToolResult(res as CallResult);
        } catch (err) {
          if (ctx.signal.aborted)
            return {
              status: "error",
              error: { code: "TIMEOUT", message: "MCP 工具调用超时或被取消", retryable: true },
            };
          return mcpError(err instanceof Error ? err.message : String(err), true);
        }
      },
    } as ToolDefinition;
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.conns.keys()].map((id) => this.disconnect(id)));
  }
}

export class McpConfigError extends Error {}

interface CallResult {
  content?: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
    resource?: { text?: string; uri?: string };
  }>;
  structuredContent?: unknown;
  isError?: boolean;
}

function mcpError(message: string, retryable: boolean): ToolResult {
  return { status: "error", error: { code: "EXTERNAL_ERROR", message, retryable } };
}

/** 06 §2.3 截断 + 图片作为视觉输入。 */
export function toToolResult(res: CallResult): ToolResult {
  const texts: string[] = [];
  const images: { mediaType: string; data: string }[] = [];
  for (const part of res.content ?? []) {
    if (part.type === "text" && typeof part.text === "string") texts.push(part.text);
    else if (part.type === "image" && part.data)
      images.push({ mediaType: part.mimeType ?? "image/png", data: part.data });
    else if (part.type === "resource" && part.resource?.text) texts.push(part.resource.text);
    else if (part.type === "resource_link" || part.type === "resource")
      texts.push(`[资源] ${part.resource?.uri ?? ""}`);
  }
  let text = texts.join("\n");
  if (text === "" && res.structuredContent !== undefined)
    text = JSON.stringify(res.structuredContent);
  const total = text.length;
  const truncated = total > MAX_RESULT_CHARS;
  if (truncated) text = text.slice(0, MAX_RESULT_CHARS);
  if (res.isError) return mcpError(text || "MCP 工具返回错误", false);
  return {
    status: "ok",
    data: { text },
    ...(truncated ? { truncated: { shown: MAX_RESULT_CHARS, total, cursor: "" } } : {}),
    ...(images.length > 0 ? { images } : {}),
  };
}

export interface McpModule extends CapabilityModule {
  service: McpService;
}

export function mcpModule(db: DatabaseSync, opts: McpServiceOptions): McpModule {
  return { id: "mcp", migrations: [MCP_MIGRATION], service: new McpService(db, opts) };
}
