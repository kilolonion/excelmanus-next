// 应用外壳：侧栏 + 顶栏 + 主区域（对话 / 全屏表格）+ 表格侧边面板 + 全局浮层。

import { lazy, Suspense, useEffect } from "react";
import { BackgroundTasks } from "@/components/chat/BackgroundTasks";
import { ChatSessionHeader } from "@/components/chat/ChatSessionHeader";
import { ChatWorkspaceTabs } from "@/components/chat/ChatWorkspaceTabs";
import { TopModelSelector } from "@/components/chat/TopModelSelector";
import { QuickOpen } from "@/components/command/QuickOpen";
import { CompareDialog } from "@/components/excel/CompareDialog";
import { OpenWorkbookDialog } from "@/components/excel/OpenWorkbookDialog";
import { WorkbookPanelButton } from "@/components/excel/WorkbookPanelButton";
import { FilePreviewHost } from "@/components/files/FilePreviewHost";
import { Sidebar, SidebarToggle } from "@/components/sidebar/Sidebar";
import { ConfirmHost } from "@/components/ui/confirm-dialog";
import { Toaster, toast } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ReconnectBar } from "@/components/workspace/ReconnectBar";
import { desktop } from "@/lib/backend/api";
import { installShortcuts } from "@/lib/shortcuts";
import { useAppStore } from "@/stores/app-store";
import { selectSession } from "@/stores/session-store";
import { useUIStore } from "@/stores/ui-store";
import { useWorkbookStore } from "@/stores/workbook-store";
import { HomePage } from "./home-page";

const SettingsDialog = lazy(() =>
  import("@/components/settings/SettingsDialog").then((m) => ({ default: m.SettingsDialog })),
);
const ExcelSidePanel = lazy(() =>
  import("@/components/excel/ExcelSidePanel").then((m) => ({ default: m.ExcelSidePanel })),
);
const OnboardingWizard = lazy(() =>
  import("@/components/onboarding/OnboardingWizard").then((m) => ({ default: m.OnboardingWizard })),
);

/** 桌面版：菜单快捷键、系统通知点回会话、自动更新状态。 */
function useDesktopBridge() {
  useEffect(() => {
    const off = installShortcuts();
    const bridge = desktop();
    bridge?.onFocusSession((id) => void selectSession(id).catch(() => undefined));
    bridge?.onUpdateStatus((status) => {
      useAppStore.setState({ desktopUpdate: status });
      if (status.status === "ready")
        toast({
          tone: "success",
          title: `新版本 ${status.version ?? ""} 已下载`,
          description: "在 设置 → 关于 中重启以完成更新。",
          durationMs: 8000,
        });
    });
    return off;
  }, []);
}

function WorkspaceOverlays() {
  const settingsOpen = useUIStore((s) => s.settingsOpen);
  const panelOpen = useWorkbookStore((s) => s.panelOpen && !s.fullView);
  const needsSetup = useAppStore((s) => !s.hasModelProfile);
  return (
    <Suspense fallback={null}>
      {settingsOpen && <SettingsDialog />}
      {needsSetup && !settingsOpen && <OnboardingWizard />}
      {panelOpen && <ExcelSidePanel />}
    </Suspense>
  );
}

export function ClientLayout() {
  useDesktopBridge();
  return (
    <TooltipProvider delayDuration={300}>
      <div className="em-app-shell flex h-viewport overflow-hidden">
        <Sidebar />
        <main className="em-main flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* 顶栏与对话区共用同一列，右侧面板打开时一起缩窄 */}
          <div className="em-topbar topbar-glass flex shrink-0 flex-col">
            <div className="em-topbar-toolbar relative flex items-center overflow-hidden">
              <div className="em-topbar-leading flex min-w-0 flex-1 items-center">
                <SidebarToggle />
                <ChatSessionHeader />
              </div>
              <div className="em-workspace-tabs">
                <ChatWorkspaceTabs />
              </div>
              <div className="em-topbar-actions ml-auto flex min-w-0 flex-shrink-0 items-center gap-1 sm:gap-1.5 md:gap-2">
                <TopModelSelector />
                <BackgroundTasks />
                <WorkbookPanelButton />
              </div>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            <HomePage />
          </div>
        </main>
        <WorkspaceOverlays />
        <FilePreviewHost />
        <OpenWorkbookDialog />
        <QuickOpen />
        <CompareDialog />
        <ReconnectBar />
        <ConfirmHost />
        <Toaster />
      </div>
    </TooltipProvider>
  );
}
