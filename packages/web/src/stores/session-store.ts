// 会话列表与导航：全部工作区的会话（侧栏按工作区分组），当前会话决定当前工作区。
// 每个工作区记住上次打开的会话；组内手动排序与折叠是本地偏好。

import type { SessionSummary } from "@excelmanus/protocol";
import { create } from "zustand";
import { api, errorMessage, saveBlob } from "@/lib/backend/api";
import { onSync } from "@/lib/backend/channel";
import { onAppEvent, useAppStore } from "@/stores/app-store";
import { clearChatSession, loadChatSession, useChatStore } from "@/stores/chat-store";

const NAV_KEY = "excelmanus.navigation";
const ORDER_KEY = "excelmanus.sidebar-order";
const SEEN_KEY = "excelmanus.session-seen";

interface Navigation {
  workspaceId?: string;
  sessions: Record<string, string>;
}

/** 组内会话的手动顺序与折叠的工作区（本机偏好；工作区顺序由服务端保存）。 */
interface SidebarOrder {
  sessions: Record<string, string[]>;
  collapsed: string[];
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? ({ ...fallback, ...JSON.parse(raw) } as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 偏好写不进去不影响功能
  }
}

interface SessionListState {
  sessions: SessionSummary[];
  activeSessionId: string | null;
  /** 当前工作区：由当前会话决定。 */
  activeWorkspaceId: string | null;
  listLoaded: boolean;
  order: SidebarOrder;
  /** 各会话已读到的日志游标（本机）；lastSeq 更大即为未读。 */
  seen: Record<string, number>;
  /** 本地刚删除、服务端列表尚未反映的会话（防止轮询结果把它"复活"）。 */
  deleting: string[];
}

export const useSessionStore = create<SessionListState>()(() => ({
  sessions: [],
  activeSessionId: null,
  activeWorkspaceId: null,
  listLoaded: false,
  order: readJson<SidebarOrder>(ORDER_KEY, { sessions: {}, collapsed: [] }),
  seen: readJson<Record<string, number>>(SEEN_KEY, {}),
  deleting: [],
}));

const set = useSessionStore.setState;
const get = useSessionStore.getState;

let listRequest = 0;
let navRequest = 0;

let latestListRead: Promise<SessionSummary[]> | null = null;

export function refreshSessions(): Promise<SessionSummary[]> {
  const request = ++listRequest;
  const pending = readSessions(request).catch((error: unknown) => {
    if (request !== listRequest && latestListRead) return latestListRead;
    throw error;
  });
  latestListRead = pending;
  return pending;
}

async function readSessions(request: number): Promise<SessionSummary[]> {
  const all = new Map<string, SessionSummary>();
  let cursor: string | undefined;
  do {
    const page = await api().listSessions({ limit: 200, ...(cursor ? { cursor } : {}) });
    if (request !== listRequest) return latestListRead ?? get().sessions;
    for (const s of page.items) all.set(s.id, s);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  const deleting = new Set(get().deleting);
  const sessions = [...all.values()].filter((s) => !deleting.has(s.id));
  // 首次见到的会话视为已读，当前会话始终已读
  const seen = { ...get().seen };
  let seenChanged = false;
  for (const s of sessions) {
    if (seen[s.id] === undefined || (s.id === get().activeSessionId && seen[s.id] !== s.lastSeq)) {
      seen[s.id] = s.lastSeq;
      seenChanged = true;
    }
  }
  for (const id of Object.keys(seen)) {
    if (!all.has(id)) {
      delete seen[id];
      seenChanged = true;
    }
  }
  set({ sessions, listLoaded: true, ...(seenChanged ? { seen } : {}) });
  if (seenChanged) writeJson(SEEN_KEY, seen);
  return sessions;
}

export function isUnread(
  session: SessionSummary,
  seen: Record<string, number>,
  activeId: string | null,
): boolean {
  return session.id !== activeId && session.lastSeq > (seen[session.id] ?? session.lastSeq);
}

export function markSessionsRead(ids: string[]): void {
  const byId = new Map(get().sessions.map((s) => [s.id, s]));
  const seen = { ...get().seen };
  for (const id of ids) {
    const s = byId.get(id);
    if (s) seen[id] = s.lastSeq;
  }
  set({ seen });
  writeJson(SEEN_KEY, seen);
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleRefresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refreshSessions().catch(() => undefined);
  }, 250);
}

