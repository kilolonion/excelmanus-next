import { confirmAction } from "@/components/ui/confirm-dialog";
import { toast } from "@/components/ui/toaster";
import { isLegacySpreadsheetFile } from "@/lib/file-kind";
import { loadWorkbookSurface } from "@/lib/workbook/load-surface";
// 工作台：打开的工作簿标签、当前活文档（快照 + 修订）与同步状态、选区/在场/定位、跟随代理。
// 活文档语义（03 §3.2）：文档 actor 是唯一写入者；用户编辑以 Univer mutation 经 doc.submit
// 提交（baseRev + 冲突检测），远端修订以 doc.op 广播，本端在 Univer 中逐条回放。

import { parseRange } from "@excelmanus/core";
import type { ApiClient, DocKind, PresenceParticipant, ServerMessage } from "@excelmanus/protocol";
import { create } from "zustand";
import { api, errorMessage } from "@/lib/backend/api";
import {
  onConnection,
  onSync,
  sendSync,
  subscribeTopic,
  syncConnectionId,
  unsubscribeTopic,
} from "@/lib/backend/channel";
import {
  type DocMutation,
  type DocSyncState,
  dropPending,
  initialDocSync,
  markDisconnected,
  markOffline,
  reduceDoc,
  type SubmittedMutation,
  trackDocSubmit,
} from "@/lib/workbook/doc-sync";
import {
  type CellDraft,
  decodeRecovery,
  encodeRecovery,
  recoveryKey,
} from "@/lib/workbook/recovery";
import { createRecoveryStorage } from "@/lib/workbook/recovery-storage";

const recoveryStorage = createRecoveryStorage();

import { parseSavedTabs } from "@/lib/workbook/saved-tabs";
import { onAppEvent } from "@/stores/app-store";
import { useChatStore } from "@/stores/chat-store";
import { loadDir } from "@/stores/files-store";
import { useSessionStore } from "@/stores/session-store";
import { useUIStore } from "./ui-store";

export interface OpenDoc {
  docId: string;
  path: string;
  kind: DocKind;
  rev: number;
  /** 当前快照对应的修订；落后于 rev 时需要重新读取。 */
  snapshotRev: number;
  snapshot: Record<string, unknown>;
  checkpointRev?: number;
  checkpointError?: string;
  /** 文件在外部被修改且应用中有未写回修订：写回暂停，等用户二选一（07 §5）。 */
  externalConflict?: boolean;
}

export interface WorkbookTab {
  path: string;
  docId?: string;
}

/** 正在输入的单元格被对方改写时留下的草稿（02 §4.7），等用户选择保留谁的。 */
export interface DraftConflict {
  docId: string;
  sheetId: string;
  row: number;
  col: number;
  text: string;
  theirs: unknown;
  source: string;
}

export interface SelectionRef {
  docId: string;
  rev: number;
  range: string;
  /** 仅用于输入框显示；发送时仍使用 docId / rev / range 契约。 */
  path?: string;
}

/** 代理请用户在表格里确认或选择区域（range_confirm / range_pick 提问）。 */
export interface RangeQuestion {
  questionId: string;
  mode: "confirm" | "pick";
  prompt: string;
  docId?: string;
  path?: string;
  /** 代理建议的区域（确认题型必有）。 */
  suggested?: string;
}

/** 工作台挂载的 Univer 回放桥：逐条在当前实例中执行远端 mutation。 */
export interface DocumentEditorBridge {
  docId: string;
  applyRemote(mutations: DocMutation[], source: string): Promise<void>;
}

interface WorkbookState {
  workspaceId: string | null;
  tabs: WorkbookTab[];
  activePath: string | null;
  doc: OpenDoc | null;
  loading: boolean;
  loadError: string | null;
  docSync: DocSyncState;
  draftConflict: DraftConflict | null;
  inputDraft: (CellDraft & { docId: string }) | null;
  recoveredDrafts: DraftConflict[];
  selection: SelectionRef | null;
  /** 输入框上方的区域徽标：钉住后不随选区变化；移除后直到选区变化前不附带。 */
  pinnedSelection: SelectionRef | null;
  selectionDismissed: boolean;
  presence: PresenceParticipant[];
  rangeFocus: { range: string; nonce: number } | null;
  rangePreview: string | null;
  referenceError: string | null;
  /** 跟随代理（02 §4.8）：主代理用工作簿工具时自动打开并定位。 */
  followAgent: boolean;
  /** 用户清除高亮时的会话游标；之后的新变更继续高亮。 */
  changesSeenSeq: number;
  panelOpen: boolean;
  fullView: boolean;
  /** 正在表格里回答的区域提问。 */
  rangeQuestion: RangeQuestion | null;
}

