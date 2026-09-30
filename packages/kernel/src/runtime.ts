import type { FileIntentMeta } from "@excelmanus/protocol";
import {
  type ApprovalCoordinator,
  type ApprovalEffect,
  type ApprovalResolution,
  type ApprovalSpec,
  isAutoApproved,
  needsApproval,
} from "./approvals.ts";
import { BackupService } from "./backup.ts";
import {
  type AgentBudget,
  addUsage,
  type BudgetUsage,
  checkBudget,
  emptyBudgetUsage,
  parseBudget,
} from "./budget.ts";
import {
  COMPACTION_PROMPT,
  COMPACTION_SYSTEM,
  type CompactionTrigger,
  estimateTokens,
  keepBudgetTokens,
  planCompaction,
  tailFrom,
  transcriptForSummary,
} from "./compaction.ts";
import { FileLeaseError, type LeaseService } from "./leases.ts";
import type { QuestionCoordinator } from "./questions.ts";
// Agent actor（04 §3 子集）：邮箱串行；Preparing→Calling→Executing→循环；
// Retrying（网络/429/5xx/流中断，指数退避最多 5 次，尊重 retryAfterMs，写
// retry.scheduled；流中断写 attempt.discarded）；不可重试写 error.guidance +
// turn.failed；最大步数到顶做一次无工具总结调用。每个工具调用先写 tool.intent
// 再执行再写 tool.result。delta 经总线瞬时推送不入库。
// 消息派发三策略（04 §4.1）：steer 在步骤边界写 applied 注入本轮；interrupt
// 中止当前调用、轮以 interrupted 收尾后立即开新一轮；queue 在轮结束后各自开轮。
// 停止只中止当前轮：排队中的派发留在 dispatches 表保持 queued（挂起），经 resume 恢复。

import type { DatabaseSync } from "node:sqlite";
import { newId } from "@excelmanus/core";
import type {
  ClassifiedError,
  ContextItem,
  DeltaKind,
  DispatchMode,
  ErrorKind,
  FinishReason,
  ResolvedModel,
  ToolCall,
  ToolResult,
  ToolSpec,
  Usage,
} from "@excelmanus/protocol";
import type { SyncBus } from "./bus.ts";
import type { ModelGateway } from "./model-gateway.ts";
import type { SessionLog } from "./session-log.ts";
import type { AgentCoordinator } from "./tools.ts";
import { createReadTable, type ReadTable, type ToolDefinition } from "./tools.ts";

export interface AgentRuntimeDeps {
  db: DatabaseSync;
  log: SessionLog;
  bus: SyncBus;
  gateway: ModelGateway;
  tools: ReadonlyMap<string, ToolDefinition>;
  toolSpecsFor(role: string): ToolSpec[];
  resolveModel(agent: {
    id: string;
    sessionId: string;
    modelProfileId: string | null;
  }): ResolvedModel | { error: ClassifiedError };
  workspaceRoot(sessionId: string): string;
  workspaceId(sessionId: string): string;
  backups?: BackupService;
  leases?: LeaseService;
  approval?: ApprovalCoordinator;
  question?: QuestionCoordinator;
  agents?: AgentCoordinator;
  maxSteps?: number;
  /** M3：未显式传入时主代理 200 步、子代理 60 步。 */
  maxStepsFor?(agent: { id: string; role: string; parentId?: string | null }): number;
  /** 最多重试次数（04 §9）。 */
  maxRetries?: number;
  /** 无 Retry-After 时的指数退避基数（测试可调小）。 */
  retryBaseMs?: number;
  /** 占用达到窗口 80% 时自动压缩（04 §6.3）；false 关闭。 */
  autoCompact?: boolean;
  emit?: (event: string, fields: Record<string, unknown>) => void;
}

interface AgentRow {
  id: string;
  session_id: string;
  role: string;
  status: string;
  model_profile_id: string | null;
  system_prompt: string | null;
  usage: string | null;
  parent_id?: string | null;
  budget?: string | null;
}

const GUIDANCE_ACTIONS: Partial<Record<ErrorKind, string[]>> = {
  auth: ["检查模型档案中的 API Key", "在设置中更新凭据后重试"],
  model_not_found: ["核对模型 ID（部分服务对不存在的模型也返回通用错误）", "更换其他模型档案"],
  invalid_request: ["核对模型名与档案参数", "如持续失败请更换模型"],
  rate_limit: ["稍后重试", "检查账户额度或降低并发"],
  server_error: ["稍后重试", "如持续失败请更换模型"],
  network: ["检查网络与代理设置", "稍后重试"],
  stream_interrupted: ["稍后重试"],
  context_overflow: ["发送 /compact 压缩上下文", "或新建会话继续"],
  content_filter: ["调整请求内容后重试"],
  unknown: ["稍后重试", "如持续失败请报告问题"],
};

const GUIDANCE_MESSAGES: Record<ErrorKind, string> = {
  auth: "模型接口认证失败：API Key 无效或已过期",
  model_not_found: "模型不存在或当前凭据无权访问",
  invalid_request: "请求被模型接口拒绝",
  rate_limit: "请求频率超限，多次重试仍失败",
  server_error: "模型服务返回错误，多次重试仍失败",
  network: "无法连接模型服务",
  stream_interrupted: "模型输出中途断流，多次重试仍失败",
  context_overflow: "上下文超出模型窗口",
  aborted: "请求已取消",
  content_filter: "内容被提供商安全策略拒绝",
  unknown: "模型调用发生未知错误",
};

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export class AgentRuntime {
  private readonly deps: AgentRuntimeDeps;
  private readonly actors = new Map<string, AgentActor>();

  constructor(deps: AgentRuntimeDeps) {
    this.deps = deps;
  }

  /** 派发受理后调用：agent 空闲则开始新一轮，运行中按 mode  steer/interrupt/queue 处理。 */
  enqueue(sessionId: string, agentId: string, dispatchId: string, mode: DispatchMode): void {
    this.actor(sessionId, agentId).enqueue(dispatchId, mode);
  }

  /** 撤回排队中的派发：从内存队列移除（DB 状态由调用方先写 cancelled）。 */
  cancelDispatch(sessionId: string, agentId: string, dispatchId: string): void {
    this.actors.get(`${sessionId}/${agentId}`)?.dropDispatch(dispatchId);
  }

  /**
   * 继续（04 §4.2、§8.3）：把该代理在 DB 中挂起（accepted/queued）的派发按
   * 消息顺序重新入队；没有挂起派发且代理处于 interrupted 时开一轮无派发的
   * 继续轮（只用已持久化历史，不重放任何副作用）。
   */
  resumeAgent(sessionId: string, agentId: string): { resumed: number; started: boolean } {
    const actor = this.actor(sessionId, agentId);
    if (actor.running) return { resumed: 0, started: false };
    const rows = this.deps.db
      .prepare(
        `SELECT d.id, d.mode FROM dispatches d
         JOIN session_log m ON m.session_id = d.session_id AND m.type = 'user.message'
           AND json_extract(m.data, '$.dispatchId') = d.id
         WHERE d.session_id = ? AND d.agent_id = ? AND d.status IN ('queued', 'accepted')
         ORDER BY m.seq`,
      )
      .all(sessionId, agentId) as { id: string; mode: DispatchMode }[];
    const seen = new Set<string>();
    let resumed = 0;
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      resumed += 1;
      actor.enqueue(row.id, row.mode);
    }
    if (resumed === 0) {
      const agent = this.deps.db
        .prepare("SELECT status FROM agents WHERE session_id = ? AND id = ?")
        .get(sessionId, agentId) as { status: string } | undefined;
      if (agent?.status === "interrupted") actor.enqueueInbox();
    }
    return { resumed, started: actor.running };
  }

  /** 收件箱消息到达：不伪造 user.message 派发，只唤醒目标 actor。 */
  enqueueInbox(sessionId: string, agentId: string): void {
    const row = this.deps.db
      .prepare("SELECT status FROM agents WHERE session_id = ? AND id = ?")
      .get(sessionId, agentId) as { status: string } | undefined;
    // 代理间消息不会绕过用户/父代理的 resume；暂停、重启中断或终态代理只保留
    // inbox_pending，避免乒乓检测后又被后续消息偷偷唤醒。
    if (!row || ["paused", "interrupted", "closed", "failed"].includes(row.status)) return;
    this.actor(sessionId, agentId).enqueueInbox();
  }

  /** 停止：中止当前模型请求/工具，返回是否有运行中的轮。 */
  stop(sessionId: string, agentId: string): boolean {
    return this.actors.get(`${sessionId}/${agentId}`)?.requestStop() ?? false;
  }

  isRunning(sessionId: string, agentId: string): boolean {
    return this.actors.get(`${sessionId}/${agentId}`)?.running ?? false;
  }

  /** 手动压缩（04 §6.3）：运行中排期到下一步边界，空闲时占用 actor 立即执行。 */
  compact(sessionId: string, agentId: string): Promise<{ compacted: boolean; scheduled: boolean }> {
    return this.actor(sessionId, agentId).requestCompact();
  }

  /** REST 审批决定入口。决定写入日志后唤醒当前 actor；重启后由持久化记录恢复一次工具调用。 */
  decideApproval(
    id: string,
    decision: "approved" | "denied",
    reason?: string,
    remember = false,
  ): {
    row: import("./approvals.ts").ApprovalRow;
    idempotent: boolean;
  } {
    const approval = this.deps.approval;
    if (!approval) throw new Error("审批执行器未装配");
    const current = approval.get(id);
    if (!current) throw new Error("审批不存在");
    const out = approval.decide(id, decision, reason, remember);
    if (!out.idempotent && !approval.hasWaiter(id)) {
      const actor = this.actor(current.session_id, current.agent_id);
      void actor.resumePersistedApproval(id);
    }
    return out;
  }

  /** REST 问题回答入口；没有当前 waiter 时由新 actor 完成一次持久化调用恢复。 */
  answerQuestion(
    id: string,
    answer: unknown,
    rev?: number,
  ): { row: import("./questions.ts").QuestionRow; idempotent: boolean } {
    const question = this.deps.question;
    if (!question) throw new Error("提问执行器未装配");
    const current = question.get(id);
    if (!current) throw new Error("问题不存在");
    const out = question.answer(id, answer, rev);
    if (!out.idempotent && !question.hasWaiter(id)) {
      const actor = this.actor(current.session_id, current.agent_id);
      void actor.resumePersistedQuestion(id);
    }
    return out;
  }

  private actor(sessionId: string, agentId: string): AgentActor {
    const key = `${sessionId}/${agentId}`;
    let a = this.actors.get(key);
    if (!a) {
      a = new AgentActor(this.deps, sessionId, agentId);
      this.actors.set(key, a);
    }
    return a;
  }
}

