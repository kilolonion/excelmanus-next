// 全局状态（Zustand）：令牌、会话列表、当前会话还原状态、工作台文档、设置弹窗。

import { parseRange } from "@excelmanus/core";
import type {
  AgentInfo,
  FileEntry,
  ModelProfile,
  ProviderPreset,
  ServerMessage,
  SessionSummary,
} from "@excelmanus/protocol";
import { create } from "zustand";
import { apiClient, bootstrapToken } from "./api.ts";
import {
  type DocSyncState,
  initialDocSync,
  initialSessionState,
  reduceDoc,
  reduceSession,
  type SessionState,
  trackDocSubmit,
} from "./reduce.ts";
import { S } from "./strings.ts";
import { SyncClient } from "./ws.ts";

export interface OpenDoc {
  docId: string;
  rev: number;
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
  agents: AgentInfo[];
  sessionId: string | null;
  agentId: string;
  session: SessionState;
  files: FileEntry[];
  doc: OpenDoc | null;
  docSync: DocSyncState;
  selection: { docId: string; rev: number; range: string } | null;
  settingsOpen: boolean;
  providers: ProviderPreset[];
  profiles: ModelProfile[];
  fatal: string | null;
  rangeFocus: { range: string; nonce: number } | null;
  rangePreview: string | null;
  referenceError: string | null;
  /** /compact 等斜杠命令的短提示（下一次发送时清除）。 */
  commandNotice: string | null;
}

type Api = ReturnType<typeof apiClient>;

let api: Api | null = null;
let sync: SyncClient | null = null;
let seq = 0;
let docRequest = 0;
let syncConnectionId: string | null = null;
let editorBridge: DocumentEditorBridge | null = null;
let editorApplyQueue: Promise<void> = Promise.resolve();

export const useApp = create<AppState>(() => ({
  token: null,
  ready: false,
  connected: false,
  workspaceId: "",
  hasModelProfile: false,
  sessions: [],
  agents: [],
  sessionId: null,
  agentId: "main",
  session: initialSessionState(),
  files: [],
  doc: null,
  docSync: initialDocSync(),
  selection: null,
  settingsOpen: false,
  providers: [],
  profiles: [],
  fatal: null,
  rangeFocus: null,
  rangePreview: null,
  referenceError: null,
  commandNotice: null,
}));

const set = useApp.setState;
const get = useApp.getState;

function requireApi(): Api {
  if (!api) throw new Error("API 未初始化");
  return api;
}

async function refreshSessions(): Promise<void> {
  const { items } = await requireApi().listSessions();
  set({ sessions: items });
}

async function refreshFiles(): Promise<void> {
  const st = get();
  if (st.workspaceId === "") return;
  try {
    const res = await requireApi().listFiles(st.workspaceId, "");
    set({ files: res.items });
  } catch {
    // 文件列表失败不阻塞
  }
}

export async function selectSession(sessionId: string): Promise<void> {
  const workspaceId = get().sessions.find((session) => session.id === sessionId)?.workspaceId;
  if (workspaceId && workspaceId !== get().workspaceId) {
    const previous = get().doc;
    if (previous) sync?.unsubscribe(`doc:${previous.docId}`);
    docRequest += 1;
    set({
      workspaceId,
      doc: null,
      selection: null,
      files: [],
      rangeFocus: null,
      rangePreview: null,
      docSync: initialDocSync(0),
    });
    await refreshFiles();
  }
  const detail = await requireApi().getSession(sessionId);
  set({ sessionId: sessionId, session: initialSessionState(), agents: detail.agents });
  sync?.subscribe(`session:${sessionId}`);
}

let initPromise: Promise<void> | null = null;
export function init(): Promise<void> {
  initPromise ??= initialize();
  return initPromise;
}

async function initialize(): Promise<void> {
  const token = bootstrapToken();
  if (!token) {
    set({ ready: true, fatal: "no-token" });
    return;
  }
  api = apiClient(token);
  set({ token });
  try {
    const boot = await api.bootstrap();
    set({ hasModelProfile: boot.hasModelProfile });
  } catch (e) {
    set({ ready: true, fatal: e instanceof Error ? e.message : "bootstrap failed" });
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
      } else if (msg.type === "hello") {
        syncConnectionId = msg.connectionId;
        set({ connected: true });
      }
    },
    onState: (connected) => set({ connected }),
  });
  sync.start();
  await refreshSessions();
  const first = get().sessions[0];
  if (first) {
    set({ workspaceId: first.workspaceId });
    await selectSession(first.id);
  } else {
    const { session } = await requireApi().createSession({});
    await refreshSessions();
    set({ workspaceId: session.workspaceId });
    await selectSession(session.id);
  }
  await refreshFiles();
  set({ ready: true });
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

