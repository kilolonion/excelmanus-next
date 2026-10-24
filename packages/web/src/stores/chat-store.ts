import { persistentDraftStorage } from "@/lib/draft-storage";
import {
  readPendingUploads,
  removePendingUpload,
  savePendingUpload,
  snapshotUploadFile,
} from "@/lib/pending-uploads";

// 当前会话：日志还原状态（唯一事实源是服务端会话日志）+ 输入框附件 + 全部对话动作。
// 发送后先显示一条乐观消息，日志里出现同 clientMessageId 的 user.message 后由真实记录接替。

import type {
  ApiReadOptions,
  AttachmentRef,
  ContextRef,
  DispatchMode,
  LogRecord,
  PermissionMode,
  ServerMessage,
} from "@excelmanus/protocol";
import { ApiError } from "@excelmanus/protocol";
import { create } from "zustand";
import {
  mergeAttachmentDraft,
  readAttachmentDraft,
  saveAttachmentDraft,
} from "@/lib/attachment-drafts";
import { api, errorMessage } from "@/lib/backend/api";
import { onSync, subscribeTopic, unsubscribeTopic } from "@/lib/backend/channel";
import { loadHistoryWindow, rebuildHistoryAsync } from "@/lib/session/history";
import { initialSessionState, MAIN_AGENT, reduceSession } from "@/lib/session/reducer";
import type { SessionState, UserItem } from "@/lib/session/types";

export interface ComposerAttachment {
  id: string;
  name: string;
  size: number;
  /** 图片：本地预览地址；上传后得到附件引用。 */
  previewUrl?: string;
  ref?: AttachmentRef;
  /** 非图片：上传到工作区后的相对路径（以 @路径 引用）。 */
  path?: string;
  status: "uploading" | "ready" | "error";
  /** 原文件已在内存或本地附件草稿中，可重试上传。 */
  canRetry?: boolean;
  error?: string;
}

export interface OptimisticMessage {
  clientMessageId: string;
  agentId: string;
  text: string;
  at: string;
  context: ContextRef[];
  attachments: AttachmentRef[];
  error?: string;
  /** 引用修订冲突，用户重试时刷新原区域的修订号。 */
  contextStale?: boolean;
}

interface ChatState {
  sessionId: string | null;
  workspaceId: string | null;
  /** 会话详情/日志回放尚未追上服务端游标。 */
  loading: boolean;
  loadError: string | null;
  /** sub.ok 报告的日志头；cursor 追上它之前视为正在回放历史。 */
  headCursor: number;
  hasOlder: boolean;
  loadingOlder: boolean;
  olderError: string | null;
  session: SessionState;
  /** 对话区显示哪个代理的对话（默认主代理）。 */
  viewAgentId: string;
  optimistic: OptimisticMessage[];
  attachments: ComposerAttachment[];
  /** 需要插入输入框的文本（拖入文件、提问卡片"在输入框中修改"等），nonce 递增触发。 */
  composerInsert: { text: string; replace?: boolean; nonce: number } | null;
  /** 斜杠命令等的短提示，下一次发送时清除。 */
  notice: { text: string; tone: "info" | "error" } | null;
  /** 输入框的聊天模式：write 正常执行；ask 只读问答；plan 先出计划不执行。跨会话保留。 */
  chatMode: ChatMode;
  /** 正在压缩上下文的代理（app.event compaction.progress，瞬时、不入日志）。 */
  compacting: Record<string, true>;
}

export type ChatMode = "write" | "ask" | "plan";
const CHAT_MODE_KEY = "excelmanus.chat-mode";

function readChatMode(): ChatMode {
  try {
    const v = localStorage.getItem(CHAT_MODE_KEY);
    return v === "ask" || v === "plan" ? v : "write";
  } catch {
    return "write";
  }
}

export const useChatStore = create<ChatState>()(() => ({
  sessionId: null,
  workspaceId: null,
  loading: false,
  loadError: null,
  headCursor: 0,
  hasOlder: false,
  loadingOlder: false,
  olderError: null,
  session: initialSessionState(),
  viewAgentId: MAIN_AGENT,
  optimistic: [],
  attachments: [],
  composerInsert: null,
  notice: null,
  chatMode: readChatMode(),
  compacting: {},
}));

const set = useChatStore.setState;
const get = useChatStore.getState;

const attachmentDrafts = new Map<string, ComposerAttachment[]>();
const attachmentScope = (state: Pick<ChatState, "sessionId" | "workspaceId" | "viewAgentId">) =>
  `${state.sessionId ?? `new:${state.workspaceId ?? "default"}`}/${state.viewAgentId}`;
