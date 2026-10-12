import type {
  CreateMcpServerBody,
  McpServer,
  McpServerConfig,
  McpStatus,
  McpTransport,
} from "@excelmanus/protocol";
import {
  CheckCircle2,
  Circle,
  Globe,
  Loader2,
  Pencil,
  Plus,
  Radio,
  RefreshCw,
  Save,
  ShieldCheck,
  Terminal,
  Trash2,
  X,
  XCircle,
  Zap,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { SettingsEntityCard } from "@/components/settings/SettingsEntityCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { confirmAction } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toaster";
import { api, errorMessage } from "@/lib/backend/api";
import { onAppEvent } from "@/stores/app-store";
import { GlassSelect } from "./model/form-widgets";

interface ServerFormData {
  name: string;
  transport: McpTransport;
  command: string;
  args: string;
  env: string;
  cwd: string;
  url: string;
  headers: string;
  timeout: string;
}

const EMPTY_FORM: ServerFormData = {
  name: "",
  transport: "stdio",
  command: "",
  args: "",
  env: "",
  cwd: "",
  url: "",
  headers: "",
  timeout: "",
};

const TRANSPORT_ICONS: Record<McpTransport, ReactNode> = {
  stdio: <Terminal className="h-3.5 w-3.5" />,
  http: <Globe className="h-3.5 w-3.5" />,
};

const TRANSPORT_LABELS: Record<McpTransport, string> = {
  stdio: "stdio",
  http: "Streamable HTTP",
};

const STATUS_ICONS: Record<McpStatus, ReactNode> = {
  connected: <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />,
  failed: <XCircle className="h-3.5 w-3.5 text-red-500" />,
  connecting: <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />,
  disabled: <Circle className="h-3.5 w-3.5 text-muted-foreground" />,
};

const STATUS_LABELS: Record<McpStatus, string> = {
  connected: "已连接",
  failed: "连接失败",
  connecting: "连接中",
  disabled: "已停用",
};

const STATUS_COLORS: Record<McpStatus, string> = {
  connected: "text-green-600 dark:text-green-400",
  failed: "text-red-600 dark:text-red-400",
  connecting: "text-muted-foreground",
  disabled: "text-muted-foreground",
};

/** KEY=VALUE 每行一个（也接受 JSON 对象）。 */
function parsePairs(text: string, label: string): Record<string, string> | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
    } catch {
      throw new Error(`${label}不是合法的 JSON`);
    }
  }
  const out: Record<string, string> = {};
  for (const line of trimmed.split("\n")) {
    const row = line.trim();
    if (!row) continue;
    const sep = row.indexOf(label === "Headers" ? ":" : "=");
    if (sep <= 0)
      throw new Error(`${label}格式应为 ${label === "Headers" ? "Name: Value" : "KEY=VALUE"}`);
    out[row.slice(0, sep).trim()] = row.slice(sep + 1).trim();
  }
  return out;
}

function formatPairs(record: Record<string, string> | undefined, sep: string): string {
  return record
    ? Object.entries(record)
        .map(([k, v]) => `${k}${sep}${v}`)
        .join("\n")
    : "";
}

function formToConfig(form: ServerFormData): McpServerConfig {
  const config: McpServerConfig = {};
  if (form.transport === "stdio") {
    if (!form.command.trim()) throw new Error("请填写启动命令");
    config.command = form.command.trim();
    const args = form.args
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (args.length) config.args = args;
    const env = parsePairs(form.env, "Env");
    if (env) config.env = env;
    if (form.cwd.trim()) config.cwd = form.cwd.trim();
  } else {
    if (!form.url.trim()) throw new Error("请填写服务地址");
    config.url = form.url.trim();
    const headers = parsePairs(form.headers, "Headers");
    if (headers) config.headers = headers;
  }
  const timeout = Number(form.timeout);
  if (form.timeout.trim()) {
    if (!Number.isInteger(timeout) || timeout <= 0 || timeout > 3600)
      throw new Error("超时应为 1–3600 秒的整数");
    config.callTimeoutSeconds = timeout;
  }
  return config;
}

