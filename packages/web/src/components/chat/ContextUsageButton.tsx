import { AlertCircle, CheckCircle2, Layers, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  OverlayCard,
  OverlayCardAction,
  OverlayCardBody,
  OverlayCardDisclosure,
  OverlayCardFooter,
  OverlayCardHeader,
  OverlayCardInset,
} from "@/components/ui/overlay-card";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { api, errorMessage } from "@/lib/backend/api";
import { compactionCount as countCompactions } from "@/lib/session/reducer";
import { useChatStore } from "@/stores/chat-store";

/** 达到窗口的这个比例时提示接近上限（服务端按自己的阈值自动压缩）。 */
const WARN_RATIO = 0.8;

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function ContextUsageButton() {
  const sessionId = useChatStore((s) => s.sessionId);
  const agentId = useChatStore((s) => s.viewAgentId);
  const usage = useChatStore((s) => s.session.live[s.viewAgentId]?.contextUsage ?? null);
  const compactionCount = useChatStore((s) => countCompactions(s.session, s.viewAgentId));
  const [requesting, setCompacting] = useState(false);
  // 服务端推送的压缩进度（自动压缩也会触发），与手动发起的请求合并显示
  const serverCompacting = useChatStore((s) => s.compacting[s.viewAgentId] === true);
  const compacting = requesting || serverCompacting;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [compactPhase, setCompactPhase] = useState<"idle" | "submitting" | "success" | "error">(
    "idle",
  );
  const [compactHow, setCompactHow] = useState(false);
  const [lastCompactResult, setLastCompactResult] = useState<string | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setLastCompactResult(null);
  }, [sessionId]);
  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );

  const handleManualCompact = useCallback(async () => {
    if (!sessionId) return;
    setCompacting(true);
    setCompactPhase("submitting");
    try {
      const res = await api().compactAgent(sessionId, agentId);
      setLastCompactResult(
        res.scheduled
          ? "将在当前步骤结束后压缩上下文"
          : res.compacted
            ? "上下文已压缩"
            : "暂无可压缩的内容",
      );
      setCompactPhase("success");
      closeTimer.current = setTimeout(() => {
        setConfirmOpen(false);
        setCompactPhase("idle");
      }, 700);
    } catch (error) {
      setLastCompactResult(`压缩触发失败：${errorMessage(error, "请稍后重试。")}`);
      setCompactPhase("error");
    } finally {
      setCompacting(false);
    }
  }, [sessionId, agentId]);

  if (!usage?.window || usage.window <= 0) return null;
  const compaction = {
    current_tokens: usage.tokens,
    max_tokens: usage.window,
    usage_ratio: usage.tokens / usage.window,
    threshold_ratio: WARN_RATIO,
  };

  const pct = Math.min(compaction.usage_ratio, 1);
  const radius = 5;
  const circumference = 2 * Math.PI * radius;
  const strokeDash = pct * circumference;
  const colorClass =
    pct >= compaction.threshold_ratio
      ? "stroke-red-500"
      : pct >= compaction.threshold_ratio * 0.8
        ? "stroke-amber-500"
        : "stroke-emerald-500";
  const percentLabel = `${Math.round(pct * 100)}%`;

  return (
    <>
      <TooltipProvider delayDuration={400}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium transition-colors text-muted-foreground hover:text-foreground hover:bg-accent/40 outline-none"
              aria-label="上下文占用"
              onClick={(event) => {
                event.stopPropagation();
                setConfirmOpen(true);
              }}
            >
              {compacting ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <svg width="12" height="12" viewBox="0 0 14 14" className="flex-shrink-0">
                  <circle
                    cx="7"
                    cy="7"
                    r={radius}
                    fill="none"
                    className="stroke-muted"
                    strokeWidth="2.2"
                  />
                  <circle
                    cx="7"
                    cy="7"
                    r={radius}
                    fill="none"
                    className={`${colorClass} transition-all`}
                    strokeWidth="2.2"
                    strokeDasharray={`${strokeDash} ${circumference}`}
                    strokeLinecap="round"
                    transform="rotate(-90 7 7)"
                  />
                </svg>
              )}
              <span className="hidden sm:inline tabular-nums">{percentLabel}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs max-w-52">
            <div className="space-y-0.5">
              <div>
                Token: {formatTokens(compaction.current_tokens)} /{" "}
                {formatTokens(compaction.max_tokens)}
              </div>
              {usage.estimated && <div className="text-muted-foreground/70">（估算值）</div>}
              {compacting && <div>状态: 正在压缩…</div>}
              {lastCompactResult && <div>最近结果: {lastCompactResult.split("\n")[0]}</div>}
              {compactionCount > 0 && <div>已压缩: {compactionCount} 次</div>}
              <div className="text-muted-foreground/70 mt-1">点击压缩上下文</div>
            </div>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <OverlayCard
        open={confirmOpen}
        onOpenChange={(open) => {
          if (compactPhase === "submitting") return;
          setConfirmOpen(open);
          if (!open) setCompactPhase("idle");
        }}
        size="md"
        tone="primary"
      >
        <OverlayCardHeader
          icon={<Layers className="h-5 w-5" />}
          eyebrow="上下文管理"
          title="压缩对话上下文？"
          description="将较早的对话整理为摘要，为后续交流腾出空间。"
          onClose={compactPhase === "submitting" ? undefined : () => setConfirmOpen(false)}
        />
        <OverlayCardBody>
          <OverlayCardInset title="当前上下文">
            <div className="flex items-end justify-between gap-3 mb-2">
              <span className="text-[28px] font-semibold tabular-nums leading-none text-foreground">
                {Math.round(pct * 100)}%
              </span>
              <span className="text-xs text-muted-foreground mb-0.5">
                {compaction.usage_ratio >= compaction.threshold_ratio
                  ? "接近容量上限"
                  : `${formatTokens(compaction.current_tokens)} / ${formatTokens(compaction.max_tokens)}`}
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-[var(--em-primary)] transition-all"
                style={{ width: `${Math.round(pct * 100)}%` }}
              />
            </div>
          </OverlayCardInset>
          <ul className="mt-3 space-y-2 text-sm text-foreground/80">
            <li className="flex items-start gap-2">
              <span className="mt-0.5 text-[var(--em-primary)]">✓</span>
              <span>整理较早的对话与工具输出</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-0.5 text-[var(--em-primary)]">✓</span>
              <span>摘要会保留任务的关键信息</span>
            </li>
          </ul>
          <p className="mt-3 flex items-start gap-1.5 text-xs text-muted-foreground">
            <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
            部分历史细节可能被精简，请先保存重要内容。
          </p>
          <OverlayCardDisclosure
            label="了解压缩方式"
            open={compactHow}
            onToggle={() => setCompactHow((v) => !v)}
          >
            <p className="text-xs text-muted-foreground leading-relaxed">
              压缩会把较早的对话和工具输出整理成摘要，最近的轮次保持原文。这不会删除会话，只减少发给模型的上下文长度。
            </p>
          </OverlayCardDisclosure>
          {compactPhase === "error" && lastCompactResult && (
            <div className="mt-2 flex items-start gap-2 px-3 py-2 rounded-xl bg-red-500/10 border border-red-500/20 text-red-600 text-sm">
              <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
              {lastCompactResult}
            </div>
          )}
        </OverlayCardBody>
        <OverlayCardFooter className="flex-col sm:flex-row-reverse sm:justify-between">
          <OverlayCardAction
            action="primary"
            onClick={() => void handleManualCompact()}
            disabled={compacting || !sessionId}
            className={compactPhase === "error" ? "bg-red-600 hover:bg-red-600/90" : undefined}
          >
            {compactPhase === "submitting" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : compactPhase === "success" ? (
              <CheckCircle2 className="h-4 w-4" />
            ) : null}
            {compactPhase === "submitting"
              ? "提交中…"
              : compactPhase === "success"
                ? "已压缩"
                : compactPhase === "error"
                  ? "提交失败，请重试"
                  : "确认压缩"}
          </OverlayCardAction>
          <OverlayCardAction
            action="outline"
            onClick={() => setConfirmOpen(false)}
            disabled={compacting}
          >
            暂不压缩
          </OverlayCardAction>
        </OverlayCardFooter>
      </OverlayCard>
    </>
  );
}
