import type { BackupEntry, Workspace } from "@excelmanus/protocol";
import {
  ArchiveRestore,
  DatabaseBackup,
  Download,
  Folder,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Loader2,
  Pencil,
  Star,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { BackupPreviewButton } from "@/components/files/BackupPreviewButton";
import { AddWorkspaceDialog } from "@/components/sidebar/AddWorkspaceDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { confirmAction } from "@/components/ui/confirm-dialog";
import { toast } from "@/components/ui/toaster";
import { createDateLabels } from "@/lib/date-labels";
import { api, desktop, errorMessage, saveBlob } from "@/lib/backend/api";
import { onAppEvent, removeWorkspace, setDefaultWorkspace, useAppStore } from "@/stores/app-store";
import { GlassSelect } from "./model/form-widgets";
import { SettingsEntityCard } from "./SettingsEntityCard";
import { SettingsPageLayout, SettingsPagePanel, SettingsPageSubnav } from "./SettingsPageLayout";

type BackupKind = "backups" | "trash";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function WorkspaceList() {
  const workspaces = useAppStore((s) => s.workspaces);
  const [dialog, setDialog] = useState<{ open: boolean; workspace: Workspace | null }>({
    open: false,
    workspace: null,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const bridge = desktop();

  async function run(id: string, action: () => Promise<void>, failTitle: string) {
    setBusy(id);
    try {
      await action();
    } catch (error) {
      toast({ title: failTitle, description: errorMessage(error), tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function handleRemove(ws: Workspace) {
    const ok = await confirmAction({
      title: `移除工作区「${ws.name}」`,
      description: "只移除登记，不会删除磁盘上的文件。仍有任务使用该工作区时无法移除。",
      confirmLabel: "移除",
      tone: "danger",
    });
    if (ok) await run(ws.id, () => removeWorkspace(ws.id), "移除失败");
  }

  return (
    <SettingsPagePanel>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <Folder className="mt-0.5 h-4 w-4 text-[var(--em-primary)]" />
          <div>
            <h3 className="text-[13px] font-semibold">工作区</h3>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Agent 只能读写已登记文件夹内的文件。默认工作区用于新建任务。
            </p>
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-8 shrink-0 gap-1 text-xs"
          onClick={() => setDialog({ open: true, workspace: null })}
        >
          <FolderPlus className="h-3.5 w-3.5" />
          添加
        </Button>
      </div>
      <div className="space-y-2">
        {workspaces.length === 0 && (
          <p className="rounded-xl border border-dashed py-6 text-center text-xs text-muted-foreground">
            还没有登记工作区
          </p>
        )}
        {workspaces.map((ws) => (
          <SettingsEntityCard
            key={ws.id}
            name={ws.name}
            icon={<FolderOpen className="h-4 w-4 text-muted-foreground" />}
            badges={
              ws.isDefault ? (
                <Badge variant="secondary" className="text-[10px]">
                  默认
                </Badge>
              ) : null
            }
            description={<span className="font-mono break-all">{ws.path}</span>}
            actions={
              busy === ws.id ? (
                <Loader2 className="m-1.5 h-3.5 w-3.5 animate-spin text-muted-foreground" />
              ) : (
                <>
                  {!ws.isDefault && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      title="设为默认"
                      aria-label="设为默认"
                      onClick={() => void run(ws.id, () => setDefaultWorkspace(ws.id), "设置失败")}
                    >
                      <Star className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  {bridge && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      title="在文件夹中显示"
                      aria-label="在文件夹中显示"
                      onClick={() => bridge.showInFolder(ws.id, "")}
                    >
                      <HardDrive className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    title="编辑"
                    aria-label="编辑"
                    onClick={() => setDialog({ open: true, workspace: ws })}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-destructive"
                    title="移除"
                    aria-label="移除"
                    onClick={() => void handleRemove(ws)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </>
              )
            }
          />
        ))}
      </div>
      <AddWorkspaceDialog
        open={dialog.open}
        workspace={dialog.workspace}
        onOpenChange={(open) => setDialog((d) => ({ ...d, open }))}
      />
    </SettingsPagePanel>
  );
}

function BackupPanel() {
  const formatTime = createDateLabels({
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const workspaces = useAppStore((s) => s.workspaces);
  const [workspaceId, setWorkspaceId] = useState<string>(
    () => workspaces.find((w) => w.isDefault)?.id ?? workspaces[0]?.id ?? "",
  );
  const [kind, setKind] = useState<BackupKind>("backups");
  const [items, setItems] = useState<BackupEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const readScope = useRef<{ workspaceId: string; kind: BackupKind } | null>(null);
  const readRequest = useRef(0);

  useEffect(() => {
    if (!workspaces.some((w) => w.id === workspaceId)) setWorkspaceId(workspaces[0]?.id ?? "");
  }, [workspaces, workspaceId]);

  const load = useCallback(async () => {
    const scope = readScope.current;
    if (!scope || scope.workspaceId !== workspaceId || scope.kind !== kind) return;
    const request = ++readRequest.current;
    setLoadError(null);
    const isCurrent = () => readScope.current === scope && readRequest.current === request;
    if (!workspaceId) {
      setItems([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await api().listBackups(workspaceId, kind);
      if (!isCurrent()) return;
      setItems([...res.items].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    } catch (error) {
      if (!isCurrent()) return;
      setItems([]);
      setLoadError(errorMessage(error, "备份列表读取失败"));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [workspaceId, kind]);

  useEffect(() => {
    readScope.current = { workspaceId, kind };
    void load();
    return () => {
      readScope.current = null;
      readRequest.current += 1;
    };
  }, [load, workspaceId, kind]);

  useEffect(
    () =>
      onAppEvent((event) => {
        if (event.type === "files.changed" && event.workspaceId === workspaceId) void load();
      }),
    [load, workspaceId],
  );

  async function restore(entry: BackupEntry) {
    const ok = await confirmAction({
      title: "恢复文件",
      description: `将「${entry.originalPath}」恢复到原位置。若原位置已有文件，当前版本会先存入备份区。`,
      confirmLabel: "恢复",
    });
    if (!ok) return;
    setBusy(entry.id);
    try {
      const res = await api().restoreBackup(workspaceId, kind, entry.id);
      toast({ title: "已恢复", description: res.path, tone: "success" });
      await load();
    } catch (error) {
      toast({ title: "恢复失败", description: errorMessage(error), tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function download(entry: BackupEntry) {
    setBusy(entry.id);
    try {
      const blob = await api().downloadBackup(workspaceId, kind, entry.id);
      saveBlob(blob, entry.originalPath.split("/").pop() || "backup");
    } catch (error) {
      toast({ title: "下载失败", description: errorMessage(error), tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function remove(entry: BackupEntry) {
    const ok = await confirmAction({
      title: "永久删除",
      description: `「${entry.originalPath}」的这份副本将被永久删除，无法恢复。`,
      confirmLabel: "删除",
      tone: "danger",
    });
    if (!ok) return;
    setBusy(entry.id);
    try {
      await api().deleteBackup(workspaceId, kind, entry.id);
      setItems((prev) => prev.filter((i) => i.id !== entry.id));
    } catch (error) {
      toast({ title: "删除失败", description: errorMessage(error), tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <SettingsPagePanel>
      <div className="mb-3 flex items-start gap-2">
        <DatabaseBackup className="mt-0.5 h-4 w-4 text-[var(--em-primary)]" />
        <div>
          <h3 className="text-[13px] font-semibold">备份与回收站</h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Agent 覆盖文件前会自动备份，删除的文件进入回收站，可随时恢复或下载。
          </p>
        </div>
      </div>
      {workspaces.length === 0 ? (
        <p className="rounded-xl border border-dashed py-6 text-center text-xs text-muted-foreground">
          添加工作区后可在这里查看备份
        </p>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="sm:w-56">
              <GlassSelect
                ariaLabel="选择工作区"
                align="start"
                value={workspaceId}
                options={workspaces.map((w) => ({ value: w.id, label: w.name }))}
                onChange={setWorkspaceId}
              />
            </div>
            <SettingsPageSubnav
              label="备份类型"
              showHeader={false}
              className="flex-1"
              activeKey={kind}
              onChange={(key) => setKind(key as BackupKind)}
              items={[
                {
                  key: "backups",
                  label: "修改前备份",
                  icon: <DatabaseBackup className="h-3 w-3" />,
                },
                { key: "trash", label: "回收站", icon: <Trash2 className="h-3 w-3" /> },
              ]}
            />
          </div>
          {loading ? (
            <div
              role="status"
              className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground"
            >
              <Loader2 className="h-5 w-5 animate-spin" />
              {kind === "backups" ? "正在读取备份…" : "正在读取回收站…"}
            </div>
          ) : loadError ? (
            <div role="alert" className="flex items-center gap-2 py-4 text-xs text-destructive">
              <span className="min-w-0 flex-1">{loadError}</span>
              <Button size="sm" variant="outline" onClick={() => void load()}>
                重新读取
              </Button>
            </div>
          ) : items.length === 0 ? (
            <p className="rounded-xl border border-dashed py-6 text-center text-xs text-muted-foreground">
              {kind === "backups" ? "暂无备份" : "回收站是空的"}
            </p>
          ) : (
            <div className="space-y-1.5">
              {items.map((entry) => (
                <div
                  key={entry.id}
                  className="flex items-center gap-2 rounded-lg border border-border px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-xs" title={entry.originalPath}>
                      {entry.originalPath}
                    </p>
                    <p className="mt-0.5 text-[10px] text-muted-foreground">
                      {formatTime(entry.createdAt)} · {formatSize(entry.size)}
                    </p>
                  </div>
                  {busy === entry.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                  ) : (
                    <div className="flex shrink-0 gap-0.5">
                      <BackupPreviewButton workspaceId={workspaceId} entry={entry} />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        title="恢复"
                        aria-label="恢复"
                        onClick={() => void restore(entry)}
                      >
                        <ArchiveRestore className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        title="下载"
                        aria-label="下载"
                        onClick={() => void download(entry)}
                      >
                        <Download className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive"
                        title="永久删除"
                        aria-label="永久删除"
                        onClick={() => void remove(entry)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </SettingsPagePanel>
  );
}

export function WorkspaceTab() {
  const dataDir = useAppStore((s) => s.dataDir);
  return (
    <SettingsPageLayout className="space-y-4 pb-2">
      <WorkspaceList />
      <BackupPanel />
      {dataDir && (
        <SettingsPagePanel>
          <h3 className="text-[13px] font-semibold">本机数据目录</h3>
          <p className="mt-1 text-[11px] text-muted-foreground">
            会话记录、设置与加密保存的密钥都在这里。迁移或备份时请复制整个目录。
          </p>
          <p className="mt-2 break-all rounded-lg bg-muted/40 px-3 py-2 font-mono text-[11px]">
            {dataDir}
          </p>
        </SettingsPagePanel>
      )}
    </SettingsPageLayout>
  );
}
