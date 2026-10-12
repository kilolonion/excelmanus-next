import { MessageSquareText, TableProperties } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/use-mobile";
import { useUIStore } from "@/stores/ui-store";
import { setFullView, setPanelOpen, useWorkbookStore } from "@/stores/workbook-store";

/**
 * 顶栏右侧的表格入口。桌面端开关对话旁的表格面板；手机端在对话与全屏表格之间切换。
 * 还没有打开过表格时先弹出「打开表格」。
 */
export function WorkbookPanelButton() {
  const isMobile = useIsMobile();
  const panelOpen = useWorkbookStore((s) => s.panelOpen);
  const full = useWorkbookStore((s) => s.fullView);
  const count = useWorkbookStore((s) => s.tabs.length);

  const active = isMobile ? full : panelOpen && !full;
  const label = isMobile
    ? full
      ? "切换到对话"
      : count > 0
        ? "切换到表格"
        : "打开表格"
    : active
      ? "收起表格面板"
      : count > 0
        ? "打开表格面板"
        : "打开表格";

  const toggle = () => {
    if (count === 0) {
      useUIStore.getState().openWorkbookPicker(isMobile ? "full" : "panel");
      return;
    }
    if (isMobile) setFullView(!full);
    else if (full) setFullView(false);
    else setPanelOpen(!panelOpen);
  };

  return (
    <Button
      variant="ghost"
      size={isMobile ? "icon-sm" : "sm"}
      className={`rounded-full transition-colors ${isMobile ? "w-8 p-0" : "px-2.5"} ${active ? "bg-[var(--em-primary-alpha-12)] text-[var(--em-primary)]" : "text-muted-foreground"}`}
      title={label}
      aria-label={label}
      aria-pressed={active}
      data-coach-id="coach-workbook-entry"
      onClick={toggle}
    >
      {isMobile && full ? (
        <MessageSquareText className="h-[17px] w-[17px]" />
      ) : (
        <TableProperties className="h-[18px] w-[18px]" />
      )}
      {!isMobile && (
        <span className="hidden text-xs font-semibold lg:inline">
          {count > 1 ? `表格 ${count}` : "表格"}
        </span>
      )}
    </Button>
  );
}
