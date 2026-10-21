import type { ReasoningLevel } from "@excelmanus/protocol";
import { Brain, Check, Loader2 } from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useCurrentProfileId } from "@/hooks/use-model-selection";
import { api, errorMessage } from "@/lib/backend/api";
import { THINKING_EFFORT_LEVELS } from "@/lib/thinking";
import { refreshProfiles, useAppStore } from "@/stores/app-store";

const LEVELS: { key: ReasoningLevel; label: string; desc: string }[] = [
  { key: "provider-default", label: "自动", desc: "使用服务商默认" },
  ...THINKING_EFFORT_LEVELS.map(({ key, label, desc }) => ({ key, label, desc })),
];

/** 当前模型档案的思考强度（改的是档案设置，对使用该档案的对话都生效）。 */
export function ThinkingLevelSelector() {
  const profileId = useCurrentProfileId();
  const profile = useAppStore((s) => s.profiles.find((p) => p.id === profileId));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const selected: ReasoningLevel = profile?.reasoning ?? "provider-default";
  const unsupported = profile?.capabilities?.reasoning?.value === false;

  const handleSelect = useCallback(
    async (level: ReasoningLevel) => {
      if (!profile || level === selected) return;
      setError("");
      setSaving(true);
      try {
        await api().updateModelProfile(profile.id, { reasoning: level });
        await refreshProfiles();
      } catch (reason) {
        setError(errorMessage(reason, "思考设置未生效"));
      } finally {
        setSaving(false);
      }
    },
    [profile, selected],
  );

  const currentLabel = !profile
    ? "自动"
    : unsupported
      ? "无推理控制"
      : (LEVELS.find((l) => l.key === selected)?.label ?? "自动");
  const selectable = !!profile && !unsupported;

  const triggerButton = (
    <button
      type="button"
      disabled={saving || !selectable}
      className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium transition-colors text-muted-foreground hover:text-foreground hover:bg-accent/40 outline-none disabled:cursor-default disabled:hover:bg-transparent"
    >
      {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Brain className="h-3 w-3" />}
      <span className="hidden sm:inline">{currentLabel}</span>
    </button>
  );

  const triggerWithTooltip = (trigger: ReactNode) => (
    <TooltipProvider delayDuration={400}>
      <Tooltip>
        <TooltipTrigger asChild>{trigger}</TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          {error || `思考控制: ${currentLabel}`}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );

  if (!selectable) return triggerWithTooltip(triggerButton);

  return (
    <DropdownMenu>
      {triggerWithTooltip(<DropdownMenuTrigger asChild>{triggerButton}</DropdownMenuTrigger>)}
      <DropdownMenuContent align="end" sideOffset={6} className="min-w-[140px]">
        {LEVELS.map(({ key, label, desc }) => (
          <DropdownMenuItem
            key={key}
            onClick={() => void handleSelect(key)}
            className="flex items-center justify-between gap-3 text-xs"
          >
            <div className="flex flex-col">
              <span className="font-medium">{label}</span>
              <span className="text-[10px] text-muted-foreground">{desc}</span>
            </div>
            {selected === key && (
              <Check className="h-3.5 w-3.5 flex-shrink-0" style={{ color: "var(--em-primary)" }} />
            )}
          </DropdownMenuItem>
        ))}
        <div className="border-t border-border/60 px-2 py-1.5 text-[10px] text-muted-foreground">
          设置保存在模型档案「{profile.name}」上
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