type StepOutcome = "continue" | "done" | "failed" | "interrupted" | "budget_exceeded";

/** 内存队列条目：用户消息派发或收件箱唤醒。 */
type QueueEntry = { dispatchId: string; mode: DispatchMode } | { inbox: true };

class AgentActor {
  private queue: QueueEntry[] = [];
  private _running = false;
  private stopRequested = false;
  private interruptRequested = false;
  /** 运行中的手动压缩请求：到下一个步骤边界执行。 */
  private compactRequested = false;
  /** 最近一次模型调用报告的上下文占用（input+output token）；无报告时回退字符估算。 */
  private lastContextTokens: number | undefined;
  /** 中止当前等待/调用时写入审批决定或工具结果的理由。 */
  private abortReason = "代理已停止";
  private callAbort: AbortController | null = null;
  private currentTurnId: string | null = null;
  private readonly deps: AgentRuntimeDeps;
  private readonly sessionId: string;
  private readonly agentId: string;
  /** 本代理的文档读集（07 §10；actor 卸下即丢弃）。 */
  private readonly reads: ReadTable = createReadTable();
  /** 本轮与历史累计预算；每次 usage.updated 同事务持久化。 */
  private budgetUsage: BudgetUsage = emptyBudgetUsage();
  private budget: AgentBudget = {};

  constructor(deps: AgentRuntimeDeps, sessionId: string, agentId: string) {
    this.deps = deps;
    this.sessionId = sessionId;
    this.agentId = agentId;
  }

  get running(): boolean {
    return this._running;
  }

  enqueue(dispatchId: string, mode: DispatchMode): void {
    if (mode === "interrupt" && this._running) {
      // 打断（04 §4.1）：插到队列最前，中止当前模型请求/工具/审批等待，
      // 当前轮以 interrupted 收尾后由 pump 立即开新一轮。
      this.queue.unshift({ dispatchId, mode });
      this.interruptRequested = true;
      this.abortReason = "用户发送了新指令";
      this.callAbort?.abort();
    } else {
      this.queue.push({ dispatchId, mode });
    }
    void this.pump();
  }

  enqueueInbox(): void {
    this.queue.push({ inbox: true });
    void this.pump();
  }

  dropDispatch(dispatchId: string): void {
    this.queue = this.queue.filter((e) => "inbox" in e || e.dispatchId !== dispatchId);
  }

