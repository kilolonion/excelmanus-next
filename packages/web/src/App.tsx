import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { desktop } from "./api.ts";
import { ChatPanel } from "./components/ChatPanel.tsx";
import { BrandMark, Icon } from "./components/Icon.tsx";
import { useWorkspaceNavigation } from "./components/layout/WorkspaceNavigation.tsx";
import { FilesPage, TeamPage } from "./components/layout/WorkspacePages.tsx";
import { SessionList } from "./components/SessionList.tsx";
import { Button } from "./components/ui/button.tsx";
import { ConfirmProvider } from "./components/ui/confirm.tsx";
import { Dialog, DialogContent, DialogTitle } from "./components/ui/dialog.tsx";
import { Alert } from "./components/ui/display.tsx";
import { Tabs, TabsList, TabsTrigger, Toaster, toast } from "./components/ui/overlay.tsx";
import { ApplicationFrame } from "./components/ui/page-layout.tsx";
import { Spinner } from "./components/ui/spinner.tsx";
import { TooltipProvider } from "./components/ui/tooltip.tsx";
import { installShortcuts } from "./shortcuts.ts";
import {
  addComposerFiles,
  init,
  resumeAuth,
  selectSession,
  setLayout,
  setNarrowTab,
  useApp,
} from "./store.ts";
import { S } from "./strings.ts";

const Workbench = lazy(() =>
  import("./components/Workbench.tsx").then((m) => ({ default: m.Workbench })),
);
const SettingsModal = lazy(() =>
  import("./components/SettingsModal.tsx").then((m) => ({ default: m.SettingsModal })),
);

/** 02 §2.2：< 1280px 时表格与对话改为标签页切换。 */
const NARROW_QUERY = "(max-width: 1279px)";

function useNarrow(query = NARROW_QUERY): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setNarrow(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [query]);
  return narrow;
}

/** 表格与对话之间的拖动分隔条；键盘左右方向键也可调整。 */
function Splitter({ container }: { container: React.RefObject<HTMLDivElement | null> }) {
  const ratio = useApp((s) => s.layout.chatRatio);
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const host = container.current;
    if (!host) return;
    e.preventDefault();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const rect = host.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      setLayout({ chatRatio: (rect.right - ev.clientX) / rect.width });
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      target.removeEventListener("lostpointercapture", up);
      document.body.classList.remove("resizing");
    };
    document.body.classList.add("resizing");
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
    target.addEventListener("lostpointercapture", up);
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: 可拖动分隔条没有对应的原生元素
    <div
      className="group relative w-[9px] touch-none cursor-col-resize bg-muted/45 outline-none before:absolute before:inset-y-0 before:left-1 before:w-px before:bg-border/60 before:transition-all before:duration-150 hover:before:left-[3px] hover:before:w-[3px] hover:before:bg-read/55 focus-visible:before:left-[3px] focus-visible:before:w-[3px] focus-visible:before:bg-ring [body.resizing_&]:before:left-[3px] [body.resizing_&]:before:w-[3px] [body.resizing_&]:before:bg-read/55"
      role="separator"
      aria-orientation="vertical"
      aria-label={S.resizePanels}
      aria-valuenow={Math.round((1 - ratio) * 100)}
      aria-valuemin={30}
      aria-valuemax={78}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={() => setLayout({ chatRatio: 0.4 })}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") setLayout({ chatRatio: ratio + 0.03 });
        else if (e.key === "ArrowRight") setLayout({ chatRatio: ratio - 0.03 });
        else return;
        e.preventDefault();
      }}
    />
  );
}

export function App() {
  return (
    <TooltipProvider>
      <ConfirmProvider>
        <AppBody />
        <Toaster />
      </ConfirmProvider>
    </TooltipProvider>
  );
}

