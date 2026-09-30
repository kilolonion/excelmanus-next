// 会话同步消息的纯函数还原器（11 §3.6）：
// 未知类型 console.warn 忽略；rec 按 seq 幂等；delta 累积为当前流式文本；
// model.output 到达后替换临时文本；attempt.discarded 清除临时显示。

import type { ServerMessage } from "@excelmanus/protocol";

export interface UiMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}

export interface ToolCard {
  toolCallId: string;
  name: string;
  status: "pending" | "ok" | "error" | "not_executed" | "cancelled";
  args?: string;
  targets?: string[];
  resultSummary?: string;
  docId?: string;
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
});

function summarizeResult(result: unknown): string {
  try {
    const s = JSON.stringify(result);
    return s.length > 160 ? `${s.slice(0, 160)}…` : s;
  } catch {
    return String(result);
  }
}

function applyRecord(s: SessionState, type: string, data: Record<string, unknown>): SessionState {
  switch (type) {
    case "session.created":
    case "session.updated":
    case "agent.spawned":
    case "agent.status":
      return s;
    case "user.message": {
      const id = typeof data.dispatchId === "string" ? data.dispatchId : `u${s.messages.length}`;
      if (s.messages.some((m) => m.id === id)) return s;
      return {
        ...s,
        messages: [...s.messages, { id, role: "user", text: String(data.text ?? "") }],
      };
    }
    case "dispatch.updated":
      return s;
    case "turn.started":
      return { ...s, running: true, error: null, retry: null };
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
        res?.status === "ok" ? "ok" : res?.status === "not_executed" ? "not_executed" : "error";
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
      return { ...s, running: false, streamingText: "", retry: null };
    case "turn.failed":
      return { ...s, running: false, streamingText: "", retry: null };
    case "usage.updated":
      return s;
    default:
      console.warn(`未知记录类型：${type}`);
      return s;
  }
}

export function reduceSession(state: SessionState, msg: ServerMessage): SessionState {
  if (msg.type === "rec") {
    if (msg.seq <= state.cursor) return state;
    const next = {
      ...applyRecord(state, msg.record.type, msg.record.data as Record<string, unknown>),
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

/** 排序展示：把工具卡片并入消息流（按序追加在最新消息之后的简化模型）。 */
export function displayItems(s: SessionState): Array<UiMessage | (ToolCard & { kind: "tool" })> {
  const items: Array<UiMessage | (ToolCard & { kind: "tool" })> = [...s.messages];
  for (const t of s.tools) items.push({ ...t, kind: "tool" });
  if (s.streamingText !== "") {
    items.push({ id: "streaming", role: "assistant", text: s.streamingText });
  }
  return items;
}
