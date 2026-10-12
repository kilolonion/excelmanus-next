import { create } from "zustand";
import { getIsDesktop, getIsMobile } from "@/hooks/use-mobile";

export type SidebarTab = "chats" | "files";

export type SettingsTab =
  | "model"
  | "general"
  | "rules"
  | "memory"
  | "skills"
  | "mcp"
  | "workspace"
  | "access"
  | "about";

interface UIState {
  sidebarOpen: boolean;
  sidebarTab: SidebarTab;
  settingsOpen: boolean;
  settingsTab: SettingsTab;
  /** 代理团队面板（子代理名册与控制）。 */
  teamOpen: boolean;
  /** Cmd/Ctrl+K 快速打开。 */
  quickOpen: boolean;
  /** 「打开表格」选择框；打开后的形态（侧栏 / 全屏）。 */
  workbookPicker: "panel" | "full" | null;
  /** 工作簿并排对比：左侧文件（右侧在对话框里选）。null = 关闭。 */
  compare: { left: string; right?: string } | null;
  /** 修订历史（撤销面板）打开的文档。 */
  revisionsDocId: string | null;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  setSidebarTab: (tab: SidebarTab) => void;
  openSettings: (tab?: SettingsTab) => void;
  closeSettings: () => void;
  setTeamOpen: (open: boolean) => void;
  setQuickOpen: (open: boolean) => void;
  openWorkbookPicker: (target?: "panel" | "full") => void;
  closeWorkbookPicker: () => void;
  openCompare: (left: string, right?: string) => void;
  closeCompare: () => void;
  setRevisionsDocId: (docId: string | null) => void;
}

export const useUIStore = create<UIState>()((set) => ({
  // 只有在桌面端（>=1280px）时才默认打开侧边栏
  sidebarOpen: !getIsMobile() && getIsDesktop(),
  sidebarTab: "chats",
  settingsOpen: false,
  settingsTab: "model",
  teamOpen: false,
  quickOpen: false,
  workbookPicker: null,
  compare: null,
  revisionsDocId: null,
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  setSidebarTab: (tab) => set({ sidebarTab: tab }),
  openSettings: (tab) => set({ settingsOpen: true, settingsTab: tab ?? "model" }),
  closeSettings: () => set({ settingsOpen: false }),
  setTeamOpen: (open) => set({ teamOpen: open }),
  setQuickOpen: (open) => set({ quickOpen: open }),
  openWorkbookPicker: (target = "panel") => set({ workbookPicker: target }),
  closeWorkbookPicker: () => set({ workbookPicker: null }),
  openCompare: (left, right) => set({ compare: right ? { left, right } : { left } }),
  closeCompare: () => set({ compare: null }),
  setRevisionsDocId: (docId) => set({ revisionsDocId: docId }),
}));
