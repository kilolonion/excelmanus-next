// 文件信息：基本属性、本会话的改动标记、来源与修改历史，以及这份文件的修改前备份（可另存、替换回原文件、删除）。

import type { BackupEntry, FileEntry, FileEvent } from "@excelmanus/protocol";
import {
  Archive,
  Bot,
  Columns2,
  Download,
  FilePlus2,
  History,
  Info,
  Loader2,
  PencilLine,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { OverlayCard, OverlayCardBody, OverlayCardHeader } from "@/components/ui/overlay-card";
import { api, errorMessage } from "@/lib/backend/api";
import { classifyWorkspaceFile } from "@/lib/file-kind";
import { normalizePath, samePath } from "@/lib/paths";
import { useChatStore } from "@/stores/chat-store";
import { selectSession, useSessionStore } from "@/stores/session-store";
import { useUIStore } from "@/stores/ui-store";
import {
  deleteBackupWithConfirm,
  listFileBackups,
  restoreBackupWithConfirm,
  saveBackupAs,
} from "./file-actions";
import { formatBytes, formatTime } from "./file-tree-helpers";
import { SESSION_MARK_LABEL, useSessionFileMarks } from "./session-file-marks";

const KIND_LABELS: Record<string, string> = {
  spreadsheet: "表格",
  "legacy-spreadsheet": "旧版表格",
  image: "图片",
  text: "文本",
  binary: "其他",
};

interface FileInfoDialogProps {
  entry: FileEntry | null;
  onOpenChange: (open: boolean) => void;
}

export function BackupRow({ backup, onChanged }: { backup: BackupEntry; onChanged: () => void }) {
  const session = useSessionStore((s) => s.sessions.find((x) => x.id === backup.sessionId));
  return (
    <div className="group flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-muted/50">
      <History className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-foreground/90">
          {formatTime(backup.createdAt)} · {formatBytes(backup.size)}
        </div>
        <div className="truncate text-[10px] text-muted-foreground">
          {session
            ? `由「${session.title?.trim() || "未命名对话"}」产生`
            : backup.sessionId
              ? "产生它的对话已删除"
              : "文件操作前自动备份"}
        </div>
      </div>
      <button
        type="button"
        aria-label="另存备份"
        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        onClick={() => void saveBackupAs(backup)}
      >
        <Download className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        aria-label="替换回原文件"
        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        onClick={() => void restoreBackupWithConfirm(backup).then((ok) => ok && onChanged())}
      >
        <RotateCcw className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        aria-label="删除备份"
        className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
        onClick={() => void deleteBackupWithConfirm(backup).then((ok) => ok && onChanged())}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  user: "你",
  agent: "代理",
  script: "脚本",
  external: "外部程序",
};

function eventText(e: FileEvent): { icon: ReactNode; title: string } {
  const who = e.source ? (SOURCE_LABEL[e.source] ?? e.source) : "";
  switch (e.kind) {
    case "created":
      return { icon: <FilePlus2 className="h-3.5 w-3.5" />, title: who ? `${who}新建` : "新建" };
    case "backup":
      return { icon: <Archive className="h-3.5 w-3.5" />, title: "生成修改前备份" };
    case "trashed":
      return { icon: <Trash2 className="h-3.5 w-3.5" />, title: "移到回收站" };
    default:
      return {
        icon:
          e.source === "agent" ? (
            <Bot className="h-3.5 w-3.5" />
          ) : (
            <PencilLine className="h-3.5 w-3.5" />
          ),
        title: `${who || "未知来源"}修改`,
      };
  }
}

/** 来源与修改历史（新到旧）：谁在哪个对话里改了哪些区域。点对话名跳过去。 */
function FileHistorySection({ path }: { path: string }) {
  const workspaceId = useChatStore((s) => s.workspaceId);
  const [events, setEvents] = useState<FileEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!workspaceId || !path) return;
    let alive = true;
    setEvents(null);
    setError(null);
    api()
      .fileHistory(workspaceId, path)
      .then((res) => alive && setEvents(res.events))
      .catch((err: unknown) => {
        if (!alive) return;
        setEvents([]);
        setError(errorMessage(err, "历史加载失败"));
      });
    return () => {
      alive = false;
    };
  }, [workspaceId, path]);

  if (!workspaceId) return null;
  return (
    <section className="space-y-2">
      <h4 className="text-xs font-medium tracking-wider text-muted-foreground">来源与修改历史</h4>
      {events === null ? (
        <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> 正在读取…
        </div>
      ) : error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : events.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          还没有记录。文件被打开、修改或备份后会出现在这里。
        </p>
      ) : (
        <ol className="em-file-history -mx-2 max-h-[min(36vh,260px)] overflow-y-auto">
          {events.map((e, i) => {
            const { icon, title } = eventText(e);
            const ranges = e.changes?.ranges ?? [];
            return (
              <li key={`${e.at}:${e.kind}:${e.rev ?? i}`} className="em-file-history-row">
                <span className="em-file-history-icon" data-kind={e.kind} data-source={e.source}>
                  {icon}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="truncate text-[12.5px] text-foreground/90">
                      {title}
                      {e.rev !== undefined ? (
                        <span className="ml-1 text-muted-foreground">· 第 {e.rev} 版</span>
                      ) : null}
                    </span>
                    <span className="ml-auto flex-shrink-0 text-[10.5px] tabular-nums text-muted-foreground">
                      {formatTime(e.at)}
                    </span>
                  </div>
                  {(ranges.length > 0 || e.sessionId) && (
                    <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10.5px] text-muted-foreground">
                      {ranges.length > 0 && (
                        <span className="truncate font-mono" title={ranges.join("、")}>
                          {ranges.slice(0, 3).join("、")}
                          {ranges.length > 3 ? ` 等 ${ranges.length} 处` : ""}
                        </span>
                      )}
                      {e.sessionId && (
                        <button
                          type="button"
                          className="em-file-history-session"
                          onClick={() =>
                            void selectSession(e.sessionId as string).catch(() => undefined)
                          }
                        >
                          {e.sessionTitle?.trim() || "未命名对话"}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

export function FileInfoDialog({ entry, onOpenChange }: FileInfoDialogProps) {
  const [backups, setBackups] = useState<BackupEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const marks = useSessionFileMarks();
  const path = entry?.path ?? "";

  const load = useCallback(async () => {
    if (!path) return;
    setError(null);
    try {
      const all = await listFileBackups();
      setBackups(all.filter((b) => samePath(b.originalPath, path)));
    } catch (err) {
      setBackups([]);
      setError(errorMessage(err, "备份列表加载失败"));
    }
  }, [path]);

  useEffect(() => {
    setBackups(null);
    void load();
  }, [load]);

  const mark = entry ? marks.get(normalizePath(entry.path)) : undefined;

  return (
    <OverlayCard open={entry !== null} onOpenChange={onOpenChange} size="md" tone="muted">
      <OverlayCardHeader
        icon={<Info className="h-5 w-5" />}
        title="文件信息"
        description={<span className="block break-all font-mono text-xs">{path}</span>}
        onClose={() => onOpenChange(false)}
      />
      <OverlayCardBody className="pb-5">
        {entry && (
          <div className="space-y-4">
            <section className="space-y-2">
              <h4 className="text-xs font-medium tracking-wider text-muted-foreground">基本信息</h4>
              <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[13px]">
                <span className="text-muted-foreground">文件名</span>
                <span className="truncate font-medium">{entry.name}</span>
                <span className="text-muted-foreground">类型</span>
                <span>
                  <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
                    {KIND_LABELS[classifyWorkspaceFile(entry.name)] ?? "其他"}
                  </Badge>
                </span>
                <span className="text-muted-foreground">大小</span>
                <span>{formatBytes(entry.size)}</span>
                <span className="text-muted-foreground">修改时间</span>
                <span>{formatTime(entry.modifiedAt)}</span>
                {entry.openedAt && (
                  <>
                    <span className="text-muted-foreground">最近打开</span>
                    <span>{formatTime(entry.openedAt)}</span>
                  </>
                )}
                {mark && (
                  <>
                    <span className="text-muted-foreground">本会话</span>
                    <span>{SESSION_MARK_LABEL[mark]}</span>
                  </>
                )}
              </div>
            </section>

            {classifyWorkspaceFile(entry.name) === "spreadsheet" && (
              <button
                type="button"
                className="em-file-info-action"
                onClick={() => {
                  onOpenChange(false);
                  useUIStore.getState().openCompare(entry.path);
                }}
              >
                <Columns2 className="h-3.5 w-3.5" />
                与另一个表格对比…
              </button>
            )}

            <FileHistorySection path={path} />

            <section className="space-y-2">
              <h4 className="text-xs font-medium tracking-wider text-muted-foreground">
                修改前备份
              </h4>
              {backups === null ? (
                <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> 正在读取…
                </div>
              ) : error ? (
                <p role="alert" className="text-xs text-destructive">
                  {error}
                </p>
              ) : backups.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  这份文件还没有备份。代理在会话中首次修改已有文件前会自动备份。
                </p>
              ) : (
                <div className="-mx-2 max-h-[min(40vh,280px)] overflow-y-auto">
                  {backups.map((b) => (
                    <BackupRow key={b.id} backup={b} onChanged={() => void load()} />
                  ))}
                </div>
              )}
            </section>
          </div>
        )}
      </OverlayCardBody>
    </OverlayCard>
  );
}