function readAttachments(scope: string): ComposerAttachment[] {
  if (attachmentDrafts.has(scope)) return attachmentDrafts.get(scope)!;
  let items: ComposerAttachment[] = [];
  try {
    items = readAttachmentDraft(persistentDraftStorage(), scope);
  } catch {
    /* unavailable */
  }
  attachmentDrafts.set(scope, items);
  return items;
}
function rememberAttachments(scope: string, items: ComposerAttachment[]): void {
  const previous = attachmentDrafts.get(scope) ?? [];
  attachmentDrafts.set(scope, items);
  try {
    const storage = persistentDraftStorage();
    saveAttachmentDraft(
      storage,
      scope,
      mergeAttachmentDraft(readAttachmentDraft(storage, scope), previous, items),
    );
  } catch {
    /* unavailable */
  }
}
function updateAttachments(
  scope: string,
  update: (items: ComposerAttachment[]) => ComposerAttachment[],
): void {
  const items = update(
    scope === attachmentScope(get()) ? get().attachments : readAttachments(scope),
  );
  rememberAttachments(scope, items);
  if (scope === attachmentScope(get())) set({ attachments: items });
}
useChatStore.subscribe((state, previous) => {
  if (attachmentScope(state) !== attachmentScope(previous))
    rememberAttachments(attachmentScope(previous), previous.attachments);
  if (state.attachments !== previous.attachments)
    rememberAttachments(attachmentScope(state), state.attachments);
});
const previewLoads = new Set<string>();
function restoreAttachmentPreviews(scope: string): void {
  void restorePendingUploads(scope);
  for (const item of readAttachments(scope)) {
    const key = `${scope}:${item.id}`;
    if (!item.ref || item.previewUrl || previewLoads.has(key)) continue;
    previewLoads.add(key);
    void api()
      .getAttachment(item.ref.sha256)
      .then((blob) => {
        const previewUrl = URL.createObjectURL(blob);
        if (!readAttachments(scope).some((entry) => entry.id === item.id)) {
          URL.revokeObjectURL(previewUrl);
          return;
        }
        updateAttachments(scope, (items) =>
          items.map((entry) => (entry.id === item.id ? { ...entry, previewUrl } : entry)),
        );
      })
      .catch(() => {
        updateAttachments(scope, (items) =>
          items.map((entry) =>
            entry.id === item.id
              ? { ...entry, status: "error", error: "附件无法恢复，请移除后重新添加" }
              : entry,
          ),
        );
      })
      .finally(() => previewLoads.delete(key));
  }
}

let seq = 0;
const nextClientId = () => `web-${Date.now().toString(36)}-${(++seq).toString(36)}`;
const topicOf = (id: string) => `session:${id}`;
let loadRequest = 0;
let historyReadController: AbortController | null = null;
let historyRecords: LogRecord[] = [];
let hydrating = false;

function caughtUp(state: Pick<ChatState, "session" | "headCursor">): boolean {
  return state.session.cursor >= state.headCursor;
}

onSync((message: ServerMessage) => {
  const { sessionId } = get();
  if (!sessionId) return;
  const topic = topicOf(sessionId);
  if (message.type === "app.event") {
    const e = message.data as {
      type: string;
      sessionId?: unknown;
      agentId?: unknown;
      running?: unknown;
    };
    if (e.type !== "compaction.progress" || e.sessionId !== sessionId) return;
    const agentId = typeof e.agentId === "string" ? e.agentId : MAIN_AGENT;
    set((s) => {
      const { [agentId]: _, ...rest } = s.compacting;
      return { compacting: e.running === true ? { ...rest, [agentId]: true } : rest };
    });
    return;
  }
  if (message.type === "sub.ok" && message.topic === topic) {
    if (hydrating) return;
    set((s) => ({
      headCursor: message.headCursor,
      loading: s.session.cursor < message.headCursor,
    }));
    return;
  }
  if (message.type === "sub.error" && message.topic === topic) {
    set({ loading: false, loadError: message.error.message || "会话加载失败" });
    return;
  }
  if (
    (message.type === "rec" || message.type === "delta" || message.type === "snapshot") &&
    message.topic === topic
  ) {
    if (hydrating) return;
    if (message.type === "rec" && message.seq > get().session.cursor)
      historyRecords.push(message.record);
    const session = reduceSession(get().session, message);
    if (session === get().session) return;
    const patch: Partial<ChatState> = { session };
    if (message.type === "rec" && message.record.type === "user.message") {
      const clientId = String(
        (message.record.data as { clientMessageId?: unknown }).clientMessageId ?? "",
      );
      if (get().optimistic.some((o) => o.clientMessageId === clientId))
        patch.optimistic = get().optimistic.filter((o) => o.clientMessageId !== clientId);
    }
    if (get().loading && caughtUp({ session, headCursor: get().headCursor })) patch.loading = false;
    set(patch);
  }
});