  /** 进程重启后没有 in-memory continuation：从 pending spec 执行已批准调用。 */
  async resumePersistedApproval(id: string): Promise<void> {
    const approval = this.deps.approval;
    const row = approval?.get(id);
    if (
      !approval ||
      !row ||
      (row.status !== "approved" && row.status !== "denied") ||
      this._running
    )
      return;
    const spec = JSON.parse(row.spec) as ApprovalSpec & { approvalId?: string };
    const tool = this.deps.tools.get(spec.toolName);
    if (!tool) return;
    const parsed = tool.input.safeParse(spec.args);
    if (!parsed.success) return;
    this._running = true;
    this.currentTurnId = spec.turnId ?? null;
    try {
      const scope = {
        workspaceId: this.deps.workspaceId(this.sessionId),
        workspaceRoot: this.deps.workspaceRoot(this.sessionId),
        sessionId: this.sessionId,
        agentId: this.agentId,
      };
      let result: ToolResult = {
        status: "error",
        error: { code: "INTERNAL", message: "工具未执行", retryable: false },
      };
      if (row.status === "denied") {
        result = {
          status: "error",
          error: {
            code: "APPROVAL_DENIED",
            message: row.reason ? `用户拒绝：${row.reason}` : "用户拒绝了此操作",
            retryable: false,
          },
        };
      } else {
        const ctrl = new AbortController();
        try {
          if (
            this.deps.leases &&
            (spec.effect === "write" || spec.effect === "destructive" || spec.effect === "external")
          ) {
            this.deps.leases.assertAvailable(
              { sessionId: this.sessionId, agentId: this.agentId, targets: spec.targets },
              { mainBypass: true },
            );
          }
          result = await tool.execute(parsed.data, {
            ...scope,
            signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(tool.timeoutMs)]),
            toolCallId: spec.toolCallId,
            reads: this.reads,
            backups: (this.deps.backups ?? new BackupService(this.deps.db)).bind(scope),
            leases: this.deps.leases,
            agents: this.deps.agents,
            rawArgs: spec.args,
            destructiveApproved: true,
          });
        } catch (err) {
          result = {
            status: "error",
            ...(err instanceof FileLeaseError
              ? {
                  data: {
                    target: err.target,
                    holder: { agentId: err.holder.agent_id, path: err.holder.path },
                  },
                }
              : {}),
            error: {
              code: err instanceof FileLeaseError ? "FILE_LEASED" : "INTERNAL",
              message:
                err instanceof FileLeaseError
                  ? err.message
                  : err instanceof Error
                    ? err.message
                    : String(err),
              retryable: false,
            },
          };
        }
      }
      this.deps.log.append(this.sessionId, this.agentId, [
        {
          type: "tool.result",
          data: {
            toolCallId: spec.toolCallId,
            toolName: spec.toolName,
            status: result.status,
            result,
          },
        },
      ]);
      // 04 §5.2 第 4/5 条：决定后继续本轮——先补执行该步排在后面且尚无
      // tool.result 的调用（各自重新走审批），再进入步骤循环直到收口。
      if (spec.turnId !== undefined) {
        const remaining = this.unansweredCalls(spec.stepId, spec.toolCallId);
        if (remaining.length > 0 && spec.stepId !== undefined) {
          const outcome = await this.executeCalls(spec.turnId, spec.stepId, remaining);
          if (outcome !== "continue") return;
        }
        if (this.stopRequested || this.interruptRequested) {
          this.deps.log.append(this.sessionId, this.agentId, [
            { type: "turn.interrupted", data: { turnId: spec.turnId } },
          ]);
          return;
        }
        await this.continueTurn(spec.turnId, this.stepsSoFar(spec.turnId));
      }
    } finally {
      this._running = false;
      this.currentTurnId = null;
      // 审批决定后让等待期间排队的派发继续运行（04 §4.1 注：steer/queue 在决定后继续）
      void this.pump();
    }
  }

  /** 该步 model.output 中排在 toolCallId 之后、且还没有 tool.result 的调用。 */
  private unansweredCalls(stepId: string | undefined, uptoToolCallId: string): ToolCall[] {
    if (stepId === undefined) return [];
    const row = this.deps.db
      .prepare(
        "SELECT data FROM session_log WHERE session_id = ? AND agent_id = ? AND type = 'model.output' AND json_extract(data, '$.stepId') = ? ORDER BY seq DESC LIMIT 1",
      )
      .get(this.sessionId, this.agentId, stepId) as { data: string } | undefined;
    if (row === undefined) return [];
    const calls = ((JSON.parse(row.data) as { toolCalls?: ToolCall[] }).toolCalls ??
      []) as ToolCall[];
    const idx = calls.findIndex((c) => c.id === uptoToolCallId);
    const tail = idx >= 0 ? calls.slice(idx + 1) : [];
    if (tail.length === 0) return [];
    const answered = new Set(
      (
        this.deps.db
          .prepare(
            "SELECT DISTINCT json_extract(data, '$.toolCallId') AS id FROM session_log WHERE session_id = ? AND agent_id = ? AND type = 'tool.result'",
          )
          .all(this.sessionId, this.agentId) as { id: string | null }[]
      ).map((r) => r.id),
    );
    return tail.filter((c) => !answered.has(c.id));
  }

  /** 日志中该轮已发出的 step.started 条数，恢复路径据此续算步数。 */
  private stepsSoFar(turnId: string): number {
    return (
      this.deps.db
        .prepare(
          "SELECT COUNT(*) AS c FROM session_log WHERE session_id = ? AND agent_id = ? AND type = 'step.started' AND json_extract(data, '$.turnId') = ?",
        )
        .get(this.sessionId, this.agentId, turnId) as { c: number }
    ).c;
  }

  /** 进程重启后没有 in-memory continuation：完成一次已回答的 ask_user 调用。 */
  async resumePersistedQuestion(id: string): Promise<void> {
    const question = this.deps.question;
    const row = question?.get(id);
    if (!question || !row || row.status !== "approved" || this._running) return;
    let spec: { questionType?: string; spec?: Record<string, unknown> };
    try {
      spec = JSON.parse(row.spec) as typeof spec;
    } catch {
      return;
    }
    const runtime = spec.spec?._runtime;
    const meta = runtime && typeof runtime === "object" ? (runtime as Record<string, unknown>) : {};
    const answer = row.reason
      ? (() => {
          try {
            const value = JSON.parse(row.reason) as { answer?: unknown; rev?: unknown };
            return value;
          } catch {
            return { answer: row.reason };
          }
        })()
      : {};
    const toolCallId =
      row.tool_call_id ?? (typeof meta.toolCallId === "string" ? meta.toolCallId : undefined);
    if (!toolCallId) return;
    this._running = true;
    try {
      const result: ToolResult = {
        status: "ok",
        data: {
          questionId: id,
          status: "answered",
          ...(Object.hasOwn(answer, "answer") ? { answer: answer.answer } : {}),
          ...(typeof answer.rev === "number" ? { rev: answer.rev } : {}),
        },
      };
      const turnId = typeof meta.turnId === "string" ? meta.turnId : undefined;
      const stepId = typeof meta.stepId === "string" ? meta.stepId : undefined;
      this.deps.log.append(this.sessionId, this.agentId, [
        {
          type: "tool.result",
          data: { toolCallId, toolName: "ask_user", status: result.status, result },
        },
      ]);
      // 同审批恢复：回答作为 tool.result 后继续本轮（04 §5.2）。
      if (turnId !== undefined) {
        this.currentTurnId = turnId;
        const remaining = this.unansweredCalls(stepId, toolCallId);
        if (remaining.length > 0 && stepId !== undefined) {
          const outcome = await this.executeCalls(turnId, stepId, remaining);
          if (outcome !== "continue") return;
        }
        if (this.stopRequested || this.interruptRequested) {
          this.deps.log.append(this.sessionId, this.agentId, [
            { type: "turn.interrupted", data: { turnId } },
          ]);
          return;
        }
        await this.continueTurn(turnId, this.stepsSoFar(turnId));
      }
    } finally {
      this._running = false;
      this.currentTurnId = null;
      void this.pump();
    }
  }

  requestStop(): boolean {
    if (!this._running) return false;
    this.stopRequested = true;
    this.abortReason = "代理已停止";
    // 停止后排队中的消息不自动开始（04 §4.2）：内存队列清空，DB 里保持
    // queued 即挂起，只经 resume 恢复。
    this.queue = [];
    this.callAbort?.abort();
    return true;
  }

  /**
   * 手动压缩（04 §6.3）：运行中置标记、到下一个步骤边界执行；空闲时占用
   * actor 直接执行（期间到达的消息照常入队，结束后 pump），不写 turn.* 记录。
   * 摘要失败抛出，由 REST 层转成 502。
   */
  async requestCompact(): Promise<{ compacted: boolean; scheduled: boolean }> {
    if (this._running) {
      this.compactRequested = true;
      return { compacted: false, scheduled: true };
    }
    this._running = true;
    try {
      const agent = this.agent();
      if (!agent) return { compacted: false, scheduled: false };
      const resolved = this.deps.resolveModel({
        id: agent.id,
        sessionId: agent.session_id,
        modelProfileId: agent.model_profile_id,
      });
      if ("error" in resolved) throw new Error(resolved.error.message);
      return { compacted: await this.compactContext("manual", resolved), scheduled: false };
    } finally {
      this._running = false;
      void this.pump();
    }
  }

  /** 当前上下文占用：优先提供商报告的上一轮 input+output，否则字符估算。 */
  private contextUsage(model: ResolvedModel): {
    tokens: number;
    window: number | null;
    estimated: boolean;
  } {
    const estimated = this.lastContextTokens === undefined;
    return {
      tokens: Math.round(this.lastContextTokens ?? estimateTokens(this.history())),
      window: model.contextWindow ?? null,
      estimated,
    };
  }

  /** auto 触发条件：窗口已知且占用 ≥ 80%（04 §6.3）。 */
  private shouldAutoCompact(model: ResolvedModel): boolean {
    if (this.deps.autoCompact === false || model.contextWindow === undefined) return false;
    return this.contextUsage(model).tokens >= 0.8 * model.contextWindow;
  }

  /**
   * 执行一次压缩：规划切点 → 纯文本转录送摘要模型 → 写 compaction 记录
   * （投影负责标记 superseded 与复制保留尾部）。返回是否写了记录；
   * 摘要调用失败抛出。
   */
  private async compactContext(trigger: CompactionTrigger, model: ResolvedModel): Promise<boolean> {
    const rows = this.deps.db
      .prepare(
        "SELECT item, from_seq FROM agent_context WHERE session_id = ? AND agent_id = ? AND superseded = 0 ORDER BY idx",
      )
      .all(this.sessionId, this.agentId) as { item: string; from_seq: number }[];
    const parsed = rows.map((r) => ({
      item: JSON.parse(r.item) as ContextItem,
      fromSeq: r.from_seq,
    }));
    const estimated = this.lastContextTokens === undefined;
    // 提供商用量理论上是整数，防御性取整以满足记录的 int 约束。
    const beforeTokens = Math.round(
      this.lastContextTokens ?? estimateTokens(parsed.map((r) => r.item)),
    );
    const plan = planCompaction(parsed, keepBudgetTokens(model.contextWindow, beforeTokens));
    if (plan === null) return false;
    const summary = await this.callSummaryModel(
      model,
      transcriptForSummary(plan.old.map((r) => r.item)),
    );
    const summaryItem: ContextItem = { kind: "user", text: `<summary>\n${summary}\n</summary>` };
    const kept = tailFrom(parsed, plan.keepFromSeq).map((r) => r.item);
    const afterTokens = estimateTokens([summaryItem, ...kept]);
    this.deps.log.append(this.sessionId, this.agentId, [
      {
        type: "compaction",
        data: {
          trigger,
          summary,
          keepFromSeq: plan.keepFromSeq,
          beforeTokens,
          afterTokens,
          estimated,
        },
      },
    ]);
    this.lastContextTokens = undefined;
    return true;
  }

  /**
   * 摘要模型调用：同一 ResolvedModel，不传 tools、不发 delta、不写 model.output；
   * 待压缩条目渲染成纯文本转录，避免结构化工具消息被提供商拒绝（04 §6.3）。
   */
  private async callSummaryModel(model: ResolvedModel, transcript: string): Promise<string> {
    const ctrl = new AbortController();
    this.callAbort = ctrl;
    try {
      let text = "";
      let usage: Usage | undefined;
      let failed: ClassifiedError | undefined;
      for await (const ev of this.deps.gateway.step({
        model,
        system: COMPACTION_SYSTEM,
        history: [{ kind: "user", text: `${transcript}\n\n${COMPACTION_PROMPT}` }],
        providerOptions: model.providerOptions,
        signal: ctrl.signal,
      })) {
        if (ev.kind === "text.delta") text += ev.text;
        else if (ev.kind === "usage") usage = ev.usage;
        else if (ev.kind === "error") failed = ev.error;
      }
      if (usage !== undefined) this.budgetUsage = addUsage(this.budgetUsage, usage);
      if (failed !== undefined || text.trim() === "") {
        throw new Error(failed?.message ?? "摘要模型未返回内容");
      }
      return text;
    } finally {
      this.callAbort = null;
    }
  }

  /** 派发仍待生效时才允许开轮/注入：已 cancelled/applied/failed 的条目直接丢弃。 */
  private dispatchAlive(dispatchId: string): boolean {
    const row = this.deps.db
      .prepare("SELECT status FROM dispatches WHERE id = ? AND session_id = ?")
      .get(dispatchId, this.sessionId) as { status: string } | undefined;
    return row !== undefined && (row.status === "accepted" || row.status === "queued");
  }

  /** 派发对应 user.message 的 seq：用于把插队后的批次恢复为消息到达顺序。 */
  private dispatchSeq(dispatchId: string): number {
    const row = this.deps.db
      .prepare(
        "SELECT seq FROM session_log WHERE session_id = ? AND type = 'user.message' AND json_extract(data, '$.dispatchId') = ? LIMIT 1",
      )
      .get(this.sessionId, dispatchId) as { seq: number } | undefined;
    return row?.seq ?? Number.MAX_SAFE_INTEGER;
  }

  /**
   * 取下一轮输入：队列第一个有效条目 + 全部剩余 steer 条目（interrupt 插队会
   * 打乱队列顺序，按 user.message 的 seq 恢复到达顺序）。inbox 唤醒返回空数组。
   */
  private takeBatch(): string[] | null {
    let head: QueueEntry | undefined;
    while (head === undefined && this.queue.length > 0) {
      const item = this.queue.shift() as QueueEntry;
      if ("inbox" in item || this.dispatchAlive(item.dispatchId)) head = item;
    }
    if (head === undefined) return null;
    const dispatchIds = "inbox" in head ? [] : [head.dispatchId];
    const rest: QueueEntry[] = [];
    for (const item of this.queue) {
      if ("inbox" in item) {
        rest.push(item);
      } else if (this.dispatchAlive(item.dispatchId)) {
        if (item.mode === "steer" && !dispatchIds.includes(item.dispatchId)) {
          dispatchIds.push(item.dispatchId);
        } else {
          rest.push(item);
        }
      }
    }
    this.queue = rest;
    dispatchIds.sort((a, b) => this.dispatchSeq(a) - this.dispatchSeq(b));
    return dispatchIds;
  }

  /** 等待审批/回答且内存中无在跑轮：不自动开新轮（重启后持久化 pending 仍在的情况）。 */
  private awaitingInteraction(): boolean {
    const agent = this.agent();
    if (agent?.status !== "blocked") return false;
    return (
      this.deps.db
        .prepare(
          "SELECT 1 FROM pending_interactions WHERE session_id = ? AND agent_id = ? AND status = 'pending' LIMIT 1",
        )
        .get(this.sessionId, this.agentId) !== undefined
    );
  }

  private async pump(): Promise<void> {
    if (this._running) return;
    if (this.awaitingInteraction()) return;
    const dispatchIds = this.takeBatch();
    if (dispatchIds === null) return;
    this._running = true;
    this.stopRequested = false;
    this.interruptRequested = false;
    try {
      await this.runTurn(dispatchIds);
    } catch (err) {
      // 未捕获的内部错误：尽力写 turn.failed，避免 actor 卡死在 running
      this.failInternal(err);
    } finally {
      this._running = false;
      this.currentTurnId = null;
      void this.pump();
    }
  }

  private agent(): AgentRow | undefined {
    return this.deps.db
      .prepare("SELECT * FROM agents WHERE session_id = ? AND id = ?")
      .get(this.sessionId, this.agentId) as AgentRow | undefined;
  }

  private history(): ContextItem[] {
    const rows = this.deps.db
      .prepare(
        "SELECT item FROM agent_context WHERE session_id = ? AND agent_id = ? AND superseded = 0 ORDER BY idx",
      )
      .all(this.sessionId, this.agentId) as { item: string }[];
    return rows.map((r) => JSON.parse(r.item) as ContextItem);
  }

  private delta(stepId: string, part: number, kind: DeltaKind, payload: unknown): void {
    this.deps.bus.publish({
      kind: "delta",
      sessionId: this.sessionId,
      agentId: this.agentId,
      stepId,
      part,
      deltaKind: kind,
      payload,
    });
  }

  private async runTurn(dispatchIds: string[]): Promise<void> {
    const { log } = this.deps;
    const turnId = newId("trn");
    this.currentTurnId = turnId;
    log.append(this.sessionId, this.agentId, [
      ...dispatchIds.map((dispatchId) => ({
        type: "dispatch.updated",
        data: { dispatchId, status: "applied" },
      })),
      { type: "turn.started", data: { turnId } },
    ]);
    await this.continueTurn(turnId, 0);
  }

  /**
   * 一轮的步骤循环（04 §5.2）：runTurn 与重启恢复共用。startStep 为日志中该轮
   * 已有 step.started 条数——恢复路径在旧步骤的工具调用续完后接着走步骤循环，
   * 不写新的 turn.started。
   */
  private async continueTurn(turnId: string, startStep: number): Promise<void> {
    const { log } = this.deps;
    const agent = this.agent();
    if (!agent) {
      this.failTurn(turnId, {
        kind: "unknown",
        retryable: false,
        message: `代理 ${this.agentId} 不存在`,
      });
      return;
    }
    const resolved = this.deps.resolveModel({
      id: agent.id,
      sessionId: agent.session_id,
      modelProfileId: agent.model_profile_id,
    });
    if ("error" in resolved) {
      this.failTurn(turnId, resolved.error);
      return;
    }

    const configuredBudget = parseBudget(agent.budget);
    const defaultMax = agent.role === "main" ? 200 : 60;
    const maxSteps =
      this.deps.maxStepsFor?.({ id: agent.id, role: agent.role, parentId: agent.parent_id }) ??
      this.deps.maxSteps ??
      configuredBudget.maxSteps ??
      defaultMax;
    this.budget = { ...configuredBudget, maxSteps };
    const persistedUsage = agent.usage ? this.parseUsage(agent.usage) : undefined;
    // 步数是单轮预算；token 与工具调用保持跨轮累计，便于重启后继续受限。
    this.budgetUsage = persistedUsage
      ? { ...persistedUsage, steps: 0, startedAt: Date.now() }
      : emptyBudgetUsage();
    let step = startStep;
    for (;;) {
      if (this.stopRequested || this.interruptRequested) {
        log.append(this.sessionId, this.agentId, [{ type: "turn.interrupted", data: { turnId } }]);
        return;
      }
      step += 1;
      this.budgetUsage.steps = Math.max(this.budgetUsage.steps, step);
      // 步数到顶仍允许一次无工具总结调用；累计 token/工具调用到顶则直接收口。
      const overStepLimit = step > maxSteps;
      if (!overStepLimit && !checkBudget(this.budget, this.budgetUsage).ok) {
        const budgetCheck = checkBudget(this.budget, this.budgetUsage);
        log.append(this.sessionId, this.agentId, [
          { type: "turn.completed", data: { turnId, reason: "budget_exceeded" } },
          {
            type: "error.guidance",
            data: {
              kind: "budget",
              message:
                budgetCheck.limit === "maxTokens"
                  ? `累计 token 已达到上限 ${budgetCheck.max}`
                  : budgetCheck.limit === "maxToolCalls"
                    ? `工具调用次数已达到上限 ${budgetCheck.max}`
                    : `本轮步数已达到上限 ${maxSteps}`,
              actions: ["缩小任务范围", "继续发送消息以开始新一轮"],
            },
          },
        ]);
        return;
      }
      const outcome = await this.runStep(turnId, step, resolved, agent, overStepLimit);
      if (outcome === "continue") continue;
      if (outcome === "budget_exceeded") {
        log.append(this.sessionId, this.agentId, [
          { type: "turn.completed", data: { turnId, reason: "budget_exceeded" } },
        ]);
      }
      return;
    }
  }

  private parseUsage(raw: string): BudgetUsage | undefined {
    try {
      const value = JSON.parse(raw) as Partial<BudgetUsage>;
      return {
        ...emptyBudgetUsage(),
        steps: typeof value.steps === "number" ? value.steps : 0,
        toolCalls: typeof value.toolCalls === "number" ? value.toolCalls : 0,
        inputTokens: typeof value.inputTokens === "number" ? value.inputTokens : 0,
        outputTokens: typeof value.outputTokens === "number" ? value.outputTokens : 0,
        reasoningTokens: typeof value.reasoningTokens === "number" ? value.reasoningTokens : 0,
        totalTokens: typeof value.totalTokens === "number" ? value.totalTokens : 0,
        startedAt: undefined,
      };
    } catch {
      return undefined;
    }
  }

  /** 一步 = 一次模型调用 + 该次调用产生的工具执行。返回下一步走向。 */
  private async runStep(
    turnId: string,
    step: number,
    model: ResolvedModel,
    agent: AgentRow,
    forceFinal: boolean,
  ): Promise<StepOutcome> {
    const { log, gateway } = this.deps;
    const maxRetries = this.deps.maxRetries ?? 5;
    const retryBase = this.deps.retryBaseMs ?? 1000;
    const topic = this.sessionId;
    let retries = 0;
    // 本步内 auto/manual 压缩只尝试一次（失败跳过本次）；overflow 只压缩重试一次（04 §6.3）。
    let compactTried = false;
    let overflowCompacted = false;

    for (;;) {
      // 压缩等步前工作可能消耗时间在标记置位之后：每个循环边界先收口停止/打断。
      if (this.stopRequested || this.interruptRequested) {
        log.append(topic, this.agentId, [{ type: "turn.interrupted", data: { turnId } }]);
        return "interrupted";
      }
      this.applyQueuedSteers();
      this.deliverInbox();
      if (this.compactRequested || (!compactTried && this.shouldAutoCompact(model))) {
        const trigger: CompactionTrigger = this.compactRequested ? "manual" : "auto";
        this.compactRequested = false;
        compactTried = true;
        try {
          await this.compactContext(trigger, model);
        } catch (err) {
          this.deps.emit?.("compaction.failed", {
            sessionId: this.sessionId,
            agentId: this.agentId,
            trigger,
            message: err instanceof Error ? err.message : String(err),
          });
        }
        // 摘要调用可能被停止/打断中止：继续前先收口本轮
        if (this.stopRequested || this.interruptRequested) {
          log.append(topic, this.agentId, [{ type: "turn.interrupted", data: { turnId } }]);
          return "interrupted";
        }
      }
      const stepId = newId("stp");
      log.append(topic, this.agentId, [
        {
          type: "step.started",
          data: { turnId, stepId, step, model: `${model.provider}/${model.model}` },
        },
      ]);

      const ctrl = new AbortController();
      this.callAbort = ctrl;
      let sawContent = false;
      let text = "";
      let reasoning = "";
      let reasoningProviderOptions: Record<string, unknown> | undefined;
      let usage: Usage | undefined;
      let finish: FinishReason | undefined;
      const toolCalls: ToolCall[] = [];
      const toolCallIdx = new Map<string, number>();
      let classified: ClassifiedError | undefined;
      let part = 0;
      try {
        const history = this.history();
        const prompt = forceFinal
          ? [
              ...history,
              {
                kind: "user",
                text: "（系统提示）本轮已达到最大步数上限。请停止调用工具，用中文简要总结目前进度与未完成事项，作为本轮最终回复。",
              } satisfies ContextItem,
            ]
          : history;
        const req = {
          model,
          system: agent.system_prompt ?? undefined,
          history: prompt,
          tools: forceFinal ? undefined : this.deps.toolSpecsFor(agent.role),
          providerOptions: model.providerOptions,
          signal: ctrl.signal,
        };
        for await (const ev of gateway.step(req)) {
          part += 1;
          switch (ev.kind) {
            case "text.delta":
              sawContent = true;
              text += ev.text;
              this.delta(stepId, part, "text", ev.text);
              break;
            case "reasoning.delta":
              sawContent = true;
              reasoning += ev.text;
              if (ev.providerMetadata !== undefined) {
                reasoningProviderOptions = ev.providerMetadata as Record<string, unknown>;
              }
              this.delta(stepId, part, "reasoning", ev.text);
              break;
            case "tool.args.delta": {
              sawContent = true;
              if (!toolCallIdx.has(ev.toolCallId)) {
                toolCallIdx.set(ev.toolCallId, toolCallIdx.size);
              }
              this.delta(stepId, toolCallIdx.get(ev.toolCallId) ?? 0, "tool_args", ev.delta);
              break;
            }
            case "tool.call":
              sawContent = true;
              toolCallIdx.set(ev.toolCallId, toolCallIdx.size);
              toolCalls.push({ id: ev.toolCallId, name: ev.toolName, args: ev.args });
              break;
            case "usage":
              usage = ev.usage;
              break;
            case "finish":
              finish = ev.reason;
              break;
            case "error":
              classified = ev.error;
              break;
            default:
              break;
          }
        }
      } catch (err) {
        classified = {
          kind: "unknown",
          retryable: false,
          message: err instanceof Error ? err.message : String(err),
        };
      } finally {
        this.callAbort = null;
      }

      if (!classified) {
        if (usage !== undefined) this.budgetUsage = addUsage(this.budgetUsage, usage);
        // 提供商报告的本步上下文占用（04 §6.1）；无报告回退字符估算。
        this.lastContextTokens =
          usage !== undefined && (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) > 0
            ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
            : undefined;
        this.budgetUsage.toolCalls += toolCalls.length;
        const budgetRecord = usage !== undefined || toolCalls.length > 0;
        log.append(topic, this.agentId, [
          {
            type: "model.output",
            data: {
              stepId,
              ...(text !== "" ? { text } : {}),
              ...(reasoning !== "" ? { reasoning } : {}),
              ...(reasoningProviderOptions !== undefined ? { reasoningProviderOptions } : {}),
              ...(toolCalls.length > 0 ? { toolCalls } : {}),
            },
          },
        ]);
        const budgetExceeded = !checkBudget(this.budget, this.budgetUsage).ok;
        if (toolCalls.length === 0 || forceFinal) {
          // forceFinal 下不再执行工具：未开始的调用一律 not_executed 收尾
          const tail = toolCalls.map((c) => ({
            type: "tool.result",
            data: {
              toolCallId: c.id,
              toolName: c.name,
              status: "not_executed",
              result: {
                status: "not_executed",
                error: {
                  code: "CANCELLED",
                  message: "已达最大步数，该工具未执行",
                  retryable: false,
                },
              },
            },
          }));
          log.append(topic, this.agentId, [
            ...tail,
            {
              type: "turn.completed",
              data: {
                turnId,
                reason: forceFinal ? "step_limit" : (finish ?? "stop"),
                ...(usage !== undefined ? { usage } : {}),
              },
            },
            ...(budgetRecord
              ? [
                  {
                    type: "usage.updated",
                    data: {
                      turnId,
                      usage: usage ?? {},
                      cumulative: {
                        inputTokens: this.budgetUsage.inputTokens,
                        outputTokens: this.budgetUsage.outputTokens,
                        reasoningTokens: this.budgetUsage.reasoningTokens,
                        totalTokens: this.budgetUsage.totalTokens,
                      },
                      steps: this.budgetUsage.steps,
                      toolCalls: this.budgetUsage.toolCalls,
                      context: this.contextUsage(model),
                    },
                  },
                ]
              : []),
          ]);
          return "done";
        }
        if (budgetRecord) {
          log.append(topic, this.agentId, [
            {
              type: "usage.updated",
              data: {
                turnId,
                usage: usage ?? {},
                cumulative: {
                  inputTokens: this.budgetUsage.inputTokens,
                  outputTokens: this.budgetUsage.outputTokens,
                  reasoningTokens: this.budgetUsage.reasoningTokens,
                  totalTokens: this.budgetUsage.totalTokens,
                },
                steps: this.budgetUsage.steps,
                toolCalls: this.budgetUsage.toolCalls,
                context: this.contextUsage(model),
              },
            },
          ]);
        }
        if (budgetExceeded) {
          log.append(topic, this.agentId, [
            ...toolCalls.map((c) => ({
              type: "tool.result",
              data: {
                toolCallId: c.id,
                toolName: c.name,
                status: "not_executed",
                result: {
                  status: "not_executed",
                  error: {
                    code: "LIMIT_EXCEEDED",
                    message: "预算已耗尽，该工具未执行",
                    retryable: false,
                  },
                },
              },
            })),
          ]);
          return "budget_exceeded";
        }
        return this.executeCalls(turnId, stepId, toolCalls);
      }

      // 错误路径
      const stopped =
        this.stopRequested || this.interruptRequested || classified.kind === "aborted";
      if (stopped) {
        if (sawContent) {
          log.append(topic, this.agentId, [{ type: "attempt.discarded", data: { stepId } }]);
        }
        log.append(topic, this.agentId, [{ type: "turn.interrupted", data: { turnId } }]);
        return "interrupted";
      }
      // 上下文超限（04 §6.3、14 场景 22）：压缩一次后重试本步；
      // 已压缩过、无可压缩或摘要失败则按原分类收口。
      if (classified.kind === "context_overflow") {
        if (!overflowCompacted) {
          if (sawContent) {
            log.append(topic, this.agentId, [{ type: "attempt.discarded", data: { stepId } }]);
          }
          let compacted = false;
          try {
            compacted = await this.compactContext("overflow", model);
          } catch (err) {
            if (this.stopRequested || this.interruptRequested) {
              log.append(topic, this.agentId, [{ type: "turn.interrupted", data: { turnId } }]);
              return "interrupted";
            }
            this.deps.emit?.("compaction.failed", {
              sessionId: this.sessionId,
              agentId: this.agentId,
              trigger: "overflow",
              message: err instanceof Error ? err.message : String(err),
            });
          }
          if (compacted) {
            overflowCompacted = true;
            continue;
          }
        }
        this.failTurn(turnId, classified);
        return "failed";
      }
      const retryable = classified.retryable;
      if (retryable && retries < maxRetries) {
        retries += 1;
        if (sawContent) {
          log.append(topic, this.agentId, [{ type: "attempt.discarded", data: { stepId } }]);
        }
        const waitMs = classified.retryAfterMs ?? Math.min(retryBase * 2 ** (retries - 1), 30_000);
        log.append(topic, this.agentId, [
          {
            type: "retry.scheduled",
            data: { attempt: retries, waitMs, reason: classified.kind },
          },
        ]);
        const sleepCtrl = new AbortController();
        this.callAbort = sleepCtrl;
        await sleep(waitMs, sleepCtrl.signal);
        this.callAbort = null;
        if (this.stopRequested || this.interruptRequested) {
          log.append(topic, this.agentId, [{ type: "turn.interrupted", data: { turnId } }]);
          return "interrupted";
        }
        continue;
      }
      this.failTurn(turnId, classified);
      return "failed";
    }
  }

  /**
   * 步骤边界把队列中所有 steer 派发一次性写 applied（04 §4.1）：同事务更新
   * agent_context，本步随后读 history 即可见。已撤回的条目直接丢弃。
   */
  private applyQueuedSteers(): void {
    const ids: string[] = [];
    const rest: QueueEntry[] = [];
    for (const item of this.queue) {
      if ("inbox" in item) {
        rest.push(item);
      } else if (!this.dispatchAlive(item.dispatchId)) {
      } else if (item.mode === "steer") {
        if (!ids.includes(item.dispatchId)) ids.push(item.dispatchId);
      } else {
        rest.push(item);
      }
    }
    if (ids.length === 0) {
      this.queue = rest;
      return;
    }
    this.queue = rest;
    this.deps.log.append(
      this.sessionId,
      this.agentId,
      ids.map((dispatchId) => ({
        type: "dispatch.updated",
        data: { dispatchId, status: "applied" },
      })),
    );
  }

  /** 步骤边界把收件箱 pending 标记为 delivered；内容已由 inbox projection 注入 agent_context。 */
  private deliverInbox(): void {
    const rows = this.deps.db
      .prepare(
        "SELECT message_id, to_agent_id FROM inbox_pending WHERE session_id = ? AND to_agent_id = ? AND status = 'pending' ORDER BY urgent DESC, created_at",
      )
      .all(this.sessionId, this.agentId) as { message_id: string; to_agent_id: string }[];
    if (rows.length === 0) return;
    this.deps.log.append(
      this.sessionId,
      this.agentId,
      rows.map((row) => ({
        type: "inbox.delivered",
        data: { messageId: row.message_id, toAgentId: row.to_agent_id },
      })),
    );
  }

  /** Executing：顺序执行本步工具调用（04 §3；M1 顺序，只读工具可并行属 P1 优化）。 */
  /**
   * 审批门（04 §5.2、08 §6）：判定权限模式 + 免审批规则 + 记住决定；需要时
   * approval.request → wait → 中止时以 abortReason 收口为 denied。返回
   * `required=false` 表示无需审批（放行）；否则返回用户决定。
   * `waitSignal`（发布时审批路径）让等待直接挂在工具执行信号上：stop 同时中止
   * 等待与工具执行；不传则用独立控制器（callAbort 换入换出，同原语义）。
   */
  private async gateApproval(input: {
    toolCallId: string;
    toolName: string;
    args: unknown;
    targets: string[];
    effect: ApprovalEffect;
    turnId: string;
    stepId: string;
    /** 租约已通过的写类调用仍按权限判定；未过租约的写类调用跳过审批（保持原语义）。 */
    leased: boolean;
    waitSignal?: AbortSignal;
  }): Promise<{ required: boolean; decision: "approved" | "denied"; reason?: string }> {
    const approval = this.deps.approval;
    const permission =
      (
        this.deps.db
          .prepare("SELECT permission_mode FROM sessions WHERE id = ?")
          .get(this.sessionId) as { permission_mode: string } | undefined
      )?.permission_mode ?? "standard";
    const needed =
      approval !== undefined &&
      needsApproval(permission, input.effect) &&
      !(
        this.deps.leases &&
        (input.effect === "write" ||
          input.effect === "destructive" ||
          input.effect === "external") &&
        !input.leased
      ) &&
      !isAutoApproved(this.deps.db, this.sessionId, input.toolName, input.targets);
    if (!needed || approval === undefined) {
      return { required: false, decision: "approved" };
    }
    const spec: ApprovalSpec = {
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      args: input.args,
      targets: input.targets,
      effect: input.effect,
      turnId: input.turnId,
      stepId: input.stepId,
      step: Number(input.stepId) || undefined,
    };
    const pending = approval.request(this.sessionId, this.agentId, spec);
    let decision: ApprovalResolution;
    if (input.waitSignal) {
      decision = await approval.wait(pending.id, input.waitSignal);
    } else {
      const approvalCtrl = new AbortController();
      this.callAbort = approvalCtrl;
      decision = await approval.wait(pending.id, approvalCtrl.signal);
      this.callAbort = null;
    }
    if (approval.get(pending.id)?.status === "pending") {
      // 等待被中止（停止/打断）：以中止理由收口审批决定
      approval.decide(pending.id, "denied", this.abortReason);
      decision = { decision: "denied", reason: this.abortReason };
    }
    return {
      required: true,
      decision: decision.decision,
      ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
    };
  }

  private async executeCalls(
    turnId: string,
    stepId: string,
    calls: ToolCall[],
  ): Promise<StepOutcome> {
    const { log, tools } = this.deps;
    const finishInterrupted = (from: number) => {
      const records = [
        ...calls.slice(from).map((c) => ({
          type: "tool.result",
          data: {
            toolCallId: c.id,
            toolName: c.name,
            status: "not_executed",
            result: {
              status: "not_executed",
              error: {
                code: "CANCELLED",
                message: "本轮已中断，该工具未执行",
                retryable: false,
              },
            },
          },
        })),
        { type: "turn.interrupted", data: { turnId } },
      ];
      log.append(this.sessionId, this.agentId, records);
      return "interrupted" as const;
    };

    for (let i = 0; i < calls.length; i++) {
      if (this.stopRequested || this.interruptRequested) return finishInterrupted(i);
      const call = calls[i];
      if (!call) continue;
      const tool = tools.get(call.name);
      let targets: string[] = [];
      try {
        targets = tool?.targets(call.args) ?? [];
      } catch {
        targets = [];
      }
      const replay =
        tool === undefined
          ? "unknown"
          : typeof tool.replay === "function"
            ? (tool.replay as (args: unknown) => string)(call.args)
            : tool.replay;
      const scope = {
        workspaceId: this.deps.workspaceId(this.sessionId),
        workspaceRoot: this.deps.workspaceRoot(this.sessionId),
        sessionId: this.sessionId,
        agentId: this.agentId,
      };
      // 发布时审批的工具在执行内自请审批；等待挂在执行信号上（stop 同时取消等待与工具）。
      let execSignal: AbortSignal | undefined;
      const ctx = {
        ...scope,
        signal: AbortSignal.timeout(tool?.timeoutMs ?? 30000),
        toolCallId: call.id,
        turnId,
        stepId,
        reads: this.reads,
        backups: (this.deps.backups ?? new BackupService(this.deps.db)).bind(scope),
        leases: this.deps.leases,
        agents: this.deps.agents,
        rawArgs: call.args,
        ...(tool?.approval === "publish"
          ? {
              requestApproval: (req: {
                targets: string[];
                args: unknown;
                effect: ApprovalEffect;
              }) =>
                this.gateApproval({
                  toolCallId: call.id,
                  toolName: call.name,
                  args: req.args,
                  targets: req.targets,
                  effect: req.effect,
                  turnId,
                  stepId,
                  // 发布计划的目标租约由工具在批准后自查；这里只为"发布"动作判定审批
                  leased: true,
                  waitSignal: execSignal,
                }).then((g) => ({
                  decision: g.decision,
                  ...(g.reason !== undefined ? { reason: g.reason } : {}),
                })),
            }
          : {}),
      };
      let intentMeta: FileIntentMeta | undefined;
      let metaFailed = false;
      try {
        const valid = tool?.input.safeParse(call.args);
        if (valid?.success) intentMeta = tool?.intentMeta?.(valid.data, ctx);
      } catch {
        metaFailed = true;
      }
      log.append(this.sessionId, this.agentId, [
        {
          type: "tool.intent",
          data: {
            stepId,
            toolCallId: call.id,
            toolName: call.name,
            args: call.args,
            targets,
            replay,
            ...(intentMeta ? { intentMeta } : {}),
          },
        },
      ]);

      let result: ToolResult = {
        status: "error",
        error: { code: "INTERNAL", message: "工具未执行", retryable: false },
      };
      if (metaFailed) {
        result = {
          status: "error",
          error: {
            code: "INVALID_ARGUMENT",
            message: "无法读取执行前文件状态，未执行写入",
            retryable: false,
          },
        };
      } else if (!tool) {
        result = {
          status: "error",
          error: {
            code: "INVALID_ARGUMENT",
            message: `工具 ${call.name} 不存在`,
            retryable: false,
          },
        };
      } else {
        const parsed = tool.input.safeParse(call.args);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          result = {
            status: "error",
            error: {
              code: "INVALID_ARGUMENT",
              message: `参数不合法：${issue?.message ?? "schema 校验失败"}`,
              ...(issue?.path !== undefined && issue.path.length > 0
                ? { field: issue.path.join(".") }
                : {}),
              retryable: false,
            },
          };
        } else {
          const effect =
            typeof tool.effect === "function"
              ? (tool.effect as (args: unknown) => string)(parsed.data)
              : tool.effect;
          let leased = false;
          if (
            this.deps.leases &&
            (effect === "write" || effect === "destructive" || effect === "external")
          ) {
            try {
              this.deps.leases.assertAvailable(
                { sessionId: this.sessionId, agentId: this.agentId, targets },
                { mainBypass: true },
              );
              leased = true;
            } catch (err) {
              if (err instanceof FileLeaseError) {
                result = {
                  status: "error",
                  data: {
                    target: err.target,
                    holder: { agentId: err.holder.agent_id, path: err.holder.path },
                  },
                  error: {
                    code: "FILE_LEASED",
                    message: err.message,
                    hint: "把修改内容发消息给持有租约的代理",
                    retryable: false,
                  },
                };
              } else {
                result = {
                  status: "error",
                  error: {
                    code: "INTERNAL",
                    message: "写入前租约检查失败，未执行工具",
                    retryable: false,
                  },
                };
              }
            }
          }
          // approval:"publish" 的工具跳过执行前审批，由工具在发布前经 ctx.requestApproval 自请。
          const gate =
            tool.approval === "publish"
              ? { required: false, decision: "approved" as const }
              : await this.gateApproval({
                  toolCallId: call.id,
                  toolName: call.name,
                  args: parsed.data,
                  targets,
                  effect: effect as ApprovalEffect,
                  turnId,
                  stepId,
                  leased,
                });
          const approved = gate.required && gate.decision === "approved";
          if (gate.required && gate.decision !== "approved") {
            result = {
              status: "error",
              error: {
                code: "APPROVAL_DENIED",
                message: gate.reason ? `用户拒绝：${gate.reason}` : "用户拒绝了此操作",
                retryable: false,
              },
            };
          }
          if (
            gate.decision === "approved" &&
            (leased ||
              !this.deps.leases ||
              effect === "read" ||
              effect === "state" ||
              effect === "interactive" ||
              effect === "agent")
          ) {
            const ctrl = new AbortController();
            this.callAbort = ctrl;
            const signal = AbortSignal.any([ctrl.signal, AbortSignal.timeout(tool.timeoutMs)]);
            execSignal = signal;
            try {
              result = await tool.execute(parsed.data, {
                ...ctx,
                signal,
                ...(approved ? { destructiveApproved: true } : {}),
              });
              const questionId =
                result.status === "ok" &&
                result.data !== null &&
                typeof result.data === "object" &&
                typeof (result.data as { questionId?: unknown }).questionId === "string" &&
                (result.data as { status?: unknown }).status === "pending"
                  ? (result.data as { questionId: string }).questionId
                  : undefined;
              if (questionId && this.deps.question) {
                const pendingData = result.data as Record<string, unknown>;
                const timeoutSeconds =
                  typeof pendingData.timeoutSeconds === "number"
                    ? pendingData.timeoutSeconds
                    : undefined;
                const waitSignal =
                  timeoutSeconds !== undefined
                    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutSeconds * 1000)])
                    : signal;
                const resolution = await this.deps.question.wait(questionId, waitSignal);
                if (resolution.aborted) {
                  // 问题自身超时后收口 pending 投影，避免稍后的用户回答重复恢复
                  // 已经结束的工具调用。
                  if (!this.stopRequested && !signal.aborted) {
                    try {
                      this.deps.question.answer(questionId, null);
                    } catch {
                      // 竞态下可能已由 REST 回答，继续记录本次超时结果即可。
                    }
                  }
                  result = {
                    status: "error",
                    error: {
                      code: this.stopRequested || signal.aborted ? "CANCELLED" : "TIMEOUT",
                      message:
                        this.stopRequested || signal.aborted ? "已被用户停止" : "等待用户回答超时",
                      retryable: false,
                    },
                  };
                } else {
                  result = {
                    ...result,
                    data: {
                      ...(result.data as Record<string, unknown>),
                      status: "answered",
                      ...(Object.hasOwn(resolution, "answer") ? { answer: resolution.answer } : {}),
                      ...(resolution.rev !== undefined ? { rev: resolution.rev } : {}),
                    },
                  };
                }
              }
            } catch (err) {
              const cancelled = this.stopRequested || this.interruptRequested;
              const timedOut = err instanceof Error && err.name === "TimeoutError";
              result = {
                status: "error",
                error: {
                  code: cancelled ? "CANCELLED" : timedOut ? "TIMEOUT" : "INTERNAL",
                  message: cancelled
                    ? this.abortReason
                    : timedOut
                      ? `工具执行超过 ${tool.timeoutMs}ms`
                      : err instanceof Error
                        ? err.message
                        : String(err),
                  retryable: false,
                },
              };
            } finally {
              this.callAbort = null;
            }
          }
        }
      }
      log.append(this.sessionId, this.agentId, [
        {
          type: "tool.result",
          data: { toolCallId: call.id, toolName: call.name, status: result.status, result },
        },
      ]);
      if (this.stopRequested || this.interruptRequested) return finishInterrupted(i + 1);
    }
    return "continue";
  }

  private failTurn(turnId: string, error: ClassifiedError): void {
    const kind: ErrorKind = error.kind;
    this.deps.log.append(this.sessionId, this.agentId, [
      {
        type: "error.guidance",
        data: {
          kind,
          message: GUIDANCE_MESSAGES[kind] ?? error.message,
          actions: GUIDANCE_ACTIONS[kind] ?? [],
        },
      },
      { type: "turn.failed", data: { turnId, error } },
    ]);
  }

  private failInternal(err: unknown): void {
    const turnId = this.currentTurnId;
    if (turnId === null) return;
    try {
      this.failTurn(turnId, {
        kind: "unknown",
        retryable: false,
        message: err instanceof Error ? err.message : String(err),
      });
    } catch {
      // 日志自身也失败时只能放弃，避免递归
    }
  }
}

