// 「变更」页签：只依据已提交结果（workbook_edit 的结果与轮次变更摘要）逐处定位；
// 每处显示修订号、改动格数、首格的「修改前 → 现在」，有修改前备份时可整文件还原。

import { formatRange, parseRange } from "@excelmanus/core";
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  History,
  LocateFixed,
  RotateCcw,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { confirmAction } from "@/components/ui/confirm-dialog";
import { toast } from "@/components/ui/toaster";
import { api, errorMessage } from "@/lib/backend/api";
import { fileName } from "@/lib/paths";
import { cn } from "@/lib/utils";
import { readComparisonSnapshot, readRevisionBefore } from "@/lib/workbook/change-reads";
import { useChangeNavigation } from "@/lib/workbook/use-overlay-data";
import { focusRange, openWorkbook, useWorkbookStore } from "@/stores/workbook-store";

function show(value: unknown): string {
  return value === null || value === undefined || value === "" ? "（空）" : String(value);
}

/**
 * 该修订首格的「修改前 → 现在」：修改前取自服务端逆操作，现在取自当前快照。
 */
export function BeforeAfter({
  workspaceId,
  docId,
  rev,
  range,
}: {
  workspaceId: string;
  docId: string;
  rev: number;
  range: string;
}) {
  const currentRev = useWorkbookStore((s) => (s.doc?.docId === docId ? s.doc.rev : null));
  const [cell, setCell] = useState<{ before: string; after: string; ref: string } | "same" | null>(
    null,
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    setCell(null);
    setLoadError(null);
    let p: ReturnType<typeof parseRange>;
    try {
      p = parseRange(range);
    } catch {
      return;
    }
    void Promise.all([
      readRevisionBefore(workspaceId, docId, rev),
      readComparisonSnapshot(workspaceId, docId, currentRev, attempt > 0),
    ])
      .then(([res, current]) => {
        if (!alive) return;
        // 逆操作为空：这次写入的值与原值相同
        if (res.cells.length === 0) {
          setCell("same");
          return;
        }
        const hit = res.cells.find(
          (c) =>
            c.row === p.startRow - 1 &&
            c.col === p.startCol - 1 &&
            (!p.sheet || c.sheet === p.sheet),
        );
        if (!hit) return;
        const sheets =
          (
            current.snapshot as {
              sheets?: Record<
                string,
                {
                  name?: string;
                  cellData?: Record<string, Record<string, { v?: unknown; f?: unknown }>>;
                }
              >;
            } | null
          )?.sheets ?? {};
        const sh = Object.values(sheets).find((x) => x.name === hit.sheet);
        const now = sh?.cellData?.[String(hit.row)]?.[String(hit.col)];
        setCell({
          before: hit.formula ?? show(hit.value),
          after: typeof now?.f === "string" && now.f ? now.f : show(now?.v),
          ref: formatRange({
            startCol: hit.col + 1,
            startRow: hit.row + 1,
            endCol: hit.col + 1,
            endRow: hit.row + 1,
          }),
        });
      })
      .catch((error: unknown) => {
        if (alive) setLoadError(errorMessage(error, "修改前后值读取失败"));
      });
    return () => {
      alive = false;
    };
  }, [workspaceId, docId, rev, range, currentRev, attempt]);
  if (loadError)
    return (
      <span
        role="alert"
        className="inline-flex min-w-0 items-center gap-2 text-xs text-muted-foreground"
      >
        <span className="truncate" title={loadError}>
          {loadError}
        </span>
        <Button size="sm" variant="ghost" onClick={() => setAttempt((value) => value + 1)}>
          重新读取
        </Button>
      </span>
    );
  if (!cell) return null;
  if (cell === "same")
    return (
      <span className="shrink-0 whitespace-nowrap text-[11px] text-muted-foreground">
        值与原来相同
      </span>
    );
  return (
    <span
      className="inline-flex h-6 min-w-0 shrink items-center gap-1 rounded-full border border-[var(--em-hairline)] bg-[var(--em-fill)] px-2 font-mono text-[11px]"
      title="首格的修改前与现在的值"
    >
      <span className="text-muted-foreground">{cell.ref}</span>
      <span className="max-w-24 truncate text-muted-foreground line-through">{cell.before}</span>
      <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
      <span className="max-w-24 truncate font-semibold text-[var(--em-primary)]">{cell.after}</span>
    </span>
  );
}

