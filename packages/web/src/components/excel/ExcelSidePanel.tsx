// 表格侧边面板：对话旁边看表、改表。桌面端可拖拽调宽（超过半屏转为浮层），手机端全屏浮层、下滑关闭。
// 全屏视图打开时面板不挂载：同一时刻只有一个 Univer 实例。

import { motion } from "framer-motion";
import { useCallback, useEffect, useRef } from "react";
import { useIsDesktop, useIsMediumScreen, useIsMobile, useIsTablet } from "@/hooks/use-mobile";
import { useResizablePanel } from "@/hooks/use-resizable-panel";
import {
  panelSlideVariants,
  panelSlideVariantsMedium,
  panelSlideVariantsMobile,
} from "@/lib/sidebar-motion";
import { useUIStore } from "@/stores/ui-store";
import { setPanelOpen, useWorkbookStore } from "@/stores/workbook-store";
import { DeferredWorkbook } from "./DeferredWorkbook";

export function ExcelSidePanel() {
  const isMobile = useIsMobile();
  const isTablet = useIsTablet();
  const isDesktop = useIsDesktop();
  const isMediumScreen = useIsMediumScreen();
  const open = useWorkbookStore((s) => s.panelOpen && !s.fullView);
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const {
    panelWidth: resizableWidth,
    isFloatingByResize,
    handleProps,
    isDragging,
  } = useResizablePanel(!isMobile, open);

  // 非手机尺寸下作为布局列，让顶栏、对话区和输入框同步缩窄；手机或桌面端拖宽超过半屏时用浮层
  const floating = isMobile || isFloatingByResize || isTablet || (!isDesktop && sidebarOpen);
  const width = isMobile ? undefined : resizableWidth;

  const touchRef = useRef<{ id: number; startX: number; startY: number; startTime: number } | null>(
    null,
  );
  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      touchRef.current = null;
      if (!isMobile || e.touches.length !== 1) return;
      const t = e.touches[0];
      touchRef.current = {
        id: t.identifier,
        startX: t.clientX,
        startY: t.clientY,
        startTime: Date.now(),
      };
    },
    [isMobile],
  );
  const onTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      const start = touchRef.current;
      touchRef.current = null;
      const t = e.changedTouches[0];
      if (!isMobile || !start || e.touches.length || t?.identifier !== start.id) return;
      const dy = t.clientY - start.startY;
      const dx = Math.abs(t.clientX - start.startX);
      const dt = Date.now() - start.startTime;
      if (dy > 50 && dy > dx && dt < 400) setPanelOpen(false);
    },
    [isMobile],
  );

  const onTouchCancel = useCallback(() => {
    touchRef.current = null;
  }, []);
  useEffect(onTouchCancel, [isMobile, open, onTouchCancel]);

  if (!open) return null;
  const variants = isMobile
    ? panelSlideVariantsMobile
    : isMediumScreen
      ? panelSlideVariantsMedium
      : panelSlideVariants;

  return (
    <>
      {!isMobile && floating && (
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
        style={{
          ...(isMobile
            ? {
                paddingTop: "env(safe-area-inset-top, 0px)",
                paddingBottom: "env(safe-area-inset-bottom, 0px)",
                paddingLeft: "env(safe-area-inset-left, 0px)",
                paddingRight: "env(safe-area-inset-right, 0px)",
              }
            : { width }),
          ...(isDragging ? { transition: "none" } : {}),
        }}
      >
        {!isMobile && (
          <div
            {...handleProps}
            role="separator"
            aria-label="调整表格面板宽度"
            aria-orientation="vertical"
            className={`group/handle absolute bottom-0 left-0 top-0 z-10 w-2 cursor-col-resize transition-colors ${
              isDragging ? "bg-[var(--em-primary)]" : "bg-border/50 hover:bg-[var(--em-primary)]/60"
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
            onTouchCancel={onTouchCancel}
            aria-label="下滑关闭表格面板"
          >
            <div className="h-1 w-10 rounded-full bg-muted-foreground/30" />
          </div>
        )}
        <div className="min-h-0 flex-1">
          <DeferredWorkbook placement="panel" />
        </div>
      </motion.aside>
    </>
  );
}
