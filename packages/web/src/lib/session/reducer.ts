// 会话日志 → 视图模型的纯函数还原器（11 §3.6）。rec 按 seq 幂等；delta/snapshot 只改瞬时状态。
// 用户消息在"已应用"时进入时间线（排队中的在 dispatches 里）；运行中插话把当前轮次拆段，
// 之后的输出进入新的一段，界面因此按真实先后顺序显示。

import {
  type ErrorGuidance,
  type LogRecord,
  PresentPayload,
  type ServerMessage,
  ToolArgsDelta,
  type ToolResult,
  type ToolResultStatus,
} from "@excelmanus/protocol";
import type {
  AgentEntry,
  ApprovalState,
  Block,
  ChangeEntry,
  DocChange,
  LiveState,
  QuestionState,
  QuestionType,
  SessionState,
  TimelineItem,
  TodoItem,
  ToolState,
  TurnSegment,
  TurnStatus,
  UserItem,
} from "./types";

export const MAIN_AGENT = "main";

export const initialSessionState = (): SessionState => ({
  cursor: 0,
  permissionMode: null,
  title: null,
  roster: {},
  timelines: {},
  dispatches: {},
  tools: {},
  approvals: {},
  questions: {},
  todos: {},
  live: {},
  changes: [],
  docNotices: {},
  feedback: {},
  rewinds: {},
  openSegments: {},
});

const emptyLive = (): LiveState => ({
  stepId: null,
  text: "",
  reasoning: "",
  reasoningStartedAt: null,
  toolArgs: {},
  activity: [],
  contextUsage: null,
});

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const omit = <T>(record: Record<string, T>, key: string): Record<string, T> => {
  const { [key]: _, ...rest } = record;
  return rest;
};
const samePath = (a: string, b: string) => {
  const norm = (p: string) => p.replaceAll("\\", "/").replace(/^(\.\/|\/)+/, "");
  return norm(a) === norm(b);
};
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

/** 预填名册（会话详情返回的代理），日志回放前也能显示名字与状态。 */
export function seedRoster(
  state: SessionState,
  agents: {
    id: string;
    name: string | null;
    role: string;
    parentId: string | null;
    status: string;
    modelProfileId: string | null;
  }[],
): SessionState {
  const roster = { ...state.roster };
  for (const a of agents) {
    roster[a.id] = {
      ...(roster[a.id] ?? { seq: 0 }),
      id: a.id,
      name: a.name,
      role: a.role,
      parentId: a.parentId,
      status: a.status,
      modelProfileId: a.modelProfileId,
    } as AgentEntry;
  }
  return { ...state, roster };
}

// ---------- 结构化更新小工具 ----------

function patchLive(s: SessionState, agentId: string, patch: Partial<LiveState>): SessionState {
  return {
    ...s,
    live: { ...s.live, [agentId]: { ...(s.live[agentId] ?? emptyLive()), ...patch } },
  };
}

function patchRoster(s: SessionState, agentId: string, patch: Partial<AgentEntry>): SessionState {
  const cur: AgentEntry = s.roster[agentId] ?? {
    id: agentId,
    name: agentId === MAIN_AGENT ? "主代理" : null,
    role: agentId === MAIN_AGENT ? "main" : null,
    parentId: null,
    status: "idle",
    modelProfileId: null,
    seq: 0,
  };
  return { ...s, roster: { ...s.roster, [agentId]: { ...cur, ...patch } } };
}

function patchTool(s: SessionState, id: string, patch: Partial<ToolState>): SessionState {
  const cur = s.tools[id];
  if (!cur) return s;
  return { ...s, tools: { ...s.tools, [id]: { ...cur, ...patch } } };
}

function pushItem(s: SessionState, agentId: string, item: TimelineItem): SessionState {
  return {
    ...s,
    timelines: { ...s.timelines, [agentId]: [...(s.timelines[agentId] ?? []), item] },
  };
}

function mapItems(
  s: SessionState,
  agentId: string,
  fn: (item: TimelineItem) => TimelineItem,
): SessionState {
  const items = s.timelines[agentId];
  if (!items) return s;
  let changed = false;
  const next = items.map((item) => {
    const out = fn(item);
    if (out !== item) changed = true;
    return out;
  });
  return changed ? { ...s, timelines: { ...s.timelines, [agentId]: next } } : s;
}

function mapSegment(
  s: SessionState,
  agentId: string,
  segmentId: string,
  fn: (seg: TurnSegment) => TurnSegment,
): SessionState {
  return mapItems(s, agentId, (item) =>
    item.kind === "turn" && item.id === segmentId ? fn(item) : item,
  );
}

