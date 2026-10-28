// 主区域：对话 + 输入框；全屏表格占满工作区，通过顶栏切回对话。

import { MessageSquareText } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { DeferredWorkbook } from "@/components/excel/DeferredWorkbook";
import { useUIStore } from "@/stores/ui-store";
import { useWorkbookStore } from "@/stores/workbook-store";
import styles from "./WorkspaceViewHost.module.css";

export function WorkspaceViewHost({
  children,
  composer,
}: {
  children: ReactNode;
  composer?: ReactNode;
}) {
  const full = useWorkbookStore((s) => s.fullView);
  const tabCount = useWorkbookStore((s) => s.tabs.length);
  const chatVisible = !full;
  const composerVisible = !full;

  // 布局变化后让表格画布按新尺寸重排
  useEffect(() => {
    if (full) useUIStore.getState().setSidebarOpen(false);
    const id = requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
    return () => cancelAnimationFrame(id);
  }, [full]);

  return (
    <div className={styles.host} data-workspace-surface={full ? "excel" : "chat"}>
      <div
        className={`${styles.chat} ${chatVisible ? "" : styles.inactive}`}
        aria-hidden={!chatVisible}
        inert={!chatVisible ? true : undefined}
      >
        <div className={styles.chatHeading}>
          <div className={styles.chatHeadingTitle}>
            <MessageSquareText size={15} aria-hidden="true" />
            <span>{tabCount > 1 ? "关于这些表格" : "关于这份表格"}</span>
          </div>
          <span className={styles.chatHeadingHint}>
            {tabCount > 1 ? "边看多张表，边和助手讨论" : "边看数据，边和助手讨论"}
          </span>
        </div>
        {children}
      </div>
      <div
        className={`${styles.composer} ${composerVisible ? "" : styles.inactive}`}
        aria-hidden={!composerVisible}
        inert={!composerVisible ? true : undefined}
      >
        {composer}
      </div>
      {full && (
        <div className={`${styles.sheet} ${styles.fullHeightSheet}`}>
          <DeferredWorkbook placement="full" />
        </div>
      )}
    </div>
  );
}
