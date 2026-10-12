// 助手轮次里的非文本块：呈现（定位 / 交付文件）、记忆、模型重试、本轮改动汇总。扁平样式。

import type { PresentPayload } from "@excelmanus/protocol";
import { Brain, CheckCircle2, LocateFixed, Repeat, Table2, Undo2 } from "lucide-react";
import { useState } from "react";
import { toast } from "@/components/ui/toaster";
import { errorMessage } from "@/lib/backend/api";
import { openWorkspaceFile } from "@/lib/open-file";
import { fileName } from "@/lib/paths";
import type { Block, DocChange } from "@/lib/session/types";
import { undoMemory } from "@/stores/chat-store";
import { downloadWorkspaceFile } from "@/stores/files-store";
import { useUIStore } from "@/stores/ui-store";
import { focusRange, openWorkbookById } from "@/stores/workbook-store";
import { RelatedFilesCard } from "../FileCapsule";

/** present 工具：在表格里指给用户看一个区域，或交付一个文件。 */
export function PresentCard({ payload }: { payload: PresentPayload }) {
  if (payload.kind === "file") {
    return (
      <div className="my-2">
        {payload.note && <p className="mb-1 text-[13px] text-foreground/90">{payload.note}</p>}
        <RelatedFilesCard
          files={[
            {
              key: payload.path,
              filename: fileName(payload.path),
              filePath: payload.path,
              onOpen: () => openWorkspaceFile(payload.path),
              onDownload: () => void downloadWorkspaceFile(payload.path).catch(() => undefined),
            },
          ]}
        />
      </div>
    );
  }
  const target = payload.docId
    ? { docId: payload.docId }
    : payload.path
      ? { path: payload.path }
      : undefined;
  return (
    <button
      type="button"
      onClick={() => void focusRange(payload.range, target)}
      className="group my-1.5 flex w-full items-start gap-2 rounded-lg border-l-2 border-[var(--em-cyan)] bg-[color-mix(in_srgb,var(--em-cyan)_6%,transparent)] px-3 py-2 text-left transition-colors hover:bg-[color-mix(in_srgb,var(--em-cyan)_10%,transparent)]"
    >
      <LocateFixed className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--em-cyan)]" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-foreground">
          查看 <span className="font-mono text-[12px]">{payload.range}</span>
          {payload.path && (
            <span className="truncate text-[11.5px] font-normal text-muted-foreground">
              · {fileName(payload.path)}
            </span>
          )}
        </span>
        {payload.note && (
          <span className="mt-0.5 block text-[12px] leading-5 text-muted-foreground">
            {payload.note}
          </span>
        )}
      </span>
      <span className="shrink-0 pt-0.5 text-[11px] text-[var(--em-cyan)] opacity-0 transition-opacity group-hover:opacity-100">
        定位
      </span>
    </button>
  );
}

/** 代理保存的记忆：可直接撤销。 */
export function MemoryCard({ block }: { block: Extract<Block, { type: "memory" }> }) {
  const openSettings = useUIStore((s) => s.openSettings);
  const [busy, setBusy] = useState(false);
  return (
    <div className="my-1.5 flex items-start gap-2 rounded-lg bg-emerald-500/[0.06] px-3 py-2 text-xs">
      <Brain className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
      <div className="min-w-0 flex-1">
        <p className={block.deleted ? "text-muted-foreground line-through" : "text-foreground/85"}>
          <span className="mr-1.5 rounded bg-emerald-500/15 px-1 py-px text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
            {block.category}
          </span>
          {block.content}
        </p>
        {block.deleted && (
          <p className="mt-0.5 text-[11px] text-muted-foreground">已撤销，这条记忆不会再被使用</p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {!block.deleted && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void undoMemory(block.memoryId)
                .catch((error: unknown) =>
                  toast({ tone: "error", title: errorMessage(error, "撤销失败") }),
                )
                .finally(() => setBusy(false));
            }}
            className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground hover:bg-background/70 hover:text-foreground disabled:opacity-50"
          >
            <Undo2 className="h-3 w-3" />
            撤销
          </button>
        )}
        <button
          type="button"
          onClick={() => openSettings("memory")}
          className="inline-flex h-6 items-center rounded-md px-1.5 text-[11px] text-muted-foreground hover:bg-background/70 hover:text-foreground"
        >
          管理
        </button>
      </div>
    </div>
  );
}

/** 模型请求重试中 / 已恢复。 */
export function RetryNotice({ block }: { block: Extract<Block, { type: "retry" }> }) {
  if (block.resolved)
    return (
      <div className="my-1 flex items-center gap-2 text-[12px] text-muted-foreground">
        <CheckCircle2 className="h-3.5 w-3.5 text-[var(--em-primary)]" />
        模型服务已恢复（第 {block.attempt} 次重试成功）
      </div>
    );
  return (
    <div className="my-1 flex items-start gap-2 text-[12px] text-muted-foreground">
      <Repeat
        className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin"
        style={{ animationDuration: "2s" }}
      />
      <span className="min-w-0">
        正在重试模型请求（第 {block.attempt} 次
        {block.waitMs > 0 ? `，${Math.ceil(block.waitMs / 1000)} 秒后` : ""}）
        {block.reason && (
          <span className="block truncate text-muted-foreground/70">{block.reason}</span>
        )}
      </span>
    </div>
  );
}

function changeSummary(change: DocChange): string {
  const cells = Object.values(change.cellsBySheet).reduce((n, v) => n + v, 0);
  return [
    cells > 0 ? `${cells} 格` : null,
    change.ranges.length > 0 ? `${change.ranges.length} 处区域` : null,
    change.structural.length > 0 ? change.structural.join("，") : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** 本轮对工作簿的改动汇总（轮次结束时）。 */
export function TurnChangesCard({ changes }: { changes: DocChange[] }) {
  if (changes.length === 0) return null;
  return (
    <div className="my-2 rounded-lg bg-[var(--em-fill)] px-1 py-1">
      <p className="px-1.5 pb-0.5 pt-0.5 text-[11.5px] font-medium text-muted-foreground">
        本轮修改了 {changes.length} 个文件
      </p>
      {changes.map((change) => (
        <div
          key={change.docId}
          className="group flex items-center gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-background/70"
        >
          <Table2 className="h-3.5 w-3.5 shrink-0 text-[var(--em-primary)]" />
          <button
            type="button"
            onClick={() =>
              void (change.ranges[0]
                ? focusRange(change.ranges[0], { docId: change.docId })
                : openWorkbookById(change.docId))
            }
            className="min-w-0 flex-1 truncate text-left text-[12.5px] text-foreground"
            title={change.path}
          >
            {fileName(change.path)}
            <span className="ml-2 text-[11.5px] text-muted-foreground">
              {changeSummary(change)}
            </span>
          </button>
          {change.backupPath && (
            <span
              className="shrink-0 text-[10.5px] text-muted-foreground/70"
              title={change.backupPath}
            >
              已备份原文件
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
