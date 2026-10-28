// 一组连续的工具步骤：一行摘要（状态 + 动作），展开后是带引导线的步骤列表。
// 有步骤等待授权或回答时始终展开，确认面板就在对应步骤下面。

import { CheckCircle2, ChevronRight, CircleAlert, CircleSlash, Clock, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { isToolActive, type ToolDisplayStatus, toolDisplayStatus } from "@/lib/session/tool-view";
import { activityGroupTitle, toolActionTitle } from "@/lib/tool-labels";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/stores/chat-store";
import { ToolCallCard } from "./ToolCallCard";

type GroupStatus = "attention" | "running" | "pending" | "error" | "stopped" | "done";

function groupStatus(statuses: ToolDisplayStatus[]): GroupStatus {
  if (statuses.some((s) => s === "approval" || s === "question")) return "attention";
  if (statuses.some((s) => s === "running")) return "running";
  if (statuses.some((s) => s === "pending")) return "pending";
  if (statuses.some((s) => s === "error" || s === "denied" || s === "uncertain")) return "error";
  if (statuses.every((s) => s === "not_executed")) return "stopped";
  return "done";
}

export function ActivityGroup({
  toolIds,
  defaultCollapsed,
}: {
  toolIds: string[];
  defaultCollapsed: boolean;
}) {
  const tools = useChatStore((s) => s.session.tools);
  const approvals = useChatStore((s) => s.session.approvals);
  const questions = useChatStore((s) => s.session.questions);
  const items = useMemo(
    () =>
      toolIds.flatMap((id) => {
        const tool = tools[id];
        if (!tool) return [];
        const approval = tool.approvalId ? approvals[tool.approvalId] : undefined;
        const question = tool.questionId ? questions[tool.questionId] : undefined;
        return [{ id, tool, status: toolDisplayStatus(tool, approval, question) }];
      }),
    [toolIds, tools, approvals, questions],
  );
  const status = groupStatus(items.map((i) => i.status));
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  // 需要用户处理时不能藏起来
  const expanded = status === "attention" || !collapsed;
  if (items.length === 0) return null;

  const count = items.length;
  const active = items.find((i) => isToolActive(i.status));
  const label =
    status === "attention"
      ? "等待你的确认"
      : status === "running" || status === "pending"
        ? active
          ? toolActionTitle(active.tool.name, active.tool.args as Record<string, unknown>)
          : activityGroupTitle(items.map((i) => ({ name: i.tool.name, status: i.status })))
        : status === "error"
          ? `${count} 个步骤，有失败`
          : status === "stopped"
            ? `${count} 个步骤未执行`
            : `已完成 ${count} 个步骤`;
  const summary =
    status === "done" || status === "error"
      ? activityGroupTitle(items.map((i) => ({ name: i.tool.name, status: i.status })))
      : null;
  const Icon =
    status === "running"
      ? Loader2
      : status === "pending" || status === "attention"
        ? Clock
        : status === "error"
          ? CircleAlert
          : status === "stopped"
            ? CircleSlash
            : CheckCircle2;

  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => setCollapsed(expanded)}
        disabled={status === "attention"}
        aria-expanded={expanded}
        className="group/act -mx-1.5 flex w-[calc(100%+12px)] items-center gap-2 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-[var(--em-fill)] disabled:cursor-default disabled:hover:bg-transparent"
      >
        <Icon
          className={cn(
            "h-3.5 w-3.5 shrink-0",
            status === "running" && "animate-spin text-[var(--em-primary)]",
            status === "attention" && "text-amber-500",
            status === "pending" && "text-muted-foreground",
            status === "error" && "text-red-500",
            (status === "done" || status === "stopped") && "text-muted-foreground/70",
          )}
        />
        <span
          className={cn(
            "min-w-0 truncate text-[13px]",
            status === "running"
              ? "em-shimmer font-medium"
              : status === "attention"
                ? "font-medium text-amber-700 dark:text-amber-400"
                : "text-muted-foreground",
          )}
        >
          {label}
        </span>
        {summary && (
          <span className="hidden min-w-0 truncate text-[12px] text-muted-foreground/70 sm:inline">
            · {summary}
          </span>
        )}
        {status !== "attention" && (
          <ChevronRight
            className={cn(
              "ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground/50 transition-transform duration-200 group-hover/act:text-foreground",
              expanded && "rotate-90",
            )}
          />
        )}
      </button>
      {expanded && (
        <div className="em-steps mt-0.5 ml-5">
          {items.map((item) => (
            <ToolCallCard key={item.id} toolId={item.id} />
          ))}
        </div>
      )}
    </div>
  );
}
