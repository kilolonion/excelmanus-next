// 一个工具步骤：单行标题 + 上下文，点开看参数与结果。需要授权或回答时，确认面板直接内联在这一步下面。

import { ChevronRight, CircleSlash, Loader2, TriangleAlert } from "lucide-react";
import React, { useEffect, useId, useRef, useState } from "react";
import { useIsMobile } from "@/hooks/use-mobile";
import { type ToolDisplayStatus, toolDisplayStatus } from "@/lib/session/tool-view";
import type { ToolState } from "@/lib/session/types";
import {
  extractToolContext,
  formatToolContextLine,
  toolActionTitle,
  toolIcon,
} from "@/lib/tool-labels";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/stores/chat-store";
import { ApprovalInline, ApprovalOutcome } from "./ApprovalInline";
import { QuestionInline } from "./AskUserCard";
import { CodeBlock } from "./CodeBlock";
import StreamingTextPreview from "./StreamingTextPreview";
import {
  PublishPlan,
  ScriptResult,
  TextChange,
  WorkbookEditResult,
  WorkbookReadResult,
} from "./tool-results";

const STATUS_TEXT: Partial<Record<ToolDisplayStatus, { text: string; cls: string }>> = {
  pending: { text: "等待执行", cls: "text-muted-foreground" },
  approval: { text: "等待授权", cls: "text-amber-700 dark:text-amber-400" },
  question: { text: "等待回答", cls: "text-[var(--em-primary)]" },
  error: { text: "失败", cls: "text-red-600 dark:text-red-400" },
  denied: { text: "已拒绝", cls: "text-red-600 dark:text-red-400" },
  not_executed: { text: "未执行", cls: "text-muted-foreground" },
  uncertain: { text: "结果未知", cls: "text-amber-700 dark:text-amber-400" },
  partial: { text: "部分完成", cls: "text-amber-700 dark:text-amber-400" },
};

const ICON_CLASS: Record<ToolDisplayStatus, string> = {
  pending: "text-muted-foreground/60",
  running: "text-[var(--em-primary)]",
  approval: "text-amber-500",
  question: "text-[var(--em-primary)]",
  success: "text-muted-foreground",
  partial: "text-amber-500",
  error: "text-red-500",
  denied: "text-red-500",
  not_executed: "text-muted-foreground/50",
  uncertain: "text-amber-500",
};

const TEXT_STREAM_TOOLS = new Set(["write", "edit", "run_script"]);

function useElapsed(running: boolean): number {
  const startRef = useRef<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!running) {
      startRef.current = null;
      setElapsed(0);
      return;
    }
    startRef.current ??= Date.now();
    const start = startRef.current;
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return elapsed;
}

