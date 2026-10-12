// 工具卡内联的授权确认：代理请求执行需要授权的工具时，直接在这张工具卡上批准或拒绝。
// 批准 = 只放行这一次；「本会话自动批准同类操作」= 记住规则；「允许本会话全部操作」= 切到自动模式。

import { AlertCircle, Check, ChevronRight, Loader2, LocateFixed, Shield, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { MiniCheckbox } from "@/components/ui/MiniCheckbox";
import { errorMessage } from "@/lib/backend/api";
import type { ApprovalState } from "@/lib/session/types";
import { approvalCopy, extractToolContext, isWriteTool } from "@/lib/tool-labels";
import { cn } from "@/lib/utils";
import { pendingWriteTargets } from "@/lib/workbook/pending-writes";
import { decideApproval, setPermissionMode } from "@/stores/chat-store";
import { focusRange } from "@/stores/workbook-store";

type Phase =
  | { kind: "idle" }
  | { kind: "busy"; action: "approve" | "deny" | "all" }
  | { kind: "error"; message: string };

const EFFECT_BADGE: Record<string, { text: string; cls: string } | undefined> = {
  write: { text: "将修改文件", cls: "bg-amber-500/12 text-amber-800 dark:text-amber-300" },
  destructive: { text: "可能删除或覆盖", cls: "bg-red-500/12 text-red-700 dark:text-red-300" },
  external: { text: "访问外部服务", cls: "bg-sky-500/12 text-sky-700 dark:text-sky-300" },
};

export function ApprovalInline({ approval }: { approval: ApprovalState }) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [remember, setRemember] = useState(false);
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const [details, setDetails] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const args = (approval.args ?? {}) as Record<string, unknown>;
  const ctx = extractToolContext(approval.toolName, args);
  const copy = approvalCopy(approval.toolName, approval.effect, ctx);
  const plan = pendingWriteTargets(approval);
  const badge =
    EFFECT_BADGE[approval.effect] ??
    (isWriteTool(approval.toolName) ? EFFECT_BADGE.write : undefined);
  const busy = phase.kind === "busy";

  // 新出现的授权请求滚到可见处，避免用户不知道代理在等
  useEffect(() => {
    rootRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, []);

  const run = async (action: "approve" | "deny" | "all") => {
    if (busy) return;
    setPhase({ kind: "busy", action });
    try {
      if (action === "deny") {
        await decideApproval(approval.id, "deny", reason.trim() ? { reason: reason.trim() } : {});
      } else {
        if (action === "all") await setPermissionMode("auto");
        await decideApproval(
          approval.id,
          "approve",
          action === "approve" && remember ? { remember: true } : {},
        );
      }
      setPhase({ kind: "idle" });
    } catch (error) {
      setPhase({ kind: "error", message: errorMessage(error, "提交失败，请重试") });
    }
  };

  return (
    <div
      ref={rootRef}
      role="group"
      aria-label="需要你的授权"
      className="mt-1.5 overflow-hidden rounded-lg border-l-2 border-amber-500 bg-amber-500/[0.06] dark:bg-amber-500/[0.08]"
    >
      <div className="flex items-start gap-2 px-3 pt-2">
        <Shield className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="text-[13px] font-semibold text-amber-950 dark:text-amber-100">
              {copy.title}
            </p>
            {badge && (
              <span className={cn("rounded-full px-1.5 py-px text-[10px] font-medium", badge.cls)}>
                {badge.text}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-[12px] leading-5 text-amber-900/80 dark:text-amber-100/70">
            {copy.description}
          </p>
          {plan && plan.ranges.length > 0 && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-amber-900/70 dark:text-amber-100/60">拟修改</span>
              {plan.ranges.slice(0, 4).map((range) => (
                <button
                  key={range}
                  type="button"
                  onClick={() =>
                    void focusRange(
                      range,
                      plan.docId
                        ? { docId: plan.docId }
                        : plan.path
                          ? { path: plan.path }
                          : undefined,
                    )
                  }
                  className="inline-flex h-5 items-center gap-1 rounded-md bg-background/80 px-1.5 font-mono text-[11px] text-foreground hover:bg-background"
                  title="在表格中预览"
                >
                  <LocateFixed className="h-2.5 w-2.5" />
                  {range}
                </button>
              ))}
              {plan.ranges.length > 4 && (
                <span className="text-[11px] text-muted-foreground">
                  等 {plan.ranges.length} 处
                </span>
              )}
            </div>
          )}
          {approval.targets.length > 0 && !plan && (
            <p
              className="mt-1 truncate font-mono text-[11px] text-amber-900/70 dark:text-amber-100/60"
              title={approval.targets.join("\n")}
            >
              {approval.targets.join(" · ")}
            </p>
          )}
          <button
            type="button"
            onClick={() => setDetails((v) => !v)}
            className="mt-1 inline-flex items-center gap-1 text-[11px] text-amber-900/70 hover:text-amber-950 dark:text-amber-100/60 dark:hover:text-amber-100"
            aria-expanded={details}
          >
            <ChevronRight className={cn("h-3 w-3 transition-transform", details && "rotate-90")} />
            参数详情
          </button>
          {details && (
            <pre className="mt-1 max-h-48 overflow-auto rounded-md bg-background/70 p-2 font-mono text-[10.5px] leading-4 text-foreground/80">
              {JSON.stringify(approval.args, null, 2)}
            </pre>
          )}
        </div>
      </div>

      {denying ? (
        <div className="px-3 pb-2.5 pt-2">
          <textarea
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void run("deny");
              if (e.key === "Escape") setDenying(false);
            }}
            rows={2}
            placeholder="拒绝理由（可选，会告诉代理，⌘/Ctrl+Enter 提交）"
            className="w-full resize-none rounded-md border border-transparent bg-background px-2.5 py-1.5 text-[12px] outline-none focus:border-[var(--em-primary)] focus:ring-2 focus:ring-[var(--em-primary-alpha-15)]"
          />
          <div className="mt-1.5 flex items-center justify-end gap-1.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => setDenying(false)}
              className="h-7 rounded-md px-2.5 text-[12px] text-muted-foreground hover:bg-background/70 hover:text-foreground"
            >
              返回
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void run("deny")}
              className="inline-flex h-7 items-center gap-1 rounded-md bg-red-600 px-3 text-[12px] font-semibold text-white hover:bg-red-600/90 disabled:opacity-60"
            >
              {phase.kind === "busy" && phase.action === "deny" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <X className="h-3.5 w-3.5" />
              )}
              确认拒绝
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2 px-3 pb-2 pt-1.5 sm:flex-row sm:items-center">
          <MiniCheckbox
            checked={remember}
            onChange={setRemember}
            label="本会话自动批准同类操作"
            className="min-w-0 flex-1 text-[11.5px] text-amber-900/80 dark:text-amber-100/70"
          />
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => void run("all")}
              className="h-9 rounded-md px-2 text-[12px] font-medium text-[var(--em-primary)] hover:bg-background/70 disabled:opacity-50 sm:h-7"
              title="切换为自动模式：本会话后续操作不再询问"
            >
              {phase.kind === "busy" && phase.action === "all" ? (
                <Loader2 className="inline h-3.5 w-3.5 animate-spin" />
              ) : (
                "允许全部"
              )}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setDenying(true)}
              className="h-9 rounded-md bg-background px-3 text-[12px] font-medium text-foreground hover:bg-muted disabled:opacity-50 sm:h-7"
            >
              拒绝
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void run("approve")}
              className="inline-flex h-9 flex-1 items-center justify-center gap-1 rounded-md bg-[var(--em-primary)] px-3 text-[12px] font-semibold text-white hover:opacity-90 disabled:opacity-60 sm:h-7 sm:flex-none"
            >
              {phase.kind === "busy" && phase.action === "approve" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="h-3.5 w-3.5" />
              )}
              {isWriteTool(approval.toolName) ? "允许本次修改" : "允许本次"}
            </button>
          </div>
        </div>
      )}
      {phase.kind === "error" && (
        <div
          role="alert"
          className="flex items-start gap-1.5 px-3 pb-2 text-[12px] text-red-700 dark:text-red-300"
        >
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          {phase.message}
        </div>
      )}
    </div>
  );
}

/** 已处理的授权：在工具卡上留一行结果。 */
export function ApprovalOutcome({ approval }: { approval: ApprovalState }) {
  if (approval.status === "pending") return null;
  const approved = approval.status === "approved";
  return (
    <p
      className={cn(
        "mt-0.5 text-[11px]",
        approved ? "text-muted-foreground" : "text-red-600 dark:text-red-400",
      )}
    >
      {approved
        ? approval.remember
          ? "已授权 · 本会话同类操作自动批准"
          : "已授权"
        : `已拒绝${approval.reason ? `：${approval.reason}` : ""}`}
    </p>
  );
}