function serverToForm(server: McpServer): ServerFormData {
  const cfg = server.config;
  return {
    name: server.name,
    transport: server.transport,
    command: cfg.command ?? "",
    args: (cfg.args ?? []).join("\n"),
    env: formatPairs(cfg.env, "="),
    cwd: cfg.cwd ?? "",
    url: cfg.url ?? "",
    headers: formatPairs(cfg.headers, ": "),
    timeout: cfg.callTimeoutSeconds ? String(cfg.callTimeoutSeconds) : "",
  };
}

export function MCPTab() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedServer, setExpandedServer] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editingServer, setEditingServer] = useState<McpServer | null>(null);
  const [createMode, setCreateMode] = useState<"form" | "json">("form");
  const [formDraft, setFormDraft] = useState<ServerFormData>({ ...EMPTY_FORM });
  const [jsonDraft, setJsonDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; msg: string }>>({});

  const fetchServers = useCallback(async () => {
    try {
      const { items } = await api().listMcpServers();
      setServers(items);
    } catch (error) {
      toast({ title: "读取 MCP 服务失败", description: errorMessage(error), tone: "error" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchServers();
  }, [fetchServers]);

  useEffect(
    () =>
      onAppEvent((event) => {
        if (event.type === "mcp.status") void fetchServers();
      }),
    [fetchServers],
  );

  const replaceServer = (server: McpServer) =>
    setServers((prev) => prev.map((s) => (s.id === server.id ? server : s)));

  const handleReload = async () => {
    setReloading(true);
    try {
      await api().reloadMcpServers();
      await fetchServers();
    } catch (error) {
      toast({ title: "重新连接失败", description: errorMessage(error), tone: "error" });
    } finally {
      setReloading(false);
    }
  };

  const handleTest = async (server: McpServer) => {
    setBusy(server.id);
    setTestResult((prev) => {
      const next = { ...prev };
      delete next[server.id];
      return next;
    });
    try {
      const res = await api().testMcpServer(server.id);
      setTestResult((prev) => ({
        ...prev,
        [server.id]: res.ok
          ? { ok: true, msg: `连接成功，发现 ${res.tools?.length ?? 0} 个工具` }
          : { ok: false, msg: res.error || "连接失败" },
      }));
      void fetchServers();
    } catch (error) {
      setTestResult((prev) => ({
        ...prev,
        [server.id]: { ok: false, msg: errorMessage(error, "测试失败") },
      }));
    } finally {
      setBusy(null);
    }
  };

  const handleToggle = async (server: McpServer, enabled: boolean) => {
    setBusy(server.id);
    try {
      const res = await api().updateMcpServer(server.id, { enabled });
      replaceServer(res.server);
    } catch (error) {
      toast({ title: "更新失败", description: errorMessage(error), tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  const handleAutoApprove = async (server: McpServer, toolName: string, on: boolean) => {
    const current = server.tools.filter((t) => t.autoApprove).map((t) => t.name);
    const next = on ? [...new Set([...current, toolName])] : current.filter((n) => n !== toolName);
    replaceServer({
      ...server,
      tools: server.tools.map((t) => (t.name === toolName ? { ...t, autoApprove: on } : t)),
    });
    try {
      const res = await api().updateMcpServer(server.id, { autoApprove: next });
      replaceServer(res.server);
    } catch (error) {
      replaceServer(server);
      toast({ title: "更新失败", description: errorMessage(error), tone: "error" });
    }
  };

  const buildBody = (): CreateMcpServerBody => {
    if (createMode === "json") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonDraft);
      } catch {
        throw new Error("JSON 格式不正确");
      }
      const obj = parsed as {
        name?: string;
        transport?: McpTransport;
        config?: McpServerConfig;
      } & McpServerConfig;
      if (!obj.name) throw new Error("JSON 中缺少 name 字段");
      const { name, transport, config, ...rest } = obj;
      return {
        name,
        transport: transport ?? (rest.url ? "http" : "stdio"),
        config: config ?? rest,
      };
    }
    if (!formDraft.name.trim()) throw new Error("请填写名称");
    return {
      name: formDraft.name.trim(),
      transport: formDraft.transport,
      config: formToConfig(formDraft),
    };
  };

  const closeForm = () => {
    setShowCreate(false);
    setEditingServer(null);
    setFormDraft({ ...EMPTY_FORM });
    setJsonDraft("");
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const body = buildBody();
      if (editingServer) {
        const res = await api().updateMcpServer(editingServer.id, body);
        replaceServer(res.server);
      } else {
        const res = await api().createMcpServer(body);
        setServers((prev) => [...prev, res.server]);
      }
      closeForm();
      void fetchServers();
    } catch (error) {
      toast({
        title: editingServer ? "更新失败" : "创建失败",
        description: errorMessage(error),
        tone: "error",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (server: McpServer) => {
    const ok = await confirmAction({
      title: "删除 MCP 服务",
      description: `确定删除「${server.name}」？`,
      confirmLabel: "删除",
      tone: "danger",
    });
    if (!ok) return;
    const snapshot = servers;
    setServers((prev) => prev.filter((s) => s.id !== server.id));
    try {
      await api().deleteMcpServer(server.id);
    } catch (error) {
      setServers(snapshot);
      toast({ title: "删除失败", description: errorMessage(error), tone: "error" });
    }
  };

  const startEdit = (server: McpServer) => {
    setFormDraft(serverToForm(server));
    setJsonDraft(
      JSON.stringify(
        { name: server.name, transport: server.transport, config: server.config },
        null,
        2,
      ),
    );
    setEditingServer(server);
    setShowCreate(false);
    setCreateMode("form");
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const textareaClass =
    "w-full rounded-md border border-input bg-background px-3 py-1 text-xs font-mono resize-y";

  return (
    <div className="space-y-3">
      <section className="em-plugin-panel space-y-3 rounded-xl border p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2">
            <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--em-primary-alpha-10)] text-[var(--em-primary)]">
              <Terminal className="h-3.5 w-3.5" />
            </div>
            <div className="min-w-0">
              <h4 className="text-sm font-medium">外部 MCP 服务</h4>
              <p className="mt-0.5 text-[10px] text-muted-foreground">
                {servers.length} 个服务 · {servers.filter((s) => s.status === "connected").length}{" "}
                个已连接
              </p>
            </div>
          </div>
          <div className="flex gap-1.5 flex-shrink-0">
            <Button
              size="sm"
              variant="ghost"
              className="h-8 text-xs gap-1 px-2"
              onClick={() => void handleReload()}
              disabled={reloading}
              title="重新连接全部服务"
            >
              {reloading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
              <span className="hidden sm:inline">重新连接</span>
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs gap-1"
              data-coach-id="coach-settings-mcp-add-btn"
              onClick={() => {
                closeForm();
                setShowCreate(true);
                setCreateMode("form");
              }}
            >
              <Plus className="h-3 w-3" />
              新增
            </Button>
          </div>
        </div>

        {(showCreate || editingServer) && (
          <div className="rounded-lg border border-dashed border-border p-3 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium break-words min-w-0">
                {editingServer ? `编辑: ${editingServer.name}` : "新增 MCP 服务"}
              </span>
              <div className="flex gap-1 shrink-0">
                <Button
                  size="sm"
                  variant={createMode === "form" ? "default" : "ghost"}
                  className="h-7 sm:h-6 text-[11px] sm:text-[10px] px-2.5 sm:px-2"
                  onClick={() => setCreateMode("form")}
                >
                  表单
                </Button>
                <Button
                  size="sm"
                  variant={createMode === "json" ? "default" : "ghost"}
                  className="h-7 sm:h-6 text-[11px] sm:text-[10px] px-2.5 sm:px-2"
                  onClick={() => setCreateMode("json")}
                >
                  JSON
                </Button>
              </div>
            </div>

            {createMode === "form" ? (
              <div className="space-y-2">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs text-muted-foreground">名称 *</label>
                    <Input
                      value={formDraft.name}
                      onChange={(e) => setFormDraft((d) => ({ ...d, name: e.target.value }))}
                      className="h-8 text-xs"
                      placeholder="server-name"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground">传输类型</label>
                    <GlassSelect
                      ariaLabel="传输类型"
                      className="h-8"
                      value={formDraft.transport}
                      options={(["stdio", "http"] as const).map((t) => ({
                        value: t,
                        label: TRANSPORT_LABELS[t],
                        icon: TRANSPORT_ICONS[t],
                      }))}
                      onChange={(value) =>
                        setFormDraft((d) => ({ ...d, transport: value as McpTransport }))
                      }
                    />
                  </div>
                </div>

                {formDraft.transport === "stdio" ? (
                  <>
                    <div>
                      <label className="text-xs text-muted-foreground">启动命令 *</label>
                      <Input
                        value={formDraft.command}
                        onChange={(e) => setFormDraft((d) => ({ ...d, command: e.target.value }))}
                        className="h-8 text-xs font-mono"
                        placeholder="npx, uvx, node..."
                      />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground">参数（每行一个）</label>
                      <textarea
                        value={formDraft.args}
                        onChange={(e) => setFormDraft((d) => ({ ...d, args: e.target.value }))}
                        className={`${textareaClass} h-16`}
                        placeholder={"-y\n@modelcontextprotocol/server-xxx"}
                      />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground">
                        环境变量（每行 KEY=VALUE，可选）
                      </label>
                      <textarea
                        value={formDraft.env}
                        onChange={(e) => setFormDraft((d) => ({ ...d, env: e.target.value }))}
                        className={`${textareaClass} h-12`}
                        placeholder="API_KEY=..."
                      />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground">工作目录（可选）</label>
                      <Input
                        value={formDraft.cwd}
                        onChange={(e) => setFormDraft((d) => ({ ...d, cwd: e.target.value }))}
                        className="h-8 text-xs font-mono"
                        placeholder="/path/to/dir"
                      />
                    </div>
                  </>
                ) : (
                  <>
                    <div>
                      <label className="text-xs text-muted-foreground">URL *</label>
                      <Input
                        value={formDraft.url}
                        onChange={(e) => setFormDraft((d) => ({ ...d, url: e.target.value }))}
                        className="h-8 text-xs font-mono"
                        placeholder="http://localhost:3000/mcp"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground">
                        请求头（每行 Name: Value，可选）
                      </label>
                      <textarea
                        value={formDraft.headers}
                        onChange={(e) => setFormDraft((d) => ({ ...d, headers: e.target.value }))}
                        className={`${textareaClass} h-12`}
                        placeholder="Authorization: Bearer ..."
                      />
                    </div>
                  </>
                )}
                {editingServer && (
                  <p className="text-[10px] text-muted-foreground">
                    显示为 •••• 的值保持不变，修改后才会替换。
                  </p>
                )}
                <div className="sm:w-1/2">
                  <label className="text-xs text-muted-foreground">工具调用超时（秒，可选）</label>
                  <Input
                    type="number"
                    value={formDraft.timeout}
                    onChange={(e) => setFormDraft((d) => ({ ...d, timeout: e.target.value }))}
                    className="h-8 text-xs"
                    min={1}
                    max={3600}
                    placeholder="默认"
                  />
                </div>
              </div>
            ) : (
              <textarea
                value={jsonDraft}
                onChange={(e) => setJsonDraft(e.target.value)}
                className={`${textareaClass} h-40 py-2`}
                placeholder={`{
  "name": "my-server",
  "transport": "stdio",
  "config": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-xxx"]
  }
}`}
              />
            )}

            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" className="h-7 text-xs gap-1" onClick={closeForm}>
                <X className="h-3 w-3" /> 取消
              </Button>
              <Button
                size="sm"
                className="h-7 text-xs gap-1 text-white"
                style={{ backgroundColor: "var(--em-primary)" }}
                disabled={saving || (createMode === "form" && !formDraft.name)}
                onClick={() => void handleSave()}
              >
                {saving ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Save className="h-3 w-3" />
                )}
                {editingServer ? "更新" : "创建"}
              </Button>
            </div>
          </div>
        )}

        <div className="space-y-2" data-coach-id="coach-settings-mcp-list">
          {servers.length === 0 && (
            <div className="rounded-xl border border-dashed px-4 py-10 text-center">
              <Radio className="mx-auto h-7 w-7 text-muted-foreground/30" />
              <p className="mt-2 text-xs font-medium text-muted-foreground">还没有外部 MCP 服务</p>
              <p className="mt-1 text-[10px] text-muted-foreground/70">
                支持 stdio 和 Streamable HTTP
              </p>
            </div>
          )}
          {servers.map((server) => (
            <SettingsEntityCard
              key={server.id}
              expandable
              expanded={expandedServer === server.id}
              onClick={() => setExpandedServer(expandedServer === server.id ? null : server.id)}
              icon={STATUS_ICONS[server.status]}
              name={server.name}
              meta={
                <div className="flex items-center gap-1.5 flex-wrap">
                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0 font-mono">
                    {TRANSPORT_ICONS[server.transport]}
                    <span className="ml-1">{TRANSPORT_LABELS[server.transport]}</span>
                  </Badge>
                  {server.tools.length > 0 && (
                    <Badge variant="outline" className="text-[10px] px-1 py-0">
                      {server.tools.length} 工具
                    </Badge>
                  )}
                  <span className={`text-[11px] ${STATUS_COLORS[server.status]}`}>
                    {STATUS_LABELS[server.status]}
                  </span>
                </div>
              }
              actions={
                <>
                  <Switch
                    checked={server.enabled}
                    disabled={busy === server.id}
                    onCheckedChange={(checked) => void handleToggle(server, checked)}
                    aria-label={server.enabled ? "停用服务" : "启用服务"}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    disabled={busy === server.id}
                    onClick={() => void handleTest(server)}
                    title="测试连接"
                  >
                    {busy === server.id ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Zap className="h-3 w-3" />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={() => startEdit(server)}
                    title="编辑"
                  >
                    <Pencil className="h-3 w-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-destructive"
                    onClick={() => void handleDelete(server)}
                    title="删除"
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </>
              }
            >
              {testResult[server.id] && (
                <div
                  className={`px-3 py-1.5 text-xs border-t ${
                    testResult[server.id].ok
                      ? "bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-300"
                      : "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300"
                  }`}
                >
                  {testResult[server.id].ok ? "✓ " : "✗ "}
                  {testResult[server.id].msg}
                </div>
              )}

              {expandedServer === server.id && (
                <div className="border-t border-border px-3 py-2.5 space-y-2 bg-muted/30">
                  {server.error && (
                    <div className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950 rounded p-2">
                      <span className="font-medium">错误: </span>
                      {server.error}
                    </div>
                  )}

                  {server.tools.length > 0 && (
                    <div>
                      <span className="flex items-center gap-1 text-[10px] font-medium text-muted-foreground">
                        <ShieldCheck className="h-3 w-3" />
                        已注册工具（{server.tools.length}）· 开关表示免审批自动执行
                      </span>
                      <div className="mt-1 divide-y divide-border/40 rounded-md border border-border/50 bg-background">
                        {server.tools.map((tool) => (
                          <div key={tool.name} className="flex items-center gap-2 px-2.5 py-1.5">
                            <div className="min-w-0 flex-1">
                              <p className="flex items-center gap-1.5 text-[11px] font-mono">
                                <span className="truncate">{tool.name}</span>
                                {tool.readOnly && (
                                  <Badge variant="outline" className="text-[9px] px-1 py-0">
                                    只读
                                  </Badge>
                                )}
                              </p>
                              {tool.description && (
                                <p
                                  className="truncate text-[10px] text-muted-foreground"
                                  title={tool.description}
                                >
                                  {tool.description}
                                </p>
                              )}
                            </div>
                            <Switch
                              checked={tool.autoApprove}
                              onCheckedChange={(checked) =>
                                void handleAutoApprove(server, tool.name, checked)
                              }
                              aria-label={`${tool.name} 自动批准`}
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div>
                    <span className="text-[10px] font-medium text-muted-foreground">原始配置</span>
                    <pre className="text-[11px] font-mono bg-background rounded p-2 max-h-32 overflow-auto whitespace-pre-wrap border mt-1">
                      {JSON.stringify(server.config, null, 2)}
                    </pre>
                  </div>
                </div>
              )}
            </SettingsEntityCard>
          ))}
        </div>
      </section>
    </div>
  );
}
