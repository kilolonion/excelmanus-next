// 当前会话：日志还原状态（唯一事实源是服务端会话日志）+ 输入框附件 + 全部对话动作。
// 发送后先显示一条乐观消息，日志里出现同 clientMessageId 的 user.message 后由真实记录接替。

import type {
  AttachmentRef,
  ContextRef,
  DispatchMode,
  PermissionMode,
  ServerMessage,
} from "@excelmanus/protocol";
import { create } from "zustand";
import { api, errorMessage } from "@/lib/backend/api";
import { onSync, subscribeTopic, unsubscribeTopic } from "@/lib/backend/channel";
import { initialSessionState, MAIN_AGENT, reduceSession, seedRoster } from "@/lib/session/reducer";
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
}

interface ChatState {
  sessionId: string | null;
  workspaceId: string | null;
  /** 会话详情/日志回放尚未追上服务端游标。 */
  loading: boolean;
  loadError: string | null;
  /** sub.ok 报告的日志头；cursor 追上它之前视为正在回放历史。 */
  headCursor: number;
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

let seq = 0;
const nextClientId = () => `web-${Date.now().toString(36)}-${(++seq).toString(36)}`;
const topicOf = (id: string) => `session:${id}`;
let loadRequest = 0;

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

/** 切换到某会话：重置还原状态，经同步通道从头回放日志。 */
export async function loadChatSession(sessionId: string): Promise<{ workspaceId: string }> {
  const request = ++loadRequest;
  const previous = get().sessionId;
  if (previous && previous !== sessionId) unsubscribeTopic(topicOf(previous));
  for (const a of get().attachments) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
  set({
    sessionId,
    loading: true,
    loadError: null,
    headCursor: Number.MAX_SAFE_INTEGER,
    session: initialSessionState(),
    viewAgentId: MAIN_AGENT,
    optimistic: [],
    compacting: {},
    ...(previous !== sessionId ? { attachments: [], notice: null } : {}),
  });
  try {
    const detail = await api().getSession(sessionId);
    if (request !== loadRequest) return { workspaceId: detail.session.workspaceId };
    set((s) => ({
      workspaceId: detail.session.workspaceId,
      headCursor: detail.headSeq,
      loading: detail.headSeq > s.session.cursor,
      session: {
        ...seedRoster(s.session, detail.agents),
        permissionMode: s.session.permissionMode ?? detail.session.permissionMode,
        title: s.session.title ?? detail.session.title,
      },
    }));
    subscribeTopic(topicOf(sessionId), () => get().session.cursor);
    return { workspaceId: detail.session.workspaceId };
  } catch (error) {
    if (request === loadRequest)
      set({ loading: false, loadError: errorMessage(error, "会话加载失败") });
    throw error;
  }
}

export function clearChatSession(): void {
  const { sessionId } = get();
  if (sessionId) unsubscribeTopic(topicOf(sessionId));
  loadRequest += 1;
  set({
    sessionId: null,
    workspaceId: null,
    loading: false,
    loadError: null,
    session: initialSessionState(),
    optimistic: [],
  });
}

export function setViewAgent(agentId: string): void {
  set({ viewAgentId: agentId });
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
  const cmd = text.trim();
  const model = /^\/model\s+(.+)$/.exec(cmd);
  if (model?.[1]) {
    const res = await api().switchAgentModel(sessionId, agentId, { modelName: model[1].trim() });
    setChatNotice(`已切换到模型档案「${res.name}」`);
    return true;
  }
  if (cmd === "/compact") {
    const res = await api().compactAgent(sessionId, agentId);
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
    try {
      if (await runCommand(text, agentId)) return true;
    } catch (error) {
      setChatNotice(errorMessage(error, "命令执行失败"), "error");
      return false;
    }
  }
  const attachments = get().attachments;
  if (attachments.some((a) => a.status === "uploading")) {
    setChatNotice("附件仍在上传，请稍候再发送", "error");
    return false;
  }
  const ready = attachments.filter((a) => a.status === "ready");
  const refs = ready.flatMap((a) => (a.ref ? [a.ref] : []));
  const references = ready.flatMap((a) => (a.path ? [`@${a.path}`] : []));
  const body = [text, ...references].filter(Boolean).join("\n");
  if (!body) return false;
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
      ...(get().chatMode !== "write" ? { chatMode: get().chatMode as "ask" | "plan" } : {}),
      ...(context.length > 0 ? { context } : {}),
      ...(refs.length > 0 ? { attachments: refs } : {}),
      ...(opts.replacesDispatchId ? { replacesDispatchId: opts.replacesDispatchId } : {}),
    });
    const sent = new Set(ready.map((a) => a.id));
    for (const a of ready) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    set((s) => ({ attachments: s.attachments.filter((a) => !sent.has(a.id)) }));
    return true;
  } catch (error) {
    const message = errorMessage(error, "发送失败，请重试");
    set((s) => ({
      optimistic: s.optimistic.map((o) =>
        o.clientMessageId === clientMessageId ? { ...o, error: message } : o,
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
  await api().cancelDispatch(requireSession(), item.id);
  insertIntoComposer(item.text, true);
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
        o.clientMessageId === clientMessageId ? { ...o, error: message } : o,
      ),
    }));
    return false;
  }
}

