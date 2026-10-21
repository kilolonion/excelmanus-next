// 失败指引：本轮模型调用失败时说明原因与下一步（重试、换模型、去设置、压缩上下文）。

import type { ClassifiedError, ErrorGuidance } from "@excelmanus/protocol";
import {
  Check,
  Copy,
  CreditCard,
  KeyRound,
  Play,
  Settings,
  ShieldAlert,
  Wifi,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import { useUIStore } from "@/stores/ui-store";
import { RetryModelPicker } from "./RetryModelPicker";

const KIND_ICON: Record<string, typeof XCircle> = {
  auth: KeyRound,
  model_not_found: ShieldAlert,
  invalid_request: ShieldAlert,
  rate_limit: CreditCard,
  network: Wifi,
  stream_interrupted: Wifi,
  server_error: XCircle,
};

const SETTINGS_KINDS = new Set(["auth", "model_not_found", "invalid_request"]);

const GHOST_BTN =
  "touch-compact inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground";
const PRIMARY_BTN =
  "touch-compact inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-[var(--em-primary)] px-3 text-[12px] font-semibold text-white hover:opacity-90";

export function FailureGuidanceCard({
  guidance,
  failure,
  onRetry,
  onRetryWithModel,
  onCompact,
}: {
  guidance?: ErrorGuidance;
  failure?: ClassifiedError;
  onRetry?: () => void;
  onRetryWithModel?: (profileId: string) => void;
  onCompact?: () => void;
}) {
  const openSettings = useUIStore((s) => s.openSettings);
  const [copied, setCopied] = useState(false);
  const kind = guidance?.kind ?? failure?.kind ?? "unknown";
  const Icon = KIND_ICON[kind] ?? XCircle;
  const title = guidance?.message ?? failure?.message ?? "本轮执行失败";
  const detail = failure && failure.message !== title ? failure.message : undefined;
  const retryable = guidance?.retryable ?? failure?.retryable ?? true;
  const copy = () => {
    const payload = JSON.stringify(
      {
        kind,
        message: title,
        detail: failure?.detail,
        statusCode: failure?.statusCode,
        at: new Date().toISOString(),
      },
      null,
      2,
    );
    void navigator.clipboard
      .writeText(payload)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => undefined);
  };
  return (
    <div className="my-2 rounded-lg border-l-2 border-red-500 bg-red-500/[0.05] px-3 py-2.5">
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-foreground">{title}</p>
          {detail && (
            <p className="mt-0.5 text-[12px] leading-5 break-words text-muted-foreground">
              {detail}
            </p>
          )}
          {guidance && guidance.actions.length > 0 && (
            <ul className="mt-1 list-inside list-disc text-[12px] leading-5 text-muted-foreground">
              {guidance.actions.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {onRetry && retryable && (
              <button type="button" onClick={onRetry} className={PRIMARY_BTN}>
                <Play className="h-3.5 w-3.5 fill-current" />
                重试
              </button>
            )}
            {kind === "context_overflow" && onCompact && (
              <button type="button" onClick={onCompact} className={PRIMARY_BTN}>
                压缩上下文
              </button>
            )}
            {SETTINGS_KINDS.has(kind) && (
              <button
                type="button"
                onClick={() => openSettings("model")}
                className={onRetry && retryable ? GHOST_BTN : PRIMARY_BTN}
              >
                <Settings className="h-3.5 w-3.5" />
                检查模型设置
              </button>
            )}
            {onRetryWithModel && (
              <RetryModelPicker onSelect={onRetryWithModel} triggerClassName={GHOST_BTN} />
            )}
            <button type="button" onClick={copy} className={GHOST_BTN}>
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "已复制" : "复制诊断信息"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
