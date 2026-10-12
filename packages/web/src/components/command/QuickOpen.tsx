// Cmd/Ctrl+K 快速打开（02 §10）：在一个列表里搜文件、对话与命令，方向键选择，回车执行。

import type { FileEntry, SessionSummary } from "@excelmanus/protocol";
import {
  CornerDownLeft,
  FileSpreadsheet,
  type LucideIcon,
  MessageSquare,
  Moon,
  PanelLeft,
  Plus,
  Search,
  Settings,
  Sheet,
  Square,
  Sun,
  Users,
} from "lucide-react";
import { Dialog } from "radix-ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { FileTypeIcon } from "@/components/ui/file-type-icon";
import { openWorkspaceFile } from "@/lib/open-file";
import { isMac, runShortcut, type ShortcutAction } from "@/lib/shortcuts";
import { isDarkTheme, setTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/stores/chat-store";
import { listAllFiles } from "@/stores/files-store";
import { selectSession, useSessionStore } from "@/stores/session-store";
import { useUIStore } from "@/stores/ui-store";

interface Item {
  id: string;
  group: "命令" | "对话" | "文件";
  title: string;
  hint?: string;
  icon: LucideIcon | { file: string };
  keys?: string;
  run: () => void;
}

const COMMANDS: { action: ShortcutAction; title: string; icon: LucideIcon; key: string }[] = [
  { action: "new-session", title: "新对话", icon: Plus, key: "N" },
  { action: "focus-workbench", title: "打开或聚焦表格", icon: Sheet, key: "1" },
  { action: "focus-chat", title: "聚焦输入框", icon: MessageSquare, key: "2" },
  { action: "toggle-sidebar", title: "切换侧栏", icon: PanelLeft, key: "B" },
  { action: "settings", title: "打开设置", icon: Settings, key: "," },
];

/** 子序列匹配打分：连续命中、词首命中加分；不匹配返回 -1。 */
function score(text: string, query: string): number {
  if (!query) return 0;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) return 1000 - direct * 2 - t.length * 0.1;
  let ti = 0;
  let total = 0;
  let streak = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    streak = found === ti ? streak + 1 : 0;
    total += 10 + streak * 5 - Math.min(found - ti, 10);
    ti = found + 1;
  }
  return total;
}

function sessionTitle(s: SessionSummary): string {
  return s.title?.trim() || "新对话";
}

