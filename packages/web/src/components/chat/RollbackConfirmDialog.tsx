// 从历史消息重新开始前的确认：之后的对话不再计入上下文；这期间改过的文件保持现状（列出来，可去备份还原）。

import { FileEdit, RotateCcw, Table2 } from "lucide-react";
import {
  OverlayCard,
  OverlayCardAction,
  OverlayCardBody,
  OverlayCardFooter,
  OverlayCardHeader,
  OverlayCardInset,
} from "@/components/ui/overlay-card";
import { fileName } from "@/lib/paths";
import { useChatStore } from "@/stores/chat-store";

export interface ChangedFile {
  path: string;
  kind: "workbook" | "text";
  detail?: string;
}

/** 这条用户消息之后改过的文件（用于重新开始前的确认）。 */
export function filesChangedAfter(seq: number, agentId: string): ChangedFile[] {
  const { session } = useChatStore.getState();
  const out = new Map<string, ChangedFile>();
  for (const change of session.changes) {
    if (change.seq <= seq || change.agentId !== agentId) continue;
    const prev = out.get(change.path);
    const cells = (prev?.detail ? Number.parseInt(prev.detail, 10) : 0) + change.cells;
    out.set(change.path, {
      path: change.path,
      kind: "workbook",
      detail: cells > 0 ? `${cells} 格` : "结构修改",
    });
  }
  for (const tool of Object.values(session.tools)) {
    if (tool.seq <= seq || tool.agentId !== agentId || tool.status !== "ok") continue;
    if (tool.name !== "write" && tool.name !== "edit") continue;
    const path = (tool.args as { path?: unknown })?.path;
    if (typeof path === "string" && !out.has(path))
      out.set(path, { path, kind: "text", detail: tool.name === "write" ? "写入" : "替换" });
  }
  return [...out.values()];
}

export function RollbackConfirmDialog({
  open,
  files,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  files: ChangedFile[];
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <OverlayCard open={open} onOpenChange={(v) => !v && onCancel()} size="md" tone="warning">
      <OverlayCardHeader
        icon={<RotateCcw className="h-5 w-5" />}
        title="从这条消息重新开始？"
        description="之后的对话不再计入上下文，代理会从这条消息重新开始。下面这些文件在之后被修改过，它们会保持现在的内容。"
        onClose={onCancel}
      />
      <OverlayCardBody>
        <OverlayCardInset padded={false}>
          <div className="max-h-56 overflow-y-auto py-1">
            {files.map((file) => (
              <div key={file.path} className="flex items-center gap-2 px-3 py-1.5 text-[13px]">
                {file.kind === "workbook" ? (
                  <Table2 className="h-3.5 w-3.5 shrink-0 text-[var(--em-primary)]" />
                ) : (
                  <FileEdit className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1 truncate" title={file.path}>
                  {fileName(file.path)}
                </span>
                {file.detail && (
                  <span className="shrink-0 text-[11px] text-muted-foreground">{file.detail}</span>
                )}
              </div>
            ))}
          </div>
        </OverlayCardInset>
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          需要撤销这些修改时，可在表格的「变更」页签用备份还原，或在 设置 → 工作区与备份 中恢复。
        </p>
      </OverlayCardBody>
      <OverlayCardFooter>
        <OverlayCardAction action="ghost" onClick={onCancel}>
          取消
        </OverlayCardAction>
        <OverlayCardAction action="primary" onClick={onConfirm}>
          仍然重新开始
        </OverlayCardAction>
      </OverlayCardFooter>
    </OverlayCard>
  );
}
