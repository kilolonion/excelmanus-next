// 会话同步消息的纯函数还原器（11 §3.6）：
// 未知类型 console.warn 忽略；rec 按 seq 幂等；delta 累积为当前流式文本；
// model.output 到达后替换临时文本；attempt.discarded 清除临时显示。
// M4（05）：状态按代理分流——live 瞬时字段、todos、tools、approvals/questions
// 都以 record.agentId 归档；roster 由 agent.spawned/status 与轮边界维护；
// inbox.sent 还原为 internal 消息（不参与任何代理的对话流归属判定）。

import type { ServerMessage } from "@excelmanus/protocol";

export interface UiMessage {
  id: string;
  role: "user" | "assistant" | "compaction" | "internal" | "memory" | "notice";
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
  /** role === "internal" 时存在：代理间消息（05 §4）的发送方/接收方/类型。 */
  internal?: { from: string; to: string; kind: string };
  /** memory.saved：可撤销的"已记住"提示（12 §2.2）。 */
  memory?: { memoryId: string; category: string; deleted: boolean };
  /** context.notice：环境变化说明（规则/技能更新）。 */
  noticeKind?: string;
  /** 助手消息：该步模型实际返回的思考内容（02 §3.1，默认折叠）。 */
  reasoning?: string;
  /** 思考时长（model.output.reasoningMs）。 */
  reasoningMs?: number;
  /** 用户消息：图片附件（只有引用，缩略图按需取）。 */
  attachments?: { sha256: string; mediaType: string; name: string }[];
  /** 用户消息：本条附带的区域上下文（02 §3.2 徽标）。 */
  context?: { docId: string; rev: number; range: string }[];
  /** 记录写入时间（ISO 8601 UTC）。 */
  at?: string;
  /** 产生该消息的记录 seq（与工具卡交错排序用）。 */
  seq?: number;
}

export interface ToolCard {
  toolCallId: string;
  name: string;
  status: "pending" | "ok" | "error" | "not_executed" | "cancelled" | "uncertain";
  args?: string;
  targets?: string[];
  resultSummary?: string;
  /** 成功时的一行结果摘要（由 tool.result 数据得出）。 */
  headline?: string;
  /** 执行耗时（tool.result.durationMs），不含审批与等待回答。 */
  durationMs?: number;
  docId?: string;
  agentId?: string | null;
  /** 首次出现时的记录 seq。 */
  seq?: number;
}