const FOLLOW_KEY = "excelmanus.followAgent";

function readFollow(): boolean {
  try {
    return localStorage.getItem(FOLLOW_KEY) !== "0";
  } catch {
    return true;
  }
}

export const useWorkbookStore = create<WorkbookState>()(() => ({
  workspaceId: null,
  tabs: [],
  activePath: null,
  doc: null,
  loading: false,
  loadError: null,
  docSync: initialDocSync(),
  draftConflict: null,
  inputDraft: null,
  recoveredDrafts: [],
  selection: null,
  pinnedSelection: null,
  selectionDismissed: false,
  presence: [],
  rangeFocus: null,
  rangePreview: null,
  referenceError: null,
  followAgent: readFollow(),
  changesSeenSeq: 0,
  panelOpen: false,
  fullView: false,
  rangeQuestion: null,
}));

const set = useWorkbookStore.setState;
const get = useWorkbookStore.getState;

let docRequest = 0;
// Navigation intent is separate from background snapshot refreshes.
let openRequest = 0;
let opSeq = 0;
let editor: DocumentEditorBridge | null = null;
let applyQueue: Promise<void> = Promise.resolve();
let presenceTimer: ReturnType<typeof setTimeout> | null = null;
const reloadOnAck = new Set<string>();
const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
let lastManualView = 0;