/** 用修改前的备份整文件替换当前文件；替换前服务端会先备份当前文件。 */
function RestoreBackup({ workspaceId, docPath }: { workspaceId: string; docPath: string }) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    const list = await api().listBackups(workspaceId, "backups");
    const latest = list.items
      .filter((b) => b.originalPath === docPath)
      .sort((x, y) => y.createdAt.localeCompare(x.createdAt))[0];
    if (!latest) throw new Error("没有找到这个文件的备份");
    const ok = await confirmAction({
      title: "用备份还原整个文件？",
      description: `「${fileName(docPath)}」将替换为 ${new Date(latest.createdAt).toLocaleString()} 的备份。当前内容会先另存一份备份，之后仍可找回。`,
      confirmLabel: "还原",
      tone: "danger",
    });
    if (!ok) return false;
    await api().restoreBackup(workspaceId, "backups", latest.id);
    return true;
  };
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void run()
          .then((done) => {
            if (!done) return;
            toast({ tone: "success", title: "已用备份还原文件" });
            void openWorkbook(docPath).catch(() => undefined);
          })
          .catch((error: unknown) =>
            toast({ tone: "error", title: errorMessage(error, "还原失败") }),
          )
          .finally(() => setBusy(false));
      }}
      className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-[11px] font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
      title="用本会话修改前的备份替换当前文件"
    >
      <RotateCcw className="h-3 w-3" />
      用备份还原
    </button>
  );
}

export function ChangeNavigator() {
  const doc = useWorkbookStore((s) => s.doc);
  const workspaceId = useWorkbookStore((s) => s.workspaceId);
  const [scope, setScope] = useState<"turn" | "all">("turn");
  const [index, setIndex] = useState(0);
  const { items, total } = useChangeNavigation(scope);
  // 新改动到达时跳到最新一处
  useEffect(() => {
    setIndex(Math.max(0, items.length - 1));
  }, [items.length]);

  if (!doc || !workspaceId) return null;
  if (total === 0) {
    return (
      <div className="flex min-w-0 flex-1 items-center gap-2 text-xs text-muted-foreground">
        <History className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">本会话还没有代理改动。手动编辑请在「修订历史」中查看。</span>
      </div>
    );
  }
  const cur = items[Math.min(index, items.length - 1)];
  const go = (i: number) => {
    const next = items[i];
    if (!next) return;
    setIndex(i);
    void focusRange(next.range, { docId: doc.docId });
  };
  return (
    <nav
      className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto text-xs scrollbar-none"
      aria-label="表格变更"
    >
      <div
        className="inline-flex shrink-0 items-center rounded-md bg-[var(--em-fill)] p-0.5"
        role="radiogroup"
        aria-label="变更范围"
      >
        {(["turn", "all"] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={scope === value}
            onClick={() => setScope(value)}
            className={cn(
              "h-6 rounded-[5px] px-2 text-[11px] font-medium transition-colors",
              scope === value
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {value === "turn" ? "本轮" : "全部"}
          </button>
        ))}
      </div>
      {items.length === 0 || !cur ? (
        <span className="shrink-0 text-muted-foreground">本轮还没有代理改动</span>
      ) : (
        <>
          <span className="shrink-0 font-mono whitespace-nowrap text-muted-foreground tabular-nums">
            {index + 1}/{items.length}
          </span>
          <span className="flex shrink-0 items-center">
            <button
              type="button"
              aria-label="上一处"
              title="上一处"
              disabled={index <= 0}
              onClick={() => go(index - 1)}
              className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-black/5 hover:text-foreground disabled:opacity-40 dark:hover:bg-white/10"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              aria-label="下一处"
              title="下一处"
              disabled={index >= items.length - 1}
              onClick={() => go(index + 1)}
              className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-black/5 hover:text-foreground disabled:opacity-40 dark:hover:bg-white/10"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </span>
          <button
            type="button"
            onClick={() => go(index)}
            title="在表格中定位"
            className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full border border-[var(--em-primary-alpha-25)] bg-[var(--em-primary-alpha-06)] px-2 font-mono text-[11px] text-[var(--em-primary)] hover:bg-[var(--em-primary-alpha-10)]"
          >
            <LocateFixed className="h-3 w-3" />
            {cur.range}
          </button>
          <span className="min-w-0 shrink truncate whitespace-nowrap text-muted-foreground">
            {cur.entry.rev !== null ? `修订 ${cur.entry.rev} · ` : ""}
            {cur.entry.cells} 格
            {cur.entry.structural.length > 0 ? ` · ${cur.entry.structural.join("，")}` : ""}
          </span>
          {cur.entry.rev !== null && (
            <BeforeAfter
              workspaceId={workspaceId}
              docId={doc.docId}
              rev={cur.entry.rev}
              range={cur.range}
            />
          )}
          {cur.entry.backupPath && <RestoreBackup workspaceId={workspaceId} docPath={doc.path} />}
        </>
      )}
    </nav>
  );
}
