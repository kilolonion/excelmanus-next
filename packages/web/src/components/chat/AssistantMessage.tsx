import { formatClock } from "@/lib/message-time";
// 助手的一段回复（一轮或被插话拆开的一段）：思考、文字、工具步骤分组、呈现与记忆等块；
// 运行中的段落接上流式内容（思考、正在生成参数的工具、文字）。

import { CircleStop, FileSpreadsheet, Play, RotateCw } from "lucide-react";
import React, { useMemo, useState } from "react";
import { toast } from "@/components/ui/toaster";
import { errorMessage } from "@/lib/backend/api";
import { MAIN_AGENT } from "@/lib/session/reducer";
import { isStandaloneTool, SELF_RENDERED_TOOLS } from "@/lib/session/tool-view";
import type { Block, TurnSegment } from "@/lib/session/types";
import { pendingToolLabel } from "@/lib/tool-labels";
import { cn } from "@/lib/utils";
import { resumeAgent, useChatStore } from "@/stores/chat-store";
import { ActivityGroup } from "./ActivityGroup";
import { AskUserCard } from "./AskUserCard";
import { AssistantWaitingIndicator } from "./AssistantWaitingIndicator";
import {
  MemoryCard,
  PresentCard,
  RetryNotice,
  TurnChangesCard,
} from "./assistant-blocks/block-cards";
import { MemoizedMarkdown } from "./assistant-blocks/MemoizedMarkdown";
import { FailureGuidanceCard } from "./FailureGuidanceCard";
import { MessageActions } from "./MessageActions";
import { SubagentBlock } from "./SubagentBlock";
import { TaskList } from "./TaskList";
import { ThinkingBlock } from "./ThinkingBlock";

type Piece =
  | { kind: "block"; block: Block }
  | { kind: "tools"; key: string; ids: string[] }
  | { kind: "standalone"; key: string; id: string };

export interface AssistantMessageProps {
  segment: TurnSegment;
  /** 最新一段：展开工具分组、常显操作栏。 */
  isLatest: boolean;
  onRetry?: () => void;
  onRetryWithModel?: (profileId: string) => void;
  onCompact?: () => void;
}