/** 重新发送一条失败的乐观消息（原文、选区与图片不变）。 */
export async function resendFailedMessage(clientMessageId: string): Promise<boolean> {
  const item = get().optimistic.find((o) => o.clientMessageId === clientMessageId);
  if (!item) return false;
  set((s) => ({ optimistic: s.optimistic.filter((o) => o.clientMessageId !== clientMessageId) }));
  return dispatchText(item.agentId, item.text, {
    context: item.context,
    attachments: item.attachments,
  });
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
  try {
    if (opts.modelProfileId)
      await api().switchAgentModel(sessionId, item.agentId, {
        modelProfileId: opts.modelProfileId,
      });
    await api().rewindAgent(sessionId, item.agentId, { dispatchId: item.id });
  } catch (error) {
    setChatNotice(errorMessage(error, "无法从这条消息重新开始"), "error");
    return false;
  }
  return dispatchText(item.agentId, opts.text ?? item.text, {
    context: item.context,
    attachments: item.attachments,
  });
}

/** 只回到某条消息之前（不重新发送）：原文放回输入框。 */
export async function rewindTo(item: UserItem): Promise<boolean> {
  try {
    await api().rewindAgent(requireSession(), item.agentId, { dispatchId: item.id });
    insertIntoComposer(item.text, true);
    return true;
  } catch (error) {
    setChatNotice(errorMessage(error, "无法回到这条消息"), "error");
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
  await api().updateSession(sessionId, { permissionMode: mode });
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
let attachSeq = 0;

function patchAttachment(id: string, patch: Partial<ComposerAttachment>): void {
  set((s) => ({ attachments: s.attachments.map((a) => (a.id === id ? { ...a, ...patch } : a)) }));
}

/** 图片作为消息附件（视觉输入）；其他文件上传到工作区并以 @路径 引用。 */
export async function addComposerFiles(files: File[], directory?: string): Promise<string[]> {
  const { workspaceId, sessionId } = get();
  if (!workspaceId) return [];
  const uploaded: string[] = [];
  const pending: { file: File; item: ComposerAttachment; image: boolean }[] = [];
  let images = get().attachments.filter((a) => a.previewUrl).length;
  for (const file of files) {
    const image =
      IMAGE_TYPES.test(file.type) ||
      (file.type === "" && /\.(png|jpe?g|gif|webp)$/i.test(file.name));
    if (image && images >= 8) {
      setChatNotice("一条消息最多附带 8 张图片", "error");
      continue;
    }
    if (image) images += 1;
    attachSeq += 1;
    pending.push({
      file,
      image,
      item: {
        id: `att-${attachSeq}`,
        name: file.name || "unnamed",
        size: file.size,
        ...(image ? { previewUrl: URL.createObjectURL(file) } : {}),
        status: "uploading",
      },
    });
  }
  set((s) => ({ attachments: [...s.attachments, ...pending.map((p) => p.item)] }));
  await Promise.all(
    pending.map(async ({ file, item, image }) => {
      try {
        if (image) {
          const ref = await api().uploadAttachment({ name: item.name, data: file });
          patchAttachment(item.id, { status: "ready", ref });
        } else {
          const { path } = await api().uploadFile(workspaceId, {
            name: item.name,
            data: file,
            ...(directory ? { path: directory } : {}),
          });
          uploaded.push(path);
          patchAttachment(item.id, { status: "ready", path });
        }
      } catch (error) {
        if (get().sessionId === sessionId)
          patchAttachment(item.id, { status: "error", error: errorMessage(error, "上传失败") });
      }
    }),
  );
  return uploaded;
}

/** 已在工作区里的文件：直接以 @路径 引用，不重复上传。 */
export function attachWorkspaceFile(path: string, size = 0): void {
  if (get().attachments.some((a) => a.path === path)) return;
  attachSeq += 1;
  const name = path.split("/").pop() || path;
  set((s) => ({
    attachments: [...s.attachments, { id: `att-${attachSeq}`, name, size, path, status: "ready" }],
  }));
}

export function removeComposerAttachment(id: string): void {
  const item = get().attachments.find((a) => a.id === id);
  if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
  set((s) => ({ attachments: s.attachments.filter((a) => a.id !== id) }));
}

const attachmentUrls = new Map<string, Promise<string>>();
/** 已发送消息里的图片缩略图：带鉴权取 Blob 转 object URL（同一附件只取一次）。 */
export function attachmentUrl(sha256: string): Promise<string> {
  let p = attachmentUrls.get(sha256);
  if (!p) {
    p = api()
      .getAttachment(sha256)
      .then((blob) => URL.createObjectURL(blob));
    attachmentUrls.set(sha256, p);
    p.catch(() => attachmentUrls.delete(sha256));
  }
  return p;
}