function formatDuration(ms: number | undefined): string | null {
  if (ms === undefined || ms < 1000) return null;
  return ms < 60_000
    ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
    : `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

/** 写入类工具成功后的改动 / 读取类的数据预览：始终可见，不需要点开。 */
function InlineResult({ tool }: { tool: ToolState }) {
  const change = useChatStore((s) => s.session.changes.find((c) => c.toolCallId === tool.id));
  if (tool.phase !== "done" || (tool.status !== "ok" && tool.status !== "partial")) return null;
  const data = tool.result?.data;
  if (tool.name === "workbook_edit") {
    if (change) return <WorkbookEditResult change={change} />;
    return null;
  }
  if (tool.name === "workbook_read") return <WorkbookReadResult data={data} />;
  if (tool.name === "run_script") return <ScriptResult data={data} />;
  if (tool.name === "write" || tool.name === "edit") return <TextChange tool={tool} />;
  return null;
}

function stringify(value: unknown, compact: boolean): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, compact ? 1 : 2);
  } catch {
    return String(value);
  }
}

export const ToolCallCard = React.memo(function ToolCallCard({
  toolId,
  nested = false,
}: {
  toolId: string;
  nested?: boolean;
}) {
  const isMobile = useIsMobile();
  const tool = useChatStore((s) => s.session.tools[toolId]);
  const approval = useChatStore((s) =>
    tool?.approvalId ? s.session.approvals[tool.approvalId] : undefined,
  );
  const question = useChatStore((s) =>
    tool?.questionId ? s.session.questions[tool.questionId] : undefined,
  );
  const streaming = useChatStore((s) =>
    tool && TEXT_STREAM_TOOLS.has(tool.name)
      ? s.session.live[tool.agentId]?.toolArgs[toolId]?.text
      : undefined,
  );
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(false);
  const detailsId = useId();
  const status = tool ? toolDisplayStatus(tool, approval, question) : "pending";
  const running = status === "running";
  const elapsed = useElapsed(running);
  if (!tool) return null;

  const args = (tool.args ?? {}) as Record<string, unknown>;
  const title = toolActionTitle(tool.name, args);
  const contextLine = formatToolContextLine(extractToolContext(tool.name, args));
  const Icon = toolIcon(tool.name);
  const statusText = STATUS_TEXT[status];
  const error = tool.result?.error;
  const timing = running ? (elapsed > 0 ? `${elapsed}s` : null) : formatDuration(tool.durationMs);
  const hasArgs = Object.keys(args).length > 0;
  const data = tool.result?.data;
  const publishPlan =
    approval?.status === "pending"
      ? (approval.args as { publishPlan?: unknown } | undefined)?.publishPlan
      : undefined;

  return (
    <div data-tool-call-id={tool.id} className={cn("min-w-0", nested && "ml-5")}>
      <button
        type="button"
        className="em-step-row"
        onClick={() => {
          setOpened(true);
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        aria-controls={detailsId}
      >
        <span className="em-step-icon">
          {running ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--em-primary)]" />
          ) : status === "error" || status === "denied" ? (
            <TriangleAlert className={cn("h-3.5 w-3.5", ICON_CLASS[status])} />
          ) : status === "not_executed" ? (
            <CircleSlash className={cn("h-3.5 w-3.5", ICON_CLASS[status])} />
          ) : (
            <Icon className={cn("h-3.5 w-3.5", ICON_CLASS[status])} />
          )}
        </span>
        <span className="min-w-0 flex-1 leading-5">
          <span
            className={cn(
              "text-[13px]",
              running
                ? "em-shimmer font-medium"
                : status === "success"
                  ? "text-foreground/85"
                  : "font-medium text-foreground",
            )}
          >
            {title}
          </span>
          {contextLine && (
            <span className="ml-2 text-[12px] text-muted-foreground [overflow-wrap:anywhere]">
              {contextLine}
            </span>
          )}
          {error && (status === "error" || status === "denied" || status === "partial") && (
            <span className="mt-0.5 line-clamp-2 block text-[12px] leading-5 text-red-600/90 dark:text-red-400/90 [overflow-wrap:anywhere]">
              {error.message}
            </span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-1.5 pt-0.5 text-[11px] leading-4">
          {statusText && (
            <span className={cn("font-medium", statusText.cls)}>{statusText.text}</span>
          )}
          {timing && <span className="tabular-nums text-muted-foreground/70">{timing}</span>}
          <ChevronRight aria-hidden="true" className="em-step-chevron h-3.5 w-3.5" />
        </span>
      </button>

      {approval && approval.status === "pending" && (
        <div className="ml-5">
          {Boolean(publishPlan) && (
            <div className="mt-1.5">
              <PublishPlan items={publishPlan} />
            </div>
          )}
          <ApprovalInline approval={approval} />
        </div>
      )}
      {approval && approval.status !== "pending" && (
        <div className="ml-5">
          <ApprovalOutcome approval={approval} />
        </div>
      )}
      {question && tool.name !== "ask_user" && (
        <div className="ml-5 mt-1.5 overflow-hidden rounded-lg border-l-2 border-[var(--em-primary)] bg-[var(--em-primary-alpha-06)]">
          <QuestionInline question={question} />
        </div>
      )}

      {streaming && tool.phase !== "done" && (
        <div className="ml-5 mt-1">
          <StreamingTextPreview toolName={tool.name} rawArgs={streaming} />
        </div>
      )}
      {!streaming && (tool.name === "write" || tool.name === "edit") && tool.phase !== "done" && (
        <div className="ml-5 mt-1">
          <TextChange tool={tool} />
        </div>
      )}

      <div className="ml-5 empty:hidden [&>*]:mt-1">
        <InlineResult tool={tool} />
      </div>

      <div
        id={detailsId}
        role="region"
        aria-label={`${title}执行详情`}
        aria-hidden={!open}
        inert={!open}
        className={cn("em-step-details", open && "em-step-details-open")}
      >
        <div className="em-step-details-clip">
          {opened && (
            <div className="em-step-details-panel">
              {hasArgs && (
                <div className="em-step-block">
                  <div className="em-step-block-label">
                    <span>参数</span>
                    <code className="font-mono text-[10px] font-normal text-muted-foreground/70">
                      {tool.name}
                    </code>
                  </div>
                  {tool.name === "run_script" && typeof args.code === "string" ? (
                    <CodeBlock language="typescript" code={args.code} maxHeightClass="max-h-64" />
                  ) : (
                    <pre className="em-step-pre max-h-56">{stringify(args, isMobile)}</pre>
                  )}
                </div>
              )}
              {data !== undefined && (
                <div className="em-step-block">
                  <div className="em-step-block-label">结果</div>
                  <pre className="em-step-pre">{stringify(data, isMobile)}</pre>
                </div>
              )}
              {error && (
                <div className="em-step-block em-step-block-error">
                  <div className="em-step-block-label">
                    错误
                    <code className="font-mono text-[10px] font-normal">{error.code}</code>
                  </div>
                  <pre className="em-step-pre">
                    {error.hint ? `${error.message}\n建议：${error.hint}` : error.message}
                  </pre>
                </div>
              )}
              {!hasArgs && data === undefined && !error && (
                <p className="py-1 text-[12px] text-muted-foreground">
                  {running
                    ? "正在执行，结果将在完成后显示。"
                    : status === "pending"
                      ? "等待执行，暂时没有详情。"
                      : "这一步没有返回详细内容。"}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
