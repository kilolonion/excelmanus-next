import { ChevronDown, History, MessageSquare, Paintbrush, Sparkles } from "lucide-react";
import { type ReactNode, useState } from "react";

/** The grid is the default screen; editing tools are a reversible local mode. */
export function MobileWorkbookDock({
  range,
  onReference,
  format,
  ask,
  changes,
  more,
}: {
  range: string | null;
  onReference: () => void;
  format: ReactNode;
  ask: ReactNode;
  changes: ReactNode;
  more: ReactNode;
}) {
  const [panel, setPanel] = useState<"format" | "ask" | "changes" | null>(null);
  const items = [
    { key: "format" as const, label: "格式", icon: Paintbrush },
    { key: "ask" as const, label: "分析", icon: Sparkles },
    { key: "changes" as const, label: "变更", icon: History },
  ];
  return (
    <section className="em-mobile-sheet-dock" aria-label="当前表格操作">
      {panel && (
        <div className="em-mobile-sheet-tools">
          <div className="flex items-center justify-between px-3 text-xs">
            <span>
              {items.find((item) => item.key === panel)?.label} · {range ?? "当前表格"}
            </span>
            <button
              type="button"
              className="inline-flex h-11 items-center gap-1"
              onClick={() => setPanel(null)}
            >
              <ChevronDown className="size-4" />
              收起工具
            </button>
          </div>
          <div className="em-mobile-sheet-tool-content">
            {panel === "format" ? format : panel === "ask" ? ask : changes}
          </div>
        </div>
      )}
      <div className="em-mobile-sheet-actions">
        <button
          type="button"
          disabled={!range}
          title={range ? `引用 ${range} 并返回对话` : "先在表格中选择区域"}
          onClick={onReference}
        >
          <MessageSquare className="size-4" />
          <span>{range ? "选区提问" : "先选区域"}</span>
        </button>
        {items.map(({ key, label, icon: Icon }) => (
          <button
            type="button"
            key={key}
            aria-expanded={panel === key}
            onClick={() => setPanel((current) => (current === key ? null : key))}
          >
            <Icon className="size-4" />
            <span>{label}</span>
          </button>
        ))}
        {more}
      </div>
    </section>
  );
}