/** 当前轮次的打开段；运行中被插话关闭后，下一个块会开出同一轮的新一段。 */
function ensureSegment(
  s: SessionState,
  agentId: string,
  seq: number,
  at: string,
): { state: SessionState; segmentId: string } {
  const open = s.openSegments[agentId];
  if (open && open.segmentId) return { state: s, segmentId: open.segmentId };
  if (open) {
    const segment = open.segment + 1;
    const id = `${open.turnId}:${segment}`;
    const seg: TurnSegment = {
      kind: "turn",
      id,
      turnId: open.turnId,
      segment,
      seq,
      at,
      agentId,
      status: "running",
      blocks: [],
      steps: 0,
    };
    const next = pushItem(s, agentId, seg);
    return {
      state: {
        ...next,
        openSegments: { ...next.openSegments, [agentId]: { ...open, segment, segmentId: id } },
      },
      segmentId: id,
    };
  }
  // 不在运行中的轮次里（例如崩溃恢复写入的记录）：挂到该代理最后一段
  const items = s.timelines[agentId] ?? [];
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.kind === "turn") return { state: s, segmentId: item.id };
  }
  const id = `orphan:${seq}`;
  const seg: TurnSegment = {
    kind: "turn",
    id,
    turnId: id,
    segment: 0,
    seq,
    at,
    agentId,
    status: "completed",
    blocks: [],
    steps: 0,
  };
  return { state: pushItem(s, agentId, seg), segmentId: id };
}

function appendBlock(
  s: SessionState,
  agentId: string,
  seq: number,
  at: string,
  block: Block,
): SessionState {
  const { state, segmentId } = ensureSegment(s, agentId, seq, at);
  return mapSegment(state, agentId, segmentId, (seg) =>
    seg.blocks.some((b) => b.type === block.type && b.key === block.key)
      ? seg
      : { ...seg, blocks: [...seg.blocks, block] },
  );
}

/** 插入一条非轮次条目：运行中的轮次在此处断开，后续输出接在它后面。 */
function pushNote(s: SessionState, agentId: string, item: TimelineItem): SessionState {
  const open = s.openSegments[agentId];
  const closed = open?.segmentId
    ? { ...s, openSegments: { ...s.openSegments, [agentId]: { ...open, segmentId: null } } }
    : s;
  return pushItem(closed, agentId, item);
}

function hasToolBlock(s: SessionState, agentId: string, toolCallId: string): boolean {
  return (s.timelines[agentId] ?? []).some(
    (item) =>
      item.kind === "turn" && item.blocks.some((b) => b.type === "tool" && b.key === toolCallId),
  );
}

function normalizeTodos(items: unknown[]): TodoItem[] {
  return items.map((raw, i) => {
    const item: Record<string, unknown> =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? { ...(raw as Record<string, unknown>) }
        : { title: String(raw ?? "") };
    const id = str(item.id) || `todo-${i + 1}`;
    const title = str(item.title) ?? str(item.content) ?? str(item.text) ?? str(item.name) ?? "";
    const status = str(item.status) ?? "pending";
    return { ...item, id, title, status };
  });
}

/** 从 workbook_edit 的结果数据提取已提交变更；dryRun 预演不算。 */
function changeEntryOf(
  toolCallId: string,
  raw: unknown,
  agentId: string,
  seq: number,
  at: string,
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
  const cells = Object.values(cellsBySheet).reduce<number>((n, v) => n + (num(v) ?? 0), 0);
  const revs =
    d.docRevs && typeof d.docRevs === "object" ? (d.docRevs as Record<string, unknown>) : {};
  return {
    toolCallId,
    docId: d.docId,
    path: str(d.path) ?? "",
    rev: num(revs[d.docId]) ?? null,
    ranges,
    cells,
    structural,
    ...(typeof d.backupPath === "string" ? { backupPath: d.backupPath } : {}),
    agentId,
    seq,
    at,
  };
}

function docChangesOf(raw: unknown): DocChange[] {
  const docs = (raw as { docs?: unknown } | undefined)?.docs;
  if (!Array.isArray(docs)) return [];
  return docs.flatMap((d): DocChange[] => {
    if (!d || typeof d !== "object") return [];
    const x = d as Record<string, unknown>;
    if (typeof x.docId !== "string") return [];
    return [
      {
        docId: x.docId,
        path: str(x.path) ?? "",
        fromRev: num(x.fromRev) ?? 0,
        toRev: num(x.toRev) ?? 0,
        revs: Array.isArray(x.revs) ? x.revs.filter((r): r is number => typeof r === "number") : [],
        cellsBySheet:
          x.cellsBySheet && typeof x.cellsBySheet === "object"
            ? (Object.fromEntries(
                Object.entries(x.cellsBySheet as Record<string, unknown>).filter(
                  (e): e is [string, number] => typeof e[1] === "number",
                ),
              ) as Record<string, number>)
            : {},
        ranges: Array.isArray(x.ranges) ? x.ranges.map(String) : [],
        structural: Array.isArray(x.structural) ? x.structural.map(String) : [],
        added: Array.isArray(x.added) ? x.added.map(String) : [],
        ...(typeof x.backupPath === "string" ? { backupPath: x.backupPath } : {}),
      },
    ];
  });
}

