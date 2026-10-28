// 修订历史（一代撤销面板）：列出这份工作簿的修订（新到旧），可撤销某一次修改。
// 撤销作为新修订提交；之后有修订改到同一区域时服务端返回 409，不覆盖别人的修改。

import type { DocRevision } from "@excelmanus/protocol";
import { Bot, History, Loader2, PencilLine, Undo2, Workflow } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createFileTimeFormatter } from "@/components/sidebar/file-tree-helpers";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { toast } from "@/components/ui/toaster";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ApiError, api, errorMessage } from "@/lib/backend/api";
import { cn } from "@/lib/utils";
import { findSessionSummary } from "@/lib/session-list-index";
import { useSessionStore } from "@/stores/session-store";
import { useWorkbookStore } from "@/stores/workbook-store";

const SOURCE: Record<string, { label: string; icon: typeof Bot }> = {
  user: { label: "你", icon: PencilLine },
  agent: { label: "代理", icon: Bot },
  script: { label: "脚本", icon: Workflow },
};

function summary(r: DocRevision): string {
  const parts = [
    ...(r.changes.ranges.length ? [r.changes.ranges.slice(0, 2).join("、")] : []),
    ...(r.changes.ranges.length > 2 ? [`等 ${r.changes.ranges.length} 处`] : []),
    ...(r.changes.structural.length ? [r.changes.structural.slice(0, 2).join("、")] : []),
    ...(r.changes.added.length ? [`新增 ${r.changes.added.join("、")}`] : []),
  ];
  if (parts.length) return parts.join(" ");
  const cells = Object.values(r.changes.cellsBySheet).reduce((a, b) => a + b, 0);
  return cells ? `${cells} 个单元格` : "无内容变化";
}

export function RevisionHistory() {
  const doc = useWorkbookStore((s) => s.doc);
  const workspaceId = useWorkbookStore((s) => s.workspaceId);
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="修订历史"
              disabled={!doc}
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground data-[state=open]:bg-[var(--em-primary-alpha-10)] data-[state=open]:text-[var(--em-primary)] dark:hover:bg-white/10"
            >
              <History className="h-3.5 w-3.5" />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6} className="text-xs">
          修订历史
        </TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-[340px] p-0">
        {open && doc && workspaceId && (
          <RevisionList
            key={`${workspaceId}:${doc.docId}`}
            workspaceId={workspaceId}
            docId={doc.docId}
            headRev={doc.rev}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

function RevisionList({
  workspaceId,
  docId,
  headRev,
}: {
  workspaceId: string;
  docId: string;
  headRev: number;
}) {
  const [items, setItems] = useState<DocRevision[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [undoing, setUndoing] = useState<number | null>(null);
  const sessions = useSessionStore((s) => s.sessions);
  const rows = useMemo(
    () =>
      (items ?? []).map((r) => ({
        revision: r,
        detail: r.revertedBy !== null ? `已被第 ${r.revertedBy} 版撤销` : summary(r),
        ranges: r.changes.ranges.join("、"),
      })),
    [items],
  );
  const formatTime = createFileTimeFormatter();
  const active = useRef(false);
  const readRequest = useRef(0);

  const load = useCallback(async () => {
    if (!active.current) return;
    const request = ++readRequest.current;
    const isCurrent = () => active.current && request === readRequest.current;
    try {
      const res = await api().listDocRevisions(workspaceId, docId, { limit: 50 });
      if (!isCurrent()) return;
      setItems(res.items);
      setError(null);
    } catch (err) {
      if (!isCurrent()) return;
      setItems([]);
      setError(errorMessage(err, "修订历史加载失败"));
    }
  }, [workspaceId, docId]);

  // 文档前进（自己或别人提交、撤销完成）后刷新列表
  // biome-ignore lint/correctness/useExhaustiveDependencies: headRev 只作刷新信号
  useEffect(() => {
    active.current = true;
    void load();
    return () => {
      active.current = false;
      readRequest.current += 1;
    };
  }, [load, headRev]);

  const undo = async (rev: number) => {
    setUndoing(rev);
    try {
      const res = await api().undoDocRevision(workspaceId, docId, rev);
      toast({ title: `已撤销第 ${rev} 版`, description: `作为第 ${res.rev} 版保存，可再次撤销。` });
      await load();
    } catch (err) {
      toast({
        tone: "error",
        title: "无法撤销",
        description:
          err instanceof ApiError && err.status === 409
            ? "之后的修改动到了同一区域或表结构。先撤销更新的修订，或手动改回。"
            : errorMessage(err),
      });
    } finally {
      setUndoing(null);
    }
  };

  return (
    <div className="flex max-h-[min(60vh,440px)] flex-col">
      <div className="border-b border-[var(--em-hairline)] px-3.5 py-2.5">
        <div className="text-[13px] font-semibold">修订历史</div>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          撤销会生成一个新版本，不会丢掉之后的修改。
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {items === null ? (
          <div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> 正在读取…
          </div>
        ) : error ? (
          <div role="alert" className="flex items-center gap-2 px-2 py-3 text-xs text-destructive">
            <span className="min-w-0 flex-1">{error}</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setItems(null);
                setError(null);
                void load();
              }}
            >
              重新读取
            </Button>
          </div>
        ) : items.length === 0 ? (
          <p className="px-2 py-3 text-xs text-muted-foreground">
            还没有修订。打开后的每次修改都会记在这里。
          </p>
        ) : (
          <ol className="space-y-0.5">
            {rows.map(({ revision: r, detail, ranges }) => {
              const src = SOURCE[r.source.kind] ?? { label: r.source.kind, icon: PencilLine };
              const Icon = r.reverts ? Undo2 : src.icon;
              const reverted = r.revertedBy !== null;
              const session = findSessionSummary(sessions, r.sessionId);
              return (
                <li key={r.rev} className={cn("em-rev-row", reverted && "is-reverted")}>
                  <span className="em-rev-icon" data-source={r.source.kind}>
                    <Icon className="h-3.5 w-3.5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-1.5">
                      <span className="shrink-0 whitespace-nowrap text-[12.5px] font-medium">
                        第 {r.rev} 版
                      </span>
                      <span className="truncate text-[11px] text-muted-foreground">
                        {r.reverts ? `撤销第 ${r.reverts} 版` : `${src.label}修改`}
                        {session ? ` · ${session.title?.trim() || "未命名对话"}` : ""}
                      </span>
                      <span className="ml-auto shrink-0 text-[10.5px] tabular-nums text-muted-foreground">
                        {formatTime(r.createdAt)}
                      </span>
                    </div>
                    <div
                      className="mt-0.5 truncate font-mono text-[10.5px] text-muted-foreground"
                      title={ranges}
                    >
                      {detail}
                    </div>
                  </div>
                  {!reverted && (
                    <button
                      type="button"
                      className="em-rev-undo"
                      disabled={undoing !== null}
                      onClick={() => void undo(r.rev)}
                      aria-label={`撤销第 ${r.rev} 版`}
                    >
                      {undoing === r.rev ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Undo2 className="h-3 w-3" />
                      )}
                      撤销
                    </button>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}