/** 先加载最近一段完整对话，再从它的游标订阅实时增量。 */
export async function loadChatSession(
  sessionId: string,
  options?: ApiReadOptions,
  expectedWorkspaceId?: string,
): Promise<{ workspaceId: string }> {
  historyReadController?.abort();
  const controller = new AbortController();
  historyReadController = controller;
  const signal = options?.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;
  const readOptions: ApiReadOptions = { timeoutMs: 15000, ...options, signal };
  const request = ++loadRequest;
  const previous = get().sessionId;
  if (previous) unsubscribeTopic(topicOf(previous));
  hydrating = true;
  historyRecords = [];
  set({
    sessionId,
    workspaceId: null,
    loading: true,
    loadError: null,
    headCursor: Number.MAX_SAFE_INTEGER,
    hasOlder: false,
    loadingOlder: false,
    olderError: null,
    session: initialSessionState(),
    viewAgentId: MAIN_AGENT,
    optimistic: [],
    compacting: {},
    ...(previous !== sessionId || get().viewAgentId !== MAIN_AGENT
      ? { attachments: readAttachments(`${sessionId}/${MAIN_AGENT}`), notice: null }
      : {}),
  });
  restoreAttachmentPreviews(`${sessionId}/${MAIN_AGENT}`);
  try {
    const window = await api().getSessionHistoryWindow(sessionId, readOptions);
    signal.throwIfAborted();
    const [history, detail] =
      window.kind === "complete"
        ? ([{ records: window.items, hasMore: window.hasMore }, window.detail] as const)
        : await Promise.all([
            loadHistoryWindow(async (before) => {
              signal.throwIfAborted();
              return api().getSessionLog(sessionId, { before, limit: 100 }, readOptions);
            }, window.headSeq + 1),
            api().getSession(sessionId, readOptions),
          ]);
    signal.throwIfAborted();
    if (expectedWorkspaceId !== undefined && detail.session.workspaceId !== expectedWorkspaceId)
      throw new Error("恢复会话不属于当前工作区");
    if (request !== loadRequest) return { workspaceId: detail.session.workspaceId };
    const restored = await rebuildHistoryAsync(
      history.records,
      initialSessionState,
      () => request === loadRequest && !signal.aborted,
      undefined,
      {
        headSeq: detail.headSeq,
        agents: detail.agents,
        pendingInteractions: detail.pendingInteractions,
      },
    );
    if (!restored || request !== loadRequest || signal.aborted)
      return { workspaceId: detail.session.workspaceId };
    historyRecords = history.records;
    set({
      workspaceId: detail.session.workspaceId,
      headCursor: Math.max(detail.headSeq, restored.cursor),
      loading: detail.headSeq > restored.cursor,
      hasOlder: history.hasMore,
      session: {
        ...restored,
        permissionMode: detail.session.permissionMode,
        title: detail.session.title,
      },
    });
    hydrating = false;
    subscribeTopic(topicOf(sessionId), () => get().session.cursor);
    return { workspaceId: detail.session.workspaceId };
  } catch (error) {
    controller.abort();
    // Superseded navigation is cancellation, not a visible load failure.
    if (request !== loadRequest)
      return { workspaceId: expectedWorkspaceId ?? get().workspaceId ?? "" };
    if (request === loadRequest) {
      hydrating = false;
      set({ loading: false, loadError: errorMessage(error, "会话加载失败") });
    }
    throw error;
  }
}

export async function loadOlderChat(): Promise<void> {
  const { sessionId, hasOlder, loadingOlder } = get();
  if (!sessionId || !hasOlder || loadingOlder || hydrating) return;
  const request = loadRequest;
  const before = historyRecords[0]?.seq;
  if (before === undefined) return;
  set({ loadingOlder: true, olderError: null });
  try {
    const page = await loadHistoryWindow(async (cursor) => {
      const page = await api().getSessionLog(sessionId, { before: cursor, limit: 100 });
      return request === loadRequest ? page : { items: [] };
    }, before);
    if (request !== loadRequest) return;
    let tailOffset = historyRecords.length;
    const restored = await rebuildHistoryAsync(
      [...page.records, ...historyRecords],
      () => get().session,
      () => request === loadRequest,
      () => {
        const tail = historyRecords.slice(tailOffset);
        tailOffset = historyRecords.length;
        return tail;
      },
    );
    if (!restored || request !== loadRequest) return;
    historyRecords = [...page.records, ...historyRecords];
    set({ session: restored, hasOlder: page.hasMore, loadingOlder: false });
  } catch (error) {
    if (request === loadRequest)
      set({ loadingOlder: false, olderError: errorMessage(error, "更早消息加载失败") });
  }
}

