import { FolderOpen } from "lucide-react";
import { useUIStore } from "@/stores/ui-store";
import { setFullView, useWorkbookStore } from "@/stores/workbook-store";

const TABS = [
  { key: "chat", label: "对话" },
  { key: "sheet", label: "表格" },
] as const;

/** 顶栏中间的「对话 / 表格」：表格 = 全屏工作台（桌面端对话停靠在右侧）。 */
export function ChatWorkspaceTabs() {
  const full = useWorkbookStore((s) => s.fullView);
  const hasWorkbook = useWorkbookStore((s) => s.tabs.length > 0);
  const active = full ? "sheet" : "chat";

  const activate = (key: (typeof TABS)[number]["key"]) => {
    if (key === "chat") setFullView(false);
    else if (hasWorkbook) setFullView(true);
    else useUIStore.getState().openWorkbookPicker("full");
  };

  return (
    <div className="flex items-center gap-2">
      <div
        role="tablist"
        aria-label="工作区视图"
        data-active-tab={active}
        className="flex min-w-0 items-center"
      >
        <span className="em-workspace-tab-glider" aria-hidden="true" />
        {TABS.map(({ key, label }) => {
          const selected = active === key;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => activate(key)}
              className={`relative inline-flex items-center justify-center leading-none ${selected ? "text-white" : "text-muted-foreground/75 hover:text-foreground"}`}
            >
              <span className="relative z-10">{label}</span>
            </button>
          );
        })}
      </div>
      <button
        type="button"
        aria-label="打开表格"
        title="打开已有表格"
        className="em-workspace-open"
        onClick={() => useUIStore.getState().openWorkbookPicker(full ? "full" : "panel")}
      >
        <FolderOpen className="h-4 w-4" />
      </button>
    </div>
  );
}