/**
 * 启动恢复（04 §8.2）：running/waiting 代理的 open_intents 逐个处理——工具声明了
 * recover 钩子就让它判定（workbook_edit 等已落库的写返回其结果），否则
 * 一律 not_executed；最后状态设 interrupted。
 */
export function recoverInterruptedAgents(deps: {
  db: DatabaseSync;
  log: SessionLog;
  tools?: ReadonlyMap<string, ToolDefinition>;
}): number {
  const running = deps.db
    .prepare("SELECT id, session_id FROM agents WHERE status IN ('running', 'waiting')")
    .all() as { id: string; session_id: string }[];
  for (const agent of running) {
    const intents = deps.db
      .prepare(
        "SELECT tool_call_id, tool_name FROM open_intents WHERE session_id = ? AND agent_id = ? ORDER BY created_seq",
      )
      .all(agent.session_id, agent.id) as { tool_call_id: string; tool_name: string }[];
    const records: { type: string; data: unknown }[] = intents.map((it) => {
      const tool = deps.tools?.get(it.tool_name);
      let recovered: ToolResult | undefined;
      if (tool?.recover) {
        // tool.intent 记录里有当时解析后的参数
        const intentRow = deps.db
          .prepare(
            "SELECT data FROM session_log WHERE session_id = ? AND agent_id = ? AND type = 'tool.intent' ORDER BY seq DESC LIMIT 50",
          )
          .all(agent.session_id, agent.id) as { data: string }[];
        let args: unknown;
        let intentMeta: FileIntentMeta | undefined;
        for (const r of intentRow) {
          const d = JSON.parse(r.data) as {
            toolCallId?: string;
            args?: unknown;
            intentMeta?: FileIntentMeta;
          };
          if (d.toolCallId === it.tool_call_id) {
            args = d.args;
            intentMeta = d.intentMeta;
            break;
          }
        }
        try {
          recovered = tool.recover({
            sessionId: agent.session_id,
            agentId: agent.id,
            toolCallId: it.tool_call_id,
            args,
            intentMeta,
          });
        } catch {
          recovered = undefined;
        }
      }
      const result: ToolResult = recovered ?? {
        status: tool?.replay === "safe" ? "not_executed" : "uncertain",
        error: {
          code: "CANCELLED",
          message:
            tool?.replay === "safe" ? "进程中断，未自动重放" : "进程中断，结果不确定，未自动重放",
          retryable: false,
        },
      };
      return {
        type: "tool.result",
        data: {
          toolCallId: it.tool_call_id,
          toolName: it.tool_name,
          status: result.status,
          result,
        },
      };
    });
    const turn = deps.db
      .prepare(
        "SELECT data FROM session_log WHERE session_id = ? AND agent_id = ? AND type = 'turn.started' ORDER BY seq DESC LIMIT 1",
      )
      .get(agent.session_id, agent.id) as { data: string } | undefined;
    if (turn) {
      const turnId = (JSON.parse(turn.data) as { turnId?: string }).turnId ?? "";
      records.push({ type: "turn.interrupted", data: { turnId } });
    } else {
      records.push({ type: "agent.status", data: { status: "interrupted" } });
    }
    if (records.length > 0) deps.log.append(agent.session_id, agent.id, records);
  }
  return running.length;
}