export function clearChatSession(): void {
  historyReadController?.abort();
  historyReadController = null;
  const { sessionId } = get();
  if (sessionId) unsubscribeTopic(topicOf(sessionId));
  loadRequest += 1;
  historyRecords = [];
  hydrating = false;
  set({
    sessionId: null,
    workspaceId: null,
    attachments: [],
    viewAgentId: MAIN_AGENT,
    loading: false,
    loadError: null,
    hasOlder: false,
    loadingOlder: false,
    olderError: null,
    session: initialSessionState(),
    optimistic: [],
  });
}

export function setViewAgent(agentId: string): void {
  const scope = attachmentScope({ ...get(), viewAgentId: agentId });
  set({ viewAgentId: agentId, attachments: readAttachments(scope) });
  restoreAttachmentPreviews(scope);
}

export function setChatNotice(text: string | null, tone: "info" | "error" = "info"): void {
  set({ notice: text ? { text, tone } : null });
}

export function insertIntoComposer(text: string, replace = false): void {
  set({ composerInsert: { text, replace, nonce: Date.now() } });
}

function requireSession(): string {
  const id = get().sessionId;
  if (!id) throw new Error("没有打开的对话");
  return id;
}

/** Late continuations must not act on another conversation or agent view. */
function currentViewGuard(): () => boolean {
  const { sessionId, viewAgentId } = get();
  const request = loadRequest;
  return () =>
    request === loadRequest && get().sessionId === sessionId && get().viewAgentId === viewAgentId;
}

// ---------- 发送 ----------

export interface SendOptions {
  text: string;
  mode?: DispatchMode;
  context?: ContextRef[];
  /** 发给哪个代理；默认当前查看的代理。 */
  agentId?: string;
  /** 替换一条仍在排队的消息。 */
  replacesDispatchId?: string;
}

/** 斜杠命令：不走消息派发。返回 true 表示已处理。 */
async function runCommand(text: string, agentId: string): Promise<boolean> {
  const sessionId = requireSession();
  const isCurrent = currentViewGuard();
  const cmd = text.trim();
  const model = /^\/model\s+(.+)$/.exec(cmd);
  if (model?.[1]) {
    const res = await api().switchAgentModel(sessionId, agentId, { modelName: model[1].trim() });
    if (isCurrent()) setChatNotice(`已切换到模型档案「${res.name}」`);
    return true;
  }
  if (cmd === "/compact") {
    const res = await api().compactAgent(sessionId, agentId);
    if (!isCurrent()) return true;
    setChatNotice(
      res.scheduled
        ? "将在当前步骤结束后压缩上下文"
        : res.compacted
          ? "上下文已压缩"
          : "暂无可压缩的内容",
    );
    return true;
  }
  if (cmd === "/resume") {
    await api().resumeAgent(sessionId, agentId);
    return true;
  }
  if (cmd === "/stop") {
    await api().stopAgent(sessionId, agentId);
    return true;
  }
  if (cmd === "/undo") {
    await undoLatestRevision();
    return true;
  }
  return false;
}

/** /undo：撤销当前打开表格的最近一次修改（作为新修订提交）。 */
async function undoLatestRevision(): Promise<void> {
  // 动态引入避免 store 之间的循环依赖
  const { useWorkbookStore } = await import("@/stores/workbook-store");
  const { doc, workspaceId } = useWorkbookStore.getState();
  if (!doc || !workspaceId) {
    setChatNotice("先打开要撤销的表格，再输入 /undo", "error");
    return;
  }
  const { items } = await api().listDocRevisions(workspaceId, doc.docId, { limit: 50 });
  const target = items.find((r) => r.revertedBy === null && r.reverts === null);
  if (!target) {
    setChatNotice(`「${doc.path}」没有可撤销的修改`);
    return;
  }
  const res = await api().undoDocRevision(workspaceId, doc.docId, target.rev);
  setChatNotice(`已撤销「${doc.path}」第 ${target.rev} 版（保存为第 ${res.rev} 版）`);
}

/**
 * 发送一条消息（附带输入框里已上传完成的附件）。失败时乐观消息保留错误，附件不清空，便于重试。
 */
