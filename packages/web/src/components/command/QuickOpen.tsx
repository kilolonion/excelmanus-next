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
import { Button } from "@/components/ui/button";
import { FileTypeIcon } from "@/components/ui/file-type-icon";
import { errorMessage } from "@/lib/backend/api";
import { openWorkspaceFile } from "@/lib/open-file";
import { rankQuickOpenItems } from "@/lib/quick-open-search";
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

function indexItems(items: Item[]) {
  return items.map((item) => ({ item, text: `${item.title} ${item.hint ?? ""}`.toLowerCase() }));
}

const COMMANDS: { action: ShortcutAction; title: string; icon: LucideIcon; key: string }[] = [
  { action: "new-session", title: "新对话", icon: Plus, key: "N" },
  { action: "focus-workbench", title: "打开或聚焦表格", icon: Sheet, key: "1" },
  { action: "focus-chat", title: "聚焦输入框", icon: MessageSquare, key: "2" },
  { action: "toggle-sidebar", title: "切换侧栏", icon: PanelLeft, key: "B" },
  { action: "settings", title: "打开设置", icon: Settings, key: "," },
];

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

export async function readQuickOpenFiles(
  isActive = () => true,
): Promise<{ files: FileEntry[]; error: string | null }> {
  try {
    return { files: await listAllFiles(800, 5, isActive), error: null };
  } catch (error) {
    return { files: [], error: errorMessage(error, "文件列表读取失败") };
  }
}

function QuickOpenBody({ onDone }: { onDone: () => void }) {
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [filesLoading, setFilesLoading] = useState(true);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [filesRetry, setFilesRetry] = useState(0);
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
    setFilesLoading(true);
    setFilesError(null);
    void readQuickOpenFiles(() => alive).then((result) => {
      if (!alive) return;
      setFiles(result.files);
      setFilesError(result.error);
      setFilesLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [filesRetry]);

  const dark = isDarkTheme();
  const commands = useMemo<Item[]>(() => {
    const mod = isMac() ? "⌘" : "Ctrl+";
    return [
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
  }, [busy, hasSubagents, dark]);
  const chats = useMemo<Item[]>(() => {
    const dateFormat = new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" });
    const dateHint = (updatedAt: string) => {
      const date = new Date(updatedAt);
      return Number.isNaN(date.getTime())
        ? date.toLocaleDateString("zh-CN", { month: "short", day: "numeric" })
        : dateFormat.format(date);
    };
    return sessions
      .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((s) => ({
        id: `session:${s.id}`,
        group: "对话",
        title: sessionTitle(s),
        hint: s.id === activeSessionId ? "当前" : dateHint(s.updatedAt),
        icon: MessageSquare,
        run: () => void selectSession(s.id).catch(() => undefined),
      }));
  }, [sessions, activeSessionId]);
  const fileItems = useMemo<Item[]>(
    () =>
      files.map((f) => ({
        id: `file:${f.path}`,
        group: "文件",
        title: f.path.split("/").pop() ?? f.path,
        hint: f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : undefined,
        icon: { file: f.path },
        run: () => openWorkspaceFile(f.path),
      })),
    [files],
  );
  const fileIndex = useMemo(() => indexItems(fileItems), [fileItems]);
  const chatIndex = useMemo(() => indexItems(chats), [chats]);
  const commandIndex = useMemo(() => indexItems(commands), [commands]);
  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [...commands.slice(0, 5), ...chats.slice(0, 5), ...fileItems.slice(0, 8)];
    // 文件排在前面：输入内容时多半在找文件
    return [
      ...rankQuickOpenItems(fileIndex, q, 12),
      ...rankQuickOpenItems(chatIndex, q, 8),
      ...rankQuickOpenItems(commandIndex, q, 6),
    ];
  }, [query, fileItems, chats, commands, fileIndex, chatIndex, commandIndex]);

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
      {filesLoading ? (
        <p role="status" className="px-4 py-2 text-xs text-muted-foreground">
          正在读取文件列表…
        </p>
      ) : filesError ? (
        <div role="alert" className="flex items-center gap-2 px-4 py-2 text-xs text-destructive">
          <span className="min-w-0 flex-1 break-words">文件列表读取失败：{filesError}</span>
          <Button size="sm" variant="outline" onClick={() => setFilesRetry((n) => n + 1)}>
            重试
          </Button>
        </div>
      ) : null}
      <div ref={listRef} id="em-quick-list" role="listbox" className="em-quick-list">
        {items.length === 0 && !filesLoading && !filesError && (
          <p className="em-quick-empty">没有匹配「{query.trim()}」的结果</p>
        )}
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
