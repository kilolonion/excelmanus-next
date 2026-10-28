// 快捷键：本机 Web 与桌面共用；桌面菜单的加速键触发同一动作（桌面形态不再重复监听键盘）。

import { toast } from "@/components/ui/toaster";
import { desktop, errorMessage } from "@/lib/backend/api";
import { focusComposer } from "@/lib/workbook/ask";
import { isWorkbookFormatShortcut } from "@/lib/workbook/shortcuts";
import { stopAgent, useChatStore } from "@/stores/chat-store";
import { createSession } from "@/stores/session-store";
import { useUIStore } from "@/stores/ui-store";
import { setPanelOpen, useWorkbookStore } from "@/stores/workbook-store";

export type ShortcutAction =
  | "new-session"
  | "quick-open"
  | "focus-composer"
  | "stop"
  | "focus-workbench"
  | "focus-chat"
  | "toggle-sidebar"
  | "settings";

export const SHORTCUTS: { key: string; label: string; action: ShortcutAction }[] = [
  { key: "n", label: "新对话", action: "new-session" },
  { key: "k", label: "快速打开文件、对话与命令", action: "quick-open" },
  { key: "l", label: "聚焦输入框并附带当前选区", action: "focus-composer" },
  { key: ".", label: "停止当前任务", action: "stop" },
  { key: "1", label: "聚焦表格", action: "focus-workbench" },
  { key: "2", label: "聚焦对话", action: "focus-chat" },
  { key: "b", label: "切换侧栏", action: "toggle-sidebar" },
  { key: ",", label: "设置", action: "settings" },
];

/** 设置里展示的完整清单：组合键 + Esc。 */
export function shortcutHelp(): { keys: string[]; label: string }[] {
  const mod = isMac() ? "⌘" : "Ctrl";
  return [
    ...SHORTCUTS.map((s) => ({
      keys: [mod, s.key === "." ? "." : s.key.toUpperCase()],
      label: s.label,
    })),
    { keys: ["Esc"], label: "关闭弹层；区域选取时取消选取" },
  ];
}

export function isMac(): boolean {
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

export function runShortcut(action: ShortcutAction): void {
  switch (action) {
    case "new-session":
      void createSession().catch((error: unknown) =>
        toast({ tone: "error", title: errorMessage(error, "新建对话失败") }),
      );
      break;
    case "quick-open":
      useUIStore.getState().setQuickOpen(!useUIStore.getState().quickOpen);
      break;
    case "focus-composer":
      // 附带当前选区：撤销之前的「不附带」
      useWorkbookStore.setState({ selectionDismissed: false });
      focusComposer();
      break;
    case "focus-chat":
      focusComposer();
      break;
    case "stop":
      if (useChatStore.getState().sessionId) void stopAgent().catch(() => undefined);
      break;
    case "focus-workbench": {
      const { tabs, fullView } = useWorkbookStore.getState();
      if (tabs.length === 0) {
        useUIStore.getState().openWorkbookPicker("panel");
        break;
      }
      if (!fullView) setPanelOpen(true);
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>(".univer-host canvas")?.focus(),
      );
      break;
    }
    case "toggle-sidebar":
      useUIStore.getState().toggleSidebar();
      break;
    case "settings":
      useUIStore.getState().openSettings();
      break;
  }
}

/** 注册键盘监听；返回卸载函数。 */
export function installShortcuts(): () => void {
  const bridge = desktop();
  if (bridge) {
    bridge.onMenu((action) => runShortcut(action as ShortcutAction));
    return () => {};
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
    // 表格加粗与切换侧栏共用 Ctrl/⌘+B，画布内优先编辑表格。
    if (
      e.target instanceof Element &&
      e.target.closest(".univer-host") &&
      isWorkbookFormatShortcut(e)
    )
      return;
    const hit = SHORTCUTS.find((s) => s.key === e.key.toLowerCase());
    if (!hit) return;
    // 浏览器保留的 Cmd+N 等无法拦截时保持默认；其余阻止默认行为
    e.preventDefault();
    runShortcut(hit.action);
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}