export async function sendMessage(opts: SendOptions): Promise<boolean> {
  const sessionId = requireSession();
  const agentId = opts.agentId ?? get().viewAgentId;
  const text = opts.text.trim();
  set({ notice: null });
  if (text.startsWith("/") && !opts.replacesDispatchId) {
    const isCurrent = currentViewGuard();
    try {
      if (await runCommand(text, agentId)) return true;
      if (!isCurrent()) return false;
    } catch (error) {
      if (isCurrent()) setChatNotice(errorMessage(error, "命令执行失败"), "error");
      return false;
    }
  }
  const scope = attachmentScope(get());
  const chatMode = effectiveChatMode(get(), agentId);
  const attachments = get().attachments;
  if (attachments.some((a) => a.status === "uploading")) {
    setChatNotice("附件仍在上传，请稍候再发送", "error");
    return false;
  }
  const ready = attachments.filter((a) => a.status === "ready");
  const refs = ready.flatMap((a) => (a.ref ? [a.ref] : []));
  const references = ready.flatMap((a) => (a.path ? [`@${a.path}`] : []));
  const body = [text, ...references].filter(Boolean).join("\n");
  if (!body && refs.length === 0) return false;
  const clientMessageId = nextClientId();
  const context = opts.context ?? [];
  set((s) => ({
    optimistic: [
      ...s.optimistic,
      {
        clientMessageId,
        agentId,
        text: body,
        at: new Date().toISOString(),
        context,
        attachments: refs,
      },
    ],
  }));
  try {
    await api().sendMessage(sessionId, agentId, {
      clientMessageId,
      text: body,
      ...(opts.mode ? { mode: opts.mode } : {}),
      ...(chatMode !== "write" ? { chatMode } : {}),
      ...(context.length > 0 ? { context } : {}),
      ...(refs.length > 0 ? { attachments: refs } : {}),
      ...(opts.replacesDispatchId ? { replacesDispatchId: opts.replacesDispatchId } : {}),
    });
    const sent = new Set(ready.map((a) => a.id));
    for (const a of ready) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    updateAttachments(scope, (items) => items.filter((a) => !sent.has(a.id)));
    return true;
  } catch (error) {
    const message = errorMessage(error, "发送失败，请重试");
    set((s) => ({
      optimistic: s.optimistic.map((o) =>
        o.clientMessageId === clientMessageId
          ? {
              ...o,
              error: message,
              contextStale:
                error instanceof ApiError &&
                error.status === 409 &&
                error.code === "conflict" &&
                o.context.length > 0,
            }
          : o,
      ),
    }));
    return false;
  }
}

/** 丢弃一条发送失败的乐观消息，把原文放回输入框。 */
export function discardFailedMessage(clientMessageId: string): void {
  const item = get().optimistic.find((o) => o.clientMessageId === clientMessageId);
  set((s) => ({ optimistic: s.optimistic.filter((o) => o.clientMessageId !== clientMessageId) }));
  if (item) insertIntoComposer(item.text, true);
}

/** 撤回仍在排队的消息，原文放回输入框。 */
export async function cancelQueuedMessage(item: UserItem): Promise<void> {
  const isCurrent = currentViewGuard();
  await api().cancelDispatch(requireSession(), item.id);
  if (isCurrent()) insertIntoComposer(item.text, true);
}

/** 以乐观消息的形式派发一段文本（重试、重新开始共用）。 */
async function dispatchText(
  agentId: string,
  text: string,
  opts: { context: ContextRef[]; attachments: AttachmentRef[] },
): Promise<boolean> {
  const sessionId = requireSession();
  const clientMessageId = nextClientId();
  set((s) => ({
    optimistic: [
      ...s.optimistic,
      {
        clientMessageId,
        agentId,
        text,
        at: new Date().toISOString(),
        context: opts.context,
        attachments: opts.attachments,
      },
    ],
  }));
  try {
    await api().sendMessage(sessionId, agentId, {
      clientMessageId,
      text,
      ...(opts.context.length > 0 ? { context: opts.context } : {}),
      ...(opts.attachments.length > 0 ? { attachments: opts.attachments } : {}),
    });
    return true;
  } catch (error) {
    const message = errorMessage(error, "发送失败，请重试");
    set((s) => ({
      optimistic: s.optimistic.map((o) =>
        o.clientMessageId === clientMessageId
          ? {
              ...o,
              error: message,
              contextStale:
                error instanceof ApiError &&
                error.status === 409 &&
                error.code === "conflict" &&
                o.context.length > 0,
            }
          : o,
      ),
    }));
    return false;
  }
}

const resendingMessages = new Set<string>();

