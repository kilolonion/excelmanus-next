import { ArrowRightLeft, RefreshCw } from "lucide-react";
import { useState } from "react";
import { ModelListBottomSheet } from "@/components/chat/ModelListBottomSheet";
import { hasProviderLogo, ProviderLogo } from "@/components/settings/model/ProviderLogo";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
  const [open, setOpen] = useState(false);
  const selectModel = (profileId: string) => {
    setOpen(false);
    onSelect(profileId);
  };
  const trigger = (
    <button
      type="button"
      aria-label={`${triggerLabel}重试`}
      title={`${triggerLabel}重试`}
      className={triggerClassName}
      onClick={isMobile ? () => setOpen(true) : undefined}
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
          open={open}
          onOpenChange={setOpen}
          models={models}
          currentModel={current}
          onSelect={selectModel}
          mode="retry"
        />
      </>
    );
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
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
          {models.map((m, index) => {
            const isCurrent = m.id === current;
            const color = getProviderColor(m.brand);
            return (
              <div key={m.id}>
                {(index === 0 || models[index - 1]?.connectionId !== m.connectionId) && (
                  <p className="px-3 pt-2 text-[10px] text-muted-foreground">{m.providerLabel}</p>
                )}
                <DropdownMenuItem
                  disabled={m.unhealthy}
                  onSelect={() => selectModel(m.id)}
                  className={`flex w-full items-center gap-2 rounded-none px-3 py-2 text-left transition-colors hover:bg-accent/50 ${isCurrent ? "bg-[var(--em-primary-alpha-06)]" : ""}`}
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
                    {m.label !== m.profileName && (
                      <span className="block truncate font-mono text-[10px] text-muted-foreground/60">
                        {m.profileName}
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
                </DropdownMenuItem>
              </div>
            );
          })}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
