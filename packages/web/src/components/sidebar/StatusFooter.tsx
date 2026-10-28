import { Circle, Settings } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsMobile } from "@/hooks/use-mobile";
import { defaultProfile, useAppStore } from "@/stores/app-store";
import { useUIStore } from "@/stores/ui-store";

const SHAPE_LABEL: Record<string, string> = {
  desktop: "桌面应用",
  "local-web": "本机网页",
};

/** 侧栏底部：同步通道状态、版本与设置入口。 */
export function StatusFooter() {
  const connected = useAppStore((s) => s.connected);
  const everConnected = useAppStore((s) => s.everConnected);
  const version = useAppStore((s) => s.appVersion);
  const shape = useAppStore((s) => s.shape);
  const model = useAppStore((s) => defaultProfile(s)?.name ?? null);
  const [reconnectFlash, setReconnectFlash] = useState(false);
  const prevConnected = useRef(connected);
  const isMobile = useIsMobile();
  const [tipOpen, setTipOpen] = useState(false);

  useEffect(() => {
    if (!isMobile || !tipOpen) return;
    const handler = (e: PointerEvent) => {
      const target = e.target as HTMLElement;
      if (
        target.closest('[data-slot="tooltip-trigger"]') ||
        target.closest('[data-slot="tooltip-content"]')
      )
        return;
      setTipOpen(false);
    };
    document.addEventListener("pointerdown", handler);
    return () => document.removeEventListener("pointerdown", handler);
  }, [isMobile, tipOpen]);

  useEffect(() => {
    const was = prevConnected.current;
    prevConnected.current = connected;
    if (was || !connected || !everConnected) return;
    const frame = requestAnimationFrame(() => setReconnectFlash(true));
    const timer = setTimeout(() => setReconnectFlash(false), 500);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [connected, everConnected]);

  const state = connected ? "online" : everConnected ? "offline" : "connecting";
  const dotColor =
    state === "online"
      ? "text-green-500"
      : state === "offline"
        ? "text-red-500"
        : "text-muted-foreground";
  const dotLabel =
    state === "online" ? "已连接" : state === "offline" ? "连接中断，正在重连…" : "正在连接…";

  return (
    <>
      <div
        className="em-sidebar-footer-divider h-px flex-shrink-0"
        style={{ background: "linear-gradient(to right, transparent, var(--border), transparent)" }}
      />

      <div className="em-sidebar-footer px-3 py-3 flex items-center justify-between flex-shrink-0">
        <TooltipProvider delayDuration={300}>
          <Tooltip
            open={isMobile ? tipOpen : undefined}
            onOpenChange={isMobile ? () => {} : undefined}
          >
            <TooltipTrigger asChild>
              <span
                className={`flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-default rounded-sm${reconnectFlash ? " animate-pulse-green" : ""}`}
                style={reconnectFlash ? { color: "var(--em-primary)" } : undefined}
                tabIndex={0}
                role="status"
                aria-label={dotLabel}
                onClick={isMobile ? () => setTipOpen((open) => !open) : undefined}
              >
                <Circle
                  className={`h-2 w-2 fill-current ${dotColor}${state === "online" ? " animate-pulse-green" : ""}`}
                />
                {state === "online" && version ? (
                  <span className="truncate max-w-[72px]">v{version}</span>
                ) : (
                  <span>{dotLabel}</span>
                )}
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              <span style={{ color: "var(--em-primary)" }}>{dotLabel}</span>
              {version && (
                <>
                  <br />
                  版本：{version}
                </>
              )}
              <br />
              运行方式：{SHAPE_LABEL[shape] ?? shape}
              {model && (
                <>
                  <br />
                  默认模型：{model}
                </>
              )}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>

        <button
          type="button"
          onClick={() => useUIStore.getState().openSettings()}
          className="h-7 w-7 inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          title="设置"
          aria-label="设置"
          data-coach-id="coach-settings"
        >
          <Settings className="h-4 w-4" />
        </button>
      </div>
    </>
  );
}
