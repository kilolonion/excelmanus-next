import { AnimatePresence, motion } from "framer-motion";
import { FolderOpen, MessageSquare, PanelLeft, PanelLeftClose } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { LazyRegion } from "@/components/ui/LazyRegion";
import { useIsMobile } from "@/hooks/use-mobile";
import { sidebarContentVariants, useMotionSafe } from "@/lib/sidebar-motion";
import { useSessionStore } from "@/stores/session-store";
import { useUIStore } from "@/stores/ui-store";
import { SessionList } from "./SessionList";
import { StatusFooter } from "./StatusFooter";

const loadFiles = () => import("./ExcelFilesBar").then((m) => ({ default: m.ExcelFilesBar }));

const tabs: { key: "chats" | "files"; label: string; icon: typeof MessageSquare }[] = [
  { key: "chats", label: "对话", icon: MessageSquare },
  { key: "files", label: "文件", icon: FolderOpen },
];

/** 移动端左滑收起侧栏。 */
function useSwipeToClose(enabled: boolean, onClose: () => void) {
  const touchRef = useRef<{ id: number; startX: number; startY: number; startTime: number } | null>(
    null,
  );

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      touchRef.current = null;
      if (!enabled || e.touches.length !== 1) return;
      const t = e.touches[0];
      touchRef.current = {
        id: t.identifier,
        startX: t.clientX,
        startY: t.clientY,
        startTime: Date.now(),
      };
    },
    [enabled],
  );

  const onTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      const start = touchRef.current;
      touchRef.current = null;
      const t = e.changedTouches[0];
      if (!enabled || !start || e.touches.length || t?.identifier !== start.id) return;
      const dx = t.clientX - start.startX;
      const dy = Math.abs(t.clientY - start.startY);
      const dt = Date.now() - start.startTime;
      // 左滑：dx < -60px，基本水平，400ms 内
      if (dx < -60 && dy < 80 && -dx > dy && dt < 400) {
        onClose();
      }
    },
    [enabled, onClose],
  );

  const onTouchCancel = useCallback(() => {
    touchRef.current = null;
  }, []);
  useEffect(onTouchCancel, [enabled, onTouchCancel]);
  return { onTouchStart, onTouchEnd, onTouchCancel };
}

