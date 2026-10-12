// 表格侧边面板：对话旁边看表、改表。桌面端可拖拽调宽（超过半屏转为浮层），手机端全屏浮层、下滑关闭。
// 全屏视图打开时面板不挂载：同一时刻只有一个 Univer 实例。

import { motion } from "framer-motion";
import { useCallback, useRef } from "react";
import { useIsDesktop, useIsMediumScreen, useIsMobile, useIsTablet } from "@/hooks/use-mobile";
import { useResizablePanel } from "@/hooks/use-resizable-panel";
import {
  panelSlideVariants,
  panelSlideVariantsMedium,
  panelSlideVariantsMobile,
} from "@/lib/sidebar-motion";
import { setPanelOpen, useWorkbookStore } from "@/stores/workbook-store";
import { WorkbookSurface } from "./WorkbookSurface";

export function ExcelSidePanel() {
  const isMobile = useIsMobile();
  const isTablet = useIsTablet();
  const isDesktop = useIsDesktop();
  const isMediumScreen = useIsMediumScreen();
  const open = useWorkbookStore((s) => s.panelOpen && !s.fullView);
  const {
    panelWidth: resizableWidth,
    isFloatingByResize,
    handleProps,
    isDragging,
  } = useResizablePanel(isDesktop);

  // 非手机尺寸下作为布局列，让顶栏、对话区和输入框同步缩窄；手机或桌面端拖宽超过半屏时用浮层
  const floating = isMobile || isFloatingByResize;
  const width = isMobile ? undefined : isDesktop ? resizableWidth : isTablet ? 420 : 600;

  const touchRef = useRef<{ startY: number; startTime: number } | null>(null);
  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (!isMobile) return;
      touchRef.current = { startY: e.touches[0]?.clientY ?? 0, startTime: Date.now() };
    },
    [isMobile],
  );
  const onTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      if (!isMobile || !touchRef.current) return;
      const dy = (e.changedTouches[0]?.clientY ?? 0) - touchRef.current.startY;
      const dt = Date.now() - touchRef.current.startTime;
      touchRef.current = null;
      if (dy > 50 && dt < 400) setPanelOpen(false);
    },
    [isMobile],
  );

  if (!open) return null;
  const variants = isMobile
    ? panelSlideVariantsMobile
    : isMediumScreen
      ? panelSlideVariantsMedium
      : panelSlideVariants;

  return (
    <>
      {isDesktop && isFloatingByResize && (
        <div
          className="fixed inset-0 z-39 bg-black/20 transition-opacity"
          onClick={() => setPanelOpen(false)}
        />
      )}
      <motion.aside
        data-coach-id="coach-excel-panel"
        aria-label="表格面板"
        variants={isDragging ? undefined : variants}
        initial={isDragging ? false : "initial"}
        animate={isDragging ? undefined : "animate"}
        className={
          floating
            ? isMobile
              ? "fixed inset-0 z-50 flex flex-col bg-background"
              : "fixed inset-y-0 right-0 z-40 flex flex-col border-l border-border bg-background shadow-2xl"
            : "relative flex h-full flex-shrink-0 flex-col border-l border-border bg-background"
        }
        style={{ ...(isMobile ? {} : { width }), ...(isDragging ? { transition: "none" } : {}) }}
      >
        {isDesktop && (
          <div
            {...handleProps}
            className={`group/handle absolute bottom-0 left-0 top-0 z-10 w-1 cursor-col-resize transition-colors ${
              isDragging
                ? "bg-[var(--em-primary)]"
                : "bg-transparent hover:bg-[var(--em-primary)]/60"
            }`}
            title="拖拽调整宽度 · 双击恢复默认"
          >
            <div className="absolute left-0 top-1/2 flex w-1 -translate-y-1/2 flex-col items-center gap-1 py-2 opacity-0 transition-opacity group-hover/handle:opacity-100">
              <div className="h-1.5 w-0.5 rounded-full bg-muted-foreground/60" />
              <div className="h-1.5 w-0.5 rounded-full bg-muted-foreground/60" />
              <div className="h-1.5 w-0.5 rounded-full bg-muted-foreground/60" />
            </div>
          </div>
        )}
        {isMobile && (
          <div
            className="flex flex-shrink-0 justify-center py-1.5"
            onTouchStart={onTouchStart}
            onTouchEnd={onTouchEnd}
            aria-label="下滑关闭表格面板"
          >
            <div className="h-1 w-10 rounded-full bg-muted-foreground/30" />
          </div>
        )}
        <div className="min-h-0 flex-1">
          <WorkbookSurface placement="panel" />
        </div>
      </motion.aside>
    </>
  );
}
