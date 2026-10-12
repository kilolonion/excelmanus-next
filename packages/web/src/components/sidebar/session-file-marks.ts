// 当前会话里代理新建或修改过的文件（02 §6 文件标记）：来自会话日志还原的工具调用与工作簿变更。

import { useMemo } from "react";
import { normalizePath } from "@/lib/paths";
import { isWriteTool } from "@/lib/tool-labels";
import { useChatStore } from "@/stores/chat-store";

export type SessionFileMark = "created" | "modified";

export const SESSION_MARK_LABEL: Record<SessionFileMark, string> = {
  created: "本会话新建",
  modified: "本会话修改",
};

export function useSessionFileMarks(): Map<string, SessionFileMark> {
  const tools = useChatStore((s) => s.session.tools);
  const changes = useChatStore((s) => s.session.changes);
  return useMemo(() => {
    const marks = new Map<string, SessionFileMark>();
    const mark = (raw: string, kind: SessionFileMark) => {
      const path = normalizePath(raw);
      if (!path || marks.get(path) === "created") return;
      marks.set(path, kind);
    };
    for (const change of changes) mark(change.path, "modified");
    for (const tool of Object.values(tools)) {
      if (!isWriteTool(tool.name) || (tool.status !== "ok" && tool.status !== "partial")) continue;
      for (const path of tool.newFiles ?? []) mark(path, "created");
      for (const target of tool.targets) mark(target, "modified");
    }
    return marks;
  }, [tools, changes]);
}