const docTopic = (docId: string) => `doc:${docId}`;
const samePath = (a: string, b: string) => a.replace(/^\.\//, "") === b.replace(/^\.\//, "");

function resetDocView(): Partial<WorkbookState> {
  return {
    doc: null,
    loading: false,
    loadError: null,
    docSync: initialDocSync(),
    draftConflict: null,
    inputDraft: null,
    recoveredDrafts: [],
    selection: null,
    pinnedSelection: null,
    selectionDismissed: get().selectionDismissed,
    presence: [],
    rangeFocus: null,
    rangePreview: null,
    referenceError: null,
  };
}

function leaveDoc(): void {
  const doc = get().doc;
  if (presenceTimer) clearTimeout(presenceTimer);
  presenceTimer = null;
  if (doc) unsubscribeTopic(docTopic(doc.docId));
  docRequest += 1;
}

// ---------- 打开 / 标签 ----------

function requireWorkspace(): string {
  const id = get().workspaceId ?? useSessionStore.getState().activeWorkspaceId;
  if (!id) throw new Error("没有可用的工作区");
  return id;
}

async function loadDoc(
  path: string,
  lookup?: Awaited<ReturnType<ApiClient["getDocSnapshot"]>>,
): Promise<OpenDoc | null> {
  const request = ++docRequest;
  const workspaceId = requireWorkspace();
  set({
    ...resetDocView(),
    pinnedSelection: get().pinnedSelection,
    loading: true,
    activePath: path,
  });
  try {
    const opened = (await api().openDoc(workspaceId, { path })).document;
    if (request !== docRequest || get().workspaceId !== workspaceId) return null;
    // The ID lookup already downloaded a full snapshot. Reuse it only if still current.
    const { document, snapshot } =
      lookup && lookup.document.id === opened.id && lookup.document.rev === opened.rev
        ? { document: opened, snapshot: lookup.snapshot }
        : await api().getDocSnapshot(workspaceId, opened.id);
    if (request !== docRequest || get().workspaceId !== workspaceId) return null;
    const doc: OpenDoc = {
      docId: document.id,
      path: document.path,
      kind: document.kind,
      rev: document.rev,
      snapshotRev: document.rev,
      snapshot: snapshot as Record<string, unknown>,
      ...(document.checkpointRev !== undefined ? { checkpointRev: document.checkpointRev } : {}),
      ...(document.checkpointError !== undefined
        ? { checkpointError: document.checkpointError }
        : {}),
      ...(document.externalConflict ? { externalConflict: true } : {}),
    };
    let recovery: ReturnType<typeof decodeRecovery> = null;
    try {
      recovery = decodeRecovery(
        recoveryStorage.read(recoveryKey(workspaceId, document.id)),
        document.rev,
      );
    } catch {
      /* Storage unavailable. */
    }
    set((s) => ({
      doc,
      loading: false,
      activePath: document.path,
      docSync: recovery?.docSync ?? initialDocSync(document.rev),
      recoveredDrafts: (recovery?.drafts ?? []).map((d) => ({
        ...d,
        docId: document.id,
        theirs: undefined,
        source: "recovery",
      })),
      tabs: s.tabs.map((t) =>
        samePath(t.path, path) ? { path: document.path, docId: document.id } : t,
      ),
    }));
    subscribeTopic(docTopic(doc.docId), () => get().doc?.rev ?? 0);
    schedulePresence(doc.docId);
    // 打开也会更新最近使用时间，刷新所在目录，不必等文件内容变化。
    void loadDir(document.path.split("/").slice(0, -1).join("/"));
    return doc;
  } catch (error) {
    if (request === docRequest)
      set({ loading: false, loadError: errorMessage(error, "工作簿打开失败") });
    return null;
  }
}

/** 文件移动只换路径，保留活文档实例、修订与选区。 */
export function relocateWorkbook(from: string, to: string): void {
  const movedPath = (path: string) =>
    samePath(path, from) ? to : path.startsWith(`${from}/`) ? to + path.slice(from.length) : path;
  set((s) => ({
    tabs: s.tabs.map((tab) => ({ ...tab, path: movedPath(tab.path) })),
    activePath: s.activePath ? movedPath(s.activePath) : null,
    doc: s.doc ? { ...s.doc, path: movedPath(s.doc.path) } : null,
    ...(s.selection?.path
      ? { selection: { ...s.selection, path: movedPath(s.selection.path) } }
      : {}),
    ...(s.pinnedSelection?.path
      ? { pinnedSelection: { ...s.pinnedSelection, path: movedPath(s.pinnedSelection.path) } }
      : {}),
  }));
}

onAppEvent((event) => {
  if (event.type !== "files.changed" || event.workspaceId !== get().workspaceId) return;
  const moved = event.moved as { from?: unknown; to?: unknown } | undefined;
  if (typeof moved?.from === "string" && typeof moved.to === "string")
    relocateWorkbook(moved.from, moved.to);
  if (Array.isArray(event.moves))
    for (const move of event.moves) {
      if (
        move &&
        typeof move === "object" &&
        typeof move.from === "string" &&
        typeof move.to === "string"
      )
        relocateWorkbook(move.from, move.to);
    }
});

/** 在工作台打开一个工作区文件（标签不存在则新增），默认打开侧边面板。 */
export async function openWorkbook(
  path: string,
  opts: { focus?: string; full?: boolean; isCurrent?: () => boolean } = {},
): Promise<boolean> {
  if (opts.isCurrent?.() === false) return false;
  const request = ++openRequest;
  if (isLegacySpreadsheetFile(path)) {
    const workspaceId = requireWorkspace();
    const isCurrent = () =>
      request === openRequest && get().workspaceId === workspaceId && opts.isCurrent?.() !== false;
    if (
      !(await confirmAction({
        title: "导入旧格式工作簿",
        description:
          "将生成新的 .xlsx，原文件保持不变。保留可解析的值、公式、数字格式、合并区域和行列尺寸；字体、图表、图片、宏及高级对象可能丢失，请核对转换结果。",
        confirmLabel: "导入为新 .xlsx",
      }))
    )
      return false;
    if (!isCurrent()) return false;
    const destination = path.replace(/\.(xls|xlsb)$/i, `-导入-${Date.now()}.xlsx`);
    try {
      const result = await api().importLegacy(workspaceId, { source: path, destination });
      if (!isCurrent()) return false;
      toast({ title: "已导入新工作簿", description: result.warnings.join(" "), durationMs: 20000 });
      path = result.path;
      await loadDir("");
      if (!isCurrent()) return false;
    } catch (error) {
      if (!isCurrent()) return false;
      toast({ title: "导入失败", description: errorMessage(error), tone: "error" });
      throw error;
    }
  }
  noteManualView();
  const current = get().doc;
  set((s) => ({
    panelOpen: true,
    ...(opts.full !== undefined ? { fullView: opts.full } : {}),
    tabs: s.tabs.some((t) => samePath(t.path, path)) ? s.tabs : [...s.tabs, { path }],
  }));
  if (current && samePath(current.path, path)) {
    set({ activePath: current.path });
  } else {
    leaveDoc();
    if (!(await loadDoc(path))) return false;
  }
  if (request === openRequest && opts.isCurrent?.() !== false && opts.focus)
    await focusRange(opts.focus);
  return request === openRequest && opts.isCurrent?.() !== false;
}

/** 按 docId 打开（代理工具结果只给 docId 时）。 */
export async function openWorkbookById(
  docId: string,
  opts: { focus?: string } = {},
): Promise<void> {
  const request = ++openRequest;
  const current = get().doc;
  if (current?.docId === docId) {
    set({ panelOpen: true });
  } else {
    const workspaceId = requireWorkspace();
    void loadWorkbookSurface().catch(() => undefined);
    const response = await api()
      .getDocSnapshot(workspaceId, docId)
      .catch((error: unknown) => {
        if (request !== openRequest || get().workspaceId !== workspaceId) return null;
        toast({ tone: "error", title: "工作簿打开失败", description: errorMessage(error) });
        return null;
      });
    if (!response || request !== openRequest || get().workspaceId !== workspaceId) return;
    const { document } = response;
    set((s) => ({
      panelOpen: true,
      tabs: s.tabs.some((t) => samePath(t.path, document.path))
        ? s.tabs
        : [...s.tabs, { path: document.path, docId }],
    }));
    leaveDoc();
    if (!(await loadDoc(document.path, response))) return;
  }
  if (request === openRequest && opts.focus) await focusRange(opts.focus);
}

export async function activateTab(path: string): Promise<void> {
  openRequest += 1;
  if (get().doc && samePath(get().doc?.path ?? "", path)) return;
  noteManualView();
  leaveDoc();
  await loadDoc(path);
}

/** 关闭标签（只退订与清空本地视图；服务端活文档不受影响）。 */
export async function closeTab(path: string): Promise<void> {
  const tabs = get().tabs;
  const index = tabs.findIndex((t) => samePath(t.path, path));
  if (index < 0) return;
  const rest = tabs.filter((_, i) => i !== index);
  const closingActive = get().activePath !== null && samePath(get().activePath ?? "", path);
  set({ tabs: rest });
  if (!closingActive) return;
  openRequest += 1;
  leaveDoc();
  const next = rest[Math.min(index, rest.length - 1)];
  if (next) await loadDoc(next.path);
  else set({ ...resetDocView(), activePath: null, panelOpen: false, fullView: false });
}

export function closeAllWorkbooks(): void {
  openRequest += 1;
  leaveDoc();
  set({
    ...resetDocView(),
    tabs: [],
    activePath: null,
    panelOpen: false,
    fullView: false,
    selectionDismissed: false,
    rangeQuestion: null,
  });
}

export function setPanelOpen(open: boolean): void {
  if (!open) openRequest += 1;
  set({ panelOpen: open, ...(open ? {} : { fullView: false }) });
}

export function setFullView(full: boolean): void {
  if (full) useUIStore.getState().setSidebarOpen(false);
  set({ fullView: full, ...(full ? { panelOpen: true } : {}) });
}

/** 重新读取服务端权威快照（远端修订无法逐条回放、提交被拒绝后撤回本地编辑）。 */
export async function reloadDocument(): Promise<void> {
  const doc = get().doc;
  if (!doc) return;
  const request = ++docRequest;
  const workspaceId = requireWorkspace();
  const response = await api()
    .getDocSnapshot(workspaceId, doc.docId)
    .catch((error: unknown) => {
      if (
        request !== docRequest ||
        get().workspaceId !== workspaceId ||
        get().doc?.docId !== doc.docId
      )
        return null;
      throw error;
    });
  if (
    !response ||
    request !== docRequest ||
    get().workspaceId !== workspaceId ||
    get().doc?.docId !== doc.docId
  )
    return;
  const { document, snapshot } = response;
  if (document.rev < (get().doc?.rev ?? 0)) {
    scheduleRefresh(doc.docId);
    return;
  }
  set((s) => ({
    doc: {
      ...(s.doc ?? doc),
      rev: document.rev,
      snapshotRev: document.rev,
      snapshot: snapshot as Record<string, unknown>,
      ...(document.checkpointRev !== undefined ? { checkpointRev: document.checkpointRev } : {}),
      checkpointError: document.checkpointError,
      externalConflict: document.externalConflict === true,
    },
    docSync: { ...s.docSync, rev: Math.max(s.docSync.rev, document.rev) },
    selection: null,
    presence: [],
  }));
  schedulePresence(doc.docId);
}

function scheduleRefresh(docId: string): void {
  const prev = refreshTimers.get(docId);
  if (prev) clearTimeout(prev);
  refreshTimers.set(
    docId,
    setTimeout(() => {
      refreshTimers.delete(docId);
      if (get().doc?.docId === docId)
        void reloadDocument().catch(() => set({ referenceError: "reload-failed" }));
    }, 150),
  );
}

/** 外部修改冲突二选一（07 §5）：另一份版本存入备份区。 */
export async function resolveExternal(choice: "keepApp" | "loadExternal"): Promise<string> {
  const doc = get().doc;
  if (!doc) throw new Error("没有打开的工作簿");
  const workspaceId = requireWorkspace();
  const res = await api().resolveDocExternal(workspaceId, doc.docId, { choice });
  if (get().workspaceId === workspaceId && get().doc?.docId === doc.docId) await reloadDocument();
  return res.backupPath;
}

// ---------- 编辑提交 ----------

export function registerDocumentEditor(bridge: DocumentEditorBridge | null): void {
  editor = bridge;
  if (bridge === null) applyQueue = Promise.resolve();
}

/** 用户在工作台产生的 mutation 走统一 doc.submit 写入路径；baseRev 缺省为当前修订。 */
export function submitDocumentMutations(
  docId: string,
  mutations: DocMutation[],
  baseRev?: number,
): boolean {
  const st = get();
  const mutation = mutations[0];
  if (!mutation || !st.doc || st.doc.docId !== docId) return false;
  const clientOpId = `web-doc-${Date.now().toString(36)}-${++opSeq}`;
  const submitted: SubmittedMutation = { mutation, mutations, baseRev: baseRev ?? st.docSync.rev };
  const draft = st.inputDraft;
  const commitsDraft =
    draft &&
    mutations.some((m) => {
      if (m.id !== "sheet.mutation.set-range-values") return false;
      const p = m.params as {
        subUnitId?: string;
        cellValue?: Record<number, Record<number, unknown>>;
      };
      return p?.subUnitId === draft.sheetId && p.cellValue?.[draft.row]?.[draft.col] !== undefined;
    });
  set({
    docSync: trackDocSubmit(get().docSync, clientOpId, submitted),
    ...(commitsDraft ? { inputDraft: null } : {}),
  });
  const sent = sendSync({
    type: "doc.submit",
    docId,
    clientOpId,
    baseRev: submitted.baseRev,
    mutations,
  });
  if (!sent) set({ docSync: markOffline(get().docSync, clientOpId, submitted) });
  return sent;
}

/**
 * 重发一条被拒绝的编辑（冲突条「保留我的」/ 断线后「重新发送」）。沿用原 baseRev，
 * 服务端据此平移坐标；overwrite 表示用户已看过对方的值、明确选择覆盖。
 * 被拒绝时本地已撤销了这次编辑，确认后要重新读取快照（回显因来自本端被跳过）。
 */
export function resubmitRejected(clientOpId: string, opts: { overwrite: boolean }): boolean {
  const st = get();
  const item = st.docSync.pending[clientOpId];
  const submitted = item?.submitted;
  if (!st.doc || item?.status !== "rejected" || !submitted) return false;
  const nextId = `web-doc-${Date.now().toString(36)}-${++opSeq}`;
  set({ docSync: trackDocSubmit(dropPending(st.docSync, clientOpId), nextId, submitted) });
  const sent = sendSync({
    type: "doc.submit",
    docId: st.doc.docId,
    clientOpId: nextId,
    baseRev: submitted.baseRev,
    mutations: submitted.mutations ?? [submitted.mutation],
    ...(opts.overwrite ? { overwrite: true } : {}),
  });
  if (!sent) {
    set({ docSync: markOffline(get().docSync, nextId, submitted) });
    return false;
  }
  reloadOnAck.add(nextId);
  return true;
}

/** 关闭一条已处理的提交冲突提示，不会重发原 mutation。 */
export function dismissDocConflict(clientOpId: string): void {
  set({ docSync: dropPending(get().docSync, clientOpId) });
}

export function setDraftConflict(draft: DraftConflict | null): void {
  const input = get().inputDraft;
  const same =
    draft &&
    input &&
    draft.docId === input.docId &&
    draft.sheetId === input.sheetId &&
    draft.row === input.row &&
    draft.col === input.col;
  set({ draftConflict: draft, ...(same ? { inputDraft: null } : {}) });
}

export function setInputDraft(docId: string, draft: CellDraft | null): void {
  if (get().doc?.docId === docId) set({ inputDraft: draft ? { ...draft, docId } : null });
}

export function dismissRecoveredDraft(draft: DraftConflict): void {
  set((s) => ({ recoveredDrafts: s.recoveredDrafts.filter((d) => d !== draft) }));
}

/** Resolving an older draft may close the active editor; retain that separate input first. */
export function retainCurrentInputDraft(): void {
  const input = get().inputDraft;
  if (!input) return;
  set((s) => ({
    inputDraft: null,
    recoveredDrafts: [...s.recoveredDrafts, { ...input, theirs: undefined, source: "recovery" }],
  }));
}

// ---------- 选区 / 定位 / 在场 ----------

function schedulePresence(docId: string): void {
  if (presenceTimer) clearTimeout(presenceTimer);
  presenceTimer = setTimeout(() => {
    presenceTimer = null;
    const st = get();
    if (st.doc?.docId !== docId) return;
    const selection = st.selection?.docId === docId ? st.selection.range : "";
    let sheet = "";
    try {
      sheet = selection ? (parseRange(selection).sheet ?? "") : "";
    } catch {
      // 选区由 Univer 产生；解析失败时仍发送空工作表
    }
    sendSync({ type: "presence", docId, sheet, selection });
  }, 80);
}

export function setSelection(range: string | null): void {
  const doc = get().doc;
  if (!doc || range === null) {
    set({ selection: null });
    if (doc) schedulePresence(doc.docId);
    return;
  }
  const previous = get().selection;
  set({
    selection: { docId: doc.docId, rev: doc.rev, range, path: doc.path },
    ...(previous?.docId !== doc.docId || previous.range !== range
      ? { selectionDismissed: false }
      : {}),
  });
  schedulePresence(doc.docId);
}

/** 本条消息将附带的区域上下文：钉住优先，其次当前选区（未被移除时）。 */
export function composerContext(
  st: Pick<WorkbookState, "pinnedSelection" | "selection" | "selectionDismissed"> = get(),
): SelectionRef | null {
  if (st.pinnedSelection) return st.pinnedSelection;
  if (st.selection && !st.selectionDismissed) return st.selection;
  return null;
}

export function pinSelection(pin: boolean): void {
  const { selection, doc } = get();
  set({
    pinnedSelection:
      pin && selection
        ? {
            ...selection,
            path: selection.path ?? (doc?.docId === selection.docId ? doc.path : undefined),
          }
        : null,
    selectionDismissed: false,
  });
}

/** 与引用条使用同一选区来源；显示用的路径不进入请求契约。 */
export function composerMessageContext(): { docId: string; rev: number; range: string }[] {
  const context = composerContext();
  return context ? [{ docId: context.docId, rev: context.rev, range: context.range }] : [];
}

export function pinRange(range: string): void {
  const doc = get().doc;
  if (!doc) return;
  set({
    pinnedSelection: { docId: doc.docId, rev: doc.rev, range, path: doc.path },
    selectionDismissed: false,
  });
}

export function resetComposerContext(
  sent: Pick<WorkbookState, "pinnedSelection" | "selectionDismissed"> = get(),
): void {
  const current = get();
  // A send acknowledgement must not undo references changed while it was pending.
  if (
    current.pinnedSelection !== sent.pinnedSelection ||
    current.selectionDismissed !== sent.selectionDismissed
  )
    return;
  set({ pinnedSelection: null, selectionDismissed: false });
}

export function dismissContext(): void {
  set({ pinnedSelection: null, selectionDismissed: true });
}

/** 在工作台中定位并闪烁高亮一个区域（必要时先打开文档）。 */
export async function focusRange(
  range: string,
  target?: { docId?: string; path?: string },
): Promise<void> {
  try {
    let opening: Promise<void | boolean> | undefined;
    if (target?.docId && get().doc?.docId !== target.docId)
      opening = openWorkbookById(target.docId);
    else if (target?.path && !samePath(get().doc?.path ?? "", target.path))
      opening = openWorkbook(target.path);
    const request = openRequest;
    if (opening) await opening;
    if (request !== openRequest) return;
    const doc = get().doc;
    if (!doc) {
      set({ referenceError: "no-document" });
      return;
    }
    if (target?.docId && doc.docId !== target.docId) return;
    if (!target?.docId && target?.path && !samePath(doc.path, target.path)) return;
    const parsed = parseRange(range);
    const sheets = doc.snapshot.sheets as Record<string, { name?: string }> | undefined;
    if (parsed.sheet && !Object.values(sheets ?? {}).some((s) => s.name === parsed.sheet)) {
      set({ referenceError: "missing-sheet" });
      return;
    }
    set({ rangeFocus: { range, nonce: Date.now() }, referenceError: null, panelOpen: true });
  } catch {
    set({ referenceError: "invalid-range" });
  }
}

/** 在表格里回答区域提问：打开目标文档并定位到建议区域，底部出现确认条。 */
export async function startRangeQuestion(question: RangeQuestion): Promise<void> {
  set({ rangeQuestion: question });
  noteManualView();
  let opening: Promise<void | boolean> | undefined;
  if (question.docId) opening = openWorkbookById(question.docId);
  else if (question.path) opening = openWorkbook(question.path);
  else set({ panelOpen: true });
  const request = openRequest;
  if (opening) await opening;
  if (get().rangeQuestion !== question) return;
  if (request !== openRequest) {
    set({ rangeQuestion: null });
    return;
  }
  const doc = get().doc;
  if (
    (question.docId && doc?.docId !== question.docId) ||
    (!question.docId && question.path && !samePath(doc?.path ?? "", question.path))
  ) {
    set({ rangeQuestion: null });
    return;
  }
  if (question.suggested) await focusRange(question.suggested);
}

export function endRangeQuestion(questionId?: string): void {
  if (questionId === undefined || get().rangeQuestion?.questionId === questionId)
    set({ rangeQuestion: null });
}

export function previewRange(range: string | null): void {
  set({ rangePreview: range });
}

export function clearReferenceError(): void {
  set({ referenceError: null });
}

// ---------- 跟随代理 / 变更反馈 ----------

export function setFollowAgent(on: boolean): void {
  try {
    localStorage.setItem(FOLLOW_KEY, on ? "1" : "0");
  } catch {
    // ignore
  }
  set({ followAgent: on });
}

/** 用户手动打开文件或切换视图（5 秒内不被代理跳转打断，02 §4.8）。 */
export function noteManualView(): void {
  lastManualView = Date.now();
}

export function markChangesSeen(): void {
  set({ changesSeenSeq: useChatStore.getState().session.cursor });
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
  const docId = typeof args.docId === "string" ? args.docId : undefined;
  const path = typeof args.path === "string" ? args.path : undefined;
  if (!docId && !path) return;
  const qualified =
    range && typeof args.sheet === "string" && !range.includes("!")
      ? `${args.sheet}!${range}`
      : range;
  const options = qualified ? { focus: qualified } : {};
  const open = docId ? openWorkbookById(docId, options) : openWorkbook(path as string, options);
  void open.catch(() => undefined);
}

// ---------- 同步通道 ----------

function onDocOp(message: Extract<ServerMessage, { type: "doc.op" }>): void {
  set({ docSync: reduceDoc(get().docSync, message) });
  const doc = get().doc;
  if (doc) {
    const selection = get().selection;
    set({
      doc: { ...doc, rev: Math.max(doc.rev, message.rev) },
      ...(selection?.docId === message.docId
        ? { selection: { ...selection, rev: Math.max(selection.rev, message.rev) } }
        : {}),
    });
  }
  // 服务端会把本端修订回显给发送者；本端已乐观应用，按连接 id 去重
  const connection = syncConnectionId();
  if (connection !== null && message.source === `user:${connection}`) return;
  const mutations = Array.isArray(message.mutations)
    ? (message.mutations as unknown[]).filter(
        (m): m is DocMutation =>
          !!m && typeof m === "object" && typeof (m as { id?: unknown }).id === "string",
      )
    : [];
  if (editor?.docId === message.docId) {
    // 分片或连续远端修订串行回放，避免多个命令交错
    applyQueue = applyQueue
      .then(async () => {
        const current = get().doc;
        // A refreshed snapshot may already include this queued revision.
        if (current?.docId === message.docId && current.snapshotRev >= message.rev) return;
        if (editor?.docId === message.docId) await editor.applyRemote(mutations, message.source);
        else if (get().doc?.docId === message.docId) scheduleRefresh(message.docId);
      })
      .catch(() => scheduleRefresh(message.docId));
  } else {
    scheduleRefresh(message.docId);
  }
}

onConnection((connected) => {
  if (!connected) set({ docSync: markDisconnected(get().docSync) });
});

onSync((message) => {
  const doc = get().doc;
  switch (message.type) {
    case "sub.ok":
      if (doc && message.topic === docTopic(doc.docId))
        set({ docSync: reduceDoc(get().docSync, message) });
      return;
    case "doc.op":
      if (message.docId === doc?.docId) onDocOp(message);
      return;
    case "doc.ack":
    case "doc.reject": {
      if (!get().docSync.pending[message.clientOpId]) return;
      set({ docSync: reduceDoc(get().docSync, message) });
      if (message.type === "doc.ack") {
        const current = get().doc;
        if (current) set({ doc: { ...current, rev: Math.max(current.rev, message.rev) } });
        if (reloadOnAck.delete(message.clientOpId)) void reloadDocument().catch(() => undefined);
      } else {
        reloadOnAck.delete(message.clientOpId);
        // 拒绝时撤销乐观编辑：重新读取服务端快照，不自动重发
        void reloadDocument().catch(() => undefined);
      }
      return;
    }
    case "doc.checkpoint":
      if (doc && message.docId === doc.docId)
        set({
          doc: {
            ...doc,
            checkpointRev: message.checkpointRev,
            checkpointError: message.error,
            externalConflict: message.externalConflict === true,
          },
        });
      return;
    case "doc.reload":
      if (doc && message.docId === doc.docId) {
        set({ docSync: reduceDoc(get().docSync, message) });
        void reloadDocument().catch(() => undefined);
      }
      return;
    case "presence":
      if (message.docId === doc?.docId) set({ presence: message.participants });
      return;
    case "hello":
      if (doc) schedulePresence(doc.docId);
      return;
    case "rec": {
      const sessionId = useChatStore.getState().sessionId;
      if (sessionId && message.topic === `session:${sessionId}`)
        followAgentActivity(message.record);
      return;
    }
    default:
      return;
  }
});

let recoveryWarning = false;
function persistRecovery(state: WorkbookState): void {
  if (!state.workspaceId || !state.doc) return;
  try {
    const drafts: CellDraft[] = [...state.recoveredDrafts];
    if (state.draftConflict?.docId === state.doc.docId) drafts.push(state.draftConflict);
    if (state.inputDraft?.docId === state.doc.docId) drafts.push(state.inputDraft);
    const raw = encodeRecovery(state.docSync, drafts);
    const key = recoveryKey(state.workspaceId, state.doc.docId);
    recoveryStorage.write(key, raw);
    recoveryWarning = false;
  } catch {
    if (!recoveryWarning) {
      recoveryWarning = true;
      toast({
        title: "草稿暂时无法保存到浏览器",
        description: "请勿刷新或关闭页面，先处理未提交的输入。",
        tone: "error",
      });
    }
  }
}
useWorkbookStore.subscribe((state, prev) => {
  const changedScope =
    prev.doc?.docId !== state.doc?.docId || prev.workspaceId !== state.workspaceId;
  if (prev.doc && changedScope) persistRecovery(prev);
  if (
    state.doc &&
    (changedScope ||
      state.docSync.pending !== prev.docSync.pending ||
      state.inputDraft !== prev.inputDraft ||
      state.draftConflict !== prev.draftConflict ||
      state.recoveredDrafts !== prev.recoveredDrafts)
  )
    persistRecovery(state);
});

// 快照始终从服务端读取；仅标签布局、未提交输入和待确认提交跨刷新保存。
useWorkbookStore.subscribe((state, prev) => {
  if (
    !state.workspaceId ||
    (state.tabs === prev.tabs &&
      state.activePath === prev.activePath &&
      state.panelOpen === prev.panelOpen &&
      state.fullView === prev.fullView)
  )
    return;
  try {
    sessionStorage.setItem(
      `excelmanus.tabs.${state.workspaceId}`,
      JSON.stringify({
        paths: state.tabs.map((tab) => tab.path),
        activePath: state.activePath,
        panelOpen: state.panelOpen,
        fullView: state.fullView,
      }),
    );
  } catch {
    /* storage may be unavailable */
  }
});

// 工作区切换：恢复该工作区的标签，文档内容始终重新读取。
useSessionStore.subscribe((state, prev) => {
  if (state.activeWorkspaceId === prev.activeWorkspaceId) return;
  openRequest += 1;
  leaveDoc();
  let saved = null;
  try {
    saved = parseSavedTabs(sessionStorage.getItem(`excelmanus.tabs.${state.activeWorkspaceId}`));
  } catch {
    /* storage may be unavailable */
  }
  set({
    ...resetDocView(),
    workspaceId: state.activeWorkspaceId,
    tabs: saved?.paths.map((path) => ({ path })) ?? [],
    activePath: saved?.activePath ?? null,
    panelOpen: saved?.panelOpen ?? false,
    fullView: saved?.fullView ?? false,
    selectionDismissed: false,
    changesSeenSeq: 0,
  });
  if (state.activeWorkspaceId && saved?.activePath) void loadDoc(saved.activePath);
});

// 会话切换：变更高亮从新会话的起点算
useChatStore.subscribe((state, prev) => {
  if (state.sessionId !== prev.sessionId)
    set({
      changesSeenSeq: 0,
      pinnedSelection: null,
      selectionDismissed: false,
      rangeQuestion: null,
    });
  // 提问已被回答（本窗口或其他窗口）或已失效：收起确认条
  const rq = get().rangeQuestion;
  if (
    rq &&
    state.session !== prev.session &&
    state.session.questions[rq.questionId]?.status !== "pending"
  )
    set({ rangeQuestion: null });
});
