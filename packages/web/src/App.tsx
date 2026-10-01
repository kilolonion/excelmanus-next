import { useEffect, useRef, useState } from "react";
import { desktop } from "./api.ts";
import { ChatPanel } from "./components/ChatPanel.tsx";
import { Icon } from "./components/Icon.tsx";
import { SessionList } from "./components/SessionList.tsx";
import { SettingsModal } from "./components/SettingsModal.tsx";
import { ConfirmProvider } from "./components/ui/confirm.tsx";
import { Alert, EmptyState } from "./components/ui/display.tsx";
import { Tabs, TabsList, TabsTrigger, Toaster, toast } from "./components/ui/overlay.tsx";
import { Spinner } from "./components/ui/spinner.tsx";
import { TooltipProvider } from "./components/ui/tooltip.tsx";
import { Workbench } from "./components/Workbench.tsx";
import { installShortcuts } from "./shortcuts.ts";
import { addComposerFiles, init, selectSession, setLayout, setNarrowTab, useApp } from "./store.ts";
import { S } from "./strings.ts";

/** 02 §2.2：< 1280px 时表格与对话改为标签页切换。 */
const NARROW_QUERY = "(max-width: 1279px)";

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW_QUERY).matches);
  useEffect(() => {
    const m = window.matchMedia(NARROW_QUERY);
    const on = () => setNarrow(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
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
      document.body.classList.remove("resizing");
    };
    document.body.classList.add("resizing");
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: 可拖动分隔条没有对应的原生元素
    <div
      className="group relative w-[9px] cursor-col-resize outline-none before:absolute before:inset-y-0 before:left-1 before:w-px before:bg-border before:transition-all hover:before:left-[3px] hover:before:w-[3px] hover:before:bg-read/55 focus-visible:before:left-[3px] focus-visible:before:w-[3px] focus-visible:before:bg-ring [body.resizing_&]:before:left-[3px] [body.resizing_&]:before:w-[3px] [body.resizing_&]:before:bg-read/55"
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
  const ready = useApp((s) => s.ready);
  const fatal = useApp((s) => s.fatal);
  const connected = useApp((s) => s.connected);
  const settingsOpen = useApp((s) => s.settingsOpen);
  const collapsed = useApp((s) => s.sidebarCollapsed);
  const hasDoc = useApp((s) => s.doc !== null);
  const layout = useApp((s) => s.layout);
  const narrowTab = useApp((s) => s.narrowTab);
  const narrow = useNarrow();
  const splitRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

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

  if (fatal === "no-token") {
    return (
      <main className="grid h-dvh place-items-center bg-background">
        <EmptyState size="page" icon="shield" title={S.noToken} />
      </main>
    );
  }
  if (!ready) {
    return (
      <main className="grid h-dvh place-items-center bg-background">
        <EmptyState size="page" icon={<Spinner size="lg" />} title={S.connecting} />
      </main>
    );
  }

  // 拖放文件到窗口（13 §3）：上传到当前工作区
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = [...e.dataTransfer.files];
    // 02 §3.3：图片进附件；其他文件上传到工作区（已有同名文件直接引用）并以 @路径 引用
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
    // biome-ignore lint/a11y/noStaticElementInteractions: 拖放上传是鼠标便利；键盘用侧栏「上传」按钮
    <div
      className={`grid h-dvh overflow-hidden bg-background text-foreground ${collapsed ? "grid-cols-1" : "grid-cols-[248px_minmax(0,1fr)]"}`}
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
      {!collapsed && (
        <aside
          className="flex min-h-0 min-w-0 flex-col border-r border-border bg-background"
          aria-label={S.sessions}
        >
          <SessionList />
        </aside>
      )}
      <main className="flex min-h-0 min-w-0 flex-col" aria-label={S.appName}>
        {!connected && (
          <Alert layout="bar" tone="muted" role="status" icon={false}>
            <span className="flex items-center gap-2">
              <Spinner size="xs" /> {S.reconnecting}
            </span>
          </Alert>
        )}
        {hasDoc && narrow && (
          <Tabs
            value={narrowTab}
            onValueChange={(v) => setNarrowTab(v as "sheet" | "chat")}
            className="flex h-11 shrink-0 items-center border-b border-border px-3"
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
              <Workbench narrow={narrow} sidebarToggle={collapsed} />
            </section>
          )}
          {split && <Splitter container={splitRef} />}
          {showChat && (
            <section className="flex min-h-0 min-w-0 flex-col bg-background" aria-label={S.tabChat}>
              <ChatPanel sidebarToggle={collapsed && !showTable} />
            </section>
          )}
        </div>
      </main>
      {dragging && (
        <div className="pointer-events-none fixed inset-3 z-40 grid place-items-center rounded-xl border-2 border-dashed border-read bg-read-soft/85 text-read-ink backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 text-md font-medium">
            <Icon name="upload" size="xl" />
            {S.dropHint}
          </div>
        </div>
      )}
      {settingsOpen && <SettingsModal />}
    </div>
  );
}
