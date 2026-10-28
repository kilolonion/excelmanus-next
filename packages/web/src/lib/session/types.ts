// 会话视图模型：由会话日志（唯一事实源）还原，按代理分别组织成时间线。
// 时间线由用户消息、助手轮次（可被插话拆成多段）与系统提示组成；轮次内是有序的块。

import type {
  AttachmentRef,
  ClassifiedError,
  ContextRef,
  DispatchMode,
  ErrorGuidance,
  PendingInteraction,
  PresentPayload,
  ToolResult,
  ToolResultStatus,
  Usage,
} from "@excelmanus/protocol";

export type DispatchStatus = "accepted" | "queued" | "applied" | "cancelled" | "failed";

export interface UserItem {
  kind: "user";
  /** dispatchId */
  id: string;
  /** user.message 的 seq；回退区间按它判断。 */
  seq: number;
  at: string;
  agentId: string;
  text: string;
  mode: DispatchMode;
  status: DispatchStatus;
  clientMessageId: string;
  attachments: AttachmentRef[];
  context: ContextRef[];
  /** 以 /技能 调用时的技能名。 */
  skill?: string;
  /** 只读问答 / 计划模式发出的消息（缺省为正常执行）。 */
  chatMode?: "ask" | "plan";
}

export type TurnStatus = "running" | "completed" | "failed" | "interrupted";

export interface TurnSegment {
  kind: "turn";
  /** `${turnId}:${segment}`：运行中插话会把一轮拆成多段。 */
  id: string;
  turnId: string;
  segment: number;
  seq: number;
  at: string;
  agentId: string;
  status: TurnStatus;
  blocks: Block[];
  /** 本轮累计用量（turn.completed）。 */
  usage?: Usage;
  /** 本轮模型调用次数。 */
  steps: number;
  reason?: string;
  cancellationCause?: "user";
  failure?: ClassifiedError;
  endedAt?: string;
}

export interface CompactionItem {
  kind: "compaction";
  id: string;
  seq: number;
  at: string;
  agentId: string;
  trigger: "auto" | "manual" | "overflow";
  beforeTokens: number;
  afterTokens: number;
  estimated: boolean;
  summary: string;
}

export interface NoticeItem {
  kind: "notice";
  id: string;
  seq: number;
  at: string;
  agentId: string;
  noticeKind: string;
  text: string;
}

export interface InboxItem {
  kind: "inbox";
  id: string;
  seq: number;
  at: string;
  /** 所在时间线（接收方）。 */
  agentId: string;
  from: string;
  to: string;
  inboxKind: "agent" | "report" | "notice" | "user";
  text: string;
  urgent: boolean;
}

export interface RewindItem {
  kind: "rewind";
  id: string;
  seq: number;
  at: string;
  agentId: string;
  dispatchId: string;
  fromSeq: number;
}

export type TimelineItem =
  | UserItem
  | TurnSegment
  | CompactionItem
  | NoticeItem
  | InboxItem
  | RewindItem;

export interface TodoItem {
  id: string;
  title: string;
  status: string;
  result?: unknown;
  [key: string]: unknown;
}

/** 一个文档在一轮中的变更摘要（kernel DocChangeSummary）。 */
export interface DocChange {
  docId: string;
  path: string;
  fromRev: number;
  toRev: number;
  revs: number[];
  cellsBySheet: Record<string, number>;
  ranges: string[];
  structural: string[];
  added: string[];
  backupPath?: string;
  metadataLimited?: boolean;
}

export type Block =
  | { type: "thinking"; key: string; seq: number; text: string; ms?: number }
  | { type: "text"; key: string; seq: number; text: string }
  /** key = toolCallId，详情在 SessionState.tools。 */
  | { type: "tool"; key: string; seq: number }
  | { type: "todo"; key: string; seq: number; items: TodoItem[] }
  | { type: "present"; key: string; seq: number; payload: PresentPayload }
  | {
      type: "retry";
      key: string;
      seq: number;
      attempt: number;
      waitMs: number;
      reason: string;
      resolved: boolean;
    }
  | { type: "guidance"; key: string; seq: number; guidance: ErrorGuidance }
  | {
      type: "memory";
      key: string;
      seq: number;
      memoryId: string;
      category: string;
      content: string;
      deleted: boolean;
    }
  | { type: "changes"; key: string; seq: number; changes: DocChange[] };

