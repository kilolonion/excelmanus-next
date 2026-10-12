// 主区域：对话 + 输入框；全屏表格时桌面端表格在左、对话停靠在右，手机端只显示表格（顶栏切回对话）。

import { MessageSquareText } from "lucide-react";
import { lazy, type ReactNode, Suspense, useEffect } from "react";
import { WorkbookLoadingState } from "@/components/excel/WorkbookLoadingState";
import { useIsMobile } from "@/hooks/use-mobile";
import { useWorkbookStore } from "@/stores/workbook-store";
import styles from "./WorkspaceViewHost.module.css";

const WorkbookSurface = lazy(() =>
  import("@/components/excel/WorkbookSurface").then((m) => ({ default: m.WorkbookSurface })),
);

export function WorkspaceViewHost({
  children,
  composer,
}: {
  children: ReactNode;
  composer?: ReactNode;
}) {
  const isMobile = useIsMobile();
  const full = useWorkbookStore((s) => s.fullView);
  const tabCount = useWorkbookStore((s) => s.tabs.length);
  const split = full && !isMobile;
  const chatVisible = !full || split;
  const composerVisible = !full || !isMobile;

  // 布局变化后让表格画布按新尺寸重排
  useEffect(() => {
    const id = requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
    return () => cancelAnimationFrame(id);
  }, [full, split]);

  return (
    <div
      className={`${styles.host} ${split ? styles.split : ""}`}
      data-workspace-surface={full ? "excel" : "chat"}
    >
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
          <Suspense
            fallback={<WorkbookLoadingState label="正在准备表格工作区" detail="正在挂载表格画布" />}
          >
            <WorkbookSurface placement="full" />
          </Suspense>
        </div>
      )}
    </div>
  );
}
