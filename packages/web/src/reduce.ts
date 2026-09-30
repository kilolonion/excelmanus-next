// 会话同步消息的纯函数还原器（11 §3.6）：
// 未知类型 console.warn 忽略；rec 按 seq 幂等；delta 累积为当前流式文本；
// model.output 到达后替换临时文本；attempt.discarded 清除临时显示。

import type { ServerMessage } from "@excelmanus/protocol";

export interface UiMessage {
  id: string;
  role: "user" | "assistant" | "compaction";
  text: string;
  agentId?: string | null;
  mode?: "steer" | "interrupt" | "queue";
  /** 派发状态（04 §4.3）：accepted 不展示；queued 可撤回。 */
  dispatchStatus?: "accepted" | "queued" | "applied" | "cancelled" | "failed";
  /** role === "compaction" 时存在：压缩前后 token 与触发来源。 */
  compaction?: {
    trigger: "auto" | "manual" | "overflow";
    beforeTokens: number;
    afterTokens: number;
    estimated: boolean;
  };
}

export interface ToolCard {
  toolCallId: string;
  name: string;
  status: "pending" | "ok" | "error" | "not_executed" | "cancelled" | "uncertain";
  args?: string;
  targets?: string[];
  resultSummary?: string;
  docId?: string;
}

export interface ApprovalCard {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  args?: unknown;
  targets: string[];
  effect: string;
  spec?: Record<string, unknown>;
  status: "pending" | "approved" | "denied";
  decision?: "approved" | "denied";
  reason?: string;
  remember?: boolean;
  agentId?: string | null;
}

export interface QuestionCard {
  questionId: string;
  questionType: "choice" | "text" | "range_confirm" | "range_pick" | "change_confirm";
  spec: Record<string, unknown>;
  status: "pending" | "answered";
  answer?: unknown;
  rev?: number;
  agentId?: string | null;
}

export interface TodoItem {
  id: string;
  [key: string]: unknown;
}

export interface SessionState {
  /** 已应用的最大 seq（游标）。 */
  cursor: number;
  messages: UiMessage[];
  tools: ToolCard[];
  running: boolean;
  streamingText: string;
  reasoningText: string;
  /** 正在累积参数的工具调用（tool-input delta）。 */
  pendingToolArgs: Record<string, { name: string; args: string }>;
  retry: { attempt: number; waitMs: number } | null;
  error: { kind: string; message: string } | null;
  /** 各代理最新状态（与 agents 投影同词表），由轮边界与 agent.status 记录维护。 */
  agentStatus: Record<string, string>;
  approvals: ApprovalCard[];
  questions: QuestionCard[];
  todos: TodoItem[];
  /** 当前上下文占用（usage.updated.context，04 §6.1）；无数据为 null。 */
  contextUsage: { tokens: number; window: number | null; estimated: boolean } | null;
}

export const initialSessionState = (): SessionState => ({
  cursor: 0,
  messages: [],
  tools: [],
  running: false,
  streamingText: "",
  reasoningText: "",
  pendingToolArgs: {},
  retry: null,
  error: null,
  agentStatus: {},
  approvals: [],
  questions: [],
  todos: [],
  contextUsage: null,
});

function summarizeResult(result: unknown): string {
  try {
    const s = JSON.stringify(result);
    return s.length > 160 ? `${s.slice(0, 160)}…` : s;
  } catch {
    return String(result);
  }
}

function normalizeTodos(items: unknown[]): TodoItem[] {
  return items.map((raw, i) => {
    const item: Record<string, unknown> =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? { ...(raw as Record<string, unknown>) }
        : { title: String(raw ?? "") };
    const id = typeof item.id === "string" && item.id !== "" ? item.id : `todo-${i}`;
    return { ...item, id };
  });
}