const TURN_END: Record<string, TurnStatus> = {
  "turn.completed": "completed",
  "turn.failed": "failed",
  "turn.interrupted": "interrupted",
};
const ROSTER_AFTER_TURN: Record<TurnStatus, string> = {
  running: "running",
  completed: "idle",
  failed: "failed",
  interrupted: "interrupted",
};

// ---------- 记录 ----------

function applyRecord(s: SessionState, rec: LogRecord): SessionState {
  const d = rec.data;
  const seq = rec.seq;
  const at = rec.createdAt;
  const agentId = rec.agentId ?? MAIN_AGENT;
  switch (rec.type) {
    case "session.created":
    case "session.updated":
      return {
        ...s,
        permissionMode: str(d.permissionMode) ?? s.permissionMode,
        title: str(d.title) ?? s.title,
      };

    case "agent.spawned":
      return patchRoster(s, agentId, {
        name: str(d.name) ?? null,
        role: str(d.role) ?? null,
        parentId: str(d.parentId) ?? null,
        modelProfileId: str(d.modelProfileId) ?? null,
        ...(str(d.task) !== undefined ? { task: str(d.task) } : {}),
        ...(Array.isArray(d.files) ? { files: d.files.map(String) } : {}),
        seq,
      });
    case "agent.status":
      return str(d.status) ? patchRoster(s, agentId, { status: str(d.status) as string }) : s;
    case "agent.updated":
      return patchRoster(s, agentId, { modelProfileId: str(d.modelProfileId) ?? null });

    case "feedback.given": {
      const target = num(d.seq);
      if (target === undefined) return s;
      const rest = Object.fromEntries(
        Object.entries(s.feedback).filter(([k]) => Number(k) !== target),
      ) as SessionState["feedback"];
      return {
        ...s,
        feedback: d.rating === "up" || d.rating === "down" ? { ...rest, [target]: d.rating } : rest,
      };
    }
    case "user.message": {
      const id = str(d.dispatchId);
      if (!id || s.dispatches[id]) return s;
      const mode = d.mode === "interrupt" || d.mode === "queue" ? d.mode : "steer";
      const item: UserItem = {
        kind: "user",
        id,
        seq,
        at,
        agentId,
        text: str(d.text) ?? "",
        mode,
        status: "accepted",
        clientMessageId: str(d.clientMessageId) ?? "",
        attachments: Array.isArray(d.attachments) ? (d.attachments as UserItem["attachments"]) : [],
        context: Array.isArray(d.context) ? (d.context as UserItem["context"]) : [],
        ...(d.skill && typeof d.skill === "object" && str((d.skill as { name?: unknown }).name)
          ? { skill: str((d.skill as { name?: unknown }).name) }
          : {}),
        ...(d.chatMode === "ask" || d.chatMode === "plan" ? { chatMode: d.chatMode } : {}),
      };
      return { ...s, dispatches: { ...s.dispatches, [id]: item } };
    }
    case "dispatch.updated": {
      const id = str(d.dispatchId) ?? "";
      const status = d.status;
      const cur = s.dispatches[id];
      if (
        !cur ||
        (status !== "accepted" &&
          status !== "queued" &&
          status !== "applied" &&
          status !== "cancelled" &&
          status !== "failed")
      )
        return s;
      const item: UserItem = { ...cur, status };
      const next = { ...s, dispatches: { ...s.dispatches, [id]: item } };
      if (status !== "applied" && status !== "failed") return next;
      // 已应用 / 失败：进入时间线（运行中的插话把当前轮次断开）
      return pushNote(next, cur.agentId, item);
    }

    case "turn.started": {
      const turnId = str(d.turnId) ?? `turn-${seq}`;
      const id = `${turnId}:0`;
      const seg: TurnSegment = {
        kind: "turn",
        id,
        turnId,
        segment: 0,
        seq,
        at,
        agentId,
        status: "running",
        blocks: [],
        steps: 0,
      };
      const next = pushItem(s, agentId, seg);
      const withOpen: SessionState = {
        ...next,
        openSegments: { ...next.openSegments, [agentId]: { turnId, segment: 0, segmentId: id } },
      };
      const live = withOpen.live[agentId] ?? emptyLive();
      return patchLive(patchRoster(withOpen, agentId, { status: "running" }), agentId, {
        ...emptyLive(),
        contextUsage: live.contextUsage,
      });
    }
    case "step.started": {
      const { state, segmentId } = ensureSegment(s, agentId, seq, at);
      const next = mapSegment(state, agentId, segmentId, (seg) => ({
        ...seg,
        steps: seg.steps + 1,
      }));
      return patchLive(next, agentId, {
        stepId: str(d.stepId) ?? null,
        text: "",
        reasoning: "",
        reasoningStartedAt: null,
        toolArgs: {},
      });
    }
    case "model.output": {
      const stepId = str(d.stepId) ?? `step-${seq}`;
      let next = s;
      const reasoning = str(d.reasoning) ?? "";
      const text = str(d.text) ?? "";
      if (reasoning !== "")
        next = appendBlock(next, agentId, seq, at, {
          type: "thinking",
          key: `think:${stepId}`,
          seq,
          text: reasoning,
          ...(num(d.reasoningMs) !== undefined ? { ms: num(d.reasoningMs) } : {}),
        });
      if (text !== "")
        next = appendBlock(next, agentId, seq, at, {
          type: "text",
          key: `text:${stepId}`,
          seq,
          text,
        });
      const calls = Array.isArray(d.toolCalls)
        ? (d.toolCalls as { id?: unknown; name?: unknown; args?: unknown }[])
        : [];
      for (const call of calls) {
        const id = str(call.id);
        if (!id) continue;
        if (!next.tools[id]) {
          next = {
            ...next,
            tools: {
              ...next.tools,
              [id]: {
                id,
                name: str(call.name) ?? "?",
                agentId,
                seq,
                stepId,
                args: call.args ?? {},
                targets: [],
                phase: "planned",
              },
            },
          };
        }
        next = appendBlock(next, agentId, seq, at, { type: "tool", key: id, seq });
      }
      next = resolveRetries(next, agentId);
      return patchLive(next, agentId, {
        text: "",
        reasoning: "",
        reasoningStartedAt: null,
        toolArgs: {},
      });
    }
    case "attempt.discarded":
      return patchLive(s, agentId, {
        text: "",
        reasoning: "",
        reasoningStartedAt: null,
        toolArgs: {},
      });

    case "tool.intent": {
      const id = str(d.toolCallId) ?? "";
      if (!id) return s;
      const name = str(d.toolName) ?? s.tools[id]?.name ?? "?";
      const tool: ToolState = {
        ...(s.tools[id] ?? { id, agentId, seq, targets: [], args: {} }),
        id,
        name,
        agentId,
        stepId: str(d.stepId) ?? s.tools[id]?.stepId,
        args: d.args ?? s.tools[id]?.args ?? {},
        targets: Array.isArray(d.targets) ? d.targets.map(String) : [],
        phase: "running",
        ...newFilesOf(d.intentMeta),
      } as ToolState;
      let next: SessionState = { ...s, tools: { ...s.tools, [id]: tool } };
      if (!hasToolBlock(next, agentId, id))
        next = appendBlock(next, agentId, seq, at, { type: "tool", key: id, seq });
      return patchRoster(next, agentId, { lastTool: name });
    }
    case "tool.result": {
      const id = str(d.toolCallId) ?? "";
      if (!id) return s;
      const result = d.result as ToolResult | undefined;
      const status = (str(d.status) ?? result?.status ?? "error") as ToolResultStatus;
      const existing = s.tools[id];
      let next: SessionState = {
        ...s,
        tools: {
          ...s.tools,
          [id]: {
            ...(existing ?? {
              id,
              name: str(d.toolName) ?? "?",
              agentId,
              seq,
              args: {},
              targets: [],
            }),
            phase: "done",
            status,
            ...(result ? { result } : {}),
            ...(num(d.durationMs) !== undefined ? { durationMs: num(d.durationMs) } : {}),
          } as ToolState,
        },
      };
      if (!existing && !hasToolBlock(next, agentId, id))
        next = appendBlock(next, agentId, seq, at, { type: "tool", key: id, seq });
      const live = next.live[agentId];
      if (live?.activity.some((a) => a.toolCallId === id))
        next = patchLive(next, agentId, {
          activity: live.activity.filter((a) => a.toolCallId !== id),
        });
      const notice = next.docNotices[agentId];
      const toolPath = str((next.tools[id]?.args as { path?: unknown } | undefined)?.path);
      if (notice && toolPath !== undefined && samePath(toolPath, notice.path))
        next = { ...next, docNotices: omit(next.docNotices, agentId) };
      const change = status === "ok" ? changeEntryOf(id, result?.data, agentId, seq, at) : null;
      if (change && !next.changes.some((c) => c.toolCallId === id))
        next = { ...next, changes: [...next.changes, change] };
      return next;
    }

    case "approval.requested": {
      const id = str(d.approvalId) ?? "";
      if (!id) return s;
      const toolCallId = str(d.toolCallId) ?? "";
      const approval: ApprovalState = {
        id,
        toolCallId,
        toolName: str(d.toolName) ?? "?",
        args: d.args,
        targets: Array.isArray(d.targets) ? d.targets.map(String) : [],
        effect: str(d.effect) ?? "write",
        ...(d.spec && typeof d.spec === "object"
          ? { spec: d.spec as Record<string, unknown> }
          : {}),
        status: s.approvals[id]?.status ?? "pending",
        agentId,
        seq,
      };
      const next = { ...s, approvals: { ...s.approvals, [id]: approval } };
      return patchRoster(
        patchTool(next, toolCallId, { phase: "approval", approvalId: id }),
        agentId,
        {
          status: "blocked",
        },
      );
    }
    case "approval.decided": {
      const id = str(d.approvalId) ?? "";
      const cur = s.approvals[id];
      if (!cur || (d.decision !== "approved" && d.decision !== "denied")) return s;
      const next: SessionState = {
        ...s,
        approvals: {
          ...s.approvals,
          [id]: {
            ...cur,
            status: d.decision,
            ...(str(d.reason) !== undefined ? { reason: str(d.reason) } : {}),
            ...(typeof d.remember === "boolean" ? { remember: d.remember } : {}),
          },
        },
      };
      const tool = next.tools[cur.toolCallId];
      const withTool =
        tool && tool.phase === "approval"
          ? patchTool(next, cur.toolCallId, { phase: "running" })
          : next;
      return withTool.roster[agentId]?.status === "blocked"
        ? patchRoster(withTool, agentId, { status: "running" })
        : withTool;
    }
    case "question.asked": {
      const id = str(d.questionId) ?? "";
      const type = d.questionType as QuestionType;
      if (
        !id ||
        !["choice", "text", "range_confirm", "range_pick", "change_confirm"].includes(type)
      )
        return s;
      const rawSpec =
        d.spec && typeof d.spec === "object" ? { ...(d.spec as Record<string, unknown>) } : {};
      const runtime = (rawSpec._runtime ?? {}) as { toolCallId?: unknown };
      delete rawSpec._runtime;
      const toolCallId = str(runtime.toolCallId);
      const question: QuestionState = {
        id,
        type,
        spec: rawSpec,
        status: s.questions[id]?.status ?? "pending",
        agentId,
        seq,
        ...(toolCallId ? { toolCallId } : {}),
      };
      const next = { ...s, questions: { ...s.questions, [id]: question } };
      const withTool = toolCallId
        ? patchTool(next, toolCallId, { phase: "question", questionId: id })
        : next;
      return patchRoster(withTool, agentId, { status: "blocked" });
    }
    case "question.answered": {
      const id = str(d.questionId) ?? "";
      const cur = s.questions[id];
      if (!cur) return s;
      const next: SessionState = {
        ...s,
        questions: {
          ...s.questions,
          [id]: {
            ...cur,
            status: "answered",
            answer: d.answer,
            ...(num(d.rev) !== undefined ? { rev: num(d.rev) } : {}),
          },
        },
      };
      const tool = cur.toolCallId ? next.tools[cur.toolCallId] : undefined;
      const withTool =
        tool && tool.phase === "question" && cur.toolCallId
          ? patchTool(next, cur.toolCallId, { phase: "running" })
          : next;
      return withTool.roster[agentId]?.status === "blocked"
        ? patchRoster(withTool, agentId, { status: "running" })
        : withTool;
    }

    case "todo.set": {
      if (!Array.isArray(d.items)) return s;
      const items = normalizeTodos(d.items);
      const next = { ...s, todos: { ...s.todos, [agentId]: items } };
      return appendBlock(next, agentId, seq, at, { type: "todo", key: `todo:${seq}`, seq, items });
    }
    case "todo.updated": {
      const todoId = str(d.todoId);
      const items = s.todos[agentId];
      if (!todoId || !items) return s;
      const updated = items.map((item) =>
        item.id === todoId
          ? {
              ...item,
              ...(str(d.status) !== undefined ? { status: str(d.status) as string } : {}),
              ...(Object.hasOwn(d, "result") ? { result: d.result } : {}),
            }
          : item,
      );
      // 待办块显示最新状态：更新该代理最后一个待办块
      let done = false;
      const timeline = [...(s.timelines[agentId] ?? [])];
      for (let i = timeline.length - 1; i >= 0 && !done; i--) {
        const item = timeline[i];
        if (item?.kind !== "turn") continue;
        const bi = item.blocks.findLastIndex((b) => b.type === "todo");
        if (bi < 0) continue;
        const blocks = [...item.blocks];
        blocks[bi] = { ...(blocks[bi] as Extract<Block, { type: "todo" }>), items: updated };
        timeline[i] = { ...item, blocks };
        done = true;
      }
      return {
        ...s,
        todos: { ...s.todos, [agentId]: updated },
        timelines: { ...s.timelines, [agentId]: timeline },
      };
    }
    case "ui.present": {
      const payload = PresentPayload.safeParse(d);
      if (!payload.success) return s;
      return appendBlock(s, agentId, seq, at, {
        type: "present",
        key: `present:${seq}`,
        seq,
        payload: payload.data,
      });
    }
    case "retry.scheduled":
      return appendBlock(s, agentId, seq, at, {
        type: "retry",
        key: `retry:${seq}`,
        seq,
        attempt: num(d.attempt) ?? 1,
        waitMs: num(d.waitMs) ?? 0,
        reason: str(d.reason) ?? "",
        resolved: false,
      });
    case "error.guidance":
      return appendBlock(s, agentId, seq, at, {
        type: "guidance",
        key: `guidance:${seq}`,
        seq,
        guidance: {
          kind: str(d.kind) ?? "unknown",
          message: str(d.message) ?? "",
          actions: Array.isArray(d.actions) ? d.actions.map(String) : [],
          ...(typeof d.retryable === "boolean" ? { retryable: d.retryable } : {}),
        } satisfies ErrorGuidance,
      });
    case "memory.saved": {
      const memoryId = str(d.memoryId);
      if (!memoryId) return s;
      return appendBlock(s, agentId, seq, at, {
        type: "memory",
        key: `memory:${memoryId}`,
        seq,
        memoryId,
        category: str(d.category) ?? "",
        content: str(d.content) ?? "",
        deleted: false,
      });
    }
    case "memory.deleted": {
      const memoryId = str(d.memoryId);
      if (!memoryId) return s;
      let next = s;
      for (const aid of Object.keys(s.timelines)) {
        next = mapItems(next, aid, (item) =>
          item.kind === "turn" &&
          item.blocks.some((b) => b.type === "memory" && b.memoryId === memoryId)
            ? {
                ...item,
                blocks: item.blocks.map((b) =>
                  b.type === "memory" && b.memoryId === memoryId ? { ...b, deleted: true } : b,
                ),
              }
            : item,
        );
      }
      return next;
    }
    case "change.summary": {
      const changes = docChangesOf(d.changes);
      if (changes.length === 0) return s;
      const turnId = str((d.changes as { turnId?: unknown } | undefined)?.turnId);
      const items = s.timelines[agentId] ?? [];
      const target = turnId
        ? items.findLast(
            (item): item is TurnSegment => item.kind === "turn" && item.turnId === turnId,
          )
        : undefined;
      const block: Block = { type: "changes", key: `changes:${seq}`, seq, changes };
      return target
        ? mapSegment(s, agentId, target.id, (seg) => ({ ...seg, blocks: [...seg.blocks, block] }))
        : appendBlock(s, agentId, seq, at, block);
    }

    case "context.notice": {
      const next =
        str(d.kind) === "doc.edited" && str(d.docId) && str(d.path)
          ? {
              ...s,
              docNotices: {
                ...s.docNotices,
                [agentId]: {
                  docId: str(d.docId) ?? "",
                  path: str(d.path) ?? "",
                  rev: num(d.rev) ?? null,
                  ranges: Array.isArray(d.ranges) ? d.ranges.map(String) : [],
                  text: str(d.text) ?? "",
                  seq,
                },
              },
            }
          : s;
      return pushNote(next, agentId, {
        kind: "notice",
        id: `notice:${seq}`,
        seq,
        at,
        agentId,
        noticeKind: str(d.kind) ?? "",
        text: str(d.text) ?? "",
      });
    }
    case "inbox.sent": {
      const to = str(d.toAgentId);
      const messageId = str(d.messageId);
      if (!to || !messageId) return s;
      const kind =
        d.kind === "report" || d.kind === "notice" || d.kind === "user" ? d.kind : "agent";
      return pushNote(s, to, {
        kind: "inbox",
        id: messageId,
        seq,
        at,
        agentId: to,
        from: str(d.fromAgentId) ?? agentId,
        to,
        inboxKind: kind,
        text: str(d.message) ?? "",
        urgent: d.urgent === true,
      });
    }
    case "compaction": {
      const afterTokens = num(d.afterTokens) ?? 0;
      const next = pushNote(s, agentId, {
        kind: "compaction",
        id: `compaction:${seq}`,
        seq,
        at,
        agentId,
        trigger: d.trigger === "manual" || d.trigger === "overflow" ? d.trigger : "auto",
        beforeTokens: num(d.beforeTokens) ?? 0,
        afterTokens,
        estimated: d.estimated === true,
        summary: str(d.summary) ?? "",
      });
      const live = next.live[agentId];
      return patchLive(next, agentId, {
        contextUsage: {
          tokens: afterTokens,
          window: live?.contextUsage?.window ?? null,
          estimated: true,
        },
      });
    }
    case "history.rewound": {
      const fromSeq = num(d.fromSeq);
      const dispatchId = str(d.dispatchId);
      if (fromSeq === undefined || !dispatchId) return s;
      const rewinds = {
        ...s.rewinds,
        [agentId]: [...(s.rewinds[agentId] ?? []), { fromSeq, seq }],
      };
      const openSegments = { ...s.openSegments };
      delete openSegments[agentId];
      return pushItem({ ...s, rewinds, openSegments }, agentId, {
        kind: "rewind",
        id: `rewind:${seq}`,
        seq,
        at,
        agentId,
        dispatchId,
        fromSeq,
      });
    }

    case "usage.updated": {
      const cumulative = d.cumulative as { totalTokens?: unknown } | undefined;
      const next =
        typeof cumulative?.totalTokens === "number"
          ? patchRoster(s, agentId, { tokens: cumulative.totalTokens })
          : s;
      const ctx = d.context as
        | { tokens?: unknown; window?: unknown; estimated?: unknown }
        | undefined;
      if (!ctx || typeof ctx.tokens !== "number") return next;
      return patchLive(next, agentId, {
        contextUsage: {
          tokens: ctx.tokens,
          window: typeof ctx.window === "number" ? ctx.window : null,
          estimated: ctx.estimated === true,
        },
      });
    }

    default: {
      const end = TURN_END[rec.type];
      if (end) return endTurn(s, agentId, str(d.turnId), end, d, at);
      return s;
    }
  }
}

