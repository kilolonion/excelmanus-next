// 全局状态（Zustand）：令牌、会话列表、当前会话还原状态、工作台文档、设置弹窗。

import { parseRange } from "@excelmanus/core";
import type {
  AttachmentRef,
  FileEntry,
  ModelProfile,
  PresenceParticipant,
  ProviderPreset,
  ServerMessage,
  SessionSummary,
} from "@excelmanus/protocol";
import { create } from "zustand";
import {
  apiClient,
  bootstrapToken,
  browserSessionPaused,
  clearToken,
  pauseBrowserSession,
  resumeBrowserSession,
} from "./api.ts";
import {
  type DocSyncState,
  initialDocSync,
  initialSessionState,
  reduceDoc,
  reduceSession,
  type SessionState,
  seedRoster,
  trackDocSubmit,
} from "./reduce.ts";
import { renderLayoutToPng } from "./render.ts";
import { S } from "./strings.ts";
import { SyncClient } from "./ws.ts";

export interface OpenDoc {
  docId: string;
  rev: number;
  snapshotRev: number;
  path: string;
  checkpointRev?: number;
  checkpointError?: string;
  snapshot: Record<string, unknown>;
}

/** 传输层可回放的 Univer mutation（与 kernel 的 DocMutation 保持中立结构）。 */
export interface ClientDocMutation {
  id: string;
  params: unknown;
}

export interface DocumentEditorBridge {
  docId: string;
  /** 逐条在当前 Univer 实例中回放远端 mutation。 */
  applyRemote(mutations: ClientDocMutation[]): Promise<void>;
}

interface AppState {
  token: string | null;
  ready: boolean;
  connected: boolean;
  workspaceId: string;
  hasModelProfile: boolean;
  sessions: SessionSummary[];
  sessionId: string | null;
  agentId: string;
  session: SessionState;
  files: FileEntry[];
  doc: OpenDoc | null;
  docSync: DocSyncState;
  selection: { docId: string; rev: number; range: string } | null;
  /** 当前文档上的瞬时协作者状态（不写入会话日志）。 */
  presence: PresenceParticipant[];
  presenceConnectionId: string | null;
  settingsOpen: boolean;
  providers: ProviderPreset[];
  profiles: ModelProfile[];
  fatal: string | null;
  rangeFocus: { range: string; nonce: number } | null;
  rangePreview: string | null;
  referenceError: string | null;
  /** /compact 等斜杠命令的短提示（下一次发送时清除）。 */
  commandNotice: string | null;
  sidebarCollapsed: boolean;
  /** 设置中心打开时的初始分页。 */
  settingsTab: string;
  appVersion: string;
  shape: string;
  /** 本机数据目录（bootstrap.dataDir）。 */
  dataDir: string | null;
  onboardingOpen: boolean;
  /** 输入框上方的选区徽标（02 §3.3）：钉住后不随选区变化；移除后直到选区变化前不附带。 */
  pinnedSelection: { docId: string; rev: number; range: string } | null;
  selectionDismissed: boolean;
  /** 布局（02 §2）：分栏比例、折叠与窄屏标签页，比例与折叠记在本地。 */
  layout: LayoutPrefs;
  narrowTab: "sheet" | "chat";
  /** 用户清除高亮时的会话游标；之后的新变更继续提供短时反馈（02 §4.2）。 */
  changesSeenSeq: number;
  /** 跟随代理（02 §4.8，默认开，记在本地）。 */
  followAgent: boolean;
  /** 输入框里的图片附件与文件引用（02 §3.3）：上传完成后才有 ref/path。 */
  composerAttachments: ComposerAttachment[];
  /** 需要追加到输入框的文本（拖入表格文件后的 @路径），nonce 递增触发。 */
  composerAppend: { text: string; nonce: number } | null;
  /** 已登记的工作区（02 §6 工作区切换器）。 */
  workspaces: { id: string; name: string; path: string; isDefault: boolean }[];
}

export interface ComposerAttachment {
  id: string;
  name: string;
  previewUrl?: string;
  path?: string;
  status: "uploading" | "ready" | "error";
  ref?: AttachmentRef;
  error?: string;
}

export interface LayoutPrefs {
  /** 对话面板占主区（工作台 + 对话）宽度的比例。 */
  chatRatio: number;
  chatCollapsed: boolean;
  tableCollapsed: boolean;
}

const LAYOUT_KEY = "excelmanus.layout";
function loadLayout(): LayoutPrefs {
  const fallback: LayoutPrefs = { chatRatio: 0.4, chatCollapsed: false, tableCollapsed: false };
  try {
    const raw = JSON.parse(
      localStorage.getItem(LAYOUT_KEY) ?? "null",
    ) as Partial<LayoutPrefs> | null;
    if (!raw) return fallback;
    const ratio = typeof raw.chatRatio === "number" ? raw.chatRatio : fallback.chatRatio;
    return {
      chatRatio: Math.min(0.7, Math.max(0.22, ratio)),
      chatCollapsed: raw.chatCollapsed === true,
      tableCollapsed: raw.tableCollapsed === true && raw.chatCollapsed !== true,
    };
  } catch {
    return fallback;
  }
}

type Api = ReturnType<typeof apiClient>;

let api: Api | null = null;
let sync: SyncClient | null = null;
let seq = 0;
let docRequest = 0;
let navigationRequest = 0;
let navigationPending = false;
let sessionsRequest = 0;
let filesRequest = 0;
let syncConnectionId: string | null = null;
let presenceTimer: ReturnType<typeof setTimeout> | null = null;
let editorBridge: DocumentEditorBridge | null = null;
let editorApplyQueue: Promise<void> = Promise.resolve();