function applyRecord(
  s: SessionState,
  type: string,
  data: Record<string, unknown>,
  meta: { agentId?: string | null } = {},
): SessionState {
  switch (type) {
    case "session.created":
    case "session.updated":
    case "agent.spawned":
      return s;
    case "user.message": {
      const id = typeof data.dispatchId === "string" ? data.dispatchId : `u${s.messages.length}`;
      if (s.messages.some((m) => m.id === id)) return s;
      const mode =
        data.mode === "steer" || data.mode === "interrupt" || data.mode === "queue"
          ? data.mode
          : "steer";
      return {
        ...s,
        messages: [
          ...s.messages,
          {
            id,
            role: "user",
            text: String(data.text ?? ""),
            agentId: meta.agentId ?? null,
            mode,
            dispatchStatus: "accepted",
          },
        ],
      };
    }
    case "dispatch.updated": {
      const dispatchId = typeof data.dispatchId === "string" ? data.dispatchId : "";
      const status = data.status;
      if (
        dispatchId === "" ||
        (status !== "accepted" &&
          status !== "queued" &&
          status !== "applied" &&
          status !== "cancelled" &&
          status !== "failed")
      ) {
        return s;
      }
      return {
        ...s,
        messages: s.messages.map((m) =>
          m.id === dispatchId ? { ...m, dispatchStatus: status } : m,
        ),
      };
    }
    case "agent.status": {
      const status = typeof data.status === "string" ? data.status : "";
      if (meta.agentId == null || status === "") return s;
      return { ...s, agentStatus: { ...s.agentStatus, [meta.agentId]: status } };
    }
    case "turn.started": {
      const agentStatus =
        meta.agentId == null ? s.agentStatus : { ...s.agentStatus, [meta.agentId]: "running" };
      return { ...s, running: true, error: null, retry: null, agentStatus };
    }
    case "step.started":
      return { ...s, streamingText: "", reasoningText: s.reasoningText };
    case "model.output": {
      const text = typeof data.text === "string" ? data.text : s.streamingText;
      const reasoning = typeof data.reasoning === "string" ? data.reasoning : s.reasoningText;
      const toolCalls = Array.isArray(data.toolCalls)
        ? (data.toolCalls as { id?: string; name?: string; args?: unknown }[])
        : [];
      const tools = [...s.tools];
      for (const tc of toolCalls) {
        const id = tc.id ?? "";
        if (id === "" || tools.some((t) => t.toolCallId === id)) continue;
        tools.push({
          toolCallId: id,
          name: tc.name ?? "?",
          status: "pending",
          ...(typeof tc.args === "string" ? { args: tc.args } : {}),
        });
      }
      const last = s.messages[s.messages.length - 1];
      const messages =
        text === ""
          ? s.messages
          : last?.role === "assistant" && last.id.startsWith("m-output")
            ? [...s.messages.slice(0, -1), { ...last, text }]
            : [
                ...s.messages,
                {
                  id: `m-output-${s.cursor}-${s.messages.length}`,
                  role: "assistant" as const,
                  text,
                },
              ];
      return { ...s, messages, tools, streamingText: "", reasoningText: reasoning };
    }
    case "attempt.discarded":
      return { ...s, streamingText: "", pendingToolArgs: {} };
    case "tool.intent": {
      const toolCallId = String(data.toolCallId ?? "");
      const tools = [...s.tools];
      const i = tools.findIndex((t) => t.toolCallId === toolCallId);
      const card: ToolCard = {
        toolCallId,
        name: String(data.toolName ?? "?"),
        status: "pending",
        args: typeof data.args === "string" ? data.args : JSON.stringify(data.args ?? {}),
        targets: Array.isArray(data.targets) ? (data.targets as string[]) : [],
      };
      if (i >= 0) tools[i] = { ...tools[i], ...card };
      else tools.push(card);
      return { ...s, tools };
    }
    case "tool.result": {
      const toolCallId = String(data.toolCallId ?? "");
      const res = data.result as
        | { status?: string; data?: unknown; error?: { message?: string } }
        | undefined;
      const status =
        res?.status === "ok"
          ? "ok"
          : res?.status === "not_executed"
            ? "not_executed"
            : res?.status === "uncertain"
              ? "uncertain"
              : "error";
      const summary =
        res?.status === "ok"
          ? summarizeResult(res.data)
          : (res?.error?.message ?? res?.status ?? "");
      const output = res?.data as { docId?: unknown } | undefined;
      const docId = typeof output?.docId === "string" ? output.docId : undefined;
      const tools = s.tools.map((t) =>
        t.toolCallId === toolCallId
          ? {
              ...t,
              status: status as ToolCard["status"],
              resultSummary: summary,
              ...(docId ? { docId } : {}),
            }
          : t,
      );
      if (!tools.some((t) => t.toolCallId === toolCallId)) {
        tools.push({ toolCallId, name: "?", status, resultSummary: summary });
      }
      return { ...s, tools };
    }
    case "approval.requested": {
      const approvalId = String(data.approvalId ?? "");
      if (approvalId === "") return s;
      const card: ApprovalCard = {
        approvalId,
        toolCallId: String(data.toolCallId ?? ""),
        toolName: String(data.toolName ?? "?"),
        args: data.args,
        targets: Array.isArray(data.targets)
          ? data.targets.filter((x): x is string => typeof x === "string")
          : [],
        effect: String(data.effect ?? "write"),
        ...(data.spec && typeof data.spec === "object" && !Array.isArray(data.spec)
          ? { spec: data.spec as Record<string, unknown> }
          : {}),
        status: "pending",
        ...(meta.agentId !== undefined ? { agentId: meta.agentId } : {}),
      };
      const i = s.approvals.findIndex((a) => a.approvalId === approvalId);
      const approvals = [...s.approvals];
      if (i >= 0) {
        const existing = approvals[i];
        if (existing) approvals[i] = { ...existing, ...card, status: existing.status };
      } else approvals.push(card);
      return { ...s, approvals };
    }
    case "approval.decided": {
      const approvalId = String(data.approvalId ?? "");
      const decision: ApprovalCard["status"] | undefined =
        data.decision === "approved"
          ? "approved"
          : data.decision === "denied"
            ? "denied"
            : undefined;
      if (!approvalId || !decision) return s;
      const approvals = s.approvals.map((a) =>
        a.approvalId === approvalId
          ? {
              ...a,
              status: decision,
              decision,
              ...(typeof data.reason === "string" ? { reason: data.reason } : {}),
              ...(typeof data.remember === "boolean" ? { remember: data.remember } : {}),
            }
          : a,
      );
      return { ...s, approvals };
    }
    case "question.asked": {
      const questionId = String(data.questionId ?? "");
      if (!questionId) return s;
      const questionType = data.questionType;
      if (
        questionType !== "choice" &&
        questionType !== "text" &&
        questionType !== "range_confirm" &&
        questionType !== "range_pick" &&
        questionType !== "change_confirm"
      )
        return s;
      const spec =
        data.spec && typeof data.spec === "object" && !Array.isArray(data.spec)
          ? (data.spec as Record<string, unknown>)
          : {};
      const card: QuestionCard = {
        questionId,
        questionType,
        spec,
        status: "pending",
        ...(meta.agentId !== undefined ? { agentId: meta.agentId } : {}),
      };
      const i = s.questions.findIndex((q) => q.questionId === questionId);
      const questions = [...s.questions];
      if (i >= 0) {
        const existing = questions[i];
        if (existing) questions[i] = { ...existing, ...card, status: existing.status };
      } else questions.push(card);
      return { ...s, questions };
    }
    case "question.answered": {
      const questionId = String(data.questionId ?? "");
      if (!questionId) return s;
      return {
        ...s,
        questions: s.questions.map((q) =>
          q.questionId === questionId
            ? {
                ...q,
                status: "answered",
                answer: data.answer,
                ...(typeof data.rev === "number" ? { rev: data.rev } : {}),
              }
            : q,
        ),
      };
    }
    case "todo.set": {
      if (!Array.isArray(data.items)) return s;
      return { ...s, todos: normalizeTodos(data.items) };
    }
    case "todo.updated": {
      const todoId = typeof data.todoId === "string" ? data.todoId : "";
      if (!todoId) return s;
      return {
        ...s,
        todos: s.todos.map((item) =>
          item.id === todoId
            ? {
                ...item,
                ...(typeof data.status === "string" ? { status: data.status } : {}),
                ...(Object.hasOwn(data, "result") ? { result: data.result } : {}),
              }
            : item,
        ),
      };
    }
    case "retry.scheduled":
      return {
        ...s,
        retry: { attempt: Number(data.attempt ?? 0), waitMs: Number(data.waitMs ?? 0) },
      };
    case "error.guidance":
      return {
        ...s,
        error: { kind: String(data.kind ?? "unknown"), message: String(data.message ?? "") },
      };
    case "turn.completed":
    case "turn.interrupted":
    case "turn.failed": {
      const agentStatus =
        meta.agentId == null
          ? s.agentStatus
          : {
              ...s.agentStatus,
              [meta.agentId]:
                type === "turn.completed"
                  ? "idle"
                  : type === "turn.interrupted"
                    ? "interrupted"
                    : "failed",
            };
      return { ...s, running: false, streamingText: "", retry: null, agentStatus };
    }
    case "usage.updated": {
      const ctx = data.context as
        | { tokens?: unknown; window?: unknown; estimated?: unknown }
        | undefined;
      if (!ctx || typeof ctx.tokens !== "number") return s;
      return {
        ...s,
        contextUsage: {
          tokens: ctx.tokens,
          window: typeof ctx.window === "number" ? ctx.window : null,
          estimated: ctx.estimated === true,
        },
      };
    }
    case "compaction": {
      const id = `cmp-${s.cursor}`;
      const beforeTokens = Number(data.beforeTokens ?? 0);
      const afterTokens = Number(data.afterTokens ?? 0);
      const trigger =
        data.trigger === "manual" || data.trigger === "overflow" ? data.trigger : "auto";
      return {
        ...s,
        messages: [
          ...s.messages,
          {
            id,
            role: "compaction",
            text: String(data.summary ?? ""),
            agentId: meta.agentId ?? null,
            compaction: {
              trigger,
              beforeTokens,
              afterTokens,
              estimated: data.estimated === true,
            },
          },
        ],
        contextUsage: {
          tokens: afterTokens,
          window: s.contextUsage?.window ?? null,
          estimated: true,
        },
      };
    }
    default:
      console.warn(`未知记录类型：${type}`);
      return s;
  }
}

