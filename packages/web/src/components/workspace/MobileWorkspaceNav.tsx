import { FolderOpen, MessageSquare, Settings, Table2 } from "lucide-react";
import { useUIStore } from "@/stores/ui-store";
import { setFullView, useWorkbookStore } from "@/stores/workbook-store";

/** Switching destinations never creates a session or clears its draft / workbook. */
export function MobileWorkspaceNav() {
  const full = useWorkbookStore((s) => s.fullView);
  const hasWorkbook = useWorkbookStore((s) => s.tabs.length > 0);
  const sidebar = useUIStore((s) => s.sidebarOpen);
  const sidebarTab = useUIStore((s) => s.sidebarTab);
  const selected = sidebar && sidebarTab === "files" ? "files" : full ? "sheet" : "chat";
  const actions = [
    {
      key: "chat",
      label: "对话",
      icon: MessageSquare,
      run: () => {
        useUIStore.getState().setSidebarOpen(false);
        setFullView(false);
      },
    },
    {
      key: "sheet",
      label: "表格",
      icon: Table2,
      run: () => {
        useUIStore.getState().setSidebarOpen(false);
        if (hasWorkbook) setFullView(true);
        else useUIStore.getState().openWorkbookPicker("full");
      },
    },
    {
      key: "files",
      label: "文件",
      icon: FolderOpen,
      run: () => {
        useUIStore.getState().setSidebarTab("files");
        useUIStore.getState().setSidebarOpen(true);
      },
    },
    {
      key: "settings",
      label: "设置",
      icon: Settings,
      run: () => useUIStore.getState().openSettings(),
    },
  ];
  return (
    <nav className="em-mobile-workspace-nav" aria-label="手机工作区导航">
      {actions.map(({ key, label, icon: Icon, run }) => (
        <button
          key={key}
          type="button"
          aria-current={selected === key ? "page" : undefined}
          onClick={run}
        >
          <Icon className="size-5" />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}
