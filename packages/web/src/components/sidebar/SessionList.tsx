import type { SessionActivity, SessionSummary, Workspace } from "@excelmanus/protocol";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { AnimatePresence, motion } from "framer-motion";
import {
  Check,
  CheckCheck,
  ChevronDown,
  Clipboard,
  Download,
  Ellipsis,
  ExternalLink,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderX,
  LoaderCircle,
  MessageSquare,
  Pencil,
  Plus,
  Search,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { type DragEvent, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AddWorkspaceDialog } from "@/components/sidebar/AddWorkspaceDialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  glassMenuDangerItemClass,
  glassMenuItemClass,
  glassMenuPanelClass,
} from "@/components/ui/menu-panel";
import { ScrollArea } from "@/components/ui/scroll-area";
import { desktop, errorMessage } from "@/lib/backend/api";
import { anyAgentBusy, pendingApprovals, pendingQuestions } from "@/lib/session/reducer";
import { applySidebarOrder, type DropSide, moveSidebarItem } from "@/lib/sidebar-order";
import { cn } from "@/lib/utils";
import {
  removeWorkspace,
  reorderWorkspaces,
  setDefaultWorkspace,
  useAppStore,
} from "@/stores/app-store";
import { useChatStore } from "@/stores/chat-store";
import {
  createSession,
  deleteSession,
  exportSession,
  exportSessionJson,
  isUnread,
  markSessionsRead,
  renameSession,
  selectSession,
  sessionError,
  setSessionOrder,
  toggleWorkspaceCollapsed,
  useSessionStore,
} from "@/stores/session-store";

/** 子序列模糊匹配：查询中的字符按顺序出现在标题里即命中。 */
function fuzzyMatch(target: string, query: string): boolean {
  let qi = 0;
  for (let ti = 0; ti < target.length && qi < query.length; ti++) {
    if (target[ti] === query[qi]) qi++;
  }
  return qi === query.length;
}

export function sessionTitle(session: Pick<SessionSummary, "title">): string {
  return session.title?.trim() || "新对话";
}

type SessionStatusTone = "running" | "approval" | "question";
type SidebarDrag = { kind: "workspace" | "session"; id: string; groupKey: string };
type SidebarDrop = { id: string; side: DropSide; rowKey: string };

interface SessionGroup {
  key: string;
  title: string;
  workspace: Workspace | null;
  sessions: SessionSummary[];
}

const STATUS_LABEL: Record<SessionStatusTone, string> = {
  approval: "等待审批",
  question: "等待回复",
  running: "正在进行",
};

function statusTone(activity: SessionActivity | undefined): SessionStatusTone | null {
  if (!activity) return null;
  if (activity.pendingApprovals > 0) return "approval";
  if (activity.pendingQuestions > 0) return "question";
  return activity.busy ? "running" : null;
}

function SessionStatusDot({ tone }: { tone: SessionStatusTone }) {
  const label = STATUS_LABEL[tone];
  return (
    <span
      className={cn("session-status-dot", `session-status-dot--${tone}`)}
      title={label}
      aria-label={label}
    />
  );
}

/** 当前会话的活动以实时日志为准（列表摘要会稍晚刷新）。 */
function useLiveActivity(): SessionActivity | null {
  const loaded = useChatStore((s) => s.sessionId !== null && !s.loading);
  const busy = useChatStore((s) => anyAgentBusy(s.session));
  const approvals = useChatStore((s) => pendingApprovals(s.session).length);
  const questions = useChatStore((s) => pendingQuestions(s.session).length);
  return useMemo(
    () => (loaded ? { busy, pendingApprovals: approvals, pendingQuestions: questions } : null),
    [loaded, busy, approvals, questions],
  );
}

function fileManagerName(): string {
  const platform =
    desktop()?.platform ??
    (typeof navigator === "undefined" ? "" : navigator.userAgent.toLowerCase());
  if (platform.includes("darwin") || platform.includes("mac")) return "Finder";
  if (platform.includes("win")) return "资源管理器";
  return "文件管理器";
}