export function reduceSession(state: SessionState, msg: ServerMessage): SessionState {
  if (msg.type === "rec") {
    if (msg.seq <= state.cursor) return state;
    const next = {
      ...applyRecord(state, msg.record.type, msg.record.data as Record<string, unknown>, {
        agentId: msg.record.agentId,
      }),
    };
    next.cursor = Math.max(state.cursor, msg.seq);
    return next;
  }
  if (msg.type === "delta") {
    const payload =
      typeof msg.payload === "string" ? msg.payload : JSON.stringify(msg.payload ?? "");
    if (msg.kind === "text") {
      return { ...state, streamingText: state.streamingText + payload };
    }
    if (msg.kind === "reasoning") {
      return { ...state, reasoningText: state.reasoningText + payload };
    }
    if (msg.kind === "tool_args") {
      // payload 形如 {id, delta} 或为纯字符串
      const p = msg.payload as { id?: string; delta?: string; name?: string } | string;
      const id = typeof p === "object" ? (p.id ?? "") : "";
      const delta = typeof p === "object" ? (p.delta ?? "") : p;
      const cur = state.pendingToolArgs[id] ?? {
        name: typeof p === "object" ? (p.name ?? "") : "",
        args: "",
      };
      return {
        ...state,
        pendingToolArgs: {
          ...state.pendingToolArgs,
          [id]: { name: cur.name, args: cur.args + delta },
        },
      };
    }
    return state;
  }
  if (msg.type === "snapshot") {
    return { ...state, streamingText: msg.text, reasoningText: msg.reasoning };
  }
  return state;
}

