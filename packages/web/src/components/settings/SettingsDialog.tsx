import { AnimatePresence, motion } from "framer-motion";
import {
  Brain,
  Folder,
  Info,
  Package,
  Plug,
  ScrollText,
  Server,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { lazy, type ReactNode, Suspense } from "react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { type SettingsTab, useUIStore } from "@/stores/ui-store";

const ModelTab = lazy(() => import("./ModelTab").then((m) => ({ default: m.ModelTab })));
const GeneralTab = lazy(() => import("./GeneralTab").then((m) => ({ default: m.GeneralTab })));
const RulesTab = lazy(() => import("./RulesTab").then((m) => ({ default: m.RulesTab })));
const MemoryTab = lazy(() => import("./MemoryTab").then((m) => ({ default: m.MemoryTab })));
const SkillsTab = lazy(() => import("./SkillsTab").then((m) => ({ default: m.SkillsTab })));
const MCPTab = lazy(() => import("./McpTab").then((m) => ({ default: m.MCPTab })));
const WorkspaceTab = lazy(() =>
  import("./WorkspaceTab").then((m) => ({ default: m.WorkspaceTab })),
);
const AccessTab = lazy(() => import("./AccessTab").then((m) => ({ default: m.AccessTab })));
const AboutTab = lazy(() => import("./AboutTab").then((m) => ({ default: m.AboutTab })));

function TabSpinner() {
  return (
    <div className="flex items-center justify-center py-12 text-muted-foreground">
      <svg
        className="h-5 w-5 animate-spin mr-2"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="M12 2v4m0 12v4m-7.07-3.93l2.83-2.83m8.48-8.48l2.83-2.83M2 12h4m12 0h4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83" />
      </svg>
    </div>
  );
}

interface TabMeta {
  value: SettingsTab;
  label: string;
  group: string;
  description: string;
  icon: ReactNode;
  render: () => ReactNode;
}

const TAB_META: TabMeta[] = [
  {
    value: "model",
    label: "模型与连接",
    group: "工作区",
    description: "添加 API 或订阅连接，选择默认模型与各角色使用的模型。",
    icon: <Server className="size-4" />,
    render: () => <ModelTab />,
  },
  {
    value: "general",
    label: "偏好与运行",
    group: "工作区",
    description: "外观、新任务默认权限、上下文压缩与网络代理。",
    icon: <SlidersHorizontal className="size-4" />,
    render: () => <GeneralTab />,
  },
  {
    value: "rules",
    label: "规则",
    group: "扩展与记忆",
    description: "用可启停的规则约束 Agent 的处理方式，全局规则会应用到每个新任务。",
    icon: <ScrollText className="size-4" />,
    render: () => <RulesTab />,
  },
  {
    value: "memory",
    label: "记忆",
    group: "扩展与记忆",
    description: "查看和整理 Agent 的跨任务记忆，清理不再准确的内容。",
    icon: <Brain className="size-4" />,
    render: () => <MemoryTab />,
  },
  {
    value: "skills",
    label: "技能",
    group: "扩展与记忆",
    description: "为 Agent 装载可复用的专业流程、指令和配套资源。",
    icon: <Package className="size-4" />,
    render: () => <SkillsTab />,
  },
  {
    value: "mcp",
    label: "MCP 服务",
    group: "扩展与记忆",
    description: "连接外部工具与数据源，并在启用前测试连接和工具发现结果。",
    icon: <Plug className="size-4" />,
    render: () => <MCPTab />,
  },
  {
    value: "workspace",
    label: "工作区与备份",
    group: "数据与安全",
    description: "管理 Agent 可访问的文件夹，恢复自动备份与回收站中的文件。",
    icon: <Folder className="size-4" />,
    render: () => <WorkspaceTab />,
  },
  {
    value: "access",
    label: "访问与安全",
    group: "数据与安全",
    description: "查看连接到本机服务的设备，吊销不再使用的访问令牌。",
    icon: <ShieldCheck className="size-4" />,
    render: () => <AccessTab />,
  },
  {
    value: "about",
    label: "关于与更新",
    group: "数据与安全",
    description: "版本信息、更新与项目链接。",
    icon: <Info className="size-4" />,
    render: () => <AboutTab />,
  },
];

const GROUPS = [...new Set(TAB_META.map((t) => t.group))];

export function SettingsDialog() {
  const { settingsOpen, settingsTab, openSettings, closeSettings } = useUIStore(
    useShallow((s) => ({
      settingsOpen: s.settingsOpen,
      settingsTab: s.settingsTab,
      openSettings: s.openSettings,
      closeSettings: s.closeSettings,
    })),
  );

  const active = TAB_META.find((t) => t.value === settingsTab) ?? TAB_META[0];

  return (
    <Dialog
      open={settingsOpen}
      onOpenChange={(open) => (open ? openSettings(settingsTab) : closeSettings())}
    >
      <DialogContent
        aria-describedby={undefined}
        showCloseButton={false}
        className="em-settings-dialog !grid-none !flex !flex-col max-w-none max-h-none h-auto sm:max-w-5xl sm:h-auto min-h-0 p-0 gap-0 overflow-hidden rounded-none sm:rounded-2xl top-0 left-0 right-0 bottom-0 sm:top-[50%] sm:left-[50%] sm:right-auto sm:bottom-auto translate-x-0 translate-y-0 sm:translate-x-[-50%] sm:translate-y-[-50%] w-full"
      >
        <DialogTitle className="sr-only">设置</DialogTitle>
        <DialogClose asChild>
          <Button
            variant="ghost"
            size="icon"
            className="em-settings-close h-8 w-8 rounded-full opacity-70 hover:opacity-100"
          >
            <X className="h-4 w-4" />
            <span className="sr-only">关闭设置</span>
          </Button>
        </DialogClose>
        <Tabs
          value={active.value}
          onValueChange={(v) => openSettings(v as SettingsTab)}
          className="flex flex-col overflow-hidden min-h-0 flex-1"
        >
          <div className="em-settings-body min-h-0 flex-1">
            <aside
              className="em-settings-sidebar hidden sm:flex"
              aria-label="设置分类"
              data-coach-id="coach-settings-tabs"
            >
              <DialogHeader className="em-settings-sidebar-header flex-shrink-0 flex-row items-start">
                <h2 className="flex items-center gap-2 flex-1 min-w-0">
                  <span className="em-settings-title-icon">
                    <Settings className="h-4 w-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold tracking-tight">设置</span>
                    <span className="mt-0.5 block text-[10px] font-normal leading-snug text-muted-foreground">
                      连接模型，调整工作方式
                    </span>
                  </span>
                </h2>
              </DialogHeader>
              {GROUPS.map((group) => (
                <div key={group} className="contents">
                  <p className="em-settings-sidebar-label">{group}</p>
                  {TAB_META.filter((tab) => tab.group === group).map((tab) => {
                    const isActive = active.value === tab.value;
                    return (
                      <button
                        key={tab.value}
                        type="button"
                        role="tab"
                        aria-selected={isActive}
                        data-coach-id={`coach-settings-tab-${tab.value}`}
                        onClick={() => openSettings(tab.value)}
                        className={`em-settings-sidebar-item ${isActive ? "is-active" : ""}`}
                      >
                        <span className="em-settings-sidebar-item-icon">{tab.icon}</span>
                        <span className="flex-1 text-left">{tab.label}</span>
                        {isActive && <span className="em-settings-sidebar-dot" />}
                      </button>
                    );
                  })}
                </div>
              ))}
              <div className="em-settings-sidebar-foot">
                <span className="em-settings-sidebar-foot-dot" />
                <span>各项设置的保存方式见页面说明</span>
              </div>
            </aside>
            <div className="em-settings-mobile-head sm:hidden">
              <nav
                className="em-settings-mobile-tabs"
                role="tablist"
                data-coach-id="coach-settings-tabs"
              >
                {TAB_META.map((tab) => {
                  const isActive = active.value === tab.value;
                  return (
                    <button
                      key={tab.value}
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      data-coach-id={`coach-settings-tab-${tab.value}`}
                      onClick={() => openSettings(tab.value)}
                      className={`em-settings-mobile-tab ${isActive ? "is-active" : ""}`}
                    >
                      {tab.icon}
                      {tab.label}
                    </button>
                  );
                })}
              </nav>
            </div>
            <AnimatePresence mode="wait">
              <motion.div
                key={active.value}
                initial={{ opacity: 0, x: 8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -8 }}
                transition={{ duration: 0.15 }}
                className="em-settings-scroll overflow-y-auto min-h-0 h-full px-4 sm:px-7 flex flex-col pb-[max(1rem,env(safe-area-inset-bottom))] sm:pb-7"
              >
                <Suspense fallback={<TabSpinner />}>
                  <TabsContent
                    value={active.value}
                    forceMount
                    className="mt-0 grow shrink-0 flex flex-col"
                    data-coach-id={`coach-settings-content-${active.value}`}
                  >
                    <header className="em-settings-page-header">
                      <div className="em-settings-page-heading">
                        <span className="em-settings-page-icon">{active.icon}</span>
                        <div>
                          <p className="em-settings-page-eyebrow">{active.group}</p>
                          <h3 className="em-settings-page-title">{active.label}</h3>
                          <p className="em-settings-page-description">{active.description}</p>
                        </div>
                      </div>
                    </header>
                    <div className="em-settings-page">{active.render()}</div>
                  </TabsContent>
                </Suspense>
              </motion.div>
            </AnimatePresence>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