/** 本会话实际提交的工作簿变更（来自 workbook_edit 的 tool.result，非模型自述）。 */
export interface ChangeEntry {
  toolCallId: string;
  docId: string;
  path: string;
  rev: number | null;
  ranges: string[];
  cells: number;
  structural: string[];
  backupPath?: string;
  agentId?: string | null;
  seq: number;
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

/** 每个代理的瞬时（非持久化）状态：流式文本、参数累积、重试与错误提示。 */
export interface AgentLive {
  streamingText: string;
  reasoningText: string;
  pendingToolArgs: Record<string, { name: string; args: string }>;
  retry: { attempt: number; waitMs: number } | null;
  error: { kind: string; message: string } | null;
  /** 该代理最近一次 usage.updated.context（04 §6.1）。 */
  contextUsage: { tokens: number; window: number | null; estimated: boolean } | null;
  /** 正在进行的工作簿活动（workbook_activity 瞬时增量，02 §4.2 "正在读取"）。 */
  activity: WorkbookActivityItem[];
}

export interface WorkbookActivityItem {
  toolCallId: string;
  kind: "read" | "write";
  docId?: string;
  path?: string;
  ranges: string[];
}

const emptyLive = (): AgentLive => ({
  streamingText: "",
  reasoningText: "",
  pendingToolArgs: {},
  retry: null,
  error: null,
  contextUsage: null,
  activity: [],
});

/** 团队名册（02 §5）：由 agent.spawned 建立，agent.status/轮边界/审批记录更新。 */
export interface RosterEntry {
  id: string;
  name: string | null;
  role: string | null;
  parentId: string | null;
  status: string;
  lastTool?: string | null;
  tokens?: number;
  /** 当前模型档案（agent.spawned / agent.updated）；null = 会话默认。 */
  modelProfileId?: string | null;
}

export interface SessionState {
  /** 已应用的最大 seq（游标）。 */
  cursor: number;
  /** 全部代理的消息（user/assistant/compaction/internal 混合，按 seq 排序）。 */
  messages: UiMessage[];
  tools: ToolCard[];
  /** 各代理最新状态（与 agents 投影同词表）。 */
  agentStatus: Record<string, string>;
  roster: Record<string, RosterEntry>;
  approvals: ApprovalCard[];
  questions: QuestionCard[];
  /** 按代理分组的待办。 */
  todos: Record<string, TodoItem[]>;
  /** 按代理分组的瞬时状态。 */
  live: Record<string, AgentLive>;
  /** 已提交的工作簿变更（按 seq 递增）。 */
  changes: ChangeEntry[];
  /** 会话权限模式（session.created / session.updated）。 */
  permissionMode: string | null;
}

export const initialSessionState = (): SessionState => ({
  cursor: 0,
  messages: [],
  tools: [],
  agentStatus: {},
  roster: {},
  approvals: [],
  questions: [],
  todos: {},
  live: {},
  changes: [],
  permissionMode: null,
});

/** 会话详情预填名册（日志回放前 roster 已有名字/角色可显示）。 */
export function seedRoster(
  s: SessionState,
  agents: {
    id: string;
    name?: string | null;
    role?: string | null;
    parentId?: string | null;
    status?: string;
    modelProfileId?: string | null;
  }[],
): SessionState {
  const roster = { ...s.roster };
  const agentStatus = { ...s.agentStatus };
  for (const a of agents) {
    roster[a.id] = {
      id: a.id,
      name: a.name ?? null,
      role: a.role ?? null,
      parentId: a.parentId ?? null,
      status: a.status ?? "idle",
      modelProfileId: a.modelProfileId ?? null,
    };
    if (a.status !== undefined) agentStatus[a.id] = a.status;
  }
  return { ...s, roster, agentStatus };
}

/** 成功工具卡的一行结果摘要（02 §3.1）：只取 tool.result 里的已知字段，认不出时不显示。 */
export function resultHeadline(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const d = result as Record<string, unknown>;
  const parts: string[] = [];
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  const changes = d.changes as { ranges?: unknown; cellsBySheet?: unknown } | undefined;
  if (Array.isArray(d.sheets)) {
    const sheets = d.sheets as { cells?: unknown }[];
    const cells = sheets.reduce((n, s) => n + (num(s.cells) ?? 0), 0);
    parts.push(`${sheets.length} 个工作表`, `${cells} 个非空单元格`);
  } else if (typeof d.range === "string" && d.mode === "range") {
    parts.push(`读取 ${d.range}`);
    if (d.truncated === true) parts.push("已截断");
  } else if (Array.isArray(d.matches)) {
    parts.push(`命中 ${d.matches.length} 处`);
  } else if (num(d.rowCount) !== null) {
    parts.push(`${num(d.rowCount)} 行结果`);
  } else if (changes && Array.isArray(changes.ranges)) {
    const cells =
      changes.cellsBySheet && typeof changes.cellsBySheet === "object"
        ? Object.values(changes.cellsBySheet as Record<string, unknown>).reduce<number>(
            (n, v) => n + (num(v) ?? 0),
            0,
          )
        : 0;
    parts.push(d.dryRun === true ? "预览（未写入）" : "已写入", `${cells} 个单元格`);
  } else if (Array.isArray(d.items)) {
    parts.push(`${d.items.length} 项`);
  } else if (typeof d.path === "string") {
    parts.push(d.path);
  }
  const revs = d.docRevs as Record<string, unknown> | undefined;
  const rev = revs && typeof revs === "object" ? num(Object.values(revs)[0]) : null;
  if (parts.length > 0 && rev !== null) parts.push(`修订 ${rev}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function summarizeResult(result: unknown): string {
  try {
    const s = JSON.stringify(result);
    return s.length > 160 ? `${s.slice(0, 160)}…` : s;
  } catch {
    return String(result);
  }
}

/** 从 workbook_edit 的结果数据提取已提交变更；dryRun 预演不算。 */
function changeEntryOf(
  toolCallId: string,
  raw: unknown,
  meta: { agentId?: string | null },
  seq: number,
): ChangeEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as {
    docId?: unknown;
    path?: unknown;
    dryRun?: unknown;
    docRevs?: unknown;
    backupPath?: unknown;
    changes?: { ranges?: unknown; cellsBySheet?: unknown; structural?: unknown };
  };
  if (typeof d.docId !== "string" || d.dryRun === true || !d.changes) return null;
  const ranges = Array.isArray(d.changes.ranges) ? d.changes.ranges.map(String) : [];
  const structural = Array.isArray(d.changes.structural) ? d.changes.structural.map(String) : [];
  if (ranges.length === 0 && structural.length === 0) return null;
  const cellsBySheet =
    d.changes.cellsBySheet && typeof d.changes.cellsBySheet === "object"
      ? (d.changes.cellsBySheet as Record<string, unknown>)
      : {};
  const cells = Object.values(cellsBySheet).reduce<number>(
    (n, v) => n + (typeof v === "number" ? v : 0),
    0,
  );
  const revs =
    d.docRevs && typeof d.docRevs === "object" ? (d.docRevs as Record<string, unknown>) : {};
  const rev = typeof revs[d.docId] === "number" ? (revs[d.docId] as number) : null;
  return {
    toolCallId,
    docId: d.docId,
    path: typeof d.path === "string" ? d.path : "",
    rev,
    ranges,
    cells,
    structural,
    ...(typeof d.backupPath === "string" ? { backupPath: d.backupPath } : {}),
    agentId: meta.agentId ?? null,
    seq,
  };
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

const agentOf = (meta: { agentId?: string | null }): string => meta.agentId ?? "main";

function patchLive(s: SessionState, agentId: string, patch: Partial<AgentLive>): SessionState {
  const cur = s.live[agentId] ?? emptyLive();
  return { ...s, live: { ...s.live, [agentId]: { ...cur, ...patch } } };
}

function patchRoster(s: SessionState, agentId: string, patch: Partial<RosterEntry>): SessionState {
  const cur = s.roster[agentId] ?? {
    id: agentId,
    name: null,
    role: null,
    parentId: null,
    status: "idle",
  };
  return { ...s, roster: { ...s.roster, [agentId]: { ...cur, ...patch } } };
}

function patchStatus(s: SessionState, agentId: string, status: string): SessionState {
  const withRoster = patchRoster(s, agentId, { status });
  return { ...withRoster, agentStatus: { ...withRoster.agentStatus, [agentId]: status } };
}

function applyRecord(
  s: SessionState,
  type: string,
  data: Record<string, unknown>,
  meta: { agentId?: string | null; seq?: number; at?: string } = {},
): SessionState {
  const seq = meta.seq ?? s.cursor + 1;
  switch (type) {
    case "session.created":
    case "session.updated":
      return typeof data.permissionMode === "string"
        ? { ...s, permissionMode: data.permissionMode }
        : s;
    case "agent.updated": {
      const id = meta.agentId ?? "";
      if (id === "") return s;
      return patchRoster(s, id, {
        modelProfileId: typeof data.modelProfileId === "string" ? data.modelProfileId : null,
      });
    }
    case "agent.spawned": {
      const id = meta.agentId ?? "";
      if (id === "") return s;
      return patchRoster(s, id, {
        name: typeof data.name === "string" ? data.name : null,
        role: typeof data.role === "string" ? data.role : null,
        parentId: typeof data.parentId === "string" ? data.parentId : null,
        status: s.roster[id]?.status ?? "idle",
        modelProfileId: typeof data.modelProfileId === "string" ? data.modelProfileId : null,
      });
    }
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
            seq,
            ...(meta.at ? { at: meta.at } : {}),
            ...(Array.isArray(data.attachments) && data.attachments.length > 0
              ? {
                  attachments: (
                    data.attachments as { sha256?: unknown; mediaType?: unknown; name?: unknown }[]
                  )
                    .filter((a) => typeof a.sha256 === "string")
                    .map((a) => ({
                      sha256: a.sha256 as string,
                      mediaType: String(a.mediaType ?? ""),
                      name: String(a.name ?? ""),
                    })),
                }
              : {}),
            ...(Array.isArray(data.context) && data.context.length > 0
              ? {
                  context: (data.context as { docId?: unknown; rev?: unknown; range?: unknown }[])
                    .filter((c) => typeof c.docId === "string" && typeof c.range === "string")
                    .map((c) => ({
                      docId: c.docId as string,
                      range: c.range as string,
                      rev: typeof c.rev === "number" ? c.rev : 0,
                    })),
                }
              : {}),
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
    case "inbox.sent": {
      // 代理间消息（05 §4）：internal 消息，agentId 取发送方。
      const messageId = typeof data.messageId === "string" ? data.messageId : "";
      const from = typeof data.fromAgentId === "string" ? data.fromAgentId : agentOf(meta);
      const to = typeof data.toAgentId === "string" ? data.toAgentId : "";
      const kind = typeof data.kind === "string" ? data.kind : "agent";
      if (messageId === "" || to === "") return s;
      if (s.messages.some((m) => m.id === messageId)) return s;
      return {
        ...s,
        messages: [
          ...s.messages,
          {
            id: messageId,
            role: "internal",
            text: String(data.message ?? ""),
            agentId: from,
            internal: { from, to, kind },
            seq,
          },
        ],
      };
    }
    case "memory.saved": {
      const memoryId = typeof data.memoryId === "string" ? data.memoryId : "";
      if (memoryId === "" || s.messages.some((m) => m.id === `mem-${memoryId}`)) return s;
      return {
        ...s,
        messages: [
          ...s.messages,
          {
            id: `mem-${memoryId}`,
            role: "memory",
            text: String(data.content ?? ""),
            agentId: agentOf(meta),
            memory: { memoryId, category: String(data.category ?? ""), deleted: false },
            seq,
          },
        ],
      };
    }
    case "memory.deleted": {
      const memoryId = typeof data.memoryId === "string" ? data.memoryId : "";
      return {
        ...s,
        messages: s.messages.map((m) =>
          m.memory?.memoryId === memoryId ? { ...m, memory: { ...m.memory, deleted: true } } : m,
        ),
      };
    }
    case "context.notice": {
      const kind = typeof data.kind === "string" ? data.kind : "";
      return {
        ...s,
        messages: [
          ...s.messages,
          {
            id: `notice-${s.messages.length}-${kind}`,
            role: "notice",
            text: String(data.text ?? ""),
            agentId: meta.agentId ?? null,
            noticeKind: kind,
            seq,
          },
        ],
      };
    }
    case "agent.status": {
      const status = typeof data.status === "string" ? data.status : "";
      if (meta.agentId == null || status === "") return s;
      return patchStatus(s, meta.agentId, status);
    }
    case "turn.started": {
      if (meta.agentId == null) return s;
      const next = patchStatus(s, meta.agentId, "running");
      return patchLive(next, meta.agentId, { error: null, retry: null });
    }
    case "step.started":
      return patchLive(s, agentOf(meta), { streamingText: "" });
    case "model.output": {
      const aid = agentOf(meta);
      const cur = s.live[aid] ?? emptyLive();
      const text = typeof data.text === "string" ? data.text : cur.streamingText;
      const reasoning = typeof data.reasoning === "string" ? data.reasoning : cur.reasoningText;
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
          agentId: meta.agentId ?? null,
          seq,
          ...(typeof tc.args === "string" ? { args: tc.args } : {}),
        });
      }
      // 思考内容挂在该步的助手消息上（默认折叠）；只有思考没有正文的步也保留一条思考块
      const stepId = typeof data.stepId === "string" ? data.stepId : null;
      const last = s.messages[s.messages.length - 1];
      const sameStep =
        stepId !== null &&
        last?.role === "assistant" &&
        last.id === `m-output-${stepId}` &&
        (last.agentId ?? null) === (meta.agentId ?? null);
      const entry: UiMessage = {
        id: stepId !== null ? `m-output-${stepId}` : `m-output-${s.cursor}-${s.messages.length}`,
        role: "assistant",
        text,
        agentId: meta.agentId ?? null,
        seq,
        ...(reasoning !== "" ? { reasoning } : {}),
        ...(typeof data.reasoningMs === "number" ? { reasoningMs: data.reasoningMs } : {}),
      };
      const messages =
        text === "" && reasoning === ""
          ? s.messages
          : sameStep
            ? [...s.messages.slice(0, -1), { ...last, ...entry, seq: last.seq ?? seq }]
            : [...s.messages, entry];
      return {
        ...patchLive({ ...s, messages, tools }, aid, {
          streamingText: "",
          reasoningText: "",
        }),
      };
    }
    case "attempt.discarded":
      return patchLive(s, agentOf(meta), { streamingText: "", pendingToolArgs: {} });
    case "tool.intent": {
      const aid = agentOf(meta);
      const toolCallId = String(data.toolCallId ?? "");
      const toolName = String(data.toolName ?? "?");
      const tools = [...s.tools];
      const i = tools.findIndex((t) => t.toolCallId === toolCallId);
      const card: ToolCard = {
        toolCallId,
        name: toolName,
        status: "pending",
        args: typeof data.args === "string" ? data.args : JSON.stringify(data.args ?? {}),
        targets: Array.isArray(data.targets) ? (data.targets as string[]) : [],
        agentId: meta.agentId ?? null,
        seq,
      };
      if (i >= 0) tools[i] = { ...tools[i], ...card, seq: tools[i]?.seq ?? seq };
      else tools.push(card);
      return patchRoster({ ...s, tools }, aid, { lastTool: toolName });
    }
    case "tool.result": {
      const toolCallId = String(data.toolCallId ?? "");
      // 结束增量丢失时以 tool.result 兜底清掉该调用的活动
      const liveCur = s.live[agentOf(meta)];
      if (liveCur?.activity.some((a) => a.toolCallId === toolCallId)) {
        s = patchLive(s, agentOf(meta), {
          activity: liveCur.activity.filter((a) => a.toolCallId !== toolCallId),
        });
      }
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
      const headline = res?.status === "ok" ? resultHeadline(res.data) : null;
      const output = res?.data as { docId?: unknown } | undefined;
      const docId = typeof output?.docId === "string" ? output.docId : undefined;
      const tools = s.tools.map((t) =>
        t.toolCallId === toolCallId
          ? {
              ...t,
              status: status as ToolCard["status"],
              resultSummary: summary,
              ...(headline ? { headline } : {}),
              ...(typeof data.durationMs === "number" ? { durationMs: data.durationMs } : {}),
              ...(docId ? { docId } : {}),
            }
          : t,
      );
      if (!tools.some((t) => t.toolCallId === toolCallId)) {
        tools.push({
          toolCallId,
          name: "?",
          status,
          resultSummary: summary,
          agentId: meta.agentId ?? null,
          seq,
        });
      }
      const change = res?.status === "ok" ? changeEntryOf(toolCallId, res.data, meta, seq) : null;
      if (change && !s.changes.some((c) => c.toolCallId === toolCallId)) {
        return { ...s, tools, changes: [...s.changes, change] };
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
      // 与 agents 投影一致：等待审批时代理为 blocked
      const next =
        meta.agentId != null
          ? patchStatus({ ...s, approvals }, meta.agentId, "blocked")
          : { ...s, approvals };
      return next;
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
      // 与 agents 投影一致：决定后 blocked 的代理回到 running
      const aid = meta.agentId;
      const next =
        aid != null && s.agentStatus[aid] === "blocked"
          ? patchStatus({ ...s, approvals }, aid, "running")
          : { ...s, approvals };
      return next;
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
      return meta.agentId != null
        ? patchStatus({ ...s, questions }, meta.agentId, "blocked")
        : { ...s, questions };
    }
    case "question.answered": {
      const questionId = String(data.questionId ?? "");
      if (!questionId) return s;
      const questions = s.questions.map((q) =>
        q.questionId === questionId
          ? {
              ...q,
              status: "answered" as const,
              answer: data.answer,
              ...(typeof data.rev === "number" ? { rev: data.rev } : {}),
            }
          : q,
      );
      const aid = meta.agentId;
      return aid != null && s.agentStatus[aid] === "blocked"
        ? patchStatus({ ...s, questions }, aid, "running")
        : { ...s, questions };
    }
    case "todo.set": {
      if (!Array.isArray(data.items)) return s;
      const aid = agentOf(meta);
      return { ...s, todos: { ...s.todos, [aid]: normalizeTodos(data.items) } };
    }
    case "todo.updated": {
      const todoId = typeof data.todoId === "string" ? data.todoId : "";
      if (!todoId) return s;
      const aid = agentOf(meta);
      const items = s.todos[aid];
      if (!items) return s;
      return {
        ...s,
        todos: {
          ...s.todos,
          [aid]: items.map((item) =>
            item.id === todoId
              ? {
                  ...item,
                  ...(typeof data.status === "string" ? { status: data.status } : {}),
                  ...(Object.hasOwn(data, "result") ? { result: data.result } : {}),
                }
              : item,
          ),
        },
      };
    }
    case "retry.scheduled":
      return patchLive(s, agentOf(meta), {
        retry: { attempt: Number(data.attempt ?? 0), waitMs: Number(data.waitMs ?? 0) },
      });
    case "error.guidance":
      return patchLive(s, agentOf(meta), {
        error: { kind: String(data.kind ?? "unknown"), message: String(data.message ?? "") },
      });
    case "turn.completed":
    case "turn.interrupted":
    case "turn.failed": {
      if (meta.agentId == null) return s;
      const status =
        type === "turn.completed" ? "idle" : type === "turn.interrupted" ? "interrupted" : "failed";
      const next = patchStatus(s, meta.agentId, status);
      return patchLive(next, meta.agentId, { streamingText: "", retry: null, activity: [] });
    }
    case "usage.updated": {
      const aid = agentOf(meta);
      const cumulative = data.cumulative as { totalTokens?: unknown } | undefined;
      const withTokens =
        typeof cumulative?.totalTokens === "number"
          ? patchRoster(s, aid, { tokens: cumulative.totalTokens })
          : s;
      const ctx = data.context as
        | { tokens?: unknown; window?: unknown; estimated?: unknown }
        | undefined;
      if (!ctx || typeof ctx.tokens !== "number") return withTokens;
      return patchLive(withTokens, aid, {
        contextUsage: {
          tokens: ctx.tokens,
          window: typeof ctx.window === "number" ? ctx.window : null,
          estimated: ctx.estimated === true,
        },
      });
    }
    case "compaction": {
      const aid = agentOf(meta);
      const id = `cmp-${s.cursor}`;
      const beforeTokens = Number(data.beforeTokens ?? 0);
      const afterTokens = Number(data.afterTokens ?? 0);
      const trigger =
        data.trigger === "manual" || data.trigger === "overflow" ? data.trigger : "auto";
      const next: SessionState = {
        ...s,
        messages: [
          ...s.messages,
          {
            id,
            role: "compaction",
            text: String(data.summary ?? ""),
            agentId: meta.agentId ?? null,
            seq,
            compaction: {
              trigger,
              beforeTokens,
              afterTokens,
              estimated: data.estimated === true,
            },
          },
        ],
      };
      return patchLive(next, aid, {
        contextUsage: {
          tokens: afterTokens,
          window: s.live[aid]?.contextUsage?.window ?? null,
          estimated: true,
        },
      });
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
        seq: msg.seq,
        at: msg.record.createdAt,
      }),
    };
    next.cursor = Math.max(state.cursor, msg.seq);
    return next;
  }
  if (msg.type === "delta") {
    const aid = msg.agentId ?? "main";
    const payload =
      typeof msg.payload === "string" ? msg.payload : JSON.stringify(msg.payload ?? "");
    if (msg.kind === "text") {
      const cur = state.live[aid] ?? emptyLive();
      return patchLive(state, aid, { streamingText: cur.streamingText + payload });
    }
    if (msg.kind === "reasoning") {
      const cur = state.live[aid] ?? emptyLive();
      return patchLive(state, aid, { reasoningText: cur.reasoningText + payload });
    }
    if (msg.kind === "workbook_activity") {
      const p = (msg.payload ?? {}) as Partial<WorkbookActivityItem> & { phase?: string };
      if (typeof p.toolCallId !== "string") return state;
      const cur = (state.live[aid] ?? emptyLive()).activity.filter(
        (a) => a.toolCallId !== p.toolCallId,
      );
      if (p.phase !== "start" || (p.kind !== "read" && p.kind !== "write")) {
        return patchLive(state, aid, { activity: cur });
      }
      return patchLive(state, aid, {
        activity: [
          ...cur,
          {
            toolCallId: p.toolCallId,
            kind: p.kind,
            ranges: Array.isArray(p.ranges) ? p.ranges.map(String) : [],
            ...(typeof p.docId === "string" ? { docId: p.docId } : {}),
            ...(typeof p.path === "string" ? { path: p.path } : {}),
          },
        ],
      });
    }
    if (msg.kind === "tool_args") {
      // payload 形如 {id, delta} 或为纯字符串
      const p = msg.payload as { id?: string; delta?: string; name?: string } | string;
      const id = typeof p === "object" ? (p.id ?? "") : "";
      const delta = typeof p === "object" ? (p.delta ?? "") : p;
      const cur = (state.live[aid] ?? emptyLive()).pendingToolArgs;
      const entry = cur[id] ?? {
        name: typeof p === "object" ? (p.name ?? "") : "",
        args: "",
      };
      return patchLive(state, aid, {
        pendingToolArgs: { ...cur, [id]: { name: entry.name, args: entry.args + delta } },
      });
    }
    return state;
  }
  if (msg.type === "snapshot") {
    return patchLive(state, msg.agentId ?? "main", {
      streamingText: msg.text,
      reasoningText: msg.reasoning,
    });
  }
  return state;
}

/** 任一代理仍在运行（等待审批/回答也算运行中）。 */
export function anyRunning(s: SessionState): boolean {
  return Object.values(s.agentStatus).some(
    (st) => st === "running" || st === "waiting" || st === "blocked" || st === "queued",
  );
}

/** 单代理视图（02 §5）：该代理的对话、工具、瞬时状态与待交互项。 */
export interface AgentView {
  agentId: string;
  messages: UiMessage[];
  tools: ToolCard[];
  live: AgentLive;
  todos: TodoItem[];
  approvals: ApprovalCard[];
  questions: QuestionCard[];
  running: boolean;
}

export function agentView(s: SessionState, agentId: string): AgentView {
  return {
    agentId,
    messages: s.messages.filter((m) =>
      m.role === "internal"
        ? m.internal !== undefined && (m.internal.from === agentId || m.internal.to === agentId)
        : (m.agentId ?? "main") === agentId,
    ),
    tools: s.tools.filter((t) => (t.agentId ?? "main") === agentId),
    live: s.live[agentId] ?? emptyLive(),
    todos: s.todos[agentId] ?? [],
    approvals: s.approvals.filter((a) => (a.agentId ?? "main") === agentId),
    questions: s.questions.filter((q) => (q.agentId ?? "main") === agentId),
    running: s.agentStatus[agentId] === "running",
  };
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

/** 连续的 internal 消息折叠为一组（02 §5：主代理视图不刷屏）。 */
export interface InternalGroup {
  kind: "internalGroup";
  id: string;
  messages: UiMessage[];
}

export type DisplayItem = UiMessage | (ToolCard & { kind: "tool" }) | InternalGroup;

export function isInternalGroup(item: DisplayItem): item is InternalGroup {
  return (item as InternalGroup).kind === "internalGroup";
}

/** 排序展示：消息与工具卡按记录 seq 交错（同 seq 时消息在前），internal 连续折叠，流式文本尾随。 */
export function displayItems(view: AgentView): DisplayItem[] {
  type Entry = {
    seq: number;
    rank: number;
    idx: number;
    item: UiMessage | (ToolCard & { kind: "tool" });
  };
  const entries: Entry[] = [];
  view.messages.forEach((m, idx) => {
    entries.push({ seq: m.seq ?? Number.MAX_SAFE_INTEGER, rank: 0, idx, item: m });
  });
  view.tools.forEach((t, idx) => {
    entries.push({
      seq: t.seq ?? Number.MAX_SAFE_INTEGER,
      rank: 1,
      idx,
      item: { ...t, kind: "tool" },
    });
  });
  entries.sort((a, b) => a.seq - b.seq || a.rank - b.rank || a.idx - b.idx);

  const items: DisplayItem[] = [];
  let group: UiMessage[] = [];
  const flush = () => {
    if (group.length === 0) return;
    if (group.length === 1) {
      const only = group[0];
      if (only) items.push(only);
    } else {
      const first = group[0];
      items.push({ kind: "internalGroup", id: `ig-${first?.id ?? items.length}`, messages: group });
    }
    group = [];
  };
  for (const { item } of entries) {
    if (!("kind" in item) && item.role === "internal") {
      group.push(item);
    } else {
      flush();
      items.push(item);
    }
  }
  flush();
  if (view.live.streamingText !== "") {
    items.push({ id: "streaming", role: "assistant", text: view.live.streamingText });
  }
  return items;
}

/** 待审批写入的目标（02 §4.4）：取自审批记录里的 workbook_edit 参数，表示"拟修改"而非已修改。 */
export function pendingWriteTargets(card: ApprovalCard): {
  path?: string;
  docId?: string;
  ranges: string[];
  /** cells.set 的拟写入值（二维，按区域）；用于修改前后对比（02 §4.4）。 */
  values: Record<string, unknown[][]>;
} | null {
  if (card.toolName !== "workbook_edit") return null;
  const a = card.args as { path?: unknown; docId?: unknown; ops?: unknown } | undefined;
  if (!a || !Array.isArray(a.ops)) return null;
  const ranges: string[] = [];
  const values: Record<string, unknown[][]> = {};
  for (const op of a.ops as {
    op?: unknown;
    range?: unknown;
    sheet?: unknown;
    values?: unknown;
  }[]) {
    if (typeof op.range !== "string") continue;
    const r =
      typeof op.sheet === "string" && !op.range.includes("!")
        ? `${op.sheet}!${op.range}`
        : op.range;
    ranges.push(r);
    if (op.op === "cells.set" && Array.isArray(op.values)) values[r] = op.values as unknown[][];
  }
  return {
    ...(typeof a.path === "string" ? { path: a.path } : {}),
    ...(typeof a.docId === "string" ? { docId: a.docId } : {}),
    ranges,
    values,
  };
}

/** 某文档的已提交变更区域（按时间顺序展开，供变更导航 ◀ ▶）。 */
export function changeRanges(
  s: SessionState,
  docId: string,
  sinceSeq = 0,
): { range: string; entry: ChangeEntry }[] {
  return s.changes
    .filter((c) => c.docId === docId && c.seq > sinceSeq)
    .flatMap((entry) => entry.ranges.map((range) => ({ range, entry })));
}

/** 最近一条用户消息的 seq（"本轮"的起点）。 */
export function lastUserSeq(s: SessionState, agentId = "main"): number {
  let seq = 0;
  for (const m of s.messages) {
    if (m.role === "user" && (m.agentId ?? "main") === agentId && (m.seq ?? 0) > seq)
      seq = m.seq ?? 0;
  }
  return seq;
}