/** 原文、区域地址与图片不变；修订冲突时先读取原文档的当前版本。 */
export async function resendFailedMessage(clientMessageId: string): Promise<boolean> {
  const { sessionId, workspaceId } = get();
  const item = get().optimistic.find((o) => o.clientMessageId === clientMessageId);
  if (!item || !sessionId || !workspaceId || resendingMessages.has(clientMessageId)) return false;
  resendingMessages.add(clientMessageId);
  try {
    let context = item.context;
    if (item.contextStale && context.length > 0) {
      const revisions = new Map(
        await Promise.all(
          [...new Set(context.map((ref) => ref.docId))].map(async (docId) => {
            const { document } = await api().getDocSnapshot(workspaceId, docId);
            return [docId, document.rev] as const;
          }),
        ),
      );
      context = context.map((ref) => ({ ...ref, rev: revisions.get(ref.docId) ?? ref.rev }));
    }
    if (get().sessionId !== sessionId || get().workspaceId !== workspaceId) return false;
    // The user may have discarded the failed message while the snapshot loaded.
    if (!get().optimistic.some((o) => o.clientMessageId === clientMessageId)) return false;
    set((s) => ({ optimistic: s.optimistic.filter((o) => o.clientMessageId !== clientMessageId) }));
    return await dispatchText(item.agentId, item.text, { context, attachments: item.attachments });
  } catch (error) {
    if (get().sessionId === sessionId && get().workspaceId === workspaceId) {
      set((s) => ({
        optimistic: s.optimistic.map((o) =>
          o.clientMessageId === clientMessageId
            ? { ...o, error: errorMessage(error, "无法刷新引用，请重新选择区域") }
            : o,
        ),
      }));
    }
    return false;
  } finally {
    resendingMessages.delete(clientMessageId);
  }
}

/**
 * 从某条用户消息起重新开始：先回退对话（不回滚文件），再以新内容（缺省为原文）重新发送。
 * 编辑重发、重试、换模型重试都走这里。
 */
export async function restartFrom(
  item: UserItem,
  opts: { text?: string; modelProfileId?: string } = {},
): Promise<boolean> {
  const sessionId = requireSession();
  const isCurrent = currentViewGuard();
  try {
    if (opts.modelProfileId)
      await api().switchAgentModel(sessionId, item.agentId, {
        modelProfileId: opts.modelProfileId,
      });
    if (!isCurrent()) return false;
    await api().rewindAgent(sessionId, item.agentId, { dispatchId: item.id });
  } catch (error) {
    if (isCurrent()) setChatNotice(errorMessage(error, "无法从这条消息重新开始"), "error");
    return false;
  }
  if (!isCurrent()) return false;
  return dispatchText(item.agentId, opts.text ?? item.text, {
    context: item.context,
    attachments: item.attachments,
  });
}

/** 只回到某条消息之前（不重新发送）：原文放回输入框。 */
export async function rewindTo(item: UserItem): Promise<boolean> {
  const isCurrent = currentViewGuard();
  try {
    await api().rewindAgent(requireSession(), item.agentId, { dispatchId: item.id });
    if (!isCurrent()) return false;
    insertIntoComposer(item.text, true);
    return true;
  } catch (error) {
    if (isCurrent()) setChatNotice(errorMessage(error, "无法回到这条消息"), "error");
    return false;
  }
}

// ---------- 控制 ----------

export async function stopAgent(agentId = get().viewAgentId): Promise<void> {
  await api().stopAgent(requireSession(), agentId);
}

export async function stopAllAgents(scope: "all" | "subagents" = "all"): Promise<void> {
  await api().stopAll(requireSession(), scope === "subagents" ? { scope } : undefined);
}

/** Reader role remains read-only without changing the main agent's selected mode. */
export function effectiveChatMode(
  state: Pick<ChatState, "session" | "chatMode">,
  agentId: string,
): ChatMode {
  return state.session.roster[agentId]?.role === "reader" && state.chatMode === "write"
    ? "ask"
    : state.chatMode;
}

export function setChatMode(chatMode: ChatMode): void {
  set({ chatMode });
  try {
    localStorage.setItem(CHAT_MODE_KEY, chatMode);
  } catch {
    // 无痕模式等：只在本页生效
  }
}

/** 对一条回复点赞/点踩；再次点同一个撤回（rating=null）。记录回到日志后界面才更新。 */
export async function sendFeedback(seq: number, rating: "up" | "down" | null): Promise<void> {
  await api().sendFeedback(requireSession(), { seq, rating });
}

export async function resumeAgent(agentId = get().viewAgentId): Promise<void> {
  await api().resumeAgent(requireSession(), agentId);
}

