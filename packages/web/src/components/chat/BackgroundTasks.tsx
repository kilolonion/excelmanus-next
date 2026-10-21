// 代理团队面板（02 §5）：名称、颜色、角色、状态、正在做什么、token；点击进入该代理的视图，
// 输入框随之改为发给它；可暂停 / 继续 / 停止单个代理，或全部停止。

import { CircleStop, Eye, Loader2, Pause, Play, Square, Users } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toaster";
import { errorMessage } from "@/lib/backend/api";
import { toolActionTitle } from "@/lib/tool-labels";
import { cn } from "@/lib/utils";
import {
  controlAgent,
  setViewAgent,
  stopAgent,
  stopAllAgents,
  useChatStore,
} from "@/stores/chat-store";
import { useUIStore } from "@/stores/ui-store";
import { AGENT_ROLE_LABEL, AGENT_STATUS } from "./SubagentBlock";
import { isAgentActive, type TeamMember, useAgentTeam } from "./use-background-tasks";

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function MemberRow({
  member,
  viewing,
  onEnter,
}: {
  member: TeamMember;
  viewing: boolean;
  onEnter: () => void;
}) {
  const { agent, color, isMain } = member;
  const [busy, setBusy] = useState(false);
  const status = AGENT_STATUS[agent.status] ?? { text: agent.status, cls: "text-muted-foreground" };
  const name = agent.name ?? (isMain ? "主代理" : agent.id);
  const role = isMain ? "main" : agent.role;
  const active = isAgentActive(agent.status);

  const run = (fn: () => Promise<void>) => {
    setBusy(true);
    void fn()
      .catch((error: unknown) => toast({ tone: "error", title: errorMessage(error, "操作失败") }))
      .finally(() => setBusy(false));
  };

  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-xl border border-[var(--em-hairline)] px-3 py-2.5",
        viewing && "border-[var(--em-primary-light)] bg-[var(--em-primary-alpha-06)]",
      )}
    >
      <span
        className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: color }}
        aria-hidden="true"
      />
      <button
        type="button"
        onClick={onEnter}
        className="min-w-0 flex-1 text-left"
        aria-label={`查看 ${name} 的对话`}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-medium text-foreground">{name}</span>
          {role && (
            <span className="shrink-0 rounded bg-muted px-1 py-px text-[10px] text-muted-foreground">
              {AGENT_ROLE_LABEL[role] ?? role}
            </span>
          )}
          <span className={cn("shrink-0 text-[11px] font-medium", status.cls)}>{status.text}</span>
          {agent.status === "running" && (
            <Loader2 className="h-3 w-3 shrink-0 animate-spin text-[var(--em-primary)]" />
          )}
        </div>
        {agent.task && (
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{agent.task}</p>
        )}
        <p className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-muted-foreground/80">
          {active && agent.lastTool && <span>正在：{toolActionTitle(agent.lastTool)}</span>}
          {typeof agent.tokens === "number" && agent.tokens > 0 && (
            <span className="tabular-nums">{formatTokens(agent.tokens)} tokens</span>
          )}
          {viewing && <span className="text-[var(--em-primary)]">当前查看</span>}
        </p>
      </button>
      <span className="flex shrink-0 items-center gap-0.5">
        {!viewing && (
          <button
            type="button"
            onClick={onEnter}
            aria-label="查看对话"
            title="查看对话"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Eye className="h-3.5 w-3.5" />
          </button>
        )}
        {!isMain && active && (
          <button
            type="button"
            disabled={busy}
            onClick={() => run(() => controlAgent(agent.id, "pause"))}
            aria-label="暂停"
            title="暂停"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Pause className="h-3.5 w-3.5" />
          </button>
        )}
        {!isMain && agent.status === "paused" && (
          <button
            type="button"
            disabled={busy}
            onClick={() => run(() => controlAgent(agent.id, "resume"))}
            aria-label="继续"
            title="继续"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Play className="h-3.5 w-3.5" />
          </button>
        )}
        {active && (
          <button
            type="button"
            disabled={busy}
            onClick={() => run(() => stopAgent(agent.id))}
            aria-label="停止"
            title="停止"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-red-600"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <CircleStop className="h-3.5 w-3.5" />
            )}
          </button>
        )}
      </span>
    </div>
  );
}

export function BackgroundTasks() {
  const sessionId = useChatStore((s) => s.sessionId);
  const viewAgentId = useChatStore((s) => s.viewAgentId);
  const open = useUIStore((s) => s.teamOpen);
  const setOpen = useUIStore((s) => s.setTeamOpen);
  const { members, subCount, activeCount, blockedCount } = useAgentTeam();
  const [stopping, setStopping] = useState<"all" | "subagents" | null>(null);
  // 主代理也在运行时才需要区分「只停子代理」，否则两者等价
  const mainRunning = members.some((m) => m.isMain && m.agent.status === "running");

  if (!sessionId || subCount === 0) return null;

  const stopAll = (scope: "all" | "subagents") => {
    setStopping(scope);
    void stopAllAgents(scope)
      .catch((error: unknown) => toast({ tone: "error", title: errorMessage(error, "停止失败") }))
      .finally(() => setStopping(null));
  };

  const label = blockedCount
    ? `代理团队，${blockedCount} 个等待确认`
    : `代理团队${activeCount ? `，${activeCount} 个进行中` : ""}`;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 px-2 text-muted-foreground"
          aria-label={label}
        >
          <Users className="h-4 w-4" />
          {activeCount > 0 && (
            <span
              className={cn(
                "min-w-4 rounded-full bg-[var(--em-primary-alpha-10)] px-1 text-[10px] text-[var(--em-primary)]",
                blockedCount > 0 && "bg-amber-500/15 text-amber-700 dark:text-amber-400",
              )}
            >
              {activeCount}
            </span>
          )}
        </Button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[85dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
        <DialogHeader className="border-b border-[var(--em-hairline)] p-5 pr-14 text-left">
          <DialogTitle>代理团队</DialogTitle>
          <DialogDescription>点击代理查看它的完整对话，输入框会直接发消息给它。</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 space-y-2 overflow-y-auto p-4">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span aria-live="polite">
              {subCount} 个子代理{activeCount ? ` · ${activeCount} 个进行中` : ""}
              {blockedCount ? ` · ${blockedCount} 个等待确认` : ""}
            </span>
            {activeCount > 0 && (
              <span className="flex items-center gap-1">
                {mainRunning && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => stopAll("subagents")}
                    disabled={stopping !== null}
                    title="主代理继续工作，子代理停下并回报已完成的部分"
                    className="h-7 text-xs"
                  >
                    {stopping === "subagents" ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <CircleStop className="h-3 w-3" />
                    )}
                    只停子代理
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => stopAll("all")}
                  disabled={stopping !== null}
                  className="h-7 text-xs text-red-600 hover:text-red-700"
                >
                  {stopping === "all" ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Square className="h-3 w-3" />
                  )}
                  全部停止
                </Button>
              </span>
            )}
          </div>
          {members.map((member) => (
            <MemberRow
              key={member.agent.id}
              member={member}
              viewing={member.agent.id === viewAgentId}
              onEnter={() => {
                setViewAgent(member.agent.id);
                setOpen(false);
              }}
            />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