export function Sidebar() {
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const setSidebarOpen = useUIStore((s) => s.setSidebarOpen);
  const isMobile = useIsMobile();

  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const { shouldReduce } = useMotionSafe();
  const activeTab = useUIStore((s) => s.sidebarTab);
  const setActiveTab = useUIStore((s) => s.setSidebarTab);
  const [contentMounted, setContentMounted] = useState(sidebarOpen);

  // 首次渲染跳过动画，避免侧栏闪烁
  const isFirstRender = useRef(true);
  useEffect(() => {
    isFirstRender.current = false;
  }, []);

  // 移动端左滑关闭侧栏
  const closeSidebar = useCallback(() => setSidebarOpen(false), [setSidebarOpen]);
  const swipe = useSwipeToClose(isMobile && sidebarOpen, closeSidebar);

  // 侧栏的最终几何状态直接由 sidebarOpen 决定。不要把 width 只交给
  // Framer Motion 的动画状态，否则关闭动画完成后快速重新打开时，store 已经
  // 是 true，但 aside 仍可能停留在动画留下的 0px，导致打开按钮消失而侧栏不见。
  // 移动端保持固定宽度，只动画 transform，避免每一帧重排会话列表。
  const mobileSidebarWidth = "min(100vw, 420px)";
  const desktopSidebarWidth = sidebarOpen ? "320px" : "0px";
  const sidebarTransition =
    shouldReduce || isFirstRender.current
      ? "none"
      : isMobile
        ? "transform 220ms ease-out"
        : "width 250ms cubic-bezier(0.4, 0, 0.2, 1), min-width 250ms cubic-bezier(0.4, 0, 0.2, 1)";

  useEffect(() => {
    if (sidebarOpen) {
      setContentMounted(true);
    } else if (shouldReduce) {
      setContentMounted(false);
    }
  }, [sidebarOpen, shouldReduce]);

  // 移动端自动收起侧栏（首次挂载及会话变化时）
  useEffect(() => {
    if (isMobile && sidebarOpen) {
      setSidebarOpen(false);
    }
  }, [activeSessionId, isMobile]);

  return (
    <>
      {/* Mobile backdrop */}
      <AnimatePresence>
        {isMobile && sidebarOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-40 bg-black/50"
            onClick={closeSidebar}
          />
        )}
      </AnimatePresence>
      <aside
        data-coach-id="coach-sidebar"
        aria-label="侧栏"
        aria-hidden={!sidebarOpen}
        inert={!sidebarOpen ? true : undefined}
        className={`em-sidebar flex flex-col ${isMobile ? "inset-y-0 left-0 z-50" : ""}`}
        style={{
          position: isMobile ? "fixed" : undefined,
          width: isMobile ? mobileSidebarWidth : desktopSidebarWidth,
          minWidth: isMobile ? mobileSidebarWidth : desktopSidebarWidth,
          transform: isMobile ? `translateX(${sidebarOpen ? "0" : "-100%"})` : undefined,
          transition: sidebarTransition,
          overflow: "hidden",
          pointerEvents: sidebarOpen ? "auto" : "none",
          willChange:
            sidebarOpen || contentMounted
              ? isMobile
                ? "transform"
                : "width, min-width"
              : undefined,
          boxShadow: sidebarOpen ? undefined : "none",
        }}
        onTransitionEnd={(event) => {
          if (event.target !== event.currentTarget) return;
          const finishedProperty = isMobile ? "transform" : "width";
          if (event.propertyName !== finishedProperty) return;
          setContentMounted(useUIStore.getState().sidebarOpen);
        }}
        onTouchStart={swipe.onTouchStart}
        onTouchEnd={swipe.onTouchEnd}
        onTouchCancel={swipe.onTouchCancel}
      >
        {/* Inner content container with fixed width to prevent layout shifts */}
        <motion.div
          className="em-sidebar-inner flex flex-col h-full"
          style={{
            width: isMobile ? mobileSidebarWidth : "320px",
            minWidth: isMobile ? mobileSidebarWidth : "320px",
          }}
          variants={isMobile ? undefined : sidebarContentVariants}
          animate={isMobile ? undefined : sidebarOpen ? "open" : "closed"}
          transition={isMobile ? undefined : isFirstRender.current ? { duration: 0 } : undefined}
        >
          {/* Header */}
          <div className="em-sidebar-header flex items-center justify-between px-4 pt-4 pb-3 flex-shrink-0">
            {isMobile ? (
              <h2 className="text-base font-semibold">
                {activeTab === "files" ? "工作区文件" : "历史对话"}
              </h2>
            ) : (
              <div className="em-brand-lockup">
                <img
                  src="/logo.svg"
                  alt="ExcelManus"
                  width={180}
                  height={60}
                  loading="lazy"
                  className="em-brand-logo em-brand-logo-light"
                />
                <img
                  src="/logo-dark.svg"
                  alt="ExcelManus"
                  width={180}
                  height={60}
                  loading="lazy"
                  className="em-brand-logo em-brand-logo-dark"
                />
                <span className="em-brand-status" aria-label="ExcelManus 已就绪">
                  <span className="em-brand-status-dot" />
                  <span>工作台</span>
                </span>
              </div>
            )}
            <Button
              variant="ghost"
              size="icon"
              onClick={closeSidebar}
              aria-label={isMobile ? "返回工作区" : "收起侧栏"}
              className="h-7 w-7 min-h-8 min-w-8 flex-shrink-0"
            >
              {isMobile ? "返回" : <PanelLeftClose className="h-4 w-4" />}
            </Button>
          </div>

          {/* Tab Navigation */}
          <div
            className="em-sidebar-tabs mx-3 flex gap-1 flex-shrink-0"
            data-coach-id="coach-sidebar-tabs"
          >
            {tabs.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                className={`em-sidebar-tab relative flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-medium rounded-md cursor-pointer transition-colors duration-150 select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--em-primary)] ${activeTab === key ? "is-active" : ""}`}
                style={
                  activeTab === key
                    ? { color: "var(--em-primary)" }
                    : { color: "var(--muted-foreground)" }
                }
                onClick={() => setActiveTab(key)}
                aria-pressed={activeTab === key}
              >
                {activeTab === key && (
                  <motion.div
                    layoutId="sidebar-tab-indicator"
                    className="absolute inset-0 rounded-md"
                    style={{ backgroundColor: "var(--em-primary-alpha-10)" }}
                    transition={{ type: "spring", stiffness: 400, damping: 30 }}
                  />
                )}
                <Icon className="h-3.5 w-3.5 relative z-10" />
                <span className="relative z-10">{label}</span>
              </button>
            ))}
          </div>

          {/* Divider */}
          <div
            className="mx-3 mt-2 mb-1 h-px flex-shrink-0"
            style={{
              background: "linear-gradient(to right, transparent, var(--border), transparent)",
            }}
          />

          {/* Unmount inactive content and release the drawer after its exit
              animation, so hidden lists have no subscriptions or scan effects. */}
          <div className="flex-1 min-h-0 overflow-hidden relative">
            {(sidebarOpen || contentMounted) &&
              (activeTab === "chats" ? (
                <div className="h-full px-2">
                  <SessionList />
                </div>
              ) : (
                <div className="h-full min-h-0">
                  <LazyRegion
                    load={loadFiles}
                    componentProps={{}}
                    label="文件列表"
                    onClose={() => setActiveTab("chats")}
                  />
                </div>
              ))}
          </div>

          {/* Footer */}
          <div
            className="shrink-0"
            style={{ paddingBottom: isMobile ? "env(safe-area-inset-bottom)" : undefined }}
          >
            <StatusFooter />
          </div>
        </motion.div>
      </aside>
    </>
  );
}

export function SidebarToggle() {
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const setSidebarOpen = useUIStore((s) => s.setSidebarOpen);

  if (sidebarOpen) return null;

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => setSidebarOpen(true)}
      aria-label="展开侧栏"
      className="h-8 w-8 mr-1"
    >
      <PanelLeft className="h-4 w-4" />
    </Button>
  );
}