export async function createSession(): Promise<void> {
  const { session } = await requireApi().createSession({});
  await refreshSessions();
  set({ workspaceId: session.workspaceId });
  await selectSession(session.id);
}

export async function removeSession(id: string): Promise<void> {
  await requireApi().deleteSession(id);
  await refreshSessions();
  if (get().sessionId === id) {
    const first = get().sessions[0];
    if (first) await selectSession(first.id);
    else set({ sessionId: null, session: initialSessionState() });
  }
}

export async function send(
  text: string,
  mode: "steer" | "interrupt" | "queue" = "steer",
): Promise<void> {
  const st = get();
  if (!st.sessionId) return;
  const cmd = text.trim();
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
  const context = st.selection
    ? [{ docId: st.selection.docId, rev: st.selection.rev, range: st.selection.range }]
    : undefined;
  seq += 1;
  await requireApi().sendMessage(st.sessionId, st.agentId, {
    clientMessageId: `web-${Date.now()}-${seq}`,
    text,
    mode,
    ...(context !== undefined ? { context } : {}),
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
  const { document: opened } = await requireApi().openDoc(st.workspaceId, { path });
  const { document, snapshot } = await requireApi().getDocSnapshot(st.workspaceId, opened.id);
  if (request !== docRequest || get().workspaceId !== st.workspaceId) return;
  set({
    doc: {
      docId: document.id,
      rev: document.rev,
      checkpointRev: document.checkpointRev,
      checkpointError: document.checkpointError,
      path: document.path,
      snapshot: snapshot as Record<string, unknown>,
    },
    docSync: initialDocSync(document.rev),
    selection: null,
    rangeFocus: null,
    rangePreview: null,
    referenceError: null,
  });
  sync?.subscribe(`doc:${document.id}`);
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
      void reloadDocument(docId).catch(() => set({ referenceError: "invalid-range" }));
    }, 150),
  );
}

async function reloadDocument(docId: string): Promise<void> {
  const request = ++docRequest;
  const workspaceId = get().workspaceId;
  const { document, snapshot } = await requireApi().getDocSnapshot(workspaceId, docId);
  if (request !== docRequest || get().doc?.docId !== docId || get().workspaceId !== workspaceId)
    return;
  set({
    doc: {
      docId,
      rev: document.rev,
      path: document.path,
      snapshot: snapshot as Record<string, unknown>,
    },
    docSync: { ...get().docSync, rev: Math.max(get().docSync.rev, document.rev) },
    selection: null,
  });
}

export async function openDocument(docId: string): Promise<void> {
  const request = ++docRequest;
  const workspaceId = get().workspaceId;
  const { document, snapshot } = await requireApi().getDocSnapshot(workspaceId, docId);
  if (request !== docRequest || get().workspaceId !== workspaceId) return;
  set({
    doc: {
      docId,
      rev: document.rev,
      path: document.path,
      snapshot: snapshot as Record<string, unknown>,
    },
    docSync: initialDocSync(document.rev),
    selection: null,
    rangeFocus: null,
    rangePreview: null,
  });
  sync?.subscribe(`doc:${docId}`);
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

export function previewRange(range: string | null): void {
  set({ rangePreview: range });
}

export async function uploadWorkspaceFile(file: File): Promise<void> {
  await requireApi().uploadFile(get().workspaceId, { name: file.name, data: file });
  await refreshFiles();
}

export function setSelection(range: string | null): void {
  const d = get().doc;
  if (!d || range === null) {
    set({ selection: null });
    return;
  }
  set({ selection: { docId: d.docId, rev: d.rev, range } });
}

export async function refreshProfiles(): Promise<void> {
  const [profiles, providers] = await Promise.all([
    requireApi().listModelProfiles(),
    requireApi().listProviders(),
  ]);
  set({ profiles: profiles.items, providers: providers.items });
}

export function setSettingsOpen(open: boolean): void {
  set({ settingsOpen: open });
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