function remember(workspaceId: string, sessionId: string): void {
  const nav = readJson<Navigation>(NAV_KEY, { sessions: {} });
  writeJson(NAV_KEY, { workspaceId, sessions: { ...nav.sessions, [workspaceId]: sessionId } });
}

export function preferredWorkspaceId(): string | null {
  const { workspaces } = useAppStore.getState();
  const saved = readJson<Navigation>(NAV_KEY, { sessions: {} }).workspaceId;
  return (
    workspaces.find((w) => w.id === saved)?.id ??
    workspaces.find((w) => w.isDefault)?.id ??
    workspaces[0]?.id ??
    null
  );
}

/** 打开一个会话（切换对话区、工作区随之切换）。 */
export async function selectSession(sessionId: string): Promise<void> {
  const request = ++navRequest;
  const known = get().sessions.find((session) => session.id === sessionId);
  set({ activeSessionId: sessionId, activeWorkspaceId: known?.workspaceId ?? null });
  markSessionsRead([sessionId]);
  const { workspaceId } = await loadChatSession(sessionId);
  if (request !== navRequest) return;
  set({ activeWorkspaceId: workspaceId });
  remember(workspaceId, sessionId);
}

/**
 * 进入某工作区：恢复该工作区上次的会话；没有会话时复用（或新建）一个空白会话。
 */
export async function openWorkspace(workspaceId: string): Promise<void> {
  const saved = readJson<Navigation>(NAV_KEY, { sessions: {} }).sessions[workspaceId];
  const inWorkspace = get().sessions.filter((s) => s.workspaceId === workspaceId);
  const target = inWorkspace.find((s) => s.id === saved) ?? inWorkspace[0];
  if (target) return selectSession(target.id);
  const request = ++navRequest;
  const { session } = await api().createSession({ workspaceId, reuseBlank: true });
  if (request !== navRequest) return;
  await refreshSessions();
  if (request !== navRequest) return;
  await selectSession(session.id);
}

/** 新建对话；当前对话本身还是空白（同一工作区）时直接留在它上面，不再堆出空会话。 */
export async function createSession(workspaceId?: string | null): Promise<string> {
  const request = ++navRequest;
  const target = workspaceId ?? get().activeWorkspaceId ?? preferredWorkspaceId();
  const current = get().sessions.find((x) => x.id === get().activeSessionId);
  const chat = useChatStore.getState();
  const blank =
    current !== undefined &&
    chat.sessionId === current.id &&
    !chat.loading &&
    chat.optimistic.length === 0 &&
    Object.values(chat.session.timelines).every((items) => items.length === 0);
  if (current && blank && (!target || current.workspaceId === target)) {
    const { closeAllWorkbooks } = await import("./workbook-store");
    if (request === navRequest && get().activeSessionId === current.id) closeAllWorkbooks();
    return current.id;
  }
  const { session } = await api().createSession(target ? { workspaceId: target } : {});
  set((s) => ({ sessions: [session, ...s.sessions.filter((x) => x.id !== session.id)] }));
  if (request !== navRequest) return session.id;
  const selecting = selectSession(session.id);
  const selectionRequest = navRequest;
  await selecting;
  if (selectionRequest === navRequest && get().activeSessionId === session.id) {
    const { closeAllWorkbooks } = await import("./workbook-store");
    if (selectionRequest === navRequest && get().activeSessionId === session.id)
      closeAllWorkbooks();
  }
  return session.id;
}

/**
 * 有空白会话就复用，否则新建：首页直接输入时用，避免每次刷新都堆出空会话。
 */