function resolveRetries(s: SessionState, agentId: string): SessionState {
  const open = s.openSegments[agentId];
  if (!open) return s;
  return mapItems(s, agentId, (item) =>
    item.kind === "turn" &&
    item.turnId === open.turnId &&
    item.blocks.some((b) => b.type === "retry" && !b.resolved)
      ? {
          ...item,
          blocks: item.blocks.map((b) => (b.type === "retry" ? { ...b, resolved: true } : b)),
        }
      : item,
  );
}

function endTurn(
  state: SessionState,
  agentId: string,
  turnId: string | undefined,
  status: TurnStatus,
  d: Record<string, unknown>,
  at: string,
): SessionState {
  const s = state.docNotices[agentId]
    ? { ...state, docNotices: omit(state.docNotices, agentId) }
    : state;
  const id = turnId ?? s.openSegments[agentId]?.turnId;
  const items = s.timelines[agentId] ?? [];
  const last = id
    ? items.findLast((item): item is TurnSegment => item.kind === "turn" && item.turnId === id)
    : undefined;
  let next = mapItems(s, agentId, (item) =>
    item.kind === "turn" && id !== undefined && item.turnId === id
      ? {
          ...item,
          status,
          ...(item.id === last?.id
            ? {
                endedAt: at,
                ...(d.usage && typeof d.usage === "object"
                  ? { usage: d.usage as TurnSegment["usage"] }
                  : {}),
                ...(str(d.reason) !== undefined ? { reason: str(d.reason) } : {}),
                ...(d.error && typeof d.error === "object"
                  ? { failure: d.error as TurnSegment["failure"] }
                  : {}),
              }
            : {}),
        }
      : item,
  );
  // 模型给出但从未执行的调用：轮次结束即定案为未执行
  const tools = { ...next.tools };
  let touched = false;
  for (const tool of Object.values(next.tools)) {
    if (tool.agentId === agentId && tool.phase === "planned") {
      tools[tool.id] = { ...tool, phase: "done", status: "not_executed" };
      touched = true;
    }
  }
  if (touched) next = { ...next, tools };
  const openSegments = { ...next.openSegments };
  delete openSegments[agentId];
  next = { ...next, openSegments };
  next = patchRoster(next, agentId, { status: ROSTER_AFTER_TURN[status] });
  return patchLive(next, agentId, {
    stepId: null,
    text: "",
    reasoning: "",
    reasoningStartedAt: null,
    toolArgs: {},
    activity: [],
  });
}