function AppBody() {
  const { view, setView } = useWorkspaceNavigation();
  const workspaceId = useApp((s) => s.workspaceId);
  // biome-ignore lint/correctness/useExhaustiveDependencies: changing workspace resets the current feature page
  useEffect(() => setView("workbench"), [workspaceId, setView]);
  const ready = useApp((s) => s.ready);
  const fatal = useApp((s) => s.fatal);
  const connected = useApp((s) => s.connected);
  const settingsOpen = useApp((s) => s.settingsOpen);
  const collapsed = useApp((s) => s.sidebarCollapsed);
  const hasDoc = useApp((s) => s.doc !== null);
  const layout = useApp((s) => s.layout);
  const narrowTab = useApp((s) => s.narrowTab);
  const narrow = useNarrow();
  const mobile = useNarrow("(max-width: 767px)");
  const sessionId = useApp((s) => s.sessionId);
  // biome-ignore lint/correctness/useExhaustiveDependencies: navigation closes the mobile drawer but keeps desktop preference
  useEffect(() => {
    if (mobile) useApp.setState({ sidebarCollapsed: true });
  }, [mobile, view, sessionId]);
  const splitRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [settingsMounted, setSettingsMounted] = useState(false);

  useEffect(() => {
    if (settingsOpen) {
      setSettingsMounted(true);
      return;
    }
    const timer = window.setTimeout(() => setSettingsMounted(false), 200);
    return () => window.clearTimeout(timer);
  }, [settingsOpen]);

  useEffect(() => {
    void init();
    const off = installShortcuts();
    // 桌面系统通知点击后定位到会话（13 §3）
    desktop()?.onFocusSession((id) => void selectSession(id).catch(() => {}));
    return off;
  }, []);

  // 打开工作簿时窄屏切到表格页；关闭后回到对话
  useEffect(() => {
    setNarrowTab(hasDoc ? "sheet" : "chat");
  }, [hasDoc]);

  if (fatal === "auth-failed" || fatal === "signed-out" || fatal === "protocol-mismatch") {
    const mismatch = fatal === "protocol-mismatch";
    const signedOut = fatal === "signed-out";
    return (
      <main className="grid min-h-dvh place-items-center bg-background px-6">
        <section className="w-full max-w-md rounded-2xl border border-border bg-card p-8 text-center shadow-card">
          <div className="mx-auto mb-5 flex size-14 items-center justify-center">
            <BrandMark className="size-10" decorative={false} />
          </div>
          <h1 className="text-xl font-semibold">
            {mismatch ? S.protocolMismatch : signedOut ? S.authSignedOut : S.authFailed}
          </h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            {mismatch ? S.protocolMismatchHint : signedOut ? S.authSignedOutHint : S.authFailedHint}
          </p>
          <Button
            className="mt-6 w-full"
            onClick={() => (signedOut ? resumeAuth() : window.location.reload())}
          >
            {signedOut ? S.resumeConnection : S.retryConnection}
          </Button>
        </section>
      </main>
    );
  }
  if (!ready) {
    return (
      <main className="grid min-h-dvh place-items-center bg-background px-6">
        <section className="w-full max-w-md rounded-2xl border border-border bg-card p-8 text-center shadow-card">
          <div className="mx-auto mb-5 flex size-14 items-center justify-center">
            <BrandMark className="size-10" decorative={false} />
          </div>
          <h1 className="text-xl font-semibold">{S.authTitle}</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{S.authDescription}</p>
          <div className="mt-6 flex items-center justify-center gap-2 text-xs text-muted-foreground">
            <Spinner size="xs" />
            {S.connecting}
          </div>
        </section>
      </main>
    );
  }

  // 拖放文件到窗口（13 §3）：上传到当前工作区
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = [...e.dataTransfer.files];
    // 02 §3.3：图片进附件；其他文件上传到工作区并以 @路径 引用
    void addComposerFiles(files).catch((err: unknown) =>
      toast({ tone: "err", title: err instanceof Error ? err.message : S.uploadFailed }),
    );
  };

  // 02 §2.1：未打开工作簿时对话优先；打开后表格 + 对话分栏
  const showTable = hasDoc && (narrow ? narrowTab === "sheet" : !layout.tableCollapsed);
  const showChat = !hasDoc || (narrow ? narrowTab === "chat" : !layout.chatCollapsed);
  const split = hasDoc && !narrow && showTable && showChat;
  const gridColumns = split
    ? `minmax(0, ${1 - layout.chatRatio}fr) 9px minmax(380px, ${layout.chatRatio}fr)`
    : "minmax(0, 1fr)";

  return (
    <ApplicationFrame
      collapsed={collapsed || mobile}
      sidebar={<SessionList />}
      sidebarLabel={S.sessions}
      label={S.appName}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      {!connected && (
        <Alert layout="bar" tone="muted" role="status" icon={false}>
          <span className="flex items-center gap-2">
            <Spinner size="xs" /> {S.reconnecting}
          </span>
        </Alert>
      )}
      {view === "files" ? (
        <FilesPage />
      ) : view === "team" ? (
        <TeamPage />
      ) : (
        <>
          {hasDoc && narrow && (
            <Tabs
              value={narrowTab}
              onValueChange={(v) => setNarrowTab(v as "sheet" | "chat")}
              className="flex h-12 shrink-0 items-center border-b border-border/70 bg-muted/30 px-4"
            >
              <TabsList aria-label={S.workbench}>
                {(["sheet", "chat"] as const).map((t) => (
                  <TabsTrigger key={t} value={t}>
                    <Icon name={t === "sheet" ? "sheet" : "chat"} size="sm" />
                    {t === "sheet" ? S.tabSheet : S.tabChat}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          )}
          <div
            className="grid min-h-0 flex-1"
            ref={splitRef}
            style={{ gridTemplateColumns: gridColumns }}
          >
            {showTable && (
              <section className="flex min-h-0 min-w-0 flex-col bg-card" aria-label={S.workbench}>
                <Suspense
                  fallback={
                    <div
                      className="grid min-h-0 flex-1 place-items-center text-muted-foreground"
                      role="status"
                      aria-label={S.workbenchLoading}
                    >
                      <span className="flex items-center gap-2 text-sm">
                        <Spinner size="sm" />
                        {S.workbenchLoading}
                      </span>
                    </div>
                  }
                >
                  <Workbench narrow={narrow} sidebarToggle={collapsed} />
                </Suspense>
              </section>
            )}
            {split && <Splitter container={splitRef} />}
            {showChat && (
              <section className="flex min-h-0 min-w-0 flex-col bg-card" aria-label={S.tabChat}>
                <ChatPanel sidebarToggle={collapsed && !showTable} />
              </section>
            )}
          </div>
        </>
      )}
      {mobile && (
        <Dialog
          open={!collapsed}
          onOpenChange={(open) => useApp.setState({ sidebarCollapsed: !open })}
        >
          <DialogContent className="mobile-navigation-drawer" aria-describedby={undefined}>
            <DialogTitle className="sr-only">{S.sessions}</DialogTitle>
            <div className="app-sidebar flex h-full min-h-0 flex-col">
              <SessionList />
            </div>
          </DialogContent>
        </Dialog>
      )}
      {dragging && (
        <div className="pointer-events-none fixed inset-3 z-40 grid place-items-center rounded-xl border-2 border-dashed border-read bg-read-soft/85 text-read-ink backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 text-md font-medium">
            <Icon name="upload" size="xl" />
            {S.dropHint}
          </div>
        </div>
      )}
      {(settingsOpen || settingsMounted) && (
        <Suspense fallback={null}>
          <SettingsModal />
        </Suspense>
      )}
    </ApplicationFrame>
  );
}