export function QuickOpen() {
  const open = useUIStore((s) => s.quickOpen);
  const setOpen = useUIStore((s) => s.setQuickOpen);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="em-quick-overlay fixed inset-0 z-[150]" />
        <Dialog.Content
          aria-describedby={undefined}
          className="em-quick fixed left-1/2 z-[151] flex w-[min(640px,calc(100vw-24px))] -translate-x-1/2 flex-col overflow-hidden outline-none"
        >
          <Dialog.Title className="sr-only">快速打开</Dialog.Title>
          {open && <QuickOpenBody onDone={() => setOpen(false)} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function QuickOpenBody({ onDone }: { onDone: () => void }) {
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const hasSubagents = useChatStore((s) =>
    Object.keys(s.session.roster).some((id) => id !== "main"),
  );
  const busy = useChatStore((s) =>
    Object.values(s.session.roster).some((a) => a.status === "running"),
  );

  useEffect(() => {
    let alive = true;
    void listAllFiles(800, 5)
      .then((items) => alive && setFiles(items))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const items = useMemo(() => {
    const mod = isMac() ? "⌘" : "Ctrl+";
    const dark = isDarkTheme();
    const commands: Item[] = [
      ...COMMANDS.map((c) => ({
        id: `cmd:${c.action}`,
        group: "命令" as const,
        title: c.title,
        icon: c.icon,
        keys: `${mod}${c.key}`,
        run: () => runShortcut(c.action),
      })),
      ...(busy
        ? [
            {
              id: "cmd:stop",
              group: "命令" as const,
              title: "停止当前任务",
              icon: Square,
              keys: `${mod}.`,
              run: () => runShortcut("stop"),
            },
          ]
        : []),
      ...(hasSubagents
        ? [
            {
              id: "cmd:team",
              group: "命令" as const,
              title: "查看代理团队",
              icon: Users,
              run: () => useUIStore.getState().setTeamOpen(true),
            },
          ]
        : []),
      {
        id: "cmd:open-workbook",
        group: "命令",
        title: "打开表格…",
        icon: FileSpreadsheet,
        run: () => useUIStore.getState().openWorkbookPicker("panel"),
      },
      {
        id: "cmd:theme",
        group: "命令",
        title: dark ? "切换到浅色主题" : "切换到深色主题",
        icon: dark ? Sun : Moon,
        run: () => setTheme(dark ? "light" : "dark"),
      },
    ];
    const chats: Item[] = sessions
      .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((s) => ({
        id: `session:${s.id}`,
        group: "对话",
        title: sessionTitle(s),
        hint:
          s.id === activeSessionId
            ? "当前"
            : new Date(s.updatedAt).toLocaleDateString("zh-CN", { month: "short", day: "numeric" }),
        icon: MessageSquare,
        run: () => void selectSession(s.id).catch(() => undefined),
      }));
    const fileItems: Item[] = files.map((f) => ({
      id: `file:${f.path}`,
      group: "文件",
      title: f.path.split("/").pop() ?? f.path,
      hint: f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : undefined,
      icon: { file: f.path },
      run: () => openWorkspaceFile(f.path),
    }));

    const q = query.trim();
    if (!q) return [...commands.slice(0, 5), ...chats.slice(0, 5), ...fileItems.slice(0, 8)];
    const ranked = (list: Item[], limit: number) =>
      list
        .map((item) => ({ item, s: score(`${item.title} ${item.hint ?? ""}`, q) }))
        .filter((x) => x.s >= 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, limit)
        .map((x) => x.item);
    // 文件排在前面：输入内容时多半在找文件
    return [...ranked(fileItems, 12), ...ranked(chats, 8), ...ranked(commands, 6)];
  }, [query, files, sessions, activeSessionId, busy, hasSubagents]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (item: Item | undefined) => {
    if (!item) return;
    onDone();
    // 等弹层卸载、焦点归还后再执行，避免目标输入框被抢焦
    requestAnimationFrame(() => item.run());
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (items.length ? (i + 1) % items.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (items.length ? (i - 1 + items.length) % items.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(items[active]);
    }
  };

  let lastGroup = "";
  return (
    <>
      <div className="em-quick-search">
        <Search className="h-4 w-4 shrink-0 text-[var(--em-muted)]" aria-hidden="true" />
        <input
          // biome-ignore lint/a11y/noAutofocus: 弹层打开即输入
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="搜索文件、对话或命令"
          aria-label="搜索文件、对话或命令"
          aria-controls="em-quick-list"
          aria-activedescendant={items[active] ? `em-quick-${active}` : undefined}
          role="combobox"
          aria-expanded="true"
          spellCheck={false}
        />
        <kbd className="em-kbd">Esc</kbd>
      </div>
      <div ref={listRef} id="em-quick-list" role="listbox" className="em-quick-list">
        {items.length === 0 && <p className="em-quick-empty">没有匹配「{query.trim()}」的结果</p>}
        {items.map((item, index) => {
          const header = item.group !== lastGroup ? item.group : null;
          lastGroup = item.group;
          const Icon = "file" in item.icon ? null : item.icon;
          return (
            <div key={item.id}>
              {header && <div className="em-quick-group">{header}</div>}
              <div
                id={`em-quick-${index}`}
                data-index={index}
                role="option"
                aria-selected={index === active}
                tabIndex={-1}
                className={cn("em-quick-item", index === active && "is-active")}
                onMouseMove={() => index !== active && setActive(index)}
                onClick={() => choose(item)}
                onKeyDown={undefined}
              >
                <span className="em-quick-icon">
                  {Icon ? (
                    <Icon className="h-4 w-4" />
                  ) : (
                    <FileTypeIcon
                      filename={(item.icon as { file: string }).file}
                      className="h-4 w-4"
                    />
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
                {item.hint && <span className="em-quick-hint">{item.hint}</span>}
                {item.keys && <kbd className="em-kbd">{item.keys}</kbd>}
                {index === active && (
                  <CornerDownLeft
                    className="h-3.5 w-3.5 shrink-0 text-[var(--em-muted)]"
                    aria-hidden="true"
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