export type ToolPhase = "planned" | "running" | "approval" | "question" | "done";

export interface ToolState {
  id: string;
  name: string;
  agentId: string;
  seq: number;
  stepId?: string;
  args: unknown;
  targets: string[];
  phase: ToolPhase;
  /** 最终状态（tool.result）；轮次结束时仍未执行的标记为 not_executed。 */
  status?: ToolResultStatus;
  result?: ToolResult;
  durationMs?: number;
  approvalId?: string;
  /** 执行前尚不存在的目标文件（tool.intent 的 intentMeta），供文件面板标记「本会话新建」。 */
  newFiles?: string[];
  questionId?: string;
}

export interface ApprovalState {
  id: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  targets: string[];
  effect: string;
  spec?: Record<string, unknown>;
  status: "pending" | "approved" | "denied";
  reason?: string;
  remember?: boolean;
  agentId: string;
  seq: number;
}

export type QuestionType = "choice" | "text" | "range_confirm" | "range_pick" | "change_confirm";

export interface QuestionState {
  id: string;
  type: QuestionType;
  spec: Record<string, unknown>;
  status: "pending" | "answered";
  answer?: unknown;
  rev?: number;
  agentId: string;
  toolCallId?: string;
  seq: number;
}

export interface AgentEntry {
  id: string;
  name: string | null;
  role: string | null;
  parentId: string | null;
  status: string;
  modelProfileId: string | null;
  task?: string;
  files?: string[];
  lastTool?: string;
  tokens?: number;
  seq: number;
}

export interface WorkbookActivity {
  toolCallId: string;
  kind: "read" | "write";
  docId?: string;
  path?: string;
  ranges: string[];
}

/** 每个代理的瞬时（不入日志）状态。 */
export interface LiveState {
  stepId: string | null;
  text: string;
  reasoning: string;
  reasoningStartedAt: number | null;
  /** 正在流式生成参数的工具调用：toolCallId → 名称与参数原文。 */
  toolArgs: Record<string, { name: string; text: string }>;
  activity: WorkbookActivity[];
  contextUsage: { tokens: number; window: number | null; estimated: boolean } | null;
}

/** workbook_edit 实际提交的变更（工作簿叠加层与变更导航用）。 */
export interface ChangeEntry {
  toolCallId: string;
  docId: string;
  path: string;
  rev: number | null;
  ranges: string[];
  cells: number;
  structural: string[];
  backupPath?: string;
  agentId: string;
  seq: number;
  at?: string;
}

export interface DocEditedNotice {
  docId: string;
  path: string;
  rev: number | null;
  ranges: string[];
  text: string;
  seq: number;
}

export interface SessionState {
  /** 已应用的最大 seq（续传游标）。 */
  cursor: number;
  permissionMode: string | null;
  title: string | null;
  roster: Record<string, AgentEntry>;
  /** 详情快照里的未决交互身份，保留历史窗口外的阻塞来源，不虚构交互卡。 */
  pendingInteractions?: PendingInteraction[];
  /** 逐步 usage.updated 按代理和轮次累计，回放时也使用同一口径。 */
  usageByTurn: Record<string, Record<string, Usage>>;
  timelines: Record<string, TimelineItem[]>;
  /** 已受理但尚未应用（或已撤回/失败）的用户消息，按代理。 */
  dispatches: Record<string, UserItem>;
  tools: Record<string, ToolState>;
  approvals: Record<string, ApprovalState>;
  questions: Record<string, QuestionState>;
  todos: Record<string, TodoItem[]>;
  live: Record<string, LiveState>;
  changes: ChangeEntry[];
  /** 用户改了代理读过的区域（context.notice doc.edited）：该代理下一次读到这份文档或本轮结束前有效。 */
  docNotices: Record<string, DocEditedNotice>;
  /** 回复反馈（feedback.given，以 model.output 的 seq 为键，同一 seq 以最后一条为准）。 */
  feedback: Record<number, "up" | "down">;
  /** 各代理的回退区间 [fromSeq, atSeq)。 */
  rewinds: Record<string, { fromSeq: number; seq: number }[]>;
  /**
   * 各代理运行中的轮次：segmentId 为 null 表示当前段已被插话/提示断开，下一个块开新段。
   */
  openSegments: Record<string, { turnId: string; segment: number; segmentId: string | null }>;
}