export async function ensureActiveSession(): Promise<string> {
  const current = get().activeSessionId;
  if (current) return current;
  const request = ++navRequest;
  const changed = () => new Error("已切换对话，请在当前对话重新操作");
  const workspaceId = preferredWorkspaceId();
  const { session } = await api().createSession({
    ...(workspaceId ? { workspaceId } : {}),
    reuseBlank: true,
  });
  if (request !== navRequest) throw changed();
  await refreshSessions();
  if (request !== navRequest) throw changed();
  const selecting = selectSession(session.id);
  const selectionRequest = navRequest;
  await selecting;
  if (selectionRequest !== navRequest || get().activeSessionId !== session.id) throw changed();
  return session.id;
}

export async function deleteSession(sessionId: string): Promise<void> {
  set((s) => ({
    deleting: [...s.deleting, sessionId],
    sessions: s.sessions.filter((x) => x.id !== sessionId),
  }));
  try {
    await api().deleteSession(sessionId);
  } catch (error) {
    set((s) => ({ deleting: s.deleting.filter((id) => id !== sessionId) }));
    await refreshSessions().catch(() => undefined);
    throw error;
  }
  set((s) => ({ deleting: s.deleting.filter((id) => id !== sessionId) }));
  if (get().activeSessionId === sessionId) {
    const workspaceId = get().activeWorkspaceId;
    set({ activeSessionId: null });
    clearChatSession();
    if (workspaceId) await openWorkspace(workspaceId).catch(() => undefined);
  }
}

export async function renameSession(sessionId: string, title: string): Promise<void> {
  const next = title.trim();
  if (!next) return;
  set((s) => ({
    sessions: s.sessions.map((x) => (x.id === sessionId ? { ...x, title: next } : x)),
  }));
  try {
    await api().updateSession(sessionId, { title: next });
  } finally {
    scheduleRefresh();
  }
}

export async function exportSession(sessionId: string): Promise<void> {
  const blob = await api().exportSession(sessionId);
  const title =
    get()
      .sessions.find((s) => s.id === sessionId)
      ?.title?.trim() || "未命名对话";
  saveBlob(blob, `${title}.md`);
}

/** 完整导出（会话、代理与全部日志记录，凭据已脱敏），便于排查问题或归档。 */
export async function exportSessionJson(sessionId: string): Promise<void> {
  const data = await api().exportSessionJson(sessionId);
  const title = data.session.title?.trim() || "未命名对话";
  saveBlob(
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
    `${title}.json`,
  );
}

export function sessionError(error: unknown): string {
  return errorMessage(error, "对话操作失败，请重试");
}

// ---------- 本地排序与折叠偏好 ----------

function saveOrder(order: SidebarOrder): void {
  set({ order });
  writeJson(ORDER_KEY, order);
}

export function setSessionOrder(workspaceId: string, ids: string[]): void {
  const order = get().order;
  saveOrder({ ...order, sessions: { ...order.sessions, [workspaceId]: [...new Set(ids)] } });
}

export function toggleWorkspaceCollapsed(workspaceId: string): void {
  const order = get().order;
  const collapsed = order.collapsed.includes(workspaceId)
    ? order.collapsed.filter((id) => id !== workspaceId)
    : [...order.collapsed, workspaceId];
  saveOrder({ ...order, collapsed });
}

// ---------- 同步 ----------

onAppEvent((event) => {
  if (event.type.startsWith("session.")) {
    scheduleRefresh();
    if (event.type === "session.deleted" && event.sessionId === get().activeSessionId) {
      const workspaceId = get().activeWorkspaceId;
      set({ activeSessionId: null });
      clearChatSession();
      if (workspaceId) void openWorkspace(workspaceId).catch(() => undefined);
    }
  }
});

onSync((message) => {
  if (message.type !== "rec") return;
  const sessionId = useChatStore.getState().sessionId;
  if (!sessionId || message.topic !== `session:${sessionId}`) return;
  const type = message.record.type;
  if (type === "user.message" || type === "session.updated" || type === "turn.completed")
    scheduleRefresh();
});