export const SessionList = memo(function SessionList() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const sessions = useSessionStore((s) => s.sessions);
  const order = useSessionStore((s) => s.order);
  const seen = useSessionStore((s) => s.seen);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const activeWorkspaceId = useSessionStore((s) => s.activeWorkspaceId);
  const workspaces = useAppStore((s) => s.workspaces);
  const liveActivity = useLiveActivity();
  const isDesktopApp = Boolean(desktop());

  const [busySessionId, setBusySessionId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  useEffect(() => {
    viewportRef.current?.scrollTo({ top: 0 });
  }, [searchQuery]);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);
  const [creatingKey, setCreatingKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [addFolderOpen, setAddFolderOpen] = useState(false);
  const [editingWorkspace, setEditingWorkspace] = useState<Workspace | null>(null);
  const [workspaceMenuKey, setWorkspaceMenuKey] = useState<string | null>(null);
  const [sessionMenuId, setSessionMenuId] = useState<string | null>(null);
  const [drag, setDrag] = useState<SidebarDrag | null>(null);
  const [dragSessions, setDragSessions] = useState<SessionSummary[] | null>(null);
  const [dropTarget, setDropTarget] = useState<SidebarDrop | null>(null);
  const [reorderingWorkspace, setReorderingWorkspace] = useState(false);
  const bulkDeleting = useRef(false);
  const dragPreview = useRef<HTMLElement | null>(null);
  const dragBlocked = useRef(false);
  const dragRef = useRef<SidebarDrag | null>(null);
  const dragPointerY = useRef<number | null>(null);
  const dragScrollFrame = useRef<number | null>(null);
  const collapsedGroups = useMemo(() => new Set(order.collapsed), [order.collapsed]);

  useEffect(() => {
    if (editingSessionId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingSessionId]);

  const handleStartEdit = useCallback((session: SessionSummary) => {
    setEditingSessionId(session.id);
    setEditValue(sessionTitle(session));
  }, []);

  const handleFinishEdit = useCallback(
    async (session: SessionSummary) => {
      const trimmed = editValue.trim();
      setEditingSessionId(null);
      if (!trimmed || trimmed === sessionTitle(session)) return;
      try {
        await renameSession(session.id, trimmed);
      } catch (err) {
        setNotice(sessionError(err));
      }
    },
    [editValue],
  );

  const handleNewSession = useCallback(
    async (workspaceId?: string, key = "__global__") => {
      if (creatingKey) return;
      setCreatingKey(key);
      setNotice(null);
      try {
        await createSession(workspaceId ?? activeWorkspaceId);
      } catch (err) {
        setNotice(errorMessage(err, "新建对话失败，请检查后端服务后重试"));
      } finally {
        setCreatingKey(null);
      }
    },
    [activeWorkspaceId, creatingKey],
  );

  const handleDelete = useCallback(async (sessionId: string) => {
    setBusySessionId(sessionId);
    try {
      await deleteSession(sessionId);
    } catch (err) {
      setNotice(sessionError(err));
    } finally {
      setBusySessionId((cur) => (cur === sessionId ? null : cur));
    }
  }, []);

  const handleDeleteGroupSessions = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0 || bulkDeleting.current) return;
      bulkDeleting.current = true;
      try {
        for (const id of ids) await handleDelete(id);
      } finally {
        bulkDeleting.current = false;
      }
    },
    [handleDelete],
  );

  const handleRevealWorkspace = useCallback(async (workspace: Workspace) => {
    const bridge = desktop();
    if (bridge) {
      bridge.showInFolder(workspace.id, "");
      return;
    }
    try {
      await navigator.clipboard.writeText(workspace.path);
      setNotice("工作区路径已复制。");
    } catch {
      setNotice(`无法写入剪贴板，工作区路径：${workspace.path}`);
    }
  }, []);

  const handleRemoveWorkspace = useCallback(async (workspace: Workspace) => {
    try {
      await removeWorkspace(workspace.id);
    } catch (err) {
      setNotice(errorMessage(err, "移除工作区失败"));
    }
  }, []);

  const handleDragStart = useCallback(
    (event: DragEvent<HTMLElement>, source: SidebarDrag) => {
      if (reorderingWorkspace || dragBlocked.current) {
        event.preventDefault();
        return;
      }
      // 取消的原生拖动可能没回到原（虚拟化）行，不要把上一次的预览带进下一次手势
      dragPreview.current?.remove();
      const element = event.currentTarget;
      const rect = element.getBoundingClientRect();
      const preview = element.cloneNode(true) as HTMLElement;
      preview.setAttribute("aria-hidden", "true");
      preview.querySelectorAll("button, input").forEach((child) => {
        child.setAttribute("tabindex", "-1");
      });
      Object.assign(preview.style, {
        position: "fixed",
        top: "-10000px",
        left: "0",
        width: `${rect.width}px`,
        margin: "0",
        border: "1px solid color-mix(in srgb, var(--em-primary) 28%, transparent)",
        borderRadius: "14px",
        background:
          "linear-gradient(135deg, color-mix(in srgb, var(--em-primary) 12%, var(--em-panel)), var(--em-panel))",
        boxShadow: "0 18px 42px color-mix(in srgb, var(--em-primary) 25%, #0003), 0 3px 10px #0002",
        transform: "rotate(1.2deg) scale(1.02)",
        opacity: "0.96",
        overflow: "hidden",
        pointerEvents: "none",
      });
      document.body.appendChild(preview);
      dragPreview.current = preview;
      event.dataTransfer.setDragImage(preview, event.clientX - rect.left, event.clientY - rect.top);
      dragRef.current = source;
      dragPointerY.current = event.clientY;
      setDrag(source);
      setDragSessions(sessions);
      setDropTarget(null);
      setNotice(null);
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", source.id);
    },
    [reorderingWorkspace, sessions],
  );

  const stopDragAutoScroll = useCallback(() => {
    dragPointerY.current = null;
    if (dragScrollFrame.current !== null) {
      window.cancelAnimationFrame(dragScrollFrame.current);
      dragScrollFrame.current = null;
    }
  }, []);

  const updateDragAutoScroll = useCallback((clientY: number) => {
    dragPointerY.current = clientY;
    if (dragScrollFrame.current !== null) return;
    const step = () => {
      const viewport = viewportRef.current;
      const pointerY = dragPointerY.current;
      if (!dragRef.current || !viewport || pointerY === null) {
        dragScrollFrame.current = null;
        return;
      }
      const rect = viewport.getBoundingClientRect();
      const edgeSize = Math.min(112, Math.max(56, rect.height * 0.2));
      const distanceFromTop = pointerY - rect.top;
      const distanceFromBottom = rect.bottom - pointerY;
      let direction = 0;
      let distance = 0;
      if (distanceFromTop < edgeSize && viewport.scrollTop > 0) {
        direction = -1;
        distance = edgeSize - distanceFromTop;
      } else if (
        distanceFromBottom < edgeSize &&
        viewport.scrollTop < viewport.scrollHeight - viewport.clientHeight
      ) {
        direction = 1;
        distance = edgeSize - distanceFromBottom;
      }
      if (direction === 0) {
        dragScrollFrame.current = null;
        return;
      }
      const intensity = Math.min(1, distance / edgeSize);
      viewport.scrollTop += direction * (3 + Math.round(15 * intensity ** 1.35));
      dragScrollFrame.current = window.requestAnimationFrame(step);
    };
    dragScrollFrame.current = window.requestAnimationFrame(step);
  }, []);

  const clearDrag = useCallback(() => {
    dragBlocked.current = false;
    dragRef.current = null;
    stopDragAutoScroll();
    setDrag(null);
    setDragSessions(null);
    setDropTarget(null);
    dragPreview.current?.remove();
    dragPreview.current = null;
  }, [stopDragAutoScroll]);

  useEffect(() => {
    // 原生 dragend/drop 可能落在文档或其他组件上：列表外也要收尾；drop 冒泡后行内已保存新顺序
    const finishDrag = () => {
      if (dragPreview.current) clearDrag();
    };
    window.addEventListener("dragend", finishDrag, true);
    window.addEventListener("drop", finishDrag);
    window.addEventListener("pointerdown", finishDrag, true);
    return () => {
      window.removeEventListener("dragend", finishDrag, true);
      window.removeEventListener("drop", finishDrag);
      window.removeEventListener("pointerdown", finishDrag, true);
      stopDragAutoScroll();
      dragRef.current = null;
      dragPreview.current?.remove();
    };
  }, [clearDrag, stopDragAutoScroll]);

  const handleViewportDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!dragRef.current) return;
      event.preventDefault();
      updateDragAutoScroll(event.clientY);
    },
    [updateDragAutoScroll],
  );

  const handleViewportDragLeave = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) stopDragAutoScroll();
    },
    [stopDragAutoScroll],
  );

  const saveWorkspaceOrder = useCallback(
    async (sourceId: string, target: SidebarDrop) => {
      const next = moveSidebarItem(workspaces, sourceId, target.id, target.side);
      if (next === workspaces) return;
      setReorderingWorkspace(true);
      try {
        await reorderWorkspaces(next.map((w) => w.id));
      } catch (err) {
        setNotice(errorMessage(err, "工作区顺序保存失败，已恢复原顺序，请重试。"));
      } finally {
        setReorderingWorkspace(false);
      }
    },
    [workspaces],
  );

  const filteredSessions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return (dragSessions ?? sessions).filter(
      (session) => !q || fuzzyMatch(sessionTitle(session).toLowerCase(), q),
    );
  }, [sessions, dragSessions, searchQuery]);

  const groupedSessions = useMemo(() => {
    const known = new Set(workspaces.map((w) => w.id));
    const groups: SessionGroup[] = workspaces.map((ws) => ({
      key: ws.id,
      title: ws.name,
      workspace: ws,
      sessions: applySidebarOrder(
        filteredSessions.filter((s) => s.workspaceId === ws.id),
        order.sessions[ws.id],
      ),
    }));
    // 工作区登记被移除前删除了会话；日志里仍可能有尚未刷新的旧会话，归入"其他"
    const orphans = filteredSessions.filter((s) => !known.has(s.workspaceId));
    if (orphans.length > 0)
      groups.push({ key: "__orphans__", title: "其他", workspace: null, sessions: orphans });
    return groups;
  }, [filteredSessions, workspaces, order.sessions]);

  // 组头与展开的会话拍平后虚拟化，长历史也只渲染视口内的行
  const rows = useMemo(
    () =>
      groupedSessions.flatMap((group) => {
        const items: { key: string; group: SessionGroup; session?: SessionSummary }[] = [
          { key: `group:${group.key}`, group },
        ];
        if (!collapsedGroups.has(group.key) || searchQuery.trim()) {
          for (const session of group.sessions)
            items.push({ key: `${group.key}:${session.id}`, group, session });
        }
        return items;
      }),
    [groupedSessions, collapsedGroups, searchQuery],
  );
  const pinnedIndices = rows.flatMap((row, index) =>
    (row.session && (row.session.id === editingSessionId || row.session.id === sessionMenuId)) ||
    (!row.session && row.group.key === workspaceMenuKey) ||
    (drag?.kind === "workspace" && !row.session && row.group.key === drag.groupKey) ||
    (drag?.kind === "session" && row.session?.id === drag.id)
      ? [index]
      : [],
  );
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => viewportRef.current,
    getItemKey: (index) => rows[index].key,
    estimateSize: () => 44,
    overscan: 5,
    rangeExtractor: (range) =>
      [...new Set([...defaultRangeExtractor(range), ...pinnedIndices])].sort((a, b) => a - b),
  });

  const getDropTarget = (event: DragEvent<HTMLDivElement>, index: number): SidebarDrop | null => {
    if (!drag) return null;
    const row = rows[index];
    const rect = event.currentTarget.getBoundingClientRect();
    const side: DropSide = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
    if (drag.kind === "session") {
      if (row.group.key !== drag.groupKey || !row.session || row.session.id === drag.id)
        return null;
      return { id: row.session.id, side, rowKey: row.key };
    }
    if (!row.group.workspace || row.group.key === drag.groupKey) return null;
    const groupRows = rows.filter((item) => item.group.key === row.group.key);
    const groupSide = row.session ? "after" : side;
    return {
      id: row.group.workspace.id,
      side: groupSide,
      rowKey: groupSide === "before" ? groupRows[0].key : groupRows[groupRows.length - 1].key,
    };
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>, index: number) => {
    const target = getDropTarget(event, index);
    if (!drag) return;
    event.preventDefault();
    if (target) {
      if (drag.kind === "workspace") {
        void saveWorkspaceOrder(drag.id, target);
      } else {
        // 含搜索隐藏的会话，过滤状态下拖动也保留它们的相对顺序
        const members = sessions.filter((session) => session.workspaceId === drag.groupKey);
        const ordered = applySidebarOrder(members, order.sessions[drag.groupKey]);
        const next = moveSidebarItem(ordered, drag.id, target.id, target.side);
        setSessionOrder(
          drag.groupKey,
          next.map((session) => session.id),
        );
      }
    }
    clearDrag();
  };

  const revealLabel = isDesktopApp ? `在${fileManagerName()}中显示` : "复制工作区路径";

  const searchRow = (
    <div className="em-session-tools flex flex-col px-1 pt-3 pb-2 flex-shrink-0">
      <Button
        className="em-new-session-button group w-full justify-between rounded-xl px-3.5 text-white shadow-sm"
        onClick={() => void handleNewSession()}
        disabled={creatingKey !== null}
        aria-busy={creatingKey === "__global__"}
      >
        <span className="flex items-center gap-2">
          <span className="em-new-session-icon flex h-6 w-6 items-center justify-center rounded-lg bg-white/15">
            {creatingKey === "__global__" ? (
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
          </span>
          <span className="text-[12px] font-semibold tracking-wide">新建对话</span>
        </span>
        <span className="em-new-session-hint text-[10px] font-medium text-white/65">开始工作</span>
      </Button>
      <div className="mt-2 flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/50 pointer-events-none" />
          <input
            type="text"
            placeholder="搜索对话…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            aria-label="搜索对话"
            className={`em-session-search w-full h-9 pl-8 text-[12px] rounded-xl border border-[var(--em-line)] bg-card/80 outline-none placeholder:text-muted-foreground/50 focus:border-[var(--em-primary)] focus:ring-2 focus:ring-[var(--em-primary-alpha-15)] transition-all duration-200 ${searchQuery ? "pr-8" : "pr-3"}`}
          />
          {searchQuery ? (
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 h-4 w-4 flex items-center justify-center rounded-full bg-muted text-muted-foreground hover:bg-muted-foreground/20 hover:text-foreground transition-colors touch-compact"
              aria-label="清除搜索"
            >
              <X className="h-3 w-3" />
            </button>
          ) : null}
        </div>
        <Button
          className="em-add-workspace-button shrink-0 rounded-xl shadow-sm"
          size="icon-sm"
          onClick={() => {
            setEditingWorkspace(null);
            setAddFolderOpen(true);
          }}
          title="添加工作区"
          aria-label="添加工作区"
        >
          <FolderPlus className="h-4 w-4" />
        </Button>
      </div>
      <div className="em-session-summary mt-2 flex items-center justify-between px-1 text-[10px] font-medium tracking-wide text-muted-foreground/65">
        <span>{searchQuery ? "搜索结果" : "最近对话"}</span>
        <span>{filteredSessions.length} 个对话</span>
      </div>
      {notice ? (
        <div
          role="alert"
          className="mt-1.5 flex items-start gap-1.5 px-2 text-[11px] leading-4 text-destructive"
        >
          <span className="min-w-0 flex-1 break-all">{notice}</span>
          <button
            type="button"
            className="shrink-0 underline underline-offset-2"
            onClick={() => setNotice(null)}
          >
            关闭
          </button>
        </div>
      ) : null}
    </div>
  );

  const groupButtonClass = (key: string) =>
    cn(
      "h-6 w-6 shrink-0 text-current opacity-0 pointer-events-none transition-opacity hover:bg-[var(--em-primary-alpha-10)] hover:text-current",
      "group-hover/ws:opacity-100 group-hover/ws:pointer-events-auto",
      "group-focus-within/ws:opacity-100 group-focus-within/ws:pointer-events-auto",
      "pointer-coarse:opacity-100 pointer-coarse:pointer-events-auto",
      workspaceMenuKey === key && "opacity-100 pointer-events-auto",
    );

  const renderGroupHeader = (group: SessionGroup) => {
    const collapsed = collapsedGroups.has(group.key) && !searchQuery.trim();
    const ws = group.workspace;
    const unreadIds = group.sessions
      .filter((item) => isUnread(item, seen, activeSessionId))
      .map((item) => item.id);
    return (
      <div
        className={cn(
          "em-workspace-group group/ws flex select-none items-center gap-1 px-2 py-1 transition-colors",
          ws && "cursor-grab active:cursor-grabbing",
        )}
        data-menu-open={workspaceMenuKey === group.key || undefined}
        draggable={Boolean(ws) && !reorderingWorkspace}
        onPointerDownCapture={(event) => {
          const button = (event.target as Element).closest("button");
          dragBlocked.current = Boolean(
            button && !button.hasAttribute("data-workspace-drag-handle"),
          );
        }}
        onDragStart={(event) => {
          if (ws) handleDragStart(event, { kind: "workspace", id: ws.id, groupKey: group.key });
        }}
      >
        <button
          type="button"
          data-workspace-drag-handle="true"
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-0.5 text-left"
          onClick={() => toggleWorkspaceCollapsed(group.key)}
          aria-expanded={!collapsed}
          title={`${collapsed ? "展开" : "折叠"}「${group.title}」的对话${ws ? "；按住拖动调整工作区顺序" : ""}`}
        >
          <ChevronDown
            className={cn(
              "pointer-events-none h-3.5 w-3.5 shrink-0 text-current transition-transform duration-[250ms] ease-[cubic-bezier(0.4,0,0.2,1)]",
              collapsed && "-rotate-90",
            )}
          />
          <span className="em-workspace-icon" aria-hidden="true">
            {collapsed ? (
              <Folder className="h-3.5 w-3.5" />
            ) : (
              <FolderOpen className="h-3.5 w-3.5" />
            )}
          </span>
          <span className="min-w-0 truncate text-current" title={ws?.path || group.title}>
            {group.title}
          </span>
          <span className="em-workspace-count" aria-label={`${group.sessions.length} 个对话`}>
            {group.sessions.length}
          </span>
          {unreadIds.length > 0 ? (
            <span className="em-workspace-unread" aria-label={`${unreadIds.length} 个未读对话`}>
              {unreadIds.length > 99 ? "99+" : unreadIds.length}
            </span>
          ) : null}
          {ws?.isDefault ? (
            <span
              className="inline-flex shrink-0 items-center rounded-full bg-[var(--em-primary-alpha-12)] px-1.5 py-0.5 text-[9px] font-semibold leading-none text-[var(--em-primary)]"
              title="新对话默认使用该工作区"
            >
              默认
            </span>
          ) : null}
        </button>
        <DropdownMenu
          open={workspaceMenuKey === group.key}
          onOpenChange={(open) => setWorkspaceMenuKey(open ? group.key : null)}
        >
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className={groupButtonClass(group.key)}
              title={`管理「${group.title}」`}
              aria-label={`管理「${group.title}」`}
            >
              <Ellipsis className="h-3.5 w-3.5 text-current" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="bottom"
            align="end"
            sideOffset={6}
            className={glassMenuPanelClass}
          >
            {ws ? (
              <>
                <DropdownMenuItem
                  className={glassMenuItemClass}
                  onClick={() => {
                    setWorkspaceMenuKey(null);
                    setAddFolderOpen(false);
                    setEditingWorkspace(ws);
                  }}
                >
                  <Pencil className="h-4 w-4" />
                  重命名工作区
                </DropdownMenuItem>
                {!ws.isDefault ? (
                  <DropdownMenuItem
                    className={glassMenuItemClass}
                    onClick={() => {
                      setWorkspaceMenuKey(null);
                      void setDefaultWorkspace(ws.id).catch((err: unknown) =>
                        setNotice(errorMessage(err, "设置默认工作区失败")),
                      );
                    }}
                  >
                    <Star className="h-4 w-4" />
                    设为默认工作区
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem
                  className={glassMenuItemClass}
                  onClick={() => {
                    setWorkspaceMenuKey(null);
                    void handleRevealWorkspace(ws);
                  }}
                >
                  {isDesktopApp ? (
                    <ExternalLink className="h-4 w-4" />
                  ) : (
                    <Clipboard className="h-4 w-4" />
                  )}
                  {revealLabel}
                </DropdownMenuItem>
                <DropdownMenuSeparator className="mx-1 my-1.5 bg-[var(--em-hairline)]" />
              </>
            ) : null}
            <DropdownMenuItem
              className={glassMenuItemClass}
              disabled={unreadIds.length === 0}
              onClick={() => {
                markSessionsRead(group.sessions.map((item) => item.id));
                setWorkspaceMenuKey(null);
              }}
            >
              <CheckCheck className="h-4 w-4" />
              全部标为已读
            </DropdownMenuItem>
            {group.sessions.length > 0 ? (
              <DropdownMenuItem
                variant="destructive"
                className={glassMenuDangerItemClass}
                onClick={() => {
                  setWorkspaceMenuKey(null);
                  void handleDeleteGroupSessions(group.sessions.map((item) => item.id));
                }}
              >
                <Trash2 className="h-4 w-4" />
                删除所有对话
              </DropdownMenuItem>
            ) : null}
            {ws ? (
              <>
                <DropdownMenuSeparator className="mx-1 my-1.5 bg-[var(--em-hairline)]" />
                <DropdownMenuItem
                  variant="destructive"
                  className={glassMenuDangerItemClass}
                  disabled={ws.isDefault || group.sessions.length > 0}
                  title={
                    ws.isDefault
                      ? "默认工作区不能移除"
                      : group.sessions.length > 0
                        ? "请先删除该工作区的对话"
                        : undefined
                  }
                  onClick={() => {
                    setWorkspaceMenuKey(null);
                    void handleRemoveWorkspace(ws);
                  }}
                >
                  <FolderX className="h-4 w-4" />
                  {ws.isDefault
                    ? "移除登记（默认工作区不可移除）"
                    : group.sessions.length > 0
                      ? "移除登记（需先删除对话）"
                      : "移除登记（不删除文件）"}
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
        {ws ? (
          <Button
            variant="ghost"
            size="icon-sm"
            className={groupButtonClass(group.key)}
            title={`在「${group.title}」新建对话`}
            aria-label={`在「${group.title}」新建对话`}
            aria-busy={creatingKey === group.key}
            disabled={creatingKey !== null}
            onClick={() => void handleNewSession(ws.id, group.key)}
          >
            {creatingKey === group.key ? (
              <LoaderCircle className="h-3.5 w-3.5 animate-spin text-current" />
            ) : (
              <Plus className="h-3.5 w-3.5 text-current" />
            )}
          </Button>
        ) : null}
      </div>
    );
  };

  const renderSession = (group: SessionGroup, session: SessionSummary) => {
    const isActive = session.id === activeSessionId;
    const tone = statusTone(isActive && liveActivity ? liveActivity : session.activity);
    const isEditing = editingSessionId === session.id;
    const title = sessionTitle(session);
    const unread = isUnread(session, seen, activeSessionId);
    return (
      <div
        className={cn(
          "em-session-card group relative mx-2 flex min-w-0 cursor-pointer select-none items-center gap-1 rounded-xl py-2 pr-1 pl-[calc(0.875rem+0.375rem)] transition-colors",
          tone === "approval"
            ? isActive
              ? "bg-[color-mix(in_srgb,var(--em-gold)_18%,transparent)]"
              : "bg-[color-mix(in_srgb,var(--em-gold)_10%,transparent)] hover:bg-[color-mix(in_srgb,var(--em-gold)_16%,transparent)]"
            : tone === "question"
              ? isActive
                ? "bg-[color-mix(in_srgb,var(--em-cyan)_14%,transparent)]"
                : "bg-[color-mix(in_srgb,var(--em-cyan)_8%,transparent)] hover:bg-[color-mix(in_srgb,var(--em-cyan)_12%,transparent)]"
              : isActive
                ? "bg-black/[0.055] dark:bg-white/[0.09]"
                : "hover:bg-black/[0.035] dark:hover:bg-white/[0.06]",
          busySessionId === session.id && "opacity-50 pointer-events-none",
        )}
        data-active={isActive || undefined}
        data-status={tone || undefined}
        tabIndex={0}
        role="button"
        aria-current={isActive ? "true" : undefined}
        draggable={!isEditing}
        onPointerDownCapture={(event) => {
          dragBlocked.current = Boolean((event.target as Element).closest("button, input"));
        }}
        onDragStart={(event) =>
          handleDragStart(event, { kind: "session", id: session.id, groupKey: group.key })
        }
        onClick={() => {
          if (!isActive)
            void selectSession(session.id).catch((err: unknown) => setNotice(sessionError(err)));
        }}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (!isActive)
              void selectSession(session.id).catch((err: unknown) => setNotice(sessionError(err)));
          }
        }}
      >
        {tone ? (
          <span className="absolute top-1/2 left-0 flex h-3.5 w-3.5 -translate-y-1/2 items-center justify-center">
            <SessionStatusDot tone={tone} />
          </span>
        ) : unread ? (
          <span className="absolute top-1/2 left-0 flex h-3.5 w-3.5 -translate-y-1/2 items-center justify-center">
            <span
              className="h-1.5 w-1.5 rounded-full bg-[var(--em-primary)]"
              title="有新消息"
              aria-label="有新消息"
            />
          </span>
        ) : null}
        <div className="flex-1 min-w-0">
          <AnimatePresence mode="wait">
            {isEditing ? (
              <motion.div
                key="edit"
                initial={{ opacity: 0, scale: 0.97 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.97 }}
                transition={{ duration: 0.15 }}
                className="flex items-center gap-1"
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  ref={editInputRef}
                  type="text"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void handleFinishEdit(session);
                    } else if (e.key === "Escape") {
                      setEditingSessionId(null);
                    }
                    e.stopPropagation();
                  }}
                  aria-label="对话名称"
                  className="session-rename-input flex-1 min-w-0 h-7 text-[13px] bg-background/90 text-foreground rounded-lg px-2 outline-none border border-[var(--em-primary)]/40 focus:border-[var(--em-primary)] focus:ring-2 focus:ring-[var(--em-primary-alpha-15)] transition-all duration-200"
                />
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleFinishEdit(session);
                  }}
                  className="flex-shrink-0 h-7 w-7 flex items-center justify-center rounded-md text-white transition-colors duration-150 hover:opacity-90"
                  style={{ backgroundColor: "var(--em-primary)" }}
                  title="确认"
                  aria-label="确认"
                >
                  <Check className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditingSessionId(null);
                  }}
                  className="flex-shrink-0 h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground bg-muted hover:bg-muted-foreground/20 hover:text-foreground transition-colors duration-150"
                  title="取消"
                  aria-label="取消"
                >
                  <X className="h-3 w-3" />
                </button>
              </motion.div>
            ) : (
              <motion.div
                key="display"
                initial={false}
                animate={{ opacity: 1 }}
                className="min-w-0"
              >
                <span
                  className={cn(
                    "block min-w-0 truncate text-[13px] leading-snug",
                    isActive || unread
                      ? "font-medium text-foreground"
                      : "font-normal text-foreground/80",
                  )}
                  title={title}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    handleStartEdit(session);
                  }}
                >
                  {title}
                </span>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {!isEditing && (
          <DropdownMenu onOpenChange={(open) => setSessionMenuId(open ? session.id : null)}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={`管理对话「${title}」`}
                className={cn(
                  "flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-all duration-150",
                  "hover:bg-[var(--em-primary-alpha-10)] hover:text-[var(--em-primary)]",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--em-primary)]",
                  "data-[state=open]:bg-[var(--em-primary-alpha-10)] data-[state=open]:text-[var(--em-primary)] data-[state=open]:opacity-100",
                  isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100 touch-show",
                )}
                onClick={(e) => e.stopPropagation()}
              >
                <Ellipsis className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              side="bottom"
              align="end"
              sideOffset={6}
              collisionPadding={8}
              className={glassMenuPanelClass}
            >
              <DropdownMenuItem
                className={glassMenuItemClass}
                onClick={(e) => {
                  e.stopPropagation();
                  handleStartEdit(session);
                }}
              >
                <Pencil className="h-4 w-4" />
                重命名
              </DropdownMenuItem>
              <DropdownMenuSeparator className="mx-1 my-1.5 bg-[var(--em-hairline)]" />
              <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-0.5">
                <Download className="h-3 w-3 text-[var(--em-primary-light)]" />
                <span className="text-[11px] font-medium tracking-wide text-muted-foreground">
                  导出
                </span>
              </div>
              <DropdownMenuItem
                className={glassMenuItemClass}
                onClick={(e) => {
                  e.stopPropagation();
                  void exportSession(session.id).catch((err: unknown) =>
                    setNotice(errorMessage(err, "导出失败")),
                  );
                }}
              >
                <FileText className="h-4 w-4" />
                Markdown
                <span className="ml-auto text-[11px] font-normal text-muted-foreground/70">
                  .md
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem
                className={glassMenuItemClass}
                onClick={(e) => {
                  e.stopPropagation();
                  void exportSessionJson(session.id).catch((err: unknown) =>
                    setNotice(errorMessage(err, "导出失败")),
                  );
                }}
              >
                <FileJson className="h-4 w-4" />
                完整记录
                <span className="ml-auto text-[11px] font-normal text-muted-foreground/70">
                  .json
                </span>
              </DropdownMenuItem>
              <DropdownMenuSeparator className="mx-1 my-1.5 bg-[var(--em-hairline)]" />
              <DropdownMenuItem
                variant="destructive"
                className={glassMenuDangerItemClass}
                onClick={(e) => {
                  e.stopPropagation();
                  void handleDelete(session.id);
                }}
              >
                <Trash2 className="h-4 w-4" />
                删除
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    );
  };

  return (
    <div
      className="flex flex-col h-full"
      data-sidebar-dragging={drag?.kind || undefined}
      onDragEnd={clearDrag}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null);
      }}
    >
      {searchRow}
      <ScrollArea
        className="flex-1 min-h-0"
        viewportRef={viewportRef}
        onDragOver={handleViewportDragOver}
        onDragLeave={handleViewportDragLeave}
      >
        <div className="space-y-2 pb-2">
          {searchQuery && filteredSessions.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-2 py-6 text-muted-foreground">
              <MessageSquare
                className="h-6 w-6 animate-empty-float"
                style={{ color: "var(--em-primary)" }}
              />
              <p className="text-xs">暂无匹配对话</p>
            </div>
          ) : (
            <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
              {virtualizer.getVirtualItems().map((row) => {
                const { group, session, key } = rows[row.index];
                const frozen = Boolean(
                  drag &&
                    (drag.kind === "workspace"
                      ? drag.groupKey === group.key
                      : drag.id === session?.id),
                );
                const indicator = dropTarget?.rowKey === key ? dropTarget.side : null;
                return (
                  <div
                    key={row.key}
                    data-index={row.index}
                    ref={virtualizer.measureElement}
                    data-sidebar-row={key}
                    data-drag-frozen={frozen || undefined}
                    data-drag-active={drag ? "true" : undefined}
                    data-drag-source={frozen ? "true" : undefined}
                    data-drop-target={indicator ? "true" : undefined}
                    onDragEnter={(event) => {
                      if (drag) event.preventDefault();
                    }}
                    onDragOver={(event) => {
                      if (!drag) return;
                      event.preventDefault();
                      const target = getDropTarget(event, row.index);
                      event.dataTransfer.dropEffect = target ? "move" : "none";
                      setDropTarget(target);
                    }}
                    onDrop={(event) => handleDrop(event, row.index)}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${row.start}px)`,
                      paddingBottom: 2,
                    }}
                  >
                    {indicator && (
                      <div
                        aria-hidden="true"
                        data-drop-indicator={indicator}
                        className="pointer-events-none absolute inset-x-2 z-10 h-0.5 rounded-full bg-[var(--em-primary)]"
                        style={indicator === "before" ? { top: -1 } : { bottom: 0 }}
                      />
                    )}
                    {session ? renderSession(group, session) : renderGroupHeader(group)}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </ScrollArea>
      <AddWorkspaceDialog
        open={addFolderOpen || Boolean(editingWorkspace)}
        workspace={editingWorkspace}
        onOpenChange={(open) => {
          if (!open) {
            setAddFolderOpen(false);
            setEditingWorkspace(null);
          }
        }}
        onCreated={(workspace) => {
          // 新登记的工作区直接开一个对话，免得用户还要再找入口
          if (workspace) void handleNewSession(workspace.id, workspace.id);
        }}
      />
    </div>
  );
});