/** 文档同步状态（11 §3.6）：rev 跟踪 + 本端 doc.submit 的待确认集。 */
export interface DocSyncState {
  rev: number;
  pending: Record<
    string,
    { status: "pending" | "acked" | "rejected"; rev?: number; conflict?: unknown }
  >;
}

export const initialDocSync = (rev = 0): DocSyncState => ({ rev, pending: {} });

export function reduceDoc(state: DocSyncState, msg: ServerMessage): DocSyncState {
  switch (msg.type) {
    case "sub.ok":
      return msg.headCursor > state.rev ? { ...state, rev: msg.headCursor } : state;
    case "doc.op":
      // 分片的各 chunk 携带同一 rev；按 rev 幂等推进
      return msg.rev > state.rev ? { ...state, rev: msg.rev } : state;
    case "doc.ack": {
      const p = state.pending[msg.clientOpId];
      if (p?.status !== "pending") return state;
      return {
        ...state,
        rev: Math.max(state.rev, msg.rev),
        pending: {
          ...state.pending,
          [msg.clientOpId]: { status: "acked", rev: msg.rev },
        },
      };
    }
    case "doc.reject": {
      const p = state.pending[msg.clientOpId];
      if (p?.status !== "pending") return state;
      return {
        ...state,
        pending: {
          ...state.pending,
          [msg.clientOpId]: { status: "rejected", conflict: msg.conflict },
        },
      };
    }
    case "doc.reload":
      return msg.rev > state.rev ? { ...state, rev: msg.rev } : state;
    default:
      return state;
  }
}

export function trackDocSubmit(state: DocSyncState, clientOpId: string): DocSyncState {
  return {
    ...state,
    pending: { ...state.pending, [clientOpId]: { status: "pending" } },
  };
}

/** 同代理中排在 msg 之前、仍未应用的 queue 模式消息数（02 §3.2 “前面还有 N 条”）。 */
export function queueAhead(s: SessionState, msg: UiMessage): number {
  let n = 0;
  for (const m of s.messages) {
    if (m.id === msg.id) break;
    if (
      m.role === "user" &&
      (m.agentId ?? null) === (msg.agentId ?? null) &&
      m.mode === "queue" &&
      m.dispatchStatus === "queued"
    ) {
      n += 1;
    }
  }
  return n;
}

/** 某代理仍未应用的派发数（停止后挂起的排队消息，04 §4.2）。 */
export function queuedCount(s: SessionState, agentId: string): number {
  return s.messages.filter(
    (m) => m.role === "user" && (m.agentId ?? null) === agentId && m.dispatchStatus === "queued",
  ).length;
}

/** 排序展示：把工具卡片并入消息流（按序追加在最新消息之后的简化模型）。 */
export function displayItems(s: SessionState): Array<UiMessage | (ToolCard & { kind: "tool" })> {
  const items: Array<UiMessage | (ToolCard & { kind: "tool" })> = [...s.messages];
  for (const t of s.tools) items.push({ ...t, kind: "tool" });
  if (s.streamingText !== "") {
    items.push({ id: "streaming", role: "assistant", text: s.streamingText });
  }
  return items;
}
