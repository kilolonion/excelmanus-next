// 快捷键集中定义（02 §10）：本机 Web 与桌面共用；桌面菜单的加速键触发同一动作。

import { desktop } from "./api.ts";
import { toast } from "./components/ui/overlay.tsx";
import { COMPOSER_INPUT_ID } from "./dom-ids.ts";
import {
  createSession,
  setLayout,
  setNarrowTab,
  setSettingsOpen,
  stopAgent,
  useApp,
} from "./store.ts";
import { S } from "./strings.ts";

/** 先让目标面板可见（窄屏切标签、宽屏展开折叠），下一帧再聚焦。 */
function reveal(pane: "sheet" | "chat", selector: string): void {
  const { layout, doc } = useApp.getState();
  if (pane === "chat" && layout.chatCollapsed) setLayout({ chatCollapsed: false });
  if (pane === "sheet" && doc && layout.tableCollapsed) setLayout({ tableCollapsed: false });
  if (doc) setNarrowTab(pane);
  requestAnimationFrame(() => document.querySelector<HTMLElement>(selector)?.focus());
}

export type ShortcutAction =
  | "new-session"
  | "focus-composer"
  | "stop"
  | "focus-workbench"
  | "focus-chat"
  | "toggle-sidebar"
  | "settings";

export const SHORTCUTS: { key: string; label: string; action: ShortcutAction }[] = [
  { key: "n", label: "新会话", action: "new-session" },
  { key: "l", label: "聚焦输入框并附带当前选区", action: "focus-composer" },
  { key: ".", label: "停止当前任务", action: "stop" },
  { key: "1", label: "聚焦表格", action: "focus-workbench" },
  { key: "2", label: "聚焦对话", action: "focus-chat" },
  { key: "b", label: "切换侧栏", action: "toggle-sidebar" },
  { key: ",", label: "设置", action: "settings" },
];

export function runShortcut(action: ShortcutAction): void {
  switch (action) {
    case "new-session":
      void createSession().catch((error: unknown) =>
        toast({ tone: "err", title: error instanceof Error ? error.message : S.newSessionFailed }),
      );
      break;
    case "focus-composer":
      // 附带当前选区：撤销之前的"不附带"
      useApp.setState({ selectionDismissed: false });
      reveal("chat", `#${COMPOSER_INPUT_ID}`);
      break;
    case "focus-chat":
      reveal("chat", `#${COMPOSER_INPUT_ID}`);
      break;
    case "stop":
      void stopAgent();
      break;
    case "focus-workbench":
      reveal(
        "sheet",
        ".univer-host [data-u-comp='editor'], .univer-host canvas, [data-slot='file-item']",
      );
      break;
    case "toggle-sidebar":
      useApp.setState((s) => ({ sidebarCollapsed: !s.sidebarCollapsed }));
      break;
    case "settings":
      setSettingsOpen(true);
      break;
  }
}

/** 注册键盘监听；桌面形态由菜单加速键触发，避免重复处理。 */
export function installShortcuts(): () => void {
  const d = desktop();
  if (d) {
    d.onMenu((action) => runShortcut(action as ShortcutAction));
    return () => {};
  }
  const onKey = (e: KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const hit = SHORTCUTS.find((s) => s.key === e.key.toLowerCase());
    if (!hit) return;
    // 浏览器自身的 Cmd+N / Cmd+L 无法拦截时保持默认；其余阻止默认行为
    e.preventDefault();
    runShortcut(hit.action);
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}
