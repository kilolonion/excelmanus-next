import type { Usage } from "@excelmanus/protocol";
import { Check, Copy, RotateCcw, ThumbsDown, ThumbsUp } from "lucide-react";
import React, { useState } from "react";
import { toast } from "@/components/ui/toaster";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { errorMessage } from "@/lib/backend/api";
import { sendFeedback, useChatStore } from "@/stores/chat-store";
import { RetryModelPicker } from "./RetryModelPicker";

function formatTokens(n: number | undefined): string {
  if (n === undefined) return "—";
  return n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString();
}

function ActionButton({
  onClick,
  label,
  active,
  pressed,
  children,
}: {
  onClick: () => void;
  label: string;
  active?: boolean;
  pressed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors ${active ? "text-[var(--em-primary)] dark:text-[var(--em-primary-light)]" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"}`}
      aria-label={label}
      {...(pressed !== undefined ? { "aria-pressed": pressed } : {})}
      title={label}
    >
      {children}
    </button>
  );
}

/** 点赞 / 点踩：状态来自日志里的 feedback.given，再点一次撤回。 */
function FeedbackButtons({ seq }: { seq: number }) {
  const rating = useChatStore((s) => s.session.feedback[seq]);
  const [pending, setPending] = useState(false);
  const give = (next: "up" | "down") => {
    if (pending) return;
    setPending(true);
    void sendFeedback(seq, rating === next ? null : next)
      .then(() => {
        if (next === "down" && rating !== "down")
          toast({ title: "已记录", description: "可以在下方继续说明哪里不对，我会据此改进。" });
      })
      .catch((error: unknown) => toast({ tone: "error", title: errorMessage(error, "反馈未保存") }))
      .finally(() => setPending(false));
  };
  return (
    <>
      <ActionButton
        onClick={() => give("up")}
        label={rating === "up" ? "取消赞" : "有帮助"}
        active={rating === "up"}
        pressed={rating === "up"}
      >
        <ThumbsUp className="h-3.5 w-3.5" />
      </ActionButton>
      <ActionButton
        onClick={() => give("down")}
        label={rating === "down" ? "取消踩" : "没帮上忙"}
        active={rating === "down"}
        pressed={rating === "down"}
      >
        <ThumbsDown className="h-3.5 w-3.5" />
      </ActionButton>
    </>
  );
}

/** 助手回复下方的操作：复制、反馈、重试、换模型重试，以及本轮用量。 */
export const MessageActions = React.memo(function MessageActions({
  text,
  usage,
  steps,
  feedbackSeq,
  onRetry,
  onRetryWithModel,
  visible,
}: {
  text: string;
  /** 本段最后一条 model.output 的 seq（反馈对象）。 */
  feedbackSeq?: number;
  usage?: Usage;
  steps: number;
  onRetry?: () => void;
  onRetryWithModel?: (profileId: string) => void;
  /** 最新一条回复始终显示，其余悬停时显示。 */
  visible: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    if (!text) return;
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  };
  const total =
    usage?.totalTokens ?? ((usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0) || undefined);
  return (
    <div
      className={`mt-1 flex items-center gap-0.5 transition-opacity duration-200 touch-show ${visible ? "opacity-100" : "opacity-0 group-hover/msg:opacity-100 focus-within:opacity-100"}`}
      role="toolbar"
      aria-label="消息操作"
    >
      {text && (
        <ActionButton onClick={copy} label={copied ? "已复制" : "复制"} active={copied}>
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </ActionButton>
      )}
      {feedbackSeq !== undefined && <FeedbackButtons seq={feedbackSeq} />}
      {onRetry && (
        <ActionButton onClick={onRetry} label="从这条消息重新开始">
          <RotateCcw className="h-3.5 w-3.5" />
        </ActionButton>
      )}
      {onRetryWithModel && (
        <RetryModelPicker
          onSelect={onRetryWithModel}
          iconOnly
          triggerClassName="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
        />
      )}
      {total !== undefined && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="ml-1.5 cursor-default text-[11px] tabular-nums text-muted-foreground/60"
              tabIndex={0}
            >
              {steps > 1 ? `${steps} 轮 · ` : ""}
              {formatTokens(total)} tokens
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            输入 {formatTokens(usage?.inputTokens)} · 输出 {formatTokens(usage?.outputTokens)}
            {usage?.reasoningTokens ? ` · 推理 ${formatTokens(usage.reasoningTokens)}` : ""}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
});