export const useApp = create<AppState>(() => ({
  token: null,
  ready: false,
  connected: false,
  workspaceId: "",
  hasModelProfile: false,
  sessions: [],
  sessionId: null,
  agentId: "main",
  session: initialSessionState(),
  files: [],
  doc: null,
  docSync: initialDocSync(),
  selection: null,
  presence: [],
  presenceConnectionId: null,
  settingsOpen: false,
  providers: [],
  profiles: [],
  fatal: null,
  rangeFocus: null,
  rangePreview: null,
  referenceError: null,
  commandNotice: null,
  sidebarCollapsed: false,
  settingsTab: "models",
  appVersion: "",
  dataDir: null,
  shape: "local-web",
  onboardingOpen: false,
  pinnedSelection: null,
  selectionDismissed: false,
  layout:
    typeof localStorage === "undefined"
      ? { chatRatio: 0.4, chatCollapsed: false, tableCollapsed: false }
      : loadLayout(),
  narrowTab: "chat",
  changesSeenSeq: 0,
  workspaces: [],
  composerAttachments: [],
  composerAppend: null,
  followAgent:
    typeof localStorage === "undefined" || localStorage.getItem("excelmanus.followAgent") !== "0",
}));

/** 更新并记住布局偏好；两侧不能同时折叠。 */
export function setLayout(patch: Partial<LayoutPrefs>): void {
  const next = { ...get().layout, ...patch };
  if (patch.chatCollapsed) next.tableCollapsed = false;
  if (patch.tableCollapsed) next.chatCollapsed = false;
  next.chatRatio = Math.min(0.7, Math.max(0.22, next.chatRatio));
  localStorage.setItem(LAYOUT_KEY, JSON.stringify(next));
  set({ layout: next });
}

export function setNarrowTab(tab: "sheet" | "chat"): void {
  set({ narrowTab: tab });
}

const FOLLOW_KEY = "excelmanus.followAgent";
let lastManualView = 0;

export function setFollowAgent(on: boolean): void {
  localStorage.setItem(FOLLOW_KEY, on ? "1" : "0");
  set({ followAgent: on });
}

/** 用户手动打开文件或切换视图（02 §4.8：5 秒内不被代理跳转打断）。 */
export function noteManualView(): void {
  lastManualView = Date.now();
}

/**
 * 跟随代理（02 §4.8）：主代理用工作簿工具时自动打开该文件并定位到读写区域。
 * 不跟随：开关关闭、用户 5 秒内手动切换过视图、子代理的活动、日志回放（记录早于 10 秒）。
 */
function followAgentActivity(record: {
  type: string;
  agentId: string | null;
  data: unknown;
  createdAt: string;
}): void {
  const st = get();
  if (!st.followAgent || record.type !== "tool.intent") return;
  if ((record.agentId ?? "main") !== "main" || Date.now() - lastManualView < 5000) return;
  if (Date.now() - Date.parse(record.createdAt) > 10_000) return;
  const d = record.data as { toolName?: unknown; args?: unknown };
  if (typeof d.toolName !== "string" || !d.toolName.startsWith("workbook_")) return;
  const args = (d.args ?? {}) as {
    path?: unknown;
    docId?: unknown;
    range?: unknown;
    sheet?: unknown;
    ops?: unknown;
  };
  const firstOp = Array.isArray(args.ops)
    ? (args.ops[0] as { range?: unknown } | undefined)
    : undefined;
  const range =
    typeof args.range === "string"
      ? args.range
      : typeof firstOp?.range === "string"
        ? firstOp.range
        : null;
  const docId = typeof args.docId === "string" ? args.docId : null;
  const path = typeof args.path === "string" ? args.path : null;
  if (docId === null && path === null) return;
  const isOpen =
    st.doc !== null && (docId !== null ? st.doc.docId === docId : st.doc.path === path);
  const open = isOpen
    ? Promise.resolve()
    : docId !== null
      ? openDocument(docId)
      : openWorkspaceFile(path as string);
  void open
    .then(() => {
      if (!range) return;
      const qualified =
        typeof args.sheet === "string" && !range.includes("!") ? `${args.sheet}!${range}` : range;
      return focusRange(qualified);
    })
    .catch(() => undefined);
}

/** 清除当前改动反馈，之后的新变更继续高亮；历史记录保持完整。 */
export function markChangesSeen(): void {
  set({ changesSeenSeq: get().session.cursor });
}

/** 本条消息将附带的区域上下文：钉住优先，其次当前选区（未被移除时）。 */
export function composerContext(
  st: Pick<AppState, "pinnedSelection" | "selection" | "selectionDismissed">,
): { docId: string; rev: number; range: string } | null {
  if (st.pinnedSelection) return st.pinnedSelection;
  if (st.selection && !st.selectionDismissed) return st.selection;
  return null;
}

export function pinSelection(pin: boolean): void {
  const cur = composerContext(get());
  set({ pinnedSelection: pin ? cur : null });
}

/** 把指定区域钉为本条消息的上下文（`@工作表` 候选）。 */
export function pinRange(docId: string, range: string): void {
  const doc = get().doc;
  if (!doc || doc.docId !== docId) return;
  set({ pinnedSelection: { docId, rev: doc.rev, range }, selectionDismissed: false });
}

export function dismissContext(): void {
  set({ pinnedSelection: null, selectionDismissed: true });
}

const set = useApp.setState;
const get = useApp.getState;

function requireApi(): Api {
  if (!api) throw new Error("API 未初始化");
  return api;
}

/** 将当前选区以瞬时 presence 广播给同一文档的其他参与者。 */
function schedulePresence(docId: string): void {
  if (presenceTimer) clearTimeout(presenceTimer);
  presenceTimer = setTimeout(() => {
    presenceTimer = null;
    const st = get();
    const doc = st.doc;
    if (!doc || doc.docId !== docId) return;
    const selection = st.selection?.docId === doc.docId ? st.selection.range : "";
    let sheet = "";
    if (selection !== "") {
      try {
        sheet = parseRange(selection).sheet ?? "";
      } catch {
        // 选区由 Univer 产生；无法解析时仍发送空工作表，避免阻塞协作状态。
      }
    }
    sync?.send({ type: "presence", docId: doc.docId, sheet, selection });
  }, 80);
}

