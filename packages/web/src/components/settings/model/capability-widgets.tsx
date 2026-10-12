import type { CapabilityValue, ModelProfile } from "@excelmanus/protocol";
import { Brain, ImageIcon, Wrench } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";

export type ProfileCapabilities = NonNullable<ModelProfile["capabilities"]>;

export const CAPABILITY_ITEMS: {
  key: "tools" | "vision" | "reasoning";
  label: string;
  icon: ReactNode;
}[] = [
  { key: "tools", label: "工具", icon: <Wrench className="h-2.5 w-2.5" /> },
  { key: "vision", label: "视觉", icon: <ImageIcon className="h-2.5 w-2.5" /> },
  { key: "reasoning", label: "思考", icon: <Brain className="h-2.5 w-2.5" /> },
];

export function CapabilityBadges({ caps }: { caps: ProfileCapabilities | null | undefined }) {
  return (
    <span className="inline-flex items-center gap-1 shrink-0 whitespace-nowrap">
      {CAPABILITY_ITEMS.map((item) => {
        const value = caps?.[item.key]?.value ?? null;
        let cls: string;
        let tip: string;
        if (value === true) {
          cls = "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400";
          tip = `${item.label}: 支持`;
        } else if (value === false) {
          cls = "bg-rose-500/10 text-rose-400/80 dark:text-rose-400/70";
          tip = `${item.label}: 不支持`;
        } else {
          cls = "bg-muted/60 text-muted-foreground/50";
          tip = `${item.label}: 未探测`;
        }
        return (
          <span
            key={item.key}
            title={tip}
            className={`inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[9px] leading-none font-medium transition-colors ${cls}`}
          >
            {item.icon}
            <span>{item.label}</span>
          </span>
        );
      })}
    </span>
  );
}

function EvidenceBadge({ cap }: { cap: CapabilityValue | undefined }) {
  const value = cap?.value ?? null;
  const source = cap?.source;
  if (value === true) {
    return (
      <Badge className="text-[9px] h-4 bg-emerald-500/15 text-emerald-600 border-emerald-500/20">
        {source === "manual" ? "手动声明" : source === "probe" ? "实测通过" : "模型目录"}
      </Badge>
    );
  }
  if (value === false) {
    return (
      <Badge variant="secondary" className="text-[9px] h-4">
        {source === "manual" ? "手动声明不支持" : source === "probe" ? "实测不支持" : "不支持"}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-[9px] h-4">
      未知
    </Badge>
  );
}

/** 能力行：同时表达探测结果、来源与手动声明开关。 */
export function CapabilityToggleRow({
  icon,
  label,
  desc,
  cap,
  disabled = false,
  onToggle,
  onReset,
}: {
  icon: ReactNode;
  label: string;
  desc: string;
  cap: CapabilityValue | undefined;
  disabled?: boolean;
  onToggle: (value: boolean) => void;
  onReset?: () => void;
}) {
  const value = cap?.value ?? null;
  return (
    <div className="flex items-start gap-2.5 border-b border-border/50 py-2.5 last:border-b-0">
      <span
        className="mt-0.5 shrink-0"
        style={{
          color:
            value === true
              ? "var(--em-primary)"
              : value === false
                ? "var(--destructive, #ef4444)"
                : "var(--muted-foreground)",
        }}
      >
        {icon}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs font-medium">{label}</span>
          <EvidenceBadge cap={cap} />
          {cap?.source === "manual" && onReset && (
            <button
              type="button"
              className="text-[9px] text-muted-foreground underline-offset-2 hover:underline"
              onClick={onReset}
              disabled={disabled}
            >
              恢复自动
            </button>
          )}
        </div>
        <p className="mt-0.5 text-[11px] text-muted-foreground leading-relaxed break-words">
          {desc}
        </p>
        {cap?.detail && (
          <p className="mt-0.5 text-[10px] text-muted-foreground truncate" title={cap.detail}>
            {cap.detail}
          </p>
        )}
      </div>
      <Switch
        aria-label={label}
        checked={value === true}
        onCheckedChange={onToggle}
        disabled={disabled}
        className="flex-shrink-0 mt-0.5"
      />
    </div>
  );
}