// ---------- 入口 ----------

/** intentMeta.paths 里值为 null 的路径：执行前不存在的文件。 */
function newFilesOf(meta: unknown): { newFiles?: string[] } {
  const paths = meta && typeof meta === "object" ? (meta as { paths?: unknown }).paths : undefined;
  if (!paths || typeof paths !== "object") return {};
  const created = Object.entries(paths as Record<string, unknown>)
    .filter(([, v]) => v === null)
    .map(([k]) => k);
  return created.length > 0 ? { newFiles: created } : {};
}

export function reduceSession(state: SessionState, msg: ServerMessage): SessionState {
  if (msg.type === "rec") {
    if (msg.seq <= state.cursor) return state;
    const next = applyRecord(state, msg.record);
    return { ...next, cursor: msg.seq };
  }
  if (msg.type === "delta") {
    const agentId = msg.agentId || MAIN_AGENT;
    const live = state.live[agentId] ?? emptyLive();
    switch (msg.kind) {
      case "text":
        return patchLive(state, agentId, {
          stepId: msg.stepId,
          text: live.text + String(msg.payload ?? ""),
        });
      case "reasoning":
        return patchLive(state, agentId, {
          stepId: msg.stepId,
          reasoning: live.reasoning + String(msg.payload ?? ""),
          reasoningStartedAt: live.reasoningStartedAt ?? Date.now(),
        });
      case "tool_args": {
        const p = ToolArgsDelta.safeParse(msg.payload);
        if (!p.success) return state;
        const prev = live.toolArgs[p.data.id];
        return patchLive(state, agentId, {
          toolArgs: {
            ...live.toolArgs,
            [p.data.id]: {
              name: p.data.name ?? prev?.name ?? "",
              text: (prev?.text ?? "") + p.data.delta,
            },
          },
        });
      }
      case "workbook_activity": {
        const p = (msg.payload ?? {}) as {
          phase?: unknown;
          toolCallId?: unknown;
          kind?: unknown;
          docId?: unknown;
          path?: unknown;
          ranges?: unknown;
        };
        if (typeof p.toolCallId !== "string") return state;
        const rest = live.activity.filter((a) => a.toolCallId !== p.toolCallId);
        if (p.phase !== "start" || (p.kind !== "read" && p.kind !== "write"))
          return patchLive(state, agentId, { activity: rest });
        return patchLive(state, agentId, {
          activity: [
            ...rest,
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
      default:
        return state;
    }
  }
  if (msg.type === "snapshot") {
    return patchLive(state, msg.agentId || MAIN_AGENT, {
      stepId: msg.stepId,
      text: msg.text,
      reasoning: msg.reasoning,
    });
  }
  return state;
}

// ---------- 选择器 ----------

function hiddenBy(rewinds: { fromSeq: number; seq: number }[] | undefined, seq: number): boolean {
  return !!rewinds?.some((r) => seq >= r.fromSeq && seq < r.seq);
}

const visibleCache = new WeakMap<SessionState, Map<string, TimelineItem[]>>();

/** 某代理当前可见的时间线：回退区间里的对话不再显示。 */
export function visibleTimeline(state: SessionState, agentId: string): TimelineItem[] {
  let perState = visibleCache.get(state);
  if (!perState) {
    perState = new Map();
    visibleCache.set(state, perState);
  }
  const cached = perState.get(agentId);
  if (cached) return cached;
  const items = state.timelines[agentId] ?? [];
  const rewinds = state.rewinds[agentId];
  let out: TimelineItem[] = items;
  if (rewinds?.length) {
    out = [];
    for (const item of items) {
      if (item.kind === "rewind") {
        out.push(item);
        continue;
      }
      if (item.kind === "turn") {
        if (hiddenBy(rewinds, item.seq)) continue;
        const blocks = item.blocks.filter((b) => !hiddenBy(rewinds, b.seq));
        if (blocks.length === 0 && item.blocks.length > 0) continue;
        out.push(blocks.length === item.blocks.length ? item : { ...item, blocks });
        continue;
      }
      if (!hiddenBy(rewinds, item.seq)) out.push(item);
    }
  }
  perState.set(agentId, out);
  return out;
}

/** 已受理、尚未进入对话的用户消息（排队中）。 */
export function pendingDispatches(state: SessionState, agentId: string): UserItem[] {
  return Object.values(state.dispatches)
    .filter((d) => d.agentId === agentId && (d.status === "accepted" || d.status === "queued"))
    .sort((a, b) => a.seq - b.seq);
}

export function pendingApprovals(state: SessionState): ApprovalState[] {
  return Object.values(state.approvals)
    .filter((a) => a.status === "pending")
    .sort((a, b) => a.seq - b.seq);
}

export function pendingQuestions(state: SessionState): QuestionState[] {
  return Object.values(state.questions)
    .filter((q) => q.status === "pending")
    .sort((a, b) => a.seq - b.seq);
}

const BUSY = new Set(["running", "blocked", "waiting", "queued"]);

export function agentBusy(state: SessionState, agentId: string): boolean {
  return BUSY.has(state.roster[agentId]?.status ?? "idle");
}

export function anyAgentBusy(state: SessionState): boolean {
  return Object.values(state.roster).some((a) => BUSY.has(a.status));
}

/** 子代理（非主代理），按派生顺序。 */
export function subAgents(state: SessionState): AgentEntry[] {
  return Object.values(state.roster)
    .filter((a) => a.id !== MAIN_AGENT)
    .sort((a, b) => a.seq - b.seq);
}

/** 运行中轮次的打开段 id（流式内容挂在它后面）。 */
export function openSegmentId(state: SessionState, agentId: string): string | null {
  return state.openSegments[agentId]?.segmentId ?? null;
}

/** 可以"从这里重新开始"的用户消息：已进入对话，且不早于最近一次压缩。 */
export function rewindableFrom(state: SessionState, agentId: string): number {
  const items = state.timelines[agentId] ?? [];
  const compaction = items.findLast((item) => item.kind === "compaction");
  return compaction ? compaction.seq : 0;
}

export function changeRanges(state: SessionState, docId: string, sinceSeq = 0) {
  return state.changes
    .filter((c) => c.docId === docId && c.seq > sinceSeq)
    .flatMap((entry) => entry.ranges.map((range) => ({ range, entry })));
}

export function lastUserSeq(state: SessionState, agentId = MAIN_AGENT): number {
  let seq = 0;
  for (const item of state.timelines[agentId] ?? [])
    if (item.kind === "user" && item.seq > seq) seq = item.seq;
  return seq;
}