function clearPresenceTimer(): void {
  if (!presenceTimer) return;
  clearTimeout(presenceTimer);
  presenceTimer = null;
}

/** 设置中心等自管状态的组件直接经契约客户端访问 REST。 */
export const apiClientOf = requireApi;

/** 清除浏览器会话并回到自动登录页；桌面端令牌由预加载桥接管理，不在这里清除。 */
export async function signOut(): Promise<void> {
  await api?.logoutBrowserSession().catch(() => undefined);
  clearToken();
  pauseBrowserSession();
  window.location.reload();
}

export function resumeAuth(): void {
  resumeBrowserSession();
  window.location.reload();
}

type AppEventListener = (data: { type: string } & Record<string, unknown>) => void;
const appListeners = new Set<AppEventListener>();
/** 订阅 app 主题事件（MCP 状态、设置变化等），返回取消函数。 */
export function onAppEvent(fn: AppEventListener): () => void {
  appListeners.add(fn);
  return () => {
    appListeners.delete(fn);
  };
}

async function refreshSessions(): Promise<void> {
  const request = ++sessionsRequest;
  const sessions = new Map<string, SessionSummary>();
  let cursor: string | undefined;
  do {
    const page = await requireApi().listSessions({ limit: 200, cursor });
    if (request !== sessionsRequest) return;
    for (const session of page.items) sessions.set(session.id, session);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  set({ sessions: [...sessions.values()] });
}

async function refreshFiles(): Promise<void> {
  const st = get();
  if (st.workspaceId === "") return;
  const request = ++filesRequest;
  try {
    const res = await requireApi().listFiles(st.workspaceId, "");
    if (request === filesRequest && get().workspaceId === st.workspaceId) set({ files: res.items });
  } catch {
    // 文件列表失败不阻塞
  }
}

export async function selectSession(sessionId: string): Promise<void> {
  const request = ++navigationRequest;
  navigationPending = true;
  try {
    await loadSession(sessionId, request);
  } finally {
    if (request === navigationRequest) navigationPending = false;
  }
}

const NAVIGATION_KEY = "excelmanus.navigation";
function readNavigation(): { workspaceId?: string; sessions: Record<string, string> } {
  try {
    const value = JSON.parse(localStorage.getItem(NAVIGATION_KEY) ?? "null") as {
      workspaceId?: unknown;
      sessions?: unknown;
    } | null;
    return {
      workspaceId: typeof value?.workspaceId === "string" ? value.workspaceId : undefined,
      sessions: Object.fromEntries(
        Object.entries(
          value?.sessions && typeof value.sessions === "object" ? value.sessions : {},
        ).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      ),
    };
  } catch {
    return { sessions: {} };
  }
}

function rememberSession(workspaceId: string, sessionId: string): void {
  const saved = readNavigation();
  localStorage.setItem(
    NAVIGATION_KEY,
    JSON.stringify({
      workspaceId,
      sessions: { ...saved.sessions, [workspaceId]: sessionId },
    }),
  );
}

async function loadSession(sessionId: string, request: number): Promise<void> {
  const detail = await requireApi().getSession(sessionId);
  if (request !== navigationRequest) return;
  const workspaceId = detail.session.workspaceId;
  if (!get().workspaces.some((workspace) => workspace.id === workspaceId)) {
    await refreshWorkspaces();
    if (request !== navigationRequest) return;
  }
  if (workspaceId !== get().workspaceId) {
    const previous = get().doc;
    clearPresenceTimer();
    if (previous) sync?.unsubscribe(`doc:${previous.docId}`);
    docRequest += 1;
    set({
      workspaceId,
      doc: null,
      selection: null,
      pinnedSelection: null,
      selectionDismissed: false,
      presence: [],
      files: [],
      rangeFocus: null,
      rangePreview: null,
      docSync: initialDocSync(0),
    });
  }
  if (get().sessionId !== sessionId) {
    for (const attachment of get().composerAttachments) {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    }
    set({ composerAttachments: [], composerAppend: null, commandNotice: null });
  }
  // 名册以 reduce 的 roster 为准（05 §8）；会话详情只用于预填名字/角色。
  set({
    sessionId: sessionId,
    session: {
      ...seedRoster(initialSessionState(), detail.agents),
      permissionMode: detail.session.permissionMode,
    },
    agentId: "main",
    changesSeenSeq: 0,
    sessions: [
      detail.session,
      ...get().sessions.filter((session) => session.id !== sessionId),
    ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id)),
  });
  rememberSession(workspaceId, sessionId);
  sync?.subscribe(`session:${sessionId}`);
  await refreshFiles();
}

let initPromise: Promise<void> | null = null;
export function init(): Promise<void> {
  initPromise ??= initialize().catch(() => set({ ready: true, fatal: "auth-failed" }));
  return initPromise;
}