export async function controlAgent(
  agentId: string,
  action: "pause" | "resume" | "close",
): Promise<void> {
  await api().controlAgent(requireSession(), agentId, { action });
}

export async function compactNow(agentId = get().viewAgentId): Promise<void> {
  await runCommand("/compact", agentId);
}

export async function switchModel(
  modelProfileId: string,
  agentId = get().viewAgentId,
): Promise<string> {
  const res = await api().switchAgentModel(requireSession(), agentId, { modelProfileId });
  return res.name;
}

export async function setPermissionMode(mode: PermissionMode): Promise<void> {
  const sessionId = requireSession();
  const request = loadRequest;
  await api().updateSession(sessionId, { permissionMode: mode });
  if (request !== loadRequest || get().sessionId !== sessionId) return;
  set((s) => ({ session: { ...s.session, permissionMode: mode } }));
}

export async function decideApproval(
  approvalId: string,
  decision: "approve" | "deny",
  opts: { reason?: string; remember?: boolean } = {},
): Promise<void> {
  await api().decideApproval(approvalId, {
    decision,
    ...(opts.reason ? { reason: opts.reason } : {}),
    ...(opts.remember ? { remember: true } : {}),
  });
}

export async function answerQuestion(
  questionId: string,
  answer: unknown,
  rev?: number,
): Promise<void> {
  await api().answerQuestion(questionId, { answer, ...(rev !== undefined ? { rev } : {}) });
}

/** 撤销代理保存的记忆（12 §2.2）。 */
export async function undoMemory(memoryId: string): Promise<void> {
  await api().deleteMemory(memoryId);
}

// ---------- 输入框附件 ----------

const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/;

function patchAttachment(scope: string, id: string, patch: Partial<ComposerAttachment>): void {
  updateAttachments(scope, (items) => items.map((a) => (a.id === id ? { ...a, ...patch } : a)));
}

interface AttachmentUpload {
  file: File;
  image: boolean;
  workspaceId: string;
  scope: string;
  directory?: string;
  running: boolean;
}
// Only unfinished uploads retain local File bytes; successful/removed files release them.
const attachmentUploads = new Map<string, AttachmentUpload>();
const uploadRecoveries = new Set<string>();
async function restorePendingUploads(scope: string): Promise<void> {
  if (uploadRecoveries.has(scope)) return;
  const pending = readAttachments(scope).filter(
    (item) => item.status !== "ready" && !attachmentUploads.has(item.id),
  );
  if (!pending.length) return;
  uploadRecoveries.add(scope);
  try {
    const stored = await readPendingUploads(scope);
    for (const item of pending) {
      if (!readAttachments(scope).some((current) => current.id === item.id)) continue;
      const record = stored.find((record) => record.id === item.id);
      if (!record || record.file.size !== item.size) {
        patchAttachment(scope, item.id, {
          status: "error",
          canRetry: false,
          error: "本地原文件不可用，请移除后重新添加",
        });
        continue;
      }
      attachmentUploads.set(item.id, {
        ...record,
        file: new File([record.file], item.name, { type: record.file.type }),
        running: false,
      });
      patchAttachment(scope, item.id, {
        status: "error",
        canRetry: true,
        error: "已恢复未完成的附件，点击重试上传",
        ...(record.image ? { previewUrl: URL.createObjectURL(record.file) } : {}),
      });
    }
    const retained = new Set(
      [...readAttachments(scope), ...readAttachmentDraft(persistentDraftStorage(), scope)].map(
        (item) => item.id,
      ),
    );
    for (const record of stored) if (!retained.has(record.id)) void removePendingUpload(record.id);
  } catch {
    for (const item of pending)
      patchAttachment(scope, item.id, {
        status: "error",
        canRetry: false,
        error: "无法读取本地原文件，请移除后重新添加",
      });
  } finally {
    uploadRecoveries.delete(scope);
  }
}
async function uploadComposerAttachment(id: string): Promise<string | undefined> {
  const job = attachmentUploads.get(id);
  if (!job || job.running) return;
  job.running = true;
  patchAttachment(job.scope, id, { status: "uploading", error: undefined, canRetry: false });
  try {
    if (job.image) {
      const ref = await api().uploadAttachment({
        name: job.file.name || "unnamed",
        data: job.file,
      });
      patchAttachment(job.scope, id, { status: "ready", ref, canRetry: false });
    } else {
      const { path } = await api().uploadFile(job.workspaceId, {
        name: job.file.name || "unnamed",
        data: job.file,
        ...(job.directory ? { path: job.directory } : {}),
      });
      patchAttachment(job.scope, id, { status: "ready", path, canRetry: false });
      void import("./files-store")
        .then(({ useFilesStore, loadDir }) => {
          if (useFilesStore.getState().workspaceId === job.workspaceId)
            return loadDir(job.directory ?? "");
        })
        .catch(() => undefined);
      return path;
    }
  } catch (error) {
    patchAttachment(job.scope, id, {
      status: "error",
      error: errorMessage(error, "上传失败"),
      canRetry: true,
    });
  } finally {
    job.running = false;
    const items =
      job.scope === attachmentScope(get()) ? get().attachments : readAttachments(job.scope);
    if (!items.some((a) => a.id === id && a.status === "error")) {
      attachmentUploads.delete(id);
      void removePendingUpload(id);
    }
  }
}
export async function retryComposerAttachment(id: string): Promise<void> {
  const item = get().attachments.find((a) => a.id === id);
  const job = attachmentUploads.get(id);
  if (item?.status !== "error" || !job || job.scope !== attachmentScope(get())) return;
  await uploadComposerAttachment(id);
}

