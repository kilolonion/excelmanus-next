// 全局状态（Zustand）：令牌、会话列表、当前会话还原状态、工作台文档、设置弹窗。

import type {
  FileEntry,
  ModelProfile,
  ProviderPreset,
  ServerMessage,
  SessionSummary,
} from "@excelmanus/protocol";
import { create } from "zustand";
import { apiClient, bootstrapToken } from "./api.ts";
import { initialSessionState, reduceSession, type SessionState } from "./reduce.ts";
import { SyncClient } from "./ws.ts";

export interface OpenDoc {
  docId: string;
  rev: number;
  path: string;
  snapshot: Record<string, unknown>;
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
  selection: { docId: string; rev: number; range: string } | null;
  settingsOpen: boolean;
  providers: ProviderPreset[];
  profiles: ModelProfile[];
  fatal: string | null;
}

type Api = ReturnType<typeof apiClient>;

let api: Api | null = null;
let sync: SyncClient | null = null;
let seq = 0;

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
  selection: null,
  settingsOpen: false,
  providers: [],
  profiles: [],
  fatal: null,
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
  set({ sessionId: sessionId, session: initialSessionState() });
  sync?.subscribe(`session:${sessionId}`);
}

export async function init(): Promise<void> {
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
    cursor: () => get().session.cursor,
    onMessage: (msg: ServerMessage) => {
      const topic = `session:${get().sessionId}`;
      if (
        (msg.type === "rec" || msg.type === "delta" || msg.type === "snapshot") &&
        msg.topic !== undefined &&
        msg.topic !== topic
      ) {
        return; // 只处理当前会话主题
      }
      if (msg.type === "rec" || msg.type === "delta") {
        set({ session: reduceSession(get().session, msg) });
      } else if (msg.type === "hello") {
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

export async function send(text: string): Promise<void> {
  const st = get();
  if (!st.sessionId) return;
  const context = st.selection
    ? [{ docId: st.selection.docId, rev: st.selection.rev, range: st.selection.range }]
    : undefined;
  seq += 1;
  await requireApi().sendMessage(st.sessionId, st.agentId, {
    clientMessageId: `web-${Date.now()}-${seq}`,
    text,
    ...(context !== undefined ? { context } : {}),
  });
}

export async function stopAgent(): Promise<void> {
  const st = get();
  if (!st.sessionId) return;
  await requireApi().stopAgent(st.sessionId, st.agentId);
}

export async function openWorkspaceFile(path: string): Promise<void> {
  const st = get();
  const { document } = await requireApi().openDoc(st.workspaceId, { path });
  const { snapshot } = await requireApi().getDocSnapshot(st.workspaceId, document.id);
  set({
    doc: {
      docId: document.id,
      rev: document.rev,
      path: document.path,
      snapshot: snapshot as Record<string, unknown>,
    },
    selection: null,
  });
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