async function initialize(): Promise<void> {
  const token = bootstrapToken();
  if (!token && browserSessionPaused()) {
    set({ ready: true, fatal: "signed-out" });
    return;
  }
  api = apiClient(token);
  set({ token: desktopToken(token) });
  try {
    if (!token) await api.createBrowserSession();
    const boot = await api.bootstrap();
    set({
      hasModelProfile: boot.hasModelProfile,
      appVersion: boot.appVersion,
      dataDir: boot.dataDir ?? null,
      shape: boot.shape,
      // 02 §8：首次使用（未配置模型且未跳过引导）时显示引导
      onboardingOpen: !boot.hasModelProfile && localStorage.getItem(ONBOARDING_KEY) !== "done",
    });
  } catch {
    set({ ready: true, fatal: "auth-failed" });
    return;
  }
  sync = new SyncClient({
    ticket: async () => (await requireApi().createTicket()).ticket,
    cursor: (topic) => (topic.startsWith("doc:") ? (get().doc?.rev ?? 0) : get().session.cursor),
    onMessage: (msg: ServerMessage) => {
      const topic = `session:${get().sessionId}`;
      if (
        (msg.type === "rec" || msg.type === "delta" || msg.type === "snapshot") &&
        msg.topic !== undefined &&
        msg.topic !== topic
      ) {
        return; // 只处理当前会话主题
      }
      if (msg.type === "rec" || msg.type === "delta" || msg.type === "snapshot") {
        set({ session: reduceSession(get().session, msg) });
        if (msg.type === "rec") {
          followAgentActivity(msg.record);
          if (msg.record.type === "user.message" || msg.record.type === "session.updated")
            void refreshSessions().catch(() => undefined);
        }
      } else if (msg.type === "presence") {
        // 只保留当前打开文档的状态；切换文档时旧主题的迟到消息不能污染新视图。
        if (msg.docId === get().doc?.docId) set({ presence: msg.participants });
      } else if (msg.type === "doc.op" && msg.docId === get().doc?.docId) {
        set({ docSync: reduceDoc(get().docSync, msg) });
        const doc = get().doc;
        // ack 前服务端会把本端修订广播回发送者；本端已经乐观应用，按
        // hello 的 connectionId 去重，避免重复执行一次 mutation。
        const own = syncConnectionId !== null && msg.source === `user:${syncConnectionId}`;
        if (doc) {
          set({ doc: { ...doc, rev: Math.max(doc.rev, msg.rev) } });
          const selection = get().selection;
          if (selection?.docId === msg.docId)
            set({ selection: { ...selection, rev: Math.max(selection.rev, msg.rev) } });
        }
        if (!own && editorBridge?.docId === msg.docId) {
          const mutations = asClientMutations(msg.mutations);
          // 分片或连续远端修订串行回放，避免多个 executeCommand 交错。
          editorApplyQueue = editorApplyQueue
            .then(async () => {
              const bridge = editorBridge;
              if (bridge?.docId === msg.docId) await bridge.applyRemote(mutations);
              else if (get().doc?.docId === msg.docId) scheduleDocRefresh(msg.docId);
            })
            .catch(() => {
              // 无法在当前版本逐条回放时回退到权威快照。
              scheduleDocRefresh(msg.docId);
            });
        } else if (!own && !editorBridge) {
          scheduleDocRefresh(msg.docId);
        }
      } else if (msg.type === "doc.ack" || msg.type === "doc.reject") {
        set({ docSync: reduceDoc(get().docSync, msg) });
        if (msg.type === "doc.ack") {
          const doc = get().doc;
          if (doc) {
            set({ doc: { ...doc, rev: Math.max(doc.rev, msg.rev) } });
            const selection = get().selection;
            if (selection?.docId === doc.docId)
              set({ selection: { ...selection, rev: Math.max(selection.rev, msg.rev) } });
          }
        } else {
          // 拒绝时撤销乐观编辑：重新读取服务端快照，不重发断线期间的提交。
          const docId = get().doc?.docId;
          if (docId)
            void reloadDocument(docId).catch(() => set({ referenceError: "invalid-range" }));
        }
      } else if (msg.type === "doc.checkpoint" && msg.docId === get().doc?.docId) {
        const doc = get().doc;
        if (doc)
          set({ doc: { ...doc, checkpointRev: msg.checkpointRev, checkpointError: msg.error } });
      } else if (msg.type === "doc.reload" && msg.docId === get().doc?.docId) {
        set({ docSync: reduceDoc(get().docSync, msg) });
        void reloadDocument(msg.docId).catch(() => set({ referenceError: "invalid-range" }));
      } else if (msg.type === "render.request") {
        // workbook_render 截图（ADR 0010）：本页签作为渲染端
        const requestId = msg.requestId;
        void renderLayoutToPng(msg.layout, msg.scale ?? 2)
          .then((png) => sync?.send({ type: "render.result", requestId, png }))
          .catch((e: unknown) =>
            sync?.send({
              type: "render.result",
              requestId,
              error: e instanceof Error ? e.message : String(e),
            }),
          );
      } else if (msg.type === "app.event") {
        for (const fn of appListeners) fn(msg.data);
        if (
          msg.data.type === "files.changed" &&
          (!msg.data.workspaceId || msg.data.workspaceId === get().workspaceId)
        )
          void refreshFiles();
        if (msg.data.type.startsWith("session.")) void reconcileSessions().catch(() => undefined);
        if (msg.data.type === "workspaces.changed") void refreshWorkspaces().catch(() => undefined);
      } else if (msg.type === "hello") {
        syncConnectionId = msg.connectionId;
        set({ connected: true, presenceConnectionId: msg.connectionId });
        const docId = get().doc?.docId;
        if (docId) schedulePresence(docId);
      }
    },
    onState: (connected) => set(connected ? { connected } : { connected, presence: [] }),
  });
  sync.start();
  sync.subscribe("app");
  // 对话头部的模型选择需要档案列表；失败不阻断启动
  void refreshProfiles().catch(() => undefined);
  await refreshWorkspaces();
  await refreshSessions();
  await openWorkspaceLanding(preferredWorkspaceId(), ++navigationRequest);
  set({ ready: true });
}

function desktopToken(token: string | null): string | null {
  return typeof window !== "undefined" && window.location.protocol === "app:" ? token : null;
}

function asClientMutations(raw: unknown): ClientDocMutation[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (m): m is ClientDocMutation =>
      !!m && typeof m === "object" && typeof (m as { id?: unknown }).id === "string",
  );
}