/** New attachments need a settled conversation/workspace target. Existing upload jobs keep their own scope. */
export function canAddComposerAttachments(): boolean {
  const { loading, loadError } = get();
  if (!loading && !loadError) return true;
  setChatNotice(
    loading ? "对话正在加载，请稍后再添加附件" : "对话加载失败，请先重试再添加附件",
    "error",
  );
  return false;
}

/** 图片作为消息附件（视觉输入）；其他文件上传到工作区并以 @路径 引用。 */
export async function addComposerFiles(files: File[], directory?: string): Promise<string[]> {
  if (!canAddComposerAttachments()) return [];
  const { workspaceId } = get();
  const scope = attachmentScope(get());
  if (!workspaceId) return [];
  const pending: { file: File; item: ComposerAttachment; image: boolean }[] = [];
  let images = get().attachments.filter((a) => a.previewUrl || a.ref).length;
  for (const file of files) {
    const image =
      IMAGE_TYPES.test(file.type) ||
      (file.type === "" && /\.(png|jpe?g|gif|webp)$/i.test(file.name));
    if (image && images >= 8) {
      setChatNotice("一条消息最多附带 8 张图片", "error");
      continue;
    }
    if (image) images += 1;
    pending.push({
      file,
      image,
      item: {
        id: `att-${crypto.randomUUID()}`,
        name: file.name || "unnamed",
        size: file.size,
        ...(image ? { previewUrl: URL.createObjectURL(file) } : {}),
        status: "uploading",
      },
    });
  }
  set((s) => ({ attachments: [...s.attachments, ...pending.map((p) => p.item)] }));
  for (const { file, item, image } of pending)
    attachmentUploads.set(item.id, { file, image, workspaceId, scope, directory, running: false });
  const uploaded = await Promise.all(
    pending.map(async ({ item }) => {
      const job = attachmentUploads.get(item.id);
      if (!job) return;
      try {
        job.file = await snapshotUploadFile(job.file);
      } catch {
        patchAttachment(scope, item.id, {
          status: "error",
          canRetry: false,
          error: "无法读取附件原文件，请移除后重新添加",
        });
        attachmentUploads.delete(item.id);
        return;
      }
      const stored = await savePendingUpload({
        id: item.id,
        scope,
        workspaceId,
        file: job.file,
        image: job.image,
        directory,
      });
      if (!attachmentUploads.has(item.id)) {
        await removePendingUpload(item.id);
        return;
      }
      if (!stored && scope === attachmentScope(get()))
        setChatNotice("本地附件草稿未能保存；本次仍可上传，刷新前请等待上传完成", "info");
      return uploadComposerAttachment(item.id);
    }),
  );
  return uploaded.filter((path): path is string => typeof path === "string");
}

/** 已在工作区里的文件：直接以 @路径 引用，不重复上传。 */
export function attachWorkspaceFile(path: string, size = 0): void {
  if (!canAddComposerAttachments()) return;
  if (get().attachments.some((a) => a.path === path)) return;
  const name = path.split("/").pop() || path;
  set((s) => ({
    attachments: [
      ...s.attachments,
      { id: `att-${crypto.randomUUID()}`, name, size, path, status: "ready" },
    ],
  }));
}

export function removeComposerAttachment(id: string): void {
  attachmentUploads.delete(id);
  void removePendingUpload(id);
  const item = get().attachments.find((a) => a.id === id);
  if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
  set((s) => ({ attachments: s.attachments.filter((a) => a.id !== id) }));
}
