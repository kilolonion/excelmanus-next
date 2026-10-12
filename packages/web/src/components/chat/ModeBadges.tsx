import type { PermissionMode } from "@excelmanus/protocol";
import { Check, Loader2, Shield } from "lucide-react";
import { useCallback, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/toaster";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { errorMessage } from "@/lib/backend/api";
import { useAppStore } from "@/stores/app-store";
import { setPermissionMode, useChatStore } from "@/stores/chat-store";

const POLICIES: { key: PermissionMode; label: string; desc: string }[] = [
  { key: "confirm", label: "询问", desc: "写入前确认" },
  { key: "standard", label: "标准", desc: "常规写入自动，删除与外部调用需确认" },
  { key: "auto", label: "自动审批", desc: "自动批准，仍保留安全边界与备份" },
];

function isPermissionMode(value: unknown): value is PermissionMode {
  return value === "confirm" || value === "standard" || value === "auto";
}

/** 当前会话的权限模式（会话覆盖全局默认）。 */
export function ModeBadges() {
  const sessionId = useChatStore((s) => s.sessionId);
  const sessionMode = useChatStore((s) => s.session.permissionMode);
  const defaultMode = useAppStore((s) => s.settings?.defaultPermissionMode ?? "standard");
  const [toggling, setToggling] = useState(false);
  const active: PermissionMode = isPermissionMode(sessionMode) ? sessionMode : defaultMode;
  const current = POLICIES.find((p) => p.key === active) ?? POLICIES[1];

  const handleSelect = useCallback(
    async (key: PermissionMode) => {
      if (!sessionId || toggling || key === active) return;
      setToggling(true);
      try {
        await setPermissionMode(key);
      } catch (error) {
        toast({ tone: "error", title: "权限模式未生效", description: errorMessage(error) });
      } finally {
        setToggling(false);
      }
    },
    [sessionId, active, toggling],
  );

  return (
    <DropdownMenu>
      <TooltipProvider delayDuration={400}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                disabled={!sessionId || toggling}
                data-coach-id="coach-mode-badges"
                className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium transition-colors outline-none disabled:cursor-default disabled:opacity-50 ${
                  active !== "confirm"
                    ? "hover:bg-accent/40"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent/40"
                }`}
                style={
                  active === "auto"
                    ? { color: "var(--em-gold)" }
                    : active === "standard"
                      ? { color: "var(--em-primary)" }
                      : undefined
                }
              >
                {toggling ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Shield className="h-3 w-3" />
                )}
                <span className="hidden sm:inline">{current.label}</span>
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            权限模式: {current.label}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <DropdownMenuContent align="end" sideOffset={6} className="min-w-[160px]">
        {POLICIES.map(({ key, label, desc }) => (
          <DropdownMenuItem
            key={key}
            onClick={() => void handleSelect(key)}
            className="flex items-center justify-between gap-3 text-xs"
          >
            <div className="flex flex-col">
              <span className="font-medium">{label}</span>
              <span className="text-[10px] text-muted-foreground">{desc}</span>
            </div>
            {active === key && (
              <Check className="h-3.5 w-3.5 flex-shrink-0" style={{ color: "var(--em-primary)" }} />
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