/** 工作台挂载/卸载当前活文档的 Univer 回放桥。 */
export function registerDocumentEditor(bridge: DocumentEditorBridge | null): void {
  editorBridge = bridge;
  if (bridge === null) editorApplyQueue = Promise.resolve();
}

/** 用户在工作台产生 mutation 后走统一 doc.submit 写入路径。 */
export function submitDocumentMutation(
  docId: string,
  mutation: ClientDocMutation,
): { clientOpId: string; sent: boolean } {
  const st = get();
  if (!st.doc || st.doc.docId !== docId || !sync) {
    return { clientOpId: "", sent: false };
  }
  const clientOpId = `web-doc-${Date.now()}-${++seq}`;
  set({ docSync: trackDocSubmit(get().docSync, clientOpId) });
  const sent = sync.send({
    type: "doc.submit",
    docId,
    clientOpId,
    baseRev: st.docSync.rev,
    mutations: [mutation],
  });
  if (!sent) {
    // 断线编辑不自动重发；标记 rejected 并让调用方保持本地内容，待用户下一次编辑时重试。
    set({
      docSync: {
        ...get().docSync,
        pending: {
          ...get().docSync.pending,
          [clientOpId]: { status: "rejected", conflict: { code: "offline" } },
        },
      },
    });
  }
  return { clientOpId, sent };
}

export async function refreshWorkspaces(): Promise<void> {
  const { items } = await requireApi().listWorkspaces();
  set({ workspaces: items });
  if (get().ready && !items.some((workspace) => workspace.id === get().workspaceId))
    await switchWorkspace(preferredWorkspaceId());
}

function preferredWorkspaceId(): string {
  const state = get();
  const saved = readNavigation().workspaceId;
  return (
    state.workspaces.find((workspace) => workspace.id === saved)?.id ??
    state.workspaces.find((workspace) => workspace.isDefault)?.id ??
    state.workspaces[0]?.id ??
    ""
  );
}

async function openWorkspaceLanding(workspaceId: string, request: number): Promise<void> {
  if (!get().workspaces.some((workspace) => workspace.id === workspaceId))
    throw new Error(S.workspaceSwitchFailed);
  const saved = readNavigation().sessions[workspaceId];
  const recent =
    get().sessions.find((session) => session.workspaceId === workspaceId && session.id === saved) ??
    get().sessions.find((session) => session.workspaceId === workspaceId);
  if (recent) {
    await loadSession(recent.id, request);
    return;
  }
  const { session } = await requireApi().createSession({ workspaceId, reuseBlank: true });
  if (request !== navigationRequest) return;
  await loadSession(session.id, request);
}

async function reconcileSessions(): Promise<void> {
  const request = navigationRequest;
  await refreshSessions();
  if (!get().ready || navigationPending || request !== navigationRequest) return;
  if (get().sessionId && !get().sessions.some((session) => session.id === get().sessionId))
    await openWorkspaceLanding(get().workspaceId, ++navigationRequest);
}

/** 切换工作区：恢复该区上次会话，空区使用真实的可复用空白会话。 */
export async function switchWorkspace(workspaceId: string): Promise<void> {
  const request = ++navigationRequest;
  navigationPending = false;
  if (workspaceId === get().workspaceId) return;
  navigationPending = true;
  try {
    await refreshSessions();
    if (request !== navigationRequest) return;
    await openWorkspaceLanding(workspaceId, request);
  } finally {
    if (request === navigationRequest) navigationPending = false;
  }
}

export async function createSession(targetWorkspaceId?: string): Promise<void> {
  const request = ++navigationRequest;
  navigationPending = true;
  try {
    if (
      targetWorkspaceId !== undefined &&
      !get().workspaces.some((workspace) => workspace.id === targetWorkspaceId)
    )
      throw new Error(S.workspaceSwitchFailed);
    const workspaceId =
      targetWorkspaceId ??
      (get().workspaces.some((workspace) => workspace.id === get().workspaceId)
        ? get().workspaceId
        : preferredWorkspaceId());
    const { session } = await requireApi().createSession(workspaceId ? { workspaceId } : {});
    if (request !== navigationRequest) return;
    await loadSession(session.id, request);
  } finally {
    if (request === navigationRequest) navigationPending = false;
  }
}

export async function removeSession(id: string): Promise<void> {
  await requireApi().deleteSession(id);
  await reconcileSessions();
}

