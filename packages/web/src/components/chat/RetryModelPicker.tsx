import { ArrowRightLeft, RefreshCw } from "lucide-react";
import { useState } from "react";
import { ModelListBottomSheet } from "@/components/chat/ModelListBottomSheet";
import { hasProviderLogo, ProviderLogo } from "@/components/settings/model/ProviderLogo";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useIsMobile } from "@/hooks/use-mobile";
import { useCurrentProfileId, usePickerModels } from "@/hooks/use-model-selection";
import { getProviderColor } from "@/lib/provider-brand";

const DEFAULT_TRIGGER =
  "touch-compact inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground";

/** 换一个模型档案重试（从触发这轮的消息重新开始）。 */
export function RetryModelPicker({
  onSelect,
  triggerClassName = DEFAULT_TRIGGER,
  triggerLabel = "换模型",
  iconOnly = false,
}: {
  onSelect: (profileId: string) => void;
  triggerClassName?: string;
  triggerLabel?: string;
  iconOnly?: boolean;
}) {
  const models = usePickerModels();
  const current = useCurrentProfileId();
  const isMobile = useIsMobile();
  const [sheetOpen, setSheetOpen] = useState(false);
  const trigger = (
    <button
      type="button"
      aria-label={`${triggerLabel}重试`}
      title={`${triggerLabel}重试`}
      className={triggerClassName}
      onClick={isMobile ? () => setSheetOpen(true) : undefined}
    >
      <ArrowRightLeft className="h-3.5 w-3.5 shrink-0" />
      {!iconOnly && <span>{triggerLabel}</span>}
    </button>
  );
  if (models.length < 2) return null;
  if (isMobile)
    return (
      <>
        {trigger}
        <ModelListBottomSheet
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          models={models}
          currentModel={current}
          onSelect={onSelect}
          mode="retry"
        />
      </>
    );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-64 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl p-0"
      >
        <div className="flex items-center gap-2 border-b border-border/50 px-3 pb-2 pt-2.5">
          <RefreshCw className="h-3.5 w-3.5" style={{ color: "var(--em-primary)" }} />
          <span className="text-xs font-medium text-foreground/70">选择模型重试</span>
        </div>
        <div className="max-h-[36vh] overflow-y-auto py-1">
          {models.map((m) => {
            const isCurrent = m.id === current;
            const color = getProviderColor(m.brand);
            return (
              <button
                key={m.id}
                type="button"
                disabled={m.unhealthy}
                onClick={() => onSelect(m.id)}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-accent/50 disabled:opacity-50 ${isCurrent ? "bg-[var(--em-primary-alpha-06)]" : ""}`}
              >
                {hasProviderLogo(m.brand) ? (
                  <ProviderLogo id={m.brand} color={color} className="h-3.5 w-3.5" />
                ) : (
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: color }}
                  />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">{m.label}</span>
                  {m.label !== m.model && (
                    <span className="block truncate font-mono text-[10px] text-muted-foreground/60">
                      {m.model}
                    </span>
                  )}
                </span>
                {isCurrent && (
                  <span
                    className="rounded-full px-1.5 py-px text-[9px] font-medium"
                    style={{
                      backgroundColor: "var(--em-primary-alpha-10)",
                      color: "var(--em-primary)",
                    }}
                  >
                    当前
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