export const AssistantMessage = React.memo(function AssistantMessage({
  segment,
  isLatest,
  onRetry,
  onRetryWithModel,
  onCompact,
}: AssistantMessageProps) {
  const tools = useChatStore((s) => s.session.tools);
  const openSegment = useChatStore(
    (s) => s.session.openSegments[segment.agentId]?.segmentId ?? null,
  );
  const live = useChatStore((s) =>
    openSegment === segment.id ? s.session.live[segment.agentId] : undefined,
  );
  const isOpen = openSegment === segment.id;
  const running = segment.status === "running";

  const pieces = useMemo(() => {
    const out: Piece[] = [];
    let group: string[] = [];
    const flush = () => {
      if (group.length > 0) {
        out.push({ kind: "tools", key: `tools:${group[0]}`, ids: group });
        group = [];
      }
    };
    for (const block of segment.blocks) {
      if (block.type === "tool") {
        const tool = tools[block.key];
        if (!tool) continue;
        // 任务清单与呈现另有展示；只有失败时才显示工具本身
        if (SELF_RENDERED_TOOLS.has(tool.name) && !(tool.phase === "done" && tool.status !== "ok"))
          continue;
        if (isStandaloneTool(tool.name)) {
          flush();
          out.push({ kind: "standalone", key: block.key, id: block.key });
        } else group.push(block.key);
        continue;
      }
      flush();
      out.push({ kind: "block", block });
    }
    flush();
    return out;
  }, [segment.blocks, tools]);

  // 流式中、尚未进入日志的工具调用（参数还在生成）
  const toolArgs = live?.toolArgs;
  const pendingArgs = useMemo(() => {
    if (!toolArgs) return [];
    return Object.entries(toolArgs).filter(
      ([id]) => !tools[id] && !segment.blocks.some((b) => b.type === "tool" && b.key === id),
    );
  }, [toolArgs, tools, segment.blocks]);

  const liveText = isOpen ? (live?.text ?? "") : "";
  const liveReasoning = isOpen ? (live?.reasoning ?? "") : "";
  const hasContent =
    pieces.length > 0 || liveText !== "" || liveReasoning !== "" || pendingArgs.length > 0;
  const showWaiting =
    running &&
    isOpen &&
    !liveText &&
    !liveReasoning &&
    pendingArgs.length === 0 &&
    !pieces.some((p) => p.kind !== "block" || p.block.type !== "thinking");
  const ended = segment.endedAt !== undefined;
  const failed = segment.status === "failed";
  const interrupted = segment.status === "interrupted";
  const { guidance, text, feedbackSeq } = useMemo(() => {
    const guidance = segment.blocks.findLast(
      (b): b is Extract<Block, { type: "guidance" }> => b.type === "guidance",
    )?.guidance;
    const text = segment.blocks
      .filter((b): b is Extract<Block, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n\n")
      .trim();
    const feedbackSeq = segment.blocks.findLast((b) => b.type === "text")?.seq;
    return { guidance, text, feedbackSeq };
  }, [segment.blocks]);
  const clock = useMemo(() => formatClock(segment.at), [segment.at]);

  const renderedPieces = useMemo(() => {
    const renderBlock = (block: Block, index: number, last: boolean) => {
      switch (block.type) {
        case "thinking":
          return (
            <ThinkingBlock
              key={block.key}
              content={block.text}
              {...(block.ms !== undefined ? { duration: block.ms / 1000 } : {})}
            />
          );
        case "text":
          return block.text.trim() ? (
            <MemoizedMarkdown
              key={block.key}
              content={block.text}
              defaultExpanded={last || index > 0}
            />
          ) : null;
        case "todo":
          return <TaskList key={block.key} items={block.items} />;
        case "present":
          return <PresentCard key={block.key} payload={block.payload} />;
        case "retry":
          return <RetryNotice key={block.key} block={block} />;
        case "memory":
          return <MemoryCard key={block.key} block={block} />;
        case "changes":
          return <TurnChangesCard key={block.key} changes={block.changes} />;
        case "guidance":
          return null; // 与轮次失败一起显示在末尾
        default:
          return null;
      }
    };

    return pieces.map((piece, i) => {
      if (piece.kind === "tools")
        return (
          <ActivityGroup
            key={piece.key}
            toolIds={piece.ids}
            defaultCollapsed={!isLatest && !running}
          />
        );
      if (piece.kind === "standalone") {
        const tool = tools[piece.id];
        if (!tool) return null;
        if (tool.name === "ask_user")
          return <StandaloneQuestion key={piece.key} toolId={piece.id} />;
        return <SubagentBlock key={piece.key} tool={tool} />;
      }
      return renderBlock(piece.block, i, i === pieces.length - 1);
    });
  }, [pieces, tools, isLatest, running]);
  if (!hasContent && !showWaiting && !(ended && (failed || interrupted))) return null;

  return (
    <div className="group/msg flex gap-2 py-2.5 sm:gap-2.5" data-segment-id={segment.id}>
      <div
        className={cn(
          "mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-[10px] text-white",
          showWaiting && "assistant-avatar-wait",
        )}
        style={{ backgroundColor: "var(--em-accent)" }}
      >
        <FileSpreadsheet className="h-3.5 w-3.5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <div className="assistant-msg-body min-w-0 flex-1">
            {showWaiting && <AssistantWaitingIndicator />}
            {renderedPieces}
            {liveReasoning && (
              <ThinkingBlock
                content={liveReasoning}
                isActive
                {...(live?.reasoningStartedAt ? { startedAt: live.reasoningStartedAt } : {})}
              />
            )}
            {liveText && <MemoizedMarkdown content={liveText} isStreamingText defaultExpanded />}
            {pendingArgs.map(([id, info]) => (
              <div key={id} className="my-1 flex items-center gap-2 text-[13px]">
                <span className="em-shimmer font-medium">
                  {pendingToolLabel(info.name, info.text)}
                </span>
              </div>
            ))}
            {ended && failed && (
              <FailureGuidanceCard
                {...(guidance ? { guidance } : {})}
                {...(segment.failure ? { failure: segment.failure } : {})}
                {...(onRetry ? { onRetry } : {})}
                {...(onRetryWithModel ? { onRetryWithModel } : {})}
                {...(onCompact ? { onCompact } : {})}
              />
            )}
            {ended && interrupted && segment.reason === "restart" ? (
              <RestartNotice agentId={segment.agentId} actionable={isLatest} />
            ) : (
              ended &&
              interrupted && (
                <div className="my-1.5 flex items-center gap-2 text-[12px] text-muted-foreground">
                  <CircleStop className="h-3.5 w-3.5" />
                  已停止
                </div>
              )
            )}
          </div>
          {clock && segment.agentId === MAIN_AGENT && (
            <span className="flex h-6 min-w-[2.75rem] flex-shrink-0 items-center justify-end text-[11px] leading-none tabular-nums text-muted-foreground/70">
              {clock}
            </span>
          )}
        </div>
        {ended && !failed && (
          <MessageActions
            text={text}
            steps={segment.steps}
            visible={isLatest}
            {...(feedbackSeq !== undefined ? { feedbackSeq } : {})}
            {...(segment.usage ? { usage: segment.usage } : {})}
            {...(onRetry ? { onRetry } : {})}
            {...(onRetryWithModel ? { onRetryWithModel } : {})}
          />
        )}
      </div>
    </div>
  );
});

function StandaloneQuestion({ toolId }: { toolId: string }) {
  const tool = useChatStore((s) => s.session.tools[toolId]);
  const question = useChatStore((s) =>
    tool?.questionId ? s.session.questions[tool.questionId] : undefined,
  );
  if (!tool) return null;
  return <AskUserCard tool={tool} {...(question ? { question } : {})} />;
}

/** 服务重启时正在运行的任务（02 §9）：不自动重放，由用户决定是否继续。 */
function RestartNotice({ agentId, actionable }: { agentId: string; actionable: boolean }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="em-restart-notice">
      <RotateCw className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">任务在服务重启时中断，未完成的操作没有自动重做。</span>
      {actionable && (
        <button
          type="button"
          disabled={busy}
          className="em-restart-notice-action"
          onClick={() => {
            setBusy(true);
            void resumeAgent(agentId)
              .catch((error: unknown) =>
                toast({ tone: "error", title: errorMessage(error, "继续失败") }),
              )
              .finally(() => setBusy(false));
          }}
        >
          <Play className="h-3 w-3" aria-hidden="true" />
          继续
        </button>
      )}
    </div>
  );
}