export async function send(text: string, mode?: "steer" | "interrupt" | "queue"): Promise<void> {
  const st = get();
  if (!st.sessionId) return;
  const cmd = text.trim();
  // /model <档案名>：切换当前代理的模型档案（09 §3），不走消息派发
  const modelCmd = /^\/model\s+(.+)$/.exec(cmd);
  if (modelCmd?.[1]) {
    try {
      const res = await requireApi().switchAgentModel(st.sessionId, st.agentId, {
        modelName: modelCmd[1].trim(),
      });
      set({ commandNotice: S.modelSwitched(res.name) });
    } catch (e) {
      set({ commandNotice: e instanceof Error ? e.message : S.commandFailed });
    }
    return;
  }
  // 斜杠命令不走消息派发（02 §3.2）：/compact 压缩上下文，/resume 继续。
  if (cmd === "/compact" || cmd === "/resume") {
    try {
      if (cmd === "/compact") {
        const res = await requireApi().compactAgent(st.sessionId, st.agentId);
        set({
          commandNotice: res.scheduled
            ? S.compactScheduled
            : res.compacted
              ? S.compactDone
              : S.compactNothing,
        });
      } else {
        await requireApi().resumeAgent(st.sessionId, st.agentId);
        set({ commandNotice: null });
      }
    } catch {
      set({ commandNotice: S.commandFailed });
    }
    return;
  }
  set({ commandNotice: null });
  if (st.composerAttachments.some((a) => a.status !== "ready")) {
    throw new Error(S.attachNotReady);
  }
  const ctx = composerContext(st);
  const context = ctx ? [{ docId: ctx.docId, rev: ctx.rev, range: ctx.range }] : undefined;
  const sending = st.composerAttachments.filter((a) => a.status === "ready");
  const attachments = sending.flatMap((a) => (a.ref ? [a.ref] : []));
  const references = sending.flatMap((a) => (a.path ? [`@${a.path}`] : []));
  seq += 1;
  await requireApi().sendMessage(st.sessionId, st.agentId, {
    clientMessageId: `web-${Date.now()}-${seq}`,
    text: [text, ...references].filter(Boolean).join("\n"),
    ...(mode ? { mode } : {}),
    ...(context !== undefined ? { context } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
  });
  // 发送成功才清掉已发出的附件（失败时保留，便于重试）
  const sentIds = new Set(sending.map((a) => a.id));
  for (const a of sending) {
    if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
  }
  set({ composerAttachments: get().composerAttachments.filter((a) => !sentIds.has(a.id)) });
}

const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/;
let attachSeq = 0;

/** 粘贴/拖入/选择的文件：图片进附件，其余上传到工作区并以 @路径 引用（02 §3.3）。 */
export async function addComposerFiles(files: File[]): Promise<void> {
  const { workspaceId, sessionId } = get();
  const pending: { file: File; item: ComposerAttachment; image: boolean }[] = [];
  let imageCount = get().composerAttachments.filter((a) => a.previewUrl).length;
  for (const file of files) {
    const image =
      IMAGE_TYPES.test(file.type) ||
      (file.type === "" && /\.(png|jpe?g|gif|webp)$/i.test(file.name));
    if (image && imageCount >= 8) {
      set({ commandNotice: S.attachLimit });
      continue;
    }
    attachSeq += 1;
    const item: ComposerAttachment = {
      id: `att-${attachSeq}`,
      name: file.name || "unnamed",
      ...(image ? { previewUrl: URL.createObjectURL(file) } : {}),
      status: "uploading",
    };
    if (image) imageCount += 1;
    pending.push({ file, item, image });
  }
  set({ composerAttachments: [...get().composerAttachments, ...pending.map((p) => p.item)] });
  for (const { file, item, image } of pending) {
    if (get().workspaceId !== workspaceId || get().sessionId !== sessionId) return;
    if (!get().composerAttachments.some((a) => a.id === item.id)) continue;
    const patch = (p: Partial<ComposerAttachment>) =>
      set({
        composerAttachments: get().composerAttachments.map((a) =>
          a.id === item.id ? { ...a, ...p } : a,
        ),
      });
    try {
      if (image) {
        const ref = await requireApi().uploadAttachment({ name: item.name, data: file });
        patch({ status: "ready", ref });
      } else {
        const { path } = await requireApi().uploadFile(workspaceId, {
          name: item.name,
          data: file,
        });
        patch({ status: "ready", path });
      }
    } catch (e) {
      patch({ status: "error", error: e instanceof Error ? e.message : S.uploadFailed });
    }
  }
  if (pending.some((p) => !p.image) && get().workspaceId === workspaceId) {
    await refreshFiles().catch(() => undefined);
  }
}

export function removeComposerAttachment(id: string): void {
  const a = get().composerAttachments.find((x) => x.id === id);
  if (a?.previewUrl) URL.revokeObjectURL(a.previewUrl);
  set({ composerAttachments: get().composerAttachments.filter((x) => x.id !== id) });
}

const attachmentUrls = new Map<string, Promise<string>>();
/** 已发送消息中的附件缩略图：带令牌取 blob 转 object URL（同一附件只取一次）。 */
export function attachmentUrl(sha256: string): Promise<string> {
  let p = attachmentUrls.get(sha256);
  if (!p) {
    p = requireApi()
      .getAttachment(sha256)
      .then((b) => URL.createObjectURL(b));
    attachmentUrls.set(sha256, p);
    p.catch(() => attachmentUrls.delete(sha256));
  }
  return p;
}

/** 会话改名（对齐清单 C6）。 */
export async function renameSession(title: string): Promise<void> {
  const st = get();
  if (!st.sessionId || title.trim() === "") return;
  await requireApi().updateSession(st.sessionId, { title: title.trim() });
  await refreshSessions();
}

/** 从会话列表直接改名；列表操作不必先切换当前会话。 */
export async function renameSessionById(id: string, title: string): Promise<void> {
  const next = title.trim();
  if (next === "") return;
  await requireApi().updateSession(id, { title: next });
  await refreshSessions();
}

/** 导出会话 Markdown，并交给浏览器下载。 */
export async function exportSession(id: string, title: string | null): Promise<void> {
  const blob = await requireApi().exportSession(id);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const safeTitle = (title?.trim() || "未命名会话").replace(/[\\/:*?"<>|]+/g, "_");
  anchor.href = url;
  anchor.download = `${safeTitle}.md`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** 本会话权限模式覆盖（04 §5：全局默认之上的会话级覆盖）。 */
export async function setSessionPermission(mode: "confirm" | "standard" | "auto"): Promise<void> {
  const st = get();
  if (!st.sessionId) return;
  await requireApi().updateSession(st.sessionId, { permissionMode: mode });
  set({ session: { ...get().session, permissionMode: mode } });
  await refreshSessions();
}

/** 切换当前代理的模型档案（与 /model 同一接口，09 §3）。 */
export async function switchModel(modelProfileId: string): Promise<void> {
  const st = get();
  if (!st.sessionId) return;
  const res = await requireApi().switchAgentModel(st.sessionId, st.agentId, { modelProfileId });
  set({ commandNotice: S.modelSwitched(res.name) });
}

/** 立即压缩当前代理上下文（与 /compact 同一接口，04 §6）。 */
export async function compactNow(): Promise<void> {
  await send("/compact");
}

/** 撤销代理保存的记忆（12 §2.2）：删除记忆，界面标记为已撤销。 */
export async function undoMemory(memoryId: string): Promise<void> {
  await requireApi().deleteMemory(memoryId);
  set({
    session: {
      ...get().session,
      messages: get().session.messages.map((m) =>
        m.memory?.memoryId === memoryId ? { ...m, memory: { ...m.memory, deleted: true } } : m,
      ),
    },
  });
}

export async function stopAgent(): Promise<void> {
  const st = get();
  if (!st.sessionId) return;
  await requireApi().stopAgent(st.sessionId, st.agentId);
}

/** 撤回未应用的派发；成功后由调用方把原文放回输入框。 */
export async function cancelDispatch(dispatchId: string): Promise<void> {
  const st = get();
  if (!st.sessionId) return;
  await requireApi().cancelDispatch(st.sessionId, dispatchId);
}

/** 继续：恢复停止后挂起的排队派发，或对 interrupted 代理开一轮续跑。 */
export async function resumeAgent(): Promise<void> {
  const st = get();
  if (!st.sessionId) return;
  await requireApi().resumeAgent(st.sessionId, st.agentId);
}

/** 切换对话面板查看的代理（02 §5 团队视图）。 */
export function selectAgent(agentId: string): void {
  set({ agentId });
}

/** 用户控制任意代理（05 §11）：pause/resume/close。 */
export async function controlAgent(
  agentId: string,
  action: "pause" | "resume" | "close",
): Promise<void> {
  const st = get();
  if (!st.sessionId) return;
  await requireApi().controlAgent(st.sessionId, agentId, { action });
}

/** 停止全部运行中代理（11 §147）。 */
export async function stopAllAgents(): Promise<void> {
  const st = get();
  if (!st.sessionId) return;
  await requireApi().stopAll(st.sessionId);
}

/** 重启中断横幅的「全部继续」：逐个恢复 interrupted 代理。 */
export async function resumeInterruptedAgents(): Promise<void> {
  const st = get();
  if (!st.sessionId) return;
  const ids = Object.values(st.session.roster)
    .filter((a) => a.status === "interrupted")
    .map((a) => a.id);
  for (const agentId of ids) {
    await requireApi().controlAgent(st.sessionId, agentId, { action: "resume" });
  }
}

export async function decideApproval(
  approvalId: string,
  decision: "approve" | "deny",
  reason?: string,
  remember = false,
): Promise<void> {
  const response = await requireApi().decideApproval(approvalId, {
    decision,
    ...(reason !== undefined && reason !== "" ? { reason } : {}),
    ...(remember ? { remember: true } : {}),
  });
  const approval = response.approval;
  set({
    session: {
      ...get().session,
      approvals: get().session.approvals.map((item) =>
        item.approvalId === approval.id
          ? {
              ...item,
              status: approval.status,
              ...(approval.decision !== undefined ? { decision: approval.decision } : {}),
              ...(approval.reason !== undefined && approval.reason !== null
                ? { reason: approval.reason }
                : {}),
            }
          : item,
      ),
    },
  });
}

export async function answerQuestion(
  questionId: string,
  answer: unknown,
  rev?: number,
): Promise<void> {
  await requireApi().answerQuestion(questionId, {
    answer,
    ...(rev !== undefined ? { rev } : {}),
  });
  set({
    session: {
      ...get().session,
      questions: get().session.questions.map((item) =>
        item.questionId === questionId
          ? { ...item, status: "answered", answer, ...(rev !== undefined ? { rev } : {}) }
          : item,
      ),
    },
  });
}

export async function openWorkspaceFile(path: string): Promise<void> {
  const request = ++docRequest;
  const st = get();
  clearPresenceTimer();
  const { document: opened } = await requireApi().openDoc(st.workspaceId, { path });
  const { document, snapshot } = await requireApi().getDocSnapshot(st.workspaceId, opened.id);
  if (request !== docRequest || get().workspaceId !== st.workspaceId) return;
  set({
    doc: {
      docId: document.id,
      rev: document.rev,
      snapshotRev: document.rev,
      checkpointRev: document.checkpointRev,
      checkpointError: document.checkpointError,
      path: document.path,
      snapshot: snapshot as Record<string, unknown>,
    },
    docSync: initialDocSync(document.rev),
    selection: null,
    presence: [],
    rangeFocus: null,
    rangePreview: null,
    referenceError: null,
  });
  sync?.subscribe(`doc:${document.id}`);
  schedulePresence(document.id);
}

const docRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** 远端修订到达后防抖重取快照（只读视图下 mutation 不便直接应用）。 */
function scheduleDocRefresh(docId: string): void {
  const prev = docRefreshTimers.get(docId);
  if (prev) clearTimeout(prev);
  docRefreshTimers.set(
    docId,
    setTimeout(() => {
      docRefreshTimers.delete(docId);
      if (get().doc?.docId !== docId) return;
      void reloadDocument(docId).catch(() => set({ referenceError: "invalid-range" }));
    }, 150),
  );
}

/** 重新读取服务端权威快照；不会自动清除冲突提示，交由用户确认。 */
export async function reloadDocument(docId: string): Promise<void> {
  const request = ++docRequest;
  const workspaceId = get().workspaceId;
  clearPresenceTimer();
  const { document, snapshot } = await requireApi().getDocSnapshot(workspaceId, docId);
  if (request !== docRequest || get().doc?.docId !== docId || get().workspaceId !== workspaceId)
    return;
  if (document.rev < (get().doc?.rev ?? 0)) {
    scheduleDocRefresh(docId);
    return;
  }
  set({
    doc: {
      docId,
      rev: document.rev,
      snapshotRev: document.rev,
      ...(document.checkpointRev !== undefined ? { checkpointRev: document.checkpointRev } : {}),
      ...(document.checkpointError !== undefined
        ? { checkpointError: document.checkpointError }
        : {}),
      path: document.path,
      snapshot: snapshot as Record<string, unknown>,
    },
    docSync: { ...get().docSync, rev: Math.max(get().docSync.rev, document.rev) },
    selection: null,
    presence: [],
  });
  schedulePresence(docId);
}

/** 关闭一条已处理的提交冲突提示，不会重发原 mutation。 */
export function dismissDocConflict(clientOpId: string): void {
  const state = get().docSync;
  const item = state.pending[clientOpId];
  if (!item || item.status !== "rejected") return;
  const pending = { ...state.pending };
  delete pending[clientOpId];
  set({ docSync: { ...state, pending } });
}

export async function openDocument(docId: string): Promise<void> {
  const request = ++docRequest;
  const workspaceId = get().workspaceId;
  clearPresenceTimer();
  const { document, snapshot } = await requireApi().getDocSnapshot(workspaceId, docId);
  if (request !== docRequest || get().workspaceId !== workspaceId) return;
  set({
    doc: {
      docId,
      rev: document.rev,
      snapshotRev: document.rev,
      path: document.path,
      snapshot: snapshot as Record<string, unknown>,
    },
    docSync: initialDocSync(document.rev),
    selection: null,
    presence: [],
    rangeFocus: null,
    rangePreview: null,
  });
  sync?.subscribe(`doc:${docId}`);
  schedulePresence(docId);
}

export async function focusRange(range: string, docId?: string): Promise<void> {
  try {
    if (!docId && !get().doc) {
      const ids = [...new Set(get().session.tools.flatMap((t) => (t.docId ? [t.docId] : [])))];
      if (ids.length === 1) docId = ids[0];
    }
    if (docId && get().doc?.docId !== docId) await openDocument(docId);
    const doc = get().doc;
    if (docId && doc?.docId !== docId) return;
    if (!doc) {
      set({ referenceError: "no-document" });
      return;
    }
    const parsed = parseRange(range);
    const sheets = doc.snapshot.sheets as Record<string, { name: string }>;
    if (parsed.sheet && !Object.values(sheets).some((s) => s.name === parsed.sheet)) {
      set({ referenceError: "missing-sheet" });
      return;
    }
    set({ rangeFocus: { range, nonce: Date.now() }, referenceError: null });
  } catch {
    set({ referenceError: "invalid-range" });
  }
}

/** 关闭工作台中的工作簿（只退订与清空本地视图；服务端活文档不受影响）。 */
export function closeDocument(): void {
  const doc = get().doc;
  if (!doc) return;
  clearPresenceTimer();
  sync?.unsubscribe(`doc:${doc.docId}`);
  docRequest += 1;
  set({
    doc: null,
    selection: null,
    presence: [],
    pinnedSelection: null,
    rangeFocus: null,
    rangePreview: null,
    docSync: initialDocSync(0),
  });
}

export function previewRange(range: string | null): void {
  set({ rangePreview: range });
}

export async function uploadWorkspaceFile(file: File): Promise<void> {
  await uploadWorkspaceFileReturningPath(file);
}

async function uploadWorkspaceFileReturningPath(file: File): Promise<string> {
  const { path } = await requireApi().uploadFile(get().workspaceId, {
    name: file.name,
    data: file,
  });
  await refreshFiles();
  return path;
}

export function setSelection(range: string | null): void {
  const d = get().doc;
  if (!d || range === null) {
    set({ selection: null });
    if (d) schedulePresence(d.docId);
    return;
  }
  set({ selection: { docId: d.docId, rev: d.rev, range }, selectionDismissed: false });
  schedulePresence(d.docId);
}

export async function refreshProfiles(): Promise<void> {
  const [profiles, providers] = await Promise.all([
    requireApi().listModelProfiles(),
    requireApi().listProviders(),
  ]);
  set({
    profiles: profiles.items,
    providers: providers.items,
    hasModelProfile: profiles.items.length > 0,
  });
}

const ONBOARDING_KEY = "excelmanus.onboarding";

export function setOnboardingOpen(open: boolean): void {
  if (!open) localStorage.setItem(ONBOARDING_KEY, "done");
  set({ onboardingOpen: open });
}

/** 引导第 3 步：把内置示例复制进当前工作区并在工作台打开。 */
export async function openSample(): Promise<string> {
  const api = requireApi();
  const { items } = await api.listSamples();
  const name = items.find((n) => n.endsWith(".xlsx")) ?? items[0];
  if (!name) throw new Error("没有内置示例");
  const { path } = await api.addSample(get().workspaceId, name);
  await refreshFiles();
  await openWorkspaceFile(path);
  return path;
}

export function setSettingsOpen(open: boolean, tab?: string): void {
  set({ settingsOpen: open, ...(tab ? { settingsTab: tab } : {}) });
  if (open) void refreshProfiles();
}

export async function createProfile(body: {
  name: string;
  provider: string;
  model: string;
  baseUrl?: string;
  apiKey: string;
}): Promise<void> {
  await requireApi().createModelProfile(body);
  await refreshProfiles();
  set({ hasModelProfile: true });
}

export async function setDefaultProfile(id: string): Promise<void> {
  await requireApi().setDefaultModelProfile(id);
  await refreshProfiles();
}

export async function testProfile(id: string): Promise<{ ok: boolean; message?: string }> {
  const r = await requireApi().testModelProfile(id);
  return { ok: r.ok, ...(r.error?.message !== undefined ? { message: r.error.message } : {}) };
}

export async function deleteProfile(id: string): Promise<void> {
  await requireApi().deleteModelProfile(id);
  await refreshProfiles();
  set({ hasModelProfile: get().profiles.length > 0 });
}
