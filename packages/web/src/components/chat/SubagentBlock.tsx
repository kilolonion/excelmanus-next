// 派生子代理（agent_spawn）：委派给谁、做什么、现在什么状态；可以切过去看它的过程，或暂停 / 继续 / 关闭。

import { ChevronDown, Eye, Loader2, Pause, Play, Power, Users } from "lucide-react";
import { useState } from "react";
import { toast } from "@/components/ui/toaster";
import { errorMessage } from "@/lib/backend/api";
import type { ToolState } from "@/lib/session/types";
import { cn } from "@/lib/utils";
import { controlAgent, setViewAgent, useChatStore } from "@/stores/chat-store";

export const AGENT_ROLE_LABEL: Record<string, string> = {
  reader: "只读",
  worker: "执行",
  lead: "协调",
  main: "主代理",
};

export const AGENT_STATUS: Record<string, { text: string; cls: string }> = {
  idle: { text: "已完成", cls: "text-muted-foreground" },
  running: { text: "进行中", cls: "text-[var(--em-primary)]" },
  waiting: { text: "等待中", cls: "text-muted-foreground" },
  blocked: { text: "等待确认", cls: "text-amber-700 dark:text-amber-400" },
  paused: { text: "已暂停", cls: "text-muted-foreground" },
  queued: { text: "排队中", cls: "text-muted-foreground" },
  interrupted: { text: "已中断", cls: "text-amber-700 dark:text-amber-400" },
  failed: { text: "失败", cls: "text-red-600 dark:text-red-400" },
  closed: { text: "已关闭", cls: "text-muted-foreground" },
};

function spawnedId(tool: ToolState): string | null {
  const d = tool.result?.data as { agentId?: unknown; id?: unknown } | undefined;
  return typeof d?.agentId === "string" ? d.agentId : typeof d?.id === "string" ? d.id : null;
}

export function SubagentBlock({ tool }: { tool: ToolState }) {
  const args = (tool.args ?? {}) as { name?: unknown; role?: unknown; task?: unknown };
  const agentId = spawnedId(tool);
  const agent = useChatStore((s) => (agentId ? s.session.roster[agentId] : undefined));
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const name = agent?.name ?? (typeof args.name === "string" ? args.name : "子代理");
  const role = agent?.role ?? (typeof args.role === "string" ? args.role : null);
  const task = typeof args.task === "string" ? args.task : (agent?.task ?? "");
  const failed = tool.phase === "done" && tool.status !== "ok";
  const status = failed
    ? { text: "未能派生", cls: "text-red-600 dark:text-red-400" }
    : agent
      ? (AGENT_STATUS[agent.status] ?? { text: agent.status, cls: "text-muted-foreground" })
      : { text: "派生中", cls: "text-muted-foreground" };
  const running = agent?.status === "running" || (!agent && !failed);
  const control = (action: "pause" | "resume" | "close") => {
    if (!agentId) return;
    setBusy(true);
    void controlAgent(agentId, action)
      .catch((error: unknown) => toast({ tone: "error", title: errorMessage(error, "操作失败") }))
      .finally(() => setBusy(false));
  };
  return (
    <div className="my-1.5 rounded-lg bg-[var(--em-fill)] px-3 py-2" data-tool-call-id={tool.id}>
      <div className="flex items-center gap-2">
        {running ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--em-primary)]" />
        ) : (
          <Users className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 truncate text-[13px] font-medium text-foreground">
          委派给「{name}」
        </span>
        {role && (
          <span className="shrink-0 rounded bg-background px-1 py-px text-[10px] text-muted-foreground">
            {AGENT_ROLE_LABEL[role] ?? role}
          </span>
        )}
        <span className={cn("shrink-0 text-[11px] font-medium", status.cls)}>{status.text}</span>
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          {typeof agent?.tokens === "number" && agent.tokens > 0 && (
            <span className="mr-1 text-[11px] tabular-nums text-muted-foreground/70">
              {agent.tokens.toLocaleString()} tokens
            </span>
          )}
          {agentId && (
            <button
              type="button"
              onClick={() => setViewAgent(agentId)}
              className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground hover:bg-background hover:text-foreground"
              title="查看这个子代理的对话"
            >
              <Eye className="h-3 w-3" />
              查看
            </button>
          )}
          {agentId &&
            agent &&
            (agent.status === "running" ||
              agent.status === "waiting" ||
              agent.status === "queued") && (
              <button
                type="button"
                disabled={busy}
                onClick={() => control("pause")}
                className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground"
                title="暂停"
                aria-label="暂停"
              >
                <Pause className="h-3 w-3" />
              </button>
            )}
          {agentId && agent?.status === "paused" && (
            <button
              type="button"
              disabled={busy}
              onClick={() => control("resume")}
              className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground"
              title="继续"
              aria-label="继续"
            >
              <Play className="h-3 w-3" />
            </button>
          )}
          {agentId && agent && agent.status !== "closed" && (
            <button
              type="button"
              disabled={busy}
              onClick={() => control("close")}
              className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-red-600"
              title="关闭子代理"
              aria-label="关闭子代理"
            >
              <Power className="h-3 w-3" />
            </button>
          )}
        </span>
      </div>
      {task && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 flex w-full items-start gap-1 text-left"
        >
          <p
            className={cn(
              "min-w-0 flex-1 text-[12px] leading-5 whitespace-pre-wrap text-muted-foreground",
              !expanded && "line-clamp-2",
            )}
          >
            {task}
          </p>
          {task.length > 120 && (
            <ChevronDown
              className={cn(
                "mt-1 h-3 w-3 shrink-0 text-muted-foreground/60 transition-transform",
                expanded && "rotate-180",
              )}
            />
          )}
        </button>
      )}
      {agent?.lastTool && running && (
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground/70">
          最近：{agent.lastTool}
        </p>
      )}
      {failed && tool.result?.error && (
        <p className="mt-1 text-[12px] text-red-600 dark:text-red-400">
          {tool.result.error.message}
        </p>
      )}
    </div>
  );
}
