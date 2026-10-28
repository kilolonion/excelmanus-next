import { type FileIntentMeta, type ReplayKind, toToolErrorCode } from "@excelmanus/protocol";
import { renderAccessFacts, turnAccessFacts } from "./access-facts.ts";
import {
  type ApprovalCoordinator,
  type ApprovalEffect,
  type ApprovalResolution,
  type ApprovalSpec,
  isAutoApproved,
  needsApproval,
} from "./approvals.ts";
import { BackupService } from "./backup.ts";
import type { BlobStore } from "./blobs.ts";
import {
  type AgentBudget,
  addUsage,
  type BudgetUsage,
  checkBudget,
  emptyBudgetUsage,
  parseBudget,
} from "./budget.ts";
import { type ChangeSummarySource, describeDocChange } from "./change-summary.ts";
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
import {
  harnessContext,
  harnessProgress,
  harnessState,
  harnessTaskId,
  harnessUsefulProgress,
  harnessUsefulProofs,
  stableHarnessHash,
} from "./harness-state.ts";
import { FileLeaseError, type LeaseService } from "./leases.ts";
import { NUMERIC_DELIVERY_GUIDANCE, numericDeliveryState } from "./numeric-delivery.ts";
import { numericExecutionFacts } from "./numeric-execution-facts.ts";
import { lastCompactionSeq } from "./projections.ts";
import type { QuestionCoordinator } from "./questions.ts";
import { isTaskContractPending, taskContractState } from "./task-contract.ts";
import { compactWorkbookCheckSpec } from "./compact-workbook-check.ts";
import { compactModelToolSpec, compactWorkbookEditSpec, deduplicateModelToolSchema, enabledAuxiliaryTools, isAuxiliaryTool, stagedCatalogState, stagedModelToolSpec, appendStagedCatalog, withStagedCapabilityDirectory } from "./model-tool-catalog.ts";
import { isResultPage, resultPageTool, withResultCursor } from "./result-pages.ts";
import {
  assertToolEffectsAllowed,
  bindToolAccess,
  runWithToolAccess,
  TurnAccessError,
} from "./tool-access.ts";
import {
  ACCESS_DELIVERY_GUIDANCE,
  accessDeliveryRequired,
  createTurnAccessBinding,
  hasTaskContractRequirement,
  steeredTurnAccessBinding,
  turnAccessBinding,
} from "./turn-access.ts";
// Agent actor（04 §3 子集）：邮箱串行；Preparing→Calling→Executing→循环；
// Retrying（网络/429/5xx/流中断，指数退避最多 5 次，尊重 retryAfterMs，写
// retry.scheduled；流中断写 attempt.discarded）；不可重试写 error.guidance +
// turn.failed；最大步数到顶做一次无工具总结调用。每个工具调用先写 tool.intent
// 再执行再写 tool.result。delta 经总线瞬时推送不入库。
// 消息派发三策略（04 §4.1）：steer 在步骤边界写 applied 注入本轮；interrupt
// 中止当前调用、轮以 interrupted 收尾后立即开新一轮；queue 在轮结束后各自开轮。
// 停止只中止当前轮：排队中的派发留在 dispatches 表保持 queued（挂起），经 resume 恢复。

import type { DatabaseSync } from "node:sqlite";
import { newId, type RangeRef } from "@excelmanus/core";
import type {
  AgentRole,
  ClassifiedError,
  ContextItem,
  DeltaKind,
  DispatchMode,
  ErrorKind,
  FinishReason,
  ResolvedModel,
  ToolArgsDelta,
  ToolCall,
  ToolResult,
  ToolSpec,
  Usage,
} from "@excelmanus/protocol";
import type { SyncBus } from "./bus.ts";
import type { ModelGateway } from "./model-gateway.ts";
import type { SessionLog } from "./session-log.ts";
import type { AgentCoordinator } from "./tools.ts";
import {
  createReadTable,
  persistedReads,
  type ReadTable,
  type ToolDefinition,
  type ToolEffect,
} from "./tools.ts";

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
  /** 非文件资源读取（skill://，12 §1.2），由装配层提供。 */
  resolveResource?(sessionId: string, uri: string): { text: string } | { error: ToolResult };
  validateContext?(
    refs: { docId: string; rev: number; range: string }[],
    workspaceRoot: string,
  ): Promise<void>;
  backups?: BackupService;
  /** 内容寻址存储：用户消息图片附件在调用模型前从这里读出（01 §3、04 §7）。 */
  blobs?: BlobStore;
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
  /** 05 §8：同时运行的子代理数上限（默认 4），超出排队按 FIFO 启动。 */
  maxConcurrentSubAgents?: number;
  /** 每轮变更摘要的数据源（04 §11；server 装配 workbook 文档日志实现）。 */
  changeSummary?: ChangeSummarySource;
  /** 子代理轮结束、向父代理投递完成报告后唤醒它（server 装配为 enqueueInbox）。 */
  onInbox?(sessionId: string, agentId: string): void;
  /** 占用达到窗口 80% 时自动压缩（04 §6.3）；false 关闭；函数形式按设置实时读取。 */
  autoCompact?: boolean | (() => boolean);
  /** 上下文压缩摘要使用的模型（09 §3 用途分配）；未设置用本代理模型。 */
  summaryModel?(): ResolvedModel | undefined;
  /** 首轮完成后用模型生成会话标题（用户没有改过标题时）；缺省关闭。 */
  autoTitle?(): boolean;
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
  name?: string | null;
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

/** 一次已提交的用户编辑（server 从文档服务转来，坐标为提交时坐标）。 */
export interface DocEdit {
  docId: string;
  path: string;
  rev: number;
  ranges: Array<RangeRef & { sheetName: string; a1: string }>;
}

export class AgentRuntime {
  private readonly deps: AgentRuntimeDeps;
  private readonly actors = new Map<string, AgentActor>();
  /** 05 §8：被并发闸门拦下的子代理，按会话 FIFO 等待空位。 */
  private readonly turnWaiters = new Map<string, AgentActor[]>();
  /**
   * 05 §11"停止全部"后的会话：收件箱消息（含被停子代理的完成报告）只留在
   * inbox_pending，不唤醒任何代理，直到用户发消息或继续。
   */
  private readonly halted = new Set<string>();
  /** 已删除的会话：不再创建 actor、不再开轮。 */
  private readonly deleted = new Set<string>();
  private shuttingDown = false;

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /** 先停止全部 actor 并等待收尾，数据库和工具宿主在此期间必须保持可用。 */
  async shutdown(timeoutMs = 30000): Promise<void> {
    this.shuttingDown = true;
    const sessions = new Set([...this.actors.values()].map((actor) => actor.sessionId));
    for (const sessionId of sessions) this.stopAll(sessionId);
    this.turnWaiters.clear();
    const deadline = Date.now() + timeoutMs;
    while ([...this.actors.values()].some((actor) => actor.running)) {
      if (Date.now() >= deadline) throw new Error("代理尚未停止，数据库保持打开以保护在途操作");
      await sleep(10);
    }
    this.actors.clear();
  }

  constructor(deps: AgentRuntimeDeps) {
    this.deps = deps;
  }

  /**
   * 子代理开轮闸门：同会话 running 子代理达到上限时把 actor 登记进 FIFO
   * 并标 agent.status=queued，返回 false。main 与终态/暂停代理不走闸门
   * （暂停/终态直接返回 false 且不登记，等待 resume/control 唤醒）。
   * `front`：被唤醒后仍没抢到名额的等待者回到表头，不丢失先后顺序。
   */
  acquireTurn(actor: AgentActor, front = false): "go" | "queued" | "blocked" {
    if (this.shuttingDown || this.deleted.has(actor.sessionId)) return "blocked";
    const row = this.deps.db
      .prepare("SELECT role, status FROM agents WHERE session_id = ? AND id = ?")
      .get(actor.sessionId, actor.agentId) as { role: string; status: string } | undefined;
    if (row === undefined || row.role === "main") return "go";
    if (["paused", "closed", "failed"].includes(row.status)) return "blocked";
    const limit = this.deps.maxConcurrentSubAgents ?? 4;
    const running = (
      this.deps.db
        .prepare(
          "SELECT COUNT(*) AS c FROM agents WHERE session_id = ? AND role != 'main' AND status = 'running'",
        )
        .get(actor.sessionId) as { c: number }
    ).c;
    if (running < limit) return "go";
    if (row.status !== "queued") {
      this.deps.log.append(actor.sessionId, actor.agentId, [
        { type: "agent.status", data: { status: "queued" } },
      ]);
    }
    const q = this.turnWaiters.get(actor.sessionId) ?? [];
    if (!q.includes(actor)) {
      if (front) q.unshift(actor);
      else q.push(actor);
    }
    this.turnWaiters.set(actor.sessionId, q);
    return "queued";
  }

  /** 一轮结束后唤醒同会话 FIFO 表头的等待者（其 pump 会再检查一次闸门）。 */
  releaseTurn(sessionId: string): void {
    const q = this.turnWaiters.get(sessionId);
    if (!q || q.length === 0) return;
    const next = q.shift();
    if (q.length === 0) this.turnWaiters.delete(sessionId);
    next?.wakeFromGate();
  }

  /** 把 actor 从闸门 FIFO 中移除（停止/关闭/删除）。 */
  private leaveGate(sessionId: string, actor: AgentActor): void {
    const q = this.turnWaiters.get(sessionId);
    if (!q) return;
    const rest = q.filter((a) => a !== actor);
    if (rest.length === 0) this.turnWaiters.delete(sessionId);
    else this.turnWaiters.set(sessionId, rest);
  }

  /** 派发受理后调用：agent 空闲则开始新一轮，运行中按 mode  steer/interrupt/queue 处理。 */
  enqueue(sessionId: string, agentId: string, dispatchId: string, mode: DispatchMode): void {
    if (this.deleted.has(sessionId)) return;
    if (this.halted.has(sessionId)) {
      // 停止全部期间被停代理收尾时派生的子代理：任务派发保持挂起，经继续恢复。
      const row = this.deps.db
        .prepare("SELECT client_message_id AS c FROM dispatches WHERE id = ?")
        .get(dispatchId) as { c: string } | undefined;
      if (row?.c.startsWith("spawn:")) return;
      this.halted.delete(sessionId);
    }
    this.actor(sessionId, agentId).enqueue(dispatchId, mode);
  }

  /** 撤回排队中的派发：从内存队列移除（DB 状态由调用方先写 cancelled）。 */
  cancelDispatch(sessionId: string, agentId: string, dispatchId: string): void {
    this.actors.get(`${sessionId}/${agentId}`)?.dropDispatch(dispatchId);
  }

  /**
   * 继续（04 §4.2、§8.3）：把该代理在 DB 中挂起（accepted/queued）的派发按
   * 消息顺序重新入队；没有挂起派发且代理处于 interrupted/failed 时开一轮无派发的
   * 继续轮（只用已持久化历史，不重放任何副作用）。
   */
  resumeAgent(sessionId: string, agentId: string): { resumed: number; started: boolean } {
    if (this.deleted.has(sessionId)) return { resumed: 0, started: false };
    this.halted.delete(sessionId);
    const actor = this.actor(sessionId, agentId);
    if (actor.running) return { resumed: 0, started: false };
    const agent = this.deps.db
      .prepare("SELECT role, status FROM agents WHERE session_id = ? AND id = ?")
      .get(sessionId, agentId) as { role: string; status: string } | undefined;
    // 失败子代理只在显式继续时解除终态阻挡，之后仍须经过并发/暂停/关闭闸门。
    if (agent?.role !== "main" && agent?.status === "failed") {
      this.deps.log.append(sessionId, agentId, [
        { type: "agent.status", data: { status: "idle" } },
      ]);
    }
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
      if (agent?.status === "interrupted" || agent?.status === "failed") actor.enqueueResume();
    }
    return { resumed, started: actor.running };
  }

  /**
   * 用户编辑提交后（02 §4.7）：读过被改区域的代理在下一步边界收到 context.notice
   * （kind=doc.edited），不必等到写入冲突才发现。候选是上下文里出现过该文档的未关闭代理；
   * 重叠按区域矩形判定、不做读取修订之后的插删变换（只是提示，写入仍由冲突检测兜底）。
   */
  notifyDocEdited(edit: DocEdit): void {
    if (this.shuttingDown) return;
    const rows = this.deps.db
      .prepare(
        `SELECT DISTINCT c.session_id, c.agent_id FROM agent_context c
         JOIN agents a ON a.session_id = c.session_id AND a.id = c.agent_id
         WHERE a.status != 'closed' AND instr(c.item, ?) > 0`,
      )
      .all(`"docId":"${edit.docId}"`) as { session_id: string; agent_id: string }[];
    for (const row of rows) {
      if (this.deleted.has(row.session_id)) continue;
      const ranges = this.actor(row.session_id, row.agent_id).staleReads(edit);
      if (ranges.length === 0) continue;
      this.deps.log.append(row.session_id, row.agent_id, [
        {
          type: "context.notice",
          data: {
            kind: "doc.edited",
            docId: edit.docId,
            path: edit.path,
            rev: edit.rev,
            ranges,
            text: `用户修改了 ${ranges.join("、")}（文件 ${edit.path}，rev ${edit.rev}）。你之前读过这些单元格，读到的值可能已过时；继续使用或写入前请重新读取。`,
          },
        },
      ]);
    }
  }

  /** 收件箱消息到达：不伪造 user.message 派发，只唤醒目标 actor。 */
  enqueueInbox(sessionId: string, agentId: string): void {
    if (this.shuttingDown) return;
    const row = this.deps.db
      .prepare("SELECT status FROM agents WHERE session_id = ? AND id = ?")
      .get(sessionId, agentId) as { status: string } | undefined;
    // 代理间消息不会绕过用户/父代理的 resume；暂停、重启中断或终态代理只保留
    // inbox_pending，避免乒乓检测后又被后续消息偷偷唤醒。
    if (!row || ["paused", "interrupted", "closed", "failed"].includes(row.status)) return;
    if (this.halted.has(sessionId) || this.deleted.has(sessionId)) return;
    this.actor(sessionId, agentId).enqueueInbox();
  }

  /**
   * 停止：中止当前模型请求/工具，返回是否有运行中的轮。不在运行的 actor 也
   * 清掉内存队列并退出闸门 FIFO（排队中的派发留在 DB 挂起，经 resume 恢复）。
   */
  stop(sessionId: string, agentId: string, opts: { cancellationCause?: "user" } = {}): boolean {
    const actor = this.actors.get(`${sessionId}/${agentId}`);
    if (!actor) return false;
    this.leaveGate(sessionId, actor);
    return actor.requestStop(opts.cancellationCause);
  }

  /**
   * 停止全部（05 §11）：会话内全部 actor 停止并退出闸门 FIFO；闸门排队中的
   * 子代理回到 idle（任务派发挂起）；此后收件箱消息不唤醒任何代理，直到用户
   * 发消息或继续。返回被停止（含被撤出闸门）的 agentId。
   */
  stopAll(
    sessionId: string,
    opts: { subagentsOnly?: boolean; cancellationCause?: "user" } = {},
  ): string[] {
    // 只停子代理时主代理照常运行，子代理的中断报告仍按正常路径投递给它
    if (!opts.subagentsOnly) this.halted.add(sessionId);
    const gated = new Set(this.turnWaiters.get(sessionId) ?? []);
    this.turnWaiters.delete(sessionId);
    const main = new Set(
      (
        this.deps.db
          .prepare("SELECT id FROM agents WHERE session_id = ? AND role = 'main'")
          .all(sessionId) as { id: string }[]
      ).map((r) => r.id),
    );
    const stopped: string[] = [];
    for (const [key, actor] of this.actors) {
      if (!key.startsWith(`${sessionId}/`)) continue;
      if (opts.subagentsOnly && main.has(actor.agentId)) continue;
      if (actor.requestStop(opts.cancellationCause) || gated.has(actor))
        stopped.push(actor.agentId);
    }
    const queued = this.deps.db
      .prepare("SELECT id FROM agents WHERE session_id = ? AND status = 'queued'")
      .all(sessionId) as { id: string }[];
    for (const row of queued) {
      this.deps.log.append(sessionId, row.id, [{ type: "agent.status", data: { status: "idle" } }]);
      if (!stopped.includes(row.id)) stopped.push(row.id);
    }
    return stopped;
  }

  /**
   * 删除会话前调用（05 §11"先停止全部代理，再删除"）：停止全部、不再接受
   * 任何开轮请求，并等待在跑的 actor 收尾（最多 timeoutMs），随后卸下 actor。
   */
  async closeSession(sessionId: string, timeoutMs = 10_000): Promise<{ stillRunning: string[] }> {
    this.deleted.add(sessionId);
    this.stopAll(sessionId);
    const prefix = `${sessionId}/`;
    const deadline = Date.now() + timeoutMs;
    const running = () =>
      [...this.actors]
        .filter(([key, actor]) => key.startsWith(prefix) && actor.running)
        .map(([, actor]) => actor.agentId);
    while (running().length > 0 && Date.now() < deadline) await sleep(20);
    // 超时仍未退出的 actor（工具不响应中止）：信号已中止、之后的日志写入被拒；
    // 返回给调用方记录，便于排查删除后仍发生的工作区改动（appendix-c 待定是否改为拒绝删除）。
    const stillRunning = running();
    for (const key of [...this.actors.keys()]) if (key.startsWith(prefix)) this.actors.delete(key);
    return { stillRunning };
  }

  /**
   * 从某条用户消息起重新开始（编辑重发 / 重试 / 回到某一轮）：代理必须空闲；仍挂起的派发
   * 一并撤回，追加 history.rewound，投影让该消息及其后的上下文条目失效。只改对话，不回滚文件，
   * 不越过最近一次压缩。检查与写日志之间没有异步让出。
   */
  rewind(
    sessionId: string,
    agentId: string,
    dispatchId: string,
  ):
    | { ok: true; fromSeq: number; cancelled: string[] }
    | { error: "busy" | "not_found" | "not_applied" | "before_compaction" } {
    const db = this.deps.db;
    const agent = db
      .prepare("SELECT status FROM agents WHERE session_id = ? AND id = ?")
      .get(sessionId, agentId) as { status: string } | undefined;
    if (!agent) return { error: "not_found" };
    if (this.isRunning(sessionId, agentId) || !REWINDABLE.has(agent.status)) {
      return { error: "busy" };
    }
    const msg = db
      .prepare(
        "SELECT seq FROM session_log WHERE session_id = ? AND agent_id = ? AND type = 'user.message' AND json_extract(data, '$.dispatchId') = ? ORDER BY seq LIMIT 1",
      )
      .get(sessionId, agentId, dispatchId) as { seq: number } | undefined;
    if (!msg) return { error: "not_found" };
    const dispatch = db
      .prepare("SELECT status FROM dispatches WHERE session_id = ? AND id = ?")
      .get(sessionId, dispatchId) as { status: string } | undefined;
    if (dispatch?.status !== "applied") return { error: "not_applied" };
    if (msg.seq <= lastCompactionSeq(db, sessionId, agentId)) return { error: "before_compaction" };
    const cancelled = (
      db
        .prepare(
          "SELECT id FROM dispatches WHERE session_id = ? AND agent_id = ? AND status IN ('accepted', 'queued') ORDER BY created_at",
        )
        .all(sessionId, agentId) as { id: string }[]
    ).map((r) => r.id);
    this.deps.log.append(sessionId, agentId, [
      ...cancelled.map((id) => ({
        type: "dispatch.updated" as const,
        data: { dispatchId: id, status: "cancelled" as const },
      })),
      { type: "history.rewound", data: { dispatchId, fromSeq: msg.seq } },
      // 被截掉的那一轮（中断/失败）不再等待继续
      ...(agent.status !== "idle"
        ? [{ type: "agent.status" as const, data: { status: "idle" as const } }]
        : []),
    ]);
    const actor = this.actors.get(`${sessionId}/${agentId}`);
    for (const id of cancelled) actor?.dropDispatch(id);
    actor?.contextRewound();
    return { ok: true, fromSeq: msg.seq, cancelled };
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
    cause: "user" | "cancelled" | "timeout" | "system" = "user",
  ): {
    row: import("./approvals.ts").ApprovalRow;
    idempotent: boolean;
  } {
    const approval = this.deps.approval;
    if (!approval) throw new Error("审批执行器未装配");
    const current = approval.get(id);
    if (!current) throw new Error("审批不存在");
    const out = approval.decide(id, decision, reason, remember, cause);
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
    hostRecords: import("./session-log.ts").NewRecord[] = [],
  ): { row: import("./questions.ts").QuestionRow; idempotent: boolean } {
    const question = this.deps.question;
    if (!question) throw new Error("提问执行器未装配");
    const current = question.get(id);
    if (!current) throw new Error("问题不存在");
    const out = question.answer(id, answer, rev, hostRecords);
    if (!out.idempotent && !question.hasWaiter(id)) {
      const actor = this.actor(current.session_id, current.agent_id);
      void actor.resumePersistedQuestion(id);
    }
    return out;
  }

  private readonly titled = new Set<string>();

  /** 每个会话只尝试一次自动标题（本进程内）。 */
  titleTried(sessionId: string): boolean {
    if (this.titled.has(sessionId)) return true;
    this.titled.add(sessionId);
    return false;
  }

  private actor(sessionId: string, agentId: string): AgentActor {
    const key = `${sessionId}/${agentId}`;
    let a = this.actors.get(key);
    if (!a) {
      a = new AgentActor(this.deps, sessionId, agentId, this);
      this.actors.set(key, a);
    }
    return a;
  }
}

const TITLE_SYSTEM =
  "根据下面的对话给这个会话起一个简短的中文标题（不超过 16 个字），概括用户要做的事。只输出标题本身，不加引号、标点或解释。";

/** 可回退的代理状态：不在运行、不在等待审批/回答、未暂停或关闭。 */
const REWINDABLE = new Set(["idle", "interrupted", "failed"]);

type StepOutcome = "continue" | "done" | "failed" | "interrupted" | "budget_exceeded";

/** 内存队列条目：用户消息派发或收件箱唤醒。 */
type QueueEntry = { dispatchId: string; mode: DispatchMode } | { inbox: true; resume?: true };

class AgentActor {
  private stagedCatalog?: {taskId:string;tools:ToolSpec[]};
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
  /** 显式宿主取消仅归属当时的活动轮，不从 AbortError 或模型内容推断。 */
  private userCancelledTurnId: string | null = null;
  private readonly deps: AgentRuntimeDeps;
  readonly sessionId: string;
  readonly agentId: string;
  /** 回指宿主运行时：并发闸门与轮结束唤醒。 */
  private readonly host: AgentRuntime;
  /** 本代理的文档读集（07 §10；首次使用时从 agent_context 重建，10 §3.4）。 */
  private reads: ReadTable = this.seededReads();
  /** 本轮与历史累计预算；每次 usage.updated 同事务持久化。 */
  private budgetUsage: BudgetUsage = emptyBudgetUsage();
  private budget: AgentBudget = {};

  constructor(deps: AgentRuntimeDeps, sessionId: string, agentId: string, host: AgentRuntime) {
    this.deps = deps;
    this.sessionId = sessionId;
    this.agentId = agentId;
    this.host = host;
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

  /** 用户明确继续中断/失败轮，不要求另有未消费消息。 */
  enqueueResume(): void {
    this.queue.push({ inbox: true, resume: true });
    void this.pump();
  }

  enqueueInbox(): void {
    if (!this.queue.some((entry) => "inbox" in entry)) this.queue.push({ inbox: true });
    void this.pump();
  }

  /** 并发闸门空出位置后被运行时唤醒：重新 pump（会再过一次闸门）。 */
  wakeFromGate(): void {
    void this.pump(true);
  }

  dropDispatch(dispatchId: string): void {
    this.queue = this.queue.filter((e) => "inbox" in e || e.dispatchId !== dispatchId);
  }

  /** 每文档最近一次 doc.edited 通知的修订：之后没有重新读取就不重复通知。 */
  private editNotices = new Map<string, number>();

  /** 本代理读过、且被这次用户编辑改到的区域（A1）；同一读取只提醒一次。 */
  staleReads(edit: DocEdit): string[] {
    const read = this.reads.get(edit.docId);
    if (!read) return [];
    const since = this.editNotices.get(edit.docId) ?? -1;
    const hit = edit.ranges.filter((w) =>
      read.ranges.some(
        (r) =>
          r.rev < edit.rev &&
          r.rev >= since &&
          ((r.sheetId !== "*" && r.sheetId === w.sheetId) || r.sheetName === w.sheetName) &&
          r.r0 <= w.r1 &&
          w.r0 <= r.r1 &&
          r.c0 <= w.c1 &&
          w.c0 <= r.c1,
      ),
    );
    if (hit.length === 0) return [];
    this.editNotices.set(edit.docId, edit.rev);
    return hit.map((w) => w.a1);
  }

  /** 上下文被回退后：读集与上下文占用按剩余条目重新计算。 */
  contextRewound(): void {
    this.reads = this.seededReads();
    this.lastContextTokens = undefined;
  }

  private seededReads(): ReadTable {
    return createReadTable(() => persistedReads(this.deps.db, this.sessionId, this.agentId));
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
    // 已有结果（停止时已收口等）或所属轮已结束：不再追加第二条结果、不复活旧轮
    if (this.hasToolResult(spec.toolCallId) || this.turnEnded(spec.turnId)) return;
    const roleAllowed = (tool.roles as readonly string[]).includes(this.agent()?.role ?? "main");
    this._running = true;
    this.currentTurnId = spec.turnId ?? null;
    try {
      const scope = {
        workspaceId: this.deps.workspaceId(this.sessionId),
        workspaceRoot: this.deps.workspaceRoot(this.sessionId),
        sessionId: this.sessionId,
        agentId: this.agentId,
        ...(this.deps.resolveResource
          ? {
              resolveResource: (uri: string) =>
                (this.deps.resolveResource as NonNullable<AgentRuntimeDeps["resolveResource"]>)(
                  this.sessionId,
                  uri,
                ),
            }
          : {}),
      };
      let result: ToolResult = {
        status: "error",
        error: { code: "INTERNAL", message: "工具未执行", retryable: false },
      };
      let durationMs: number | undefined;
      if (row.status === "denied") {
        result = {
          status: "error",
          error: {
            code: "APPROVAL_DENIED",
            message: row.reason ? `用户拒绝：${row.reason}` : "用户拒绝了此操作",
            retryable: false,
          },
        };
      } else if (!roleAllowed) {
        result = {
          status: "error",
          error: {
            code: "INVALID_ARGUMENT",
            message: `工具 ${spec.toolName} 不存在`,
            retryable: false,
          },
        };
      } else if (
        hasTaskContractRequirement(
          this.deps.db,
          this.sessionId,
          this.agentId,
          spec.turnId ?? "legacy-approval",
        ) &&
        (tool.externalTransport === true ||
          (typeof tool.effect === "function"
            ? (tool.effect as (args: unknown) => string)(parsed.data)
            : tool.effect) === "external")
      ) {
        // Recovered approval never grants an external capability added by a
        // current tool definition, even if its historical spec said write/read.
        result = {
          status: "error",
          error: {
            code: "UNSUPPORTED_FEATURE",
            message: "当前任务契约不支持业务外发授权；历史普通审批不能允许该操作。",
            retryable: false,
          },
        };
      } else {
        const ctrl = new AbortController();
        const startedAt = Date.now();
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
          const access = bindToolAccess({
            db: this.deps.db,
            log: this.deps.log,
            workspaceRoot: scope.workspaceRoot,
            sessionId: this.sessionId,
            agentId: this.agentId,
            turnId: spec.turnId ?? "legacy-approval",
            stepId: spec.stepId,
            toolCallId: spec.toolCallId,
          });
          result = await runWithToolAccess(access, () =>
            tool.execute(parsed.data, {
              ...scope,
              access,
              turnId: spec.turnId,
              stepId: spec.stepId,
              toolTargets: spec.targets,
              signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(tool.timeoutMs)]),
              toolCallId: spec.toolCallId,
              role: (this.agent()?.role ?? "main") as AgentRole,
              reads: this.reads,
              backups: runWithToolAccess(access, () =>
                (this.deps.backups ?? new BackupService(this.deps.db)).bind(scope),
              ),
              leases: this.deps.leases,
              agents: this.deps.agents,
              rawArgs: spec.args,
              destructiveApproved: true,
            }),
          );
          durationMs = Date.now() - startedAt;
        } catch (err) {
          durationMs = Date.now() - startedAt;
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
              code:
                err instanceof FileLeaseError
                  ? "FILE_LEASED"
                  : err instanceof TurnAccessError
                    ? "INVALID_ARGUMENT"
                    : "INTERNAL",
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
      result = withVocabularyCode(result);
      this.deps.log.append(this.sessionId, this.agentId, [
        {
          type: "tool.result",
          data: {
            toolCallId: spec.toolCallId,
            toolName: spec.toolName,
            status: result.status,
            result,
            ...(durationMs !== undefined ? { durationMs } : {}),
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
            { type: "turn.interrupted", data: this.interruptedTurnData(spec.turnId) },
          ]);
          return;
        }
        await this.continueTurn(spec.turnId, this.stepsSoFar(spec.turnId));
      }
    } finally {
      const finishedTurn = this.currentTurnId;
      this.currentTurnId = null;
      await this.afterTurn(finishedTurn);
      this._running = false;
      this.host.releaseTurn(this.sessionId);
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

  private hasToolResult(toolCallId: string): boolean {
    return (
      this.deps.db
        .prepare(
          "SELECT 1 FROM session_log WHERE session_id = ? AND agent_id = ? AND type = 'tool.result' AND json_extract(data, '$.toolCallId') = ? LIMIT 1",
        )
        .get(this.sessionId, this.agentId, toolCallId) !== undefined
    );
  }

  private turnEnded(turnId: string | undefined): boolean {
    if (turnId === undefined) return false;
    return (
      this.deps.db
        .prepare(
          "SELECT 1 FROM session_log WHERE session_id = ? AND agent_id = ? AND type IN ('turn.completed','turn.failed','turn.interrupted') AND json_extract(data, '$.turnId') = ? LIMIT 1",
        )
        .get(this.sessionId, this.agentId, turnId) !== undefined
    );
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
    // A question's display metadata is not authority to impersonate another tool.
    // Contract recovery requires both its real runtime intent and host request.
    let restoredToolName = "ask_user";
    const intentRow = this.deps.db
      .prepare(
        "SELECT data FROM session_log WHERE session_id=? AND agent_id=? AND type='tool.intent' AND json_extract(data,'$.toolCallId')=? ORDER BY seq DESC LIMIT 1",
      )
      .get(this.sessionId, this.agentId, toolCallId) as { data: string } | undefined;
    const intent = intentRow
      ? (JSON.parse(intentRow.data) as {
          toolName?: unknown;
          stepId?: unknown;
          args?: { action?: unknown };
        })
      : undefined;
    if (meta.toolName === "contract" || intent?.toolName === "contract") {
      const requested = this.deps.db
        .prepare(
          "SELECT 1 FROM session_log WHERE session_id=? AND agent_id=? AND type='contract.confirmation.requested' AND json_extract(data,'$.questionId')=?",
        )
        .get(this.sessionId, this.agentId, id);
      if (
        !requested ||
        intent?.toolName !== "contract" ||
        intent.args?.action !== "confirm" ||
        intent.stepId !== meta.stepId
      )
        return;
      restoredToolName = "contract";
    }
    // 停止/打断已收口该调用或所属轮已结束：回答只落在问题投影，不再追加结果、不复活旧轮
    if (
      this.hasToolResult(toolCallId) ||
      this.turnEnded(typeof meta.turnId === "string" ? meta.turnId : undefined)
    )
      return;
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
          data: { toolCallId, toolName: restoredToolName, status: result.status, result },
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
            { type: "turn.interrupted", data: this.interruptedTurnData(turnId) },
          ]);
          return;
        }
        await this.continueTurn(turnId, this.stepsSoFar(turnId));
      }
    } finally {
      const finishedTurn = this.currentTurnId;
      this.currentTurnId = null;
      await this.afterTurn(finishedTurn);
      this._running = false;
      this.host.releaseTurn(this.sessionId);
      void this.pump();
    }
  }

  private interruptedTurnData(turnId: string) {
    const userCancelled = this.userCancelledTurnId === turnId;
    if (userCancelled) this.userCancelledTurnId = null;
    return userCancelled
      ? { turnId, reason: "stopped" as const, cancellationCause: "user" as const }
      : { turnId };
  }

  requestStop(cancellationCause?: "user"): boolean {
    // 停止后排队中的消息不自动开始（04 §4.2）：内存队列清空，DB 里保持
    // queued 即挂起，只经 resume 恢复。不在运行（如闸门排队）时同样清空。
    this.queue = [];
    if (!this._running) return false;
    if (
      cancellationCause === "user" &&
      this.currentTurnId !== null &&
      !this.turnEnded(this.currentTurnId)
    )
      this.userCancelledTurnId = this.currentTurnId;
    this.stopRequested = true;
    this.abortReason = "代理已停止";
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
    const auto =
      typeof this.deps.autoCompact === "function" ? this.deps.autoCompact() : this.deps.autoCompact;
    if (auto === false || model.contextWindow === undefined) return false;
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
    // 压缩进度（瞬时，不入日志）：界面据此显示"正在压缩上下文"，结束以 compaction 记录或失败收尾
    const progress = (running: boolean) =>
      this.deps.bus.publish({
        kind: "app",
        data: {
          type: "compaction.progress",
          sessionId: this.sessionId,
          agentId: this.agentId,
          trigger,
          running,
          beforeTokens,
        },
      });
    progress(true);
    let summary: string;
    try {
      summary = await this.callSummaryModel(
        this.deps.summaryModel?.() ?? model,
        transcriptForSummary(plan.old.map((r) => r.item)),
      );
    } finally {
      progress(false);
    }
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

  /** 本代理最近一条已生效用户消息的聊天模式（ask/plan 时本轮只读）。 */
  private chatMode(): "ask" | "plan" | undefined {
    const row = this.deps.db
      .prepare(
        `SELECT json_extract(m.data, '$.chatMode') AS mode FROM session_log m
         JOIN dispatches d ON d.session_id = m.session_id AND d.id = json_extract(m.data, '$.dispatchId')
         WHERE m.session_id = ? AND m.agent_id = ? AND m.type = 'user.message' AND d.status = 'applied'
         ORDER BY m.seq DESC LIMIT 1`,
      )
      .get(this.sessionId, this.agentId) as { mode: string | null } | undefined;
    return row?.mode === "ask" || row?.mode === "plan" ? row.mode : undefined;
  }

  /**
   * 自动会话标题：标题仍是首条消息截断（日志里没有任何 title）时，取首条用户消息与本轮回复
   * 让模型起一个短标题，写 session.updated（auto）。失败不重试、不影响对话。
   */
  private async autoTitle(agent: AgentRow): Promise<void> {
    const { db, log } = this.deps;
    if (this.deps.autoTitle?.() !== true || this.host.titleTried(this.sessionId)) return;
    const titled = db
      .prepare(
        "SELECT 1 FROM session_log WHERE session_id = ? AND type IN ('session.created', 'session.updated') AND json_extract(data, '$.title') IS NOT NULL LIMIT 1",
      )
      .get(this.sessionId);
    if (titled) return;
    const first = db
      .prepare(
        "SELECT json_extract(data, '$.text') AS t FROM session_log WHERE session_id = ? AND type = 'user.message' ORDER BY seq LIMIT 1",
      )
      .get(this.sessionId) as { t: string | null } | undefined;
    const reply = db
      .prepare(
        "SELECT json_extract(data, '$.text') AS t FROM session_log WHERE session_id = ? AND agent_id = ? AND type = 'model.output' AND json_extract(data, '$.text') != '' ORDER BY seq DESC LIMIT 1",
      )
      .get(this.sessionId, this.agentId) as { t: string | null } | undefined;
    if (!first?.t) return;
    const resolved =
      this.deps.summaryModel?.() ??
      this.deps.resolveModel({
        id: agent.id,
        sessionId: this.sessionId,
        modelProfileId: agent.model_profile_id,
      });
    if ("error" in resolved) return;
    try {
      let text = "";
      for await (const ev of this.deps.gateway.step({
        model: resolved,
        system: TITLE_SYSTEM,
        history: [
          {
            kind: "user",
            text: `用户：${first.t.slice(0, 2000)}\n助手：${(reply?.t ?? "").slice(0, 2000)}`,
          },
        ],
        providerOptions: resolved.providerOptions,
        signal: AbortSignal.timeout(30_000),
      })) {
        if (ev.kind === "text.delta") text += ev.text;
        else if (ev.kind === "error") return;
      }
      const title = text
        .trim()
        .split("\n")[0]
        ?.replace(/^["'“”‘’《「【#\s]+|["'“”‘’》」】。.\s]+$/g, "")
        .slice(0, 30);
      // 生成期间用户可能已经改了标题
      if (
        !title ||
        db
          .prepare(
            "SELECT 1 FROM session_log WHERE session_id = ? AND type = 'session.updated' AND json_extract(data, '$.title') IS NOT NULL LIMIT 1",
          )
          .get(this.sessionId)
      )
        return;
      log.append(this.sessionId, null, [{ type: "session.updated", data: { title, auto: true } }]);
    } catch {
      // 标题只是便利功能：失败保持首条消息截断
    }
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
  private takeBatch(): { dispatchIds: string[]; resume: boolean } | null {
    let head: QueueEntry | undefined;
    while (head === undefined && this.queue.length > 0) {
      const item = this.queue.shift() as QueueEntry;
      if (
        "inbox" in item
          ? item.resume || this.hasPendingInbox()
          : this.dispatchAlive(item.dispatchId)
      )
        head = item;
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
    return {
      dispatchIds,
      resume: "inbox" in head && head.resume === true && dispatchIds.length === 0,
    };
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

  /** 运行中步骤可能已消费报告；队列里的唤醒标记本身不代表仍有输入。 */
  private hasPendingInbox(): boolean {
    return (
      this.deps.db
        .prepare(
          "SELECT 1 FROM inbox_pending WHERE session_id = ? AND to_agent_id = ? AND status = 'pending' AND from_agent_id != 'environment' LIMIT 1",
        )
        .get(this.sessionId, this.agentId) !== undefined
    );
  }

  /** 丢弃已消费的 inbox 唤醒及已撤回/已应用的派发。 */
  private hasWork(): boolean {
    const pendingInbox = this.hasPendingInbox();
    this.queue = this.queue.filter((e) =>
      "inbox" in e ? e.resume || pendingInbox : this.dispatchAlive(e.dispatchId),
    );
    return this.queue.length > 0;
  }

  /**
   * `fromGate`：由闸门唤醒。被唤醒却用不上名额（没有任务、在跑、等交互、已暂停/
   * 关闭）时把唤醒转交给下一个等待者，避免排在后面的代理无人唤醒。
   */
  private async pump(fromGate = false): Promise<void> {
    if (this.host.isShuttingDown) return;
    const handOff = () => {
      if (fromGate) this.host.releaseTurn(this.sessionId);
    };
    if (this._running || this.awaitingInteraction()) return handOff();
    // 05 §3、§8：先看有没有任务再过闸门——没有任务的代理不排队；曾在闸门
    // 排队、任务已撤回/被停止的代理回到 idle。
    if (!this.hasWork()) {
      if (this.agent()?.status === "queued") {
        this.deps.log.append(this.sessionId, this.agentId, [
          { type: "agent.status", data: { status: "idle" } },
        ]);
      }
      return handOff();
    }
    // 05 §8：子代理并发闸门——running 子代理到上限时排入 FIFO，等空位再开轮。
    const gate = this.host.acquireTurn(this, fromGate);
    if (gate === "blocked") return handOff();
    if (gate === "queued") return;
    const batch = this.takeBatch();
    if (batch === null) return handOff();
    this._running = true;
    this.stopRequested = false;
    this.interruptRequested = false;
    this.userCancelledTurnId = null;
    try {
      await this.runTurn(batch.dispatchIds, batch.resume);
    } catch (err) {
      // 未捕获的内部错误：尽力写 turn.failed，避免 actor 卡死在 running
      this.failInternal(err);
    } finally {
      const finishedTurn = this.currentTurnId;
      this.currentTurnId = null;
      await this.afterTurn(finishedTurn);
      this._running = false;
      this.host.releaseTurn(this.sessionId);
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
    return rows.map((r) => {
      const item = JSON.parse(r.item) as ContextItem;
      // 图片附件：按引用读出 base64；blob 丢失时不带 data，网关以文字说明代替
      if (item.kind !== "user" || !item.images || !this.deps.blobs) return item;
      const blobs = this.deps.blobs;
      return {
        ...item,
        images: item.images.map((img) => {
          const bytes = blobs.get(img.sha256);
          return bytes ? { ...img, data: bytes.toString("base64") } : img;
        }),
      };
    });
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

  /** Derived discharge only: the immutable attempt, failure and fact records stay intact. */
  private completedNumericDelivery(turnId: string): boolean {
    const { db } = this.deps;
    const start = db
      .prepare(
        "SELECT seq FROM session_log WHERE session_id=? AND agent_id=? AND type='turn.started' AND json_extract(data,'$.turnId')=? ORDER BY seq DESC LIMIT 1",
      )
      .get(this.sessionId, this.agentId, turnId) as { seq: number } | undefined;
    if (!start) return false;
    const rows = db
      .prepare(
        "SELECT type,data FROM session_log WHERE session_id=? AND agent_id=? AND seq>? AND seq<COALESCE((SELECT MIN(seq) FROM session_log WHERE session_id=? AND agent_id=? AND type='turn.started' AND seq>?),9223372036854775807) AND type IN ('step.started','tool.intent','tool.result','model.output','inbox.delivered','turn.completed','turn.failed','turn.interrupted') ORDER BY seq",
      )
      .all(this.sessionId, this.agentId, start.seq, this.sessionId, this.agentId, start.seq) as {
      type: string;
      data: string;
    }[];
    const object = (value: unknown): Record<string, unknown> =>
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    let stepId: string | undefined;
    let latest:
      | { callId: string; stepId: string; toolName: string; finalText?: string }
      | undefined;
    let candidate = false;
    let completed = false;
    for (const row of rows) {
      const data = object(JSON.parse(row.data));
      if (row.type === "step.started") {
        stepId =
          data.turnId === turnId && typeof data.stepId === "string" ? data.stepId : undefined;
        latest = undefined;
        candidate = completed = false;
      } else if (row.type === "tool.intent") {
        candidate = completed = false;
        const args = object(data.args);
        const finalizing =
          (data.toolName === "deliver" && args.action === "finalize") ||
          (data.toolName === "present" && Object.hasOwn(args, "finalize"));
        latest =
          finalizing &&
          stepId !== undefined &&
          data.stepId === stepId &&
          typeof data.toolCallId === "string" &&
          typeof data.toolName === "string"
            ? { callId: data.toolCallId, stepId, toolName: data.toolName }
            : undefined;
      } else if (row.type === "tool.result") {
        candidate = completed = false;
        const result = object(data.result),
          output = object(result.data);
        if (
          latest &&
          data.toolCallId === latest.callId &&
          data.toolName === latest.toolName &&
          stepId === latest.stepId &&
          data.status === "ok" &&
          result.status === "ok" &&
          output.outcome === "completed" &&
          output.finalizationStatus === "complete" &&
          typeof output.finalText === "string" &&
          output.finalText.length > 0
        )
          latest.finalText = output.finalText;
        else latest = undefined;
      } else if (row.type === "model.output") {
        // Model prose, lookalike JSON, old IDs and a new call-bearing step cannot discharge.
        completed = false;
        candidate =
          latest?.finalText !== undefined &&
          data.stepId === latest.stepId &&
          data.sourceToolCallId === latest.callId &&
          data.deliveryStatus === "complete" &&
          data.text === latest.finalText &&
          !data.toolCalls;
        if (Array.isArray(data.toolCalls) && data.toolCalls.length > 0) latest = undefined;
      } else if (row.type === "turn.completed") {
        completed = data.turnId === turnId && candidate;
      } else {
        latest = undefined;
        candidate = completed = false;
      }
    }
    return completed;
  }

  private async runTurn(dispatchIds: string[], resume = false): Promise<void> {
    const { log } = this.deps;
    const previous = this.deps.db
      .prepare(
        "SELECT json_extract(data,'$.turnId') AS turnId FROM session_log WHERE session_id=? AND agent_id=? AND type='turn.started' ORDER BY seq DESC LIMIT 1",
      )
      .get(this.sessionId, this.agentId) as { turnId: string } | undefined;
    const turnId = newId("trn");
    this.currentTurnId = turnId;
    const accessBinding = createTurnAccessBinding(this.deps.db, {
      sessionId: this.sessionId,
      agentId: this.agentId,
      turnId,
      dispatchIds,
      resume,
    });
    const previousBinding = previous
      ? turnAccessBinding(this.deps.db, this.sessionId, this.agentId, previous.turnId)
      : undefined;
    const sameContractOrigin =
      previousBinding?.contractRef !== undefined &&
      accessBinding.contractRef !== undefined &&
      previousBinding.contractRef.contractId === accessBinding.contractRef.contractId &&
      previousBinding.contractRef.originAgentId === accessBinding.contractRef.originAgentId &&
      previousBinding.contractRef.originTurnId === accessBinding.contractRef.originTurnId;
    const inherited =
      previous !== undefined &&
      (resume || sameContractOrigin) &&
      numericDeliveryState(this.deps.db, this.sessionId, this.agentId, previous.turnId).required &&
      !this.completedNumericDelivery(previous.turnId);
    log.append(this.sessionId, this.agentId, [
      ...dispatchIds.map((dispatchId) => ({
        type: "dispatch.updated",
        data: { dispatchId, status: "applied" },
      })),
      {
        type: "turn.started",
        data: { turnId, accessBinding, ...(inherited ? { numericDeliveryRequired: true } : {}) },
      },
      ...(dispatchIds.some((id) =>
        this.deps.db
          .prepare(
            "SELECT 1 FROM session_log WHERE session_id=? AND agent_id=? AND type='user.message' AND json_extract(data,'$.dispatchId')=? AND json_extract(data,'$.unscopedContextRead')=1",
          )
          .get(this.sessionId, this.agentId, id),
      )
        ? [
            {
              type: "access.unscoped",
              data: {
                turnId,
                originAgentId: accessBinding.originAgentId,
                originTurnId: accessBinding.originTurnId,
              },
            },
          ]
        : []),
    ]);
    await this.continueTurn(turnId, 0);
  }

  /**
   * 一轮的步骤循环（04 §5.2）：runTurn 与重启恢复共用。startStep 为日志中该轮
   * 已有 step.started 条数——恢复路径在旧步骤的工具调用续完后接着走步骤循环，
   * 不写新的 turn.started。
   */
  private completeAccessIncomplete(turnId: string, message: string): void {
    this.deps.log.append(this.sessionId, this.agentId, [
      {
        type: "model.output",
        data: {
          stepId: newId("stp"),
          text:
            message +
            "\n\n" +
            renderAccessFacts(
              turnAccessFacts(this.deps.db, {
                sessionId: this.sessionId,
                agentId: this.agentId,
                turnId,
              }),
            ),
          deliveryStatus: "incomplete",
        },
      },
      { type: "turn.completed", data: { turnId, reason: "stop" } },
    ]);
  }
  private async validateAccessContext(turnId: string): Promise<boolean> {
    const binding = turnAccessBinding(this.deps.db, this.sessionId, this.agentId, turnId);
    // A legacy parser ambiguity is a crosscheck for contract-backed tasks, not
    // authority to terminate before contract/ask_user can resolve it. File effects
    // remain fail-closed at the persisted contract gate.
    if (!binding?.contractRef && binding?.decision.kind === "unresolved") {
      this.completeAccessIncomplete(
        turnId,
        "本轮允许文件或目录不明确，文件任务未完成。请另发新消息，写明：仅访问目录 <相对目录>，执行 <任务>；或明确两个文件及另存目标。",
      );
      return false;
    }
    if (!binding) return true;
    for (const dispatchId of binding.sourceDispatchIds) {
      const row = this.deps.db
        .prepare(
          "SELECT data FROM session_log WHERE session_id=? AND agent_id=? AND type='user.message' AND json_extract(data,'$.dispatchId')=? ORDER BY seq DESC LIMIT 1",
        )
        .get(this.sessionId, this.agentId, dispatchId) as { data: string } | undefined;
      if (!row) continue;
      const msg = JSON.parse(row.data) as {
        deferredContextValidation?: boolean;
        context?: { docId: string; rev: number; range: string }[];
      };
      if (!msg.deferredContextValidation || !msg.context?.length) continue;
      if (
        this.deps.db
          .prepare(
            "SELECT 1 FROM session_log WHERE session_id=? AND agent_id=? AND type='turn.context.validated' AND json_extract(data,'$.dispatchId')=?",
          )
          .get(this.sessionId, this.agentId, dispatchId)
      )
        continue;
      try {
        // Ingress has already checked workspace, scope, revision and range syntax.
        // A snapshot needs read authority, so let the model propose the contract first.
        // Revisit this same reference next step; do not mark it validated while pending.
        if (binding.contractRef && isTaskContractPending({
          db: this.deps.db,
          sessionId: this.sessionId,
          ...binding.contractRef,
          contractExpected: true,
        })) continue;
        if (!this.deps.validateContext) throw new Error("未装配选区验证");
        const workspaceRoot = this.deps.workspaceRoot(this.sessionId);
        const access = bindToolAccess({
          db: this.deps.db,
          log: this.deps.log,
          workspaceRoot,
          sessionId: this.sessionId,
          agentId: this.agentId,
          turnId,
          toolCallId: `context:${dispatchId}`,
        });
        await runWithToolAccess(access, () =>
          this.deps.validateContext!(msg.context!, workspaceRoot),
        );
        this.deps.log.append(this.sessionId, this.agentId, [
          { type: "turn.context.validated", data: { turnId, dispatchId } },
        ]);
      } catch (error) {
        // Keep the proposal/confirmation loop reachable while a context read is
        // awaiting permission. This does not validate the reference or grant I/O.
        if (binding.contractRef && error instanceof Error &&
            error.message === "Contract permission unavailable or needs_confirmation") {
          const contract = taskContractState({ db: this.deps.db, sessionId: this.sessionId,
            ...binding.contractRef, contractExpected: true });
          if (contract?.permissions.some(permission => permission.state === "needs_confirmation" &&
              (permission.operation === "read-content" || permission.operation === "read-metadata"))) continue;
        }
        this.completeAccessIncomplete(
          turnId,
          "选区引用无法在当前允许文件或目录内完成验证，本轮未完成。请重新选择许可文件中的有效选区并另发明确任务。",
        );
        return false;
      }
    }
    return true;
  }

  private async continueTurn(turnId: string, startStep: number): Promise<void> {
    const { log } = this.deps;
    if (!(await this.validateAccessContext(turnId))) return;
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
        log.append(this.sessionId, this.agentId, [
          { type: "turn.interrupted", data: this.interruptedTurnData(turnId) },
        ]);
        return;
      }
      step += 1;
      this.budgetUsage.steps = Math.max(this.budgetUsage.steps, step);
      // 步数到顶仍允许一次无工具总结调用；累计 token/工具调用到顶则直接收口。
      const overStepLimit = step > maxSteps;
      if (!overStepLimit && !checkBudget(this.budget, this.budgetUsage).ok) {
        const budgetCheck = checkBudget(this.budget, this.budgetUsage);
        if (accessDeliveryRequired(this.deps.db, this.sessionId, this.agentId, turnId)) {
          this.completeAccessIncomplete(turnId, "本轮预算已用尽，证据交付未完成。");
          return;
        }
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
              retryable: false,
            },
          },
        ]);
        return;
      }
      const outcome = await this.runStep(turnId, step, resolved, agent, overStepLimit);
      if (outcome === "continue") continue;
      if (outcome === "budget_exceeded") {
        if (accessDeliveryRequired(this.deps.db, this.sessionId, this.agentId, turnId)) {
          this.completeAccessIncomplete(turnId, "本轮预算已用尽，证据交付未完成。");
          return;
        }
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
    let admittedProgressDrain = false;

    for (;;) {
      // 压缩等步前工作可能消耗时间在标记置位之后：每个循环边界先收口停止/打断。
      if (this.stopRequested || this.interruptRequested) {
        log.append(topic, this.agentId, [
          { type: "turn.interrupted", data: this.interruptedTurnData(turnId) },
        ]);
        return "interrupted";
      }
      this.applyQueuedSteers();
      if (!(await this.validateAccessContext(turnId))) return "done";
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
          log.append(topic, this.agentId, [
            { type: "turn.interrupted", data: this.interruptedTurnData(turnId) },
          ]);
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
      const numericDelivery = numericDeliveryState(
        this.deps.db,
        this.sessionId,
        this.agentId,
        turnId,
      );
      const accessRequired = accessDeliveryRequired(
        this.deps.db,
        this.sessionId,
        this.agentId,
        turnId,
      );
      const taskBinding = turnAccessBinding(this.deps.db, this.sessionId, this.agentId, turnId);
      const harness = harnessState(
        this.deps.db,
        this.sessionId,
        harnessTaskId({ sessionId: this.sessionId, agentId: this.agentId, turnId, ...taskBinding }),
      );
      const progress = harnessProgress(this.deps.db, this.sessionId, harness.taskId);
      const descendantsBusy = () =>
        this.deps.db
          .prepare(
            "WITH RECURSIVE descendants(id,status) AS (SELECT id,status FROM agents WHERE session_id=? AND parent_id=? UNION ALL SELECT a.id,a.status FROM agents a JOIN descendants d ON a.parent_id=d.id WHERE a.session_id=?) SELECT 1 FROM descendants WHERE status IN ('running','waiting') LIMIT 1",
          )
          .get(this.sessionId, this.agentId, this.sessionId) !== undefined;
      const childBusy = descendantsBusy();
      if (progress.exhausted && childBusy && progress.drainSteps === 0)
        admittedProgressDrain = true;
      const progressStopping = progress.exhausted && !admittedProgressDrain;
      const progressReason =
        progress.reason === "invalid_exploration_budget"
          ? "连续 12 次无效或不支持的检查预检未增加有效证据"
          : "同语义检查已重复 3 次且未增加有效证据";
      if (progressStopping && progress.terminationSteps >= 2) {
        // Do not report a terminal task while already-started descendants can still publish.
        // No wall-clock timeout: user stop remains responsive and pending approvals remain pending.
        while (descendantsBusy()) {
          if (this.stopRequested || this.interruptRequested) {
            log.append(topic, this.agentId, [
              { type: "turn.interrupted", data: this.interruptedTurnData(turnId) },
            ]);
            return "interrupted";
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 50));
        }
        const settledProgress = harnessProgress(this.deps.db, this.sessionId, harness.taskId);
        if (!settledProgress.exhausted) continue;
        this.completeAccessIncomplete(
          turnId,
          `${progressReason}，宿主已停止无进展循环。已保存文件和失败义务仍保留；没有自动发卡或认定完成。`,
        );
        return "done";
      }
      const delivery = {
        ...numericDelivery,
        required:
          numericDelivery.required || accessRequired || harness.required || progressStopping,
      };
      const deliveryGuidance = [
        numericDelivery.required ? NUMERIC_DELIVERY_GUIDANCE : "",
        accessRequired ? ACCESS_DELIVERY_GUIDANCE : "",
        harnessContext(harness),
        progressStopping
          ? `${progressReason}。仅允许 inspect 当前目录并用 partial/blocked 结束；最多两步，不能再执行修复或重试检查。`
          : "",
      ]
        .filter(Boolean)
        .join("\n");
      if (forceFinal && delivery.required) {
        log.append(topic, this.agentId, [
          {
            type: "model.output",
            data: {
              stepId,
              text:
                "本轮已达到执行限制，证据交付未完成。\n\n" +
                (harness.required
                  ? "文件保存和业务校验的宿主状态仍需完成交付；未完成不表示已回滚。\n\n"
                  : "") +
                numericExecutionFacts(this.deps.db, this.sessionId, this.agentId, turnId) +
                (accessRequired
                  ? "\n\n" +
                    renderAccessFacts(
                      turnAccessFacts(this.deps.db, {
                        sessionId: this.sessionId,
                        agentId: this.agentId,
                        turnId,
                      }),
                    )
                  : ""),
              deliveryStatus: "incomplete",
            },
          },
          { type: "turn.completed", data: { turnId, reason: "step_limit" } },
        ]);
        return "done";
      }

      const ctrl = new AbortController();
      this.callAbort = ctrl;
      let sawContent = false;
      let text = "";
      let textBytes = 0;
      let textOverflow = false;
      const textByteLimit = 256 * 1024;
      let reasoning = "";
      let reasoningStart: number | undefined;
      let reasoningEnd: number | undefined;
      let reasoningProviderOptions: Record<string, unknown> | undefined;
      let usage: Usage | undefined;
      let finish: FinishReason | undefined;
      const toolCalls: ToolCall[] = [];
      const toolCallIdx = new Map<string, number>();
      let classified: ClassifiedError | undefined;
      let part = 0;
      try {
        const contractPending = taskBinding?.contractRef
          ? isTaskContractPending({
              db: this.deps.db,
              sessionId: this.sessionId,
              ...taskBinding.contractRef,
              contractExpected: true,
            })
          : false;
        const contract = !contractPending && taskBinding?.contractRef
          ? taskContractState({
              db: this.deps.db,
              sessionId: this.sessionId,
              ...taskBinding.contractRef,
              contractExpected: true,
            })
          : undefined;
        // Catalog relevance only; actual calls retain all path/range and confirmation checks.
        // Pending confirmation must remain callable so normal approval can resolve it.
        const operations = new Set(contract?.permissions
          .filter((permission) => permission.state !== "denied")
          .map((permission) => permission.operation));
        const canWrite = operations.has("create") || operations.has("mutate") ||
          operations.has("remove") || operations.has("relocate");
        const contentWrites = contract?.permissions.filter(permission =>
          permission.state !== "denied" && (permission.operation === "create" || permission.operation === "mutate")) ?? [];
        const textWriteAvailable = contentWrites.some(permission => permission.target.match === "tree" ||
          !/\.(xlsx|xlsm|xls|xlsb|ods|zip|png|jpe?g|gif|webp|pdf|exe|dll|bin|gz|7z|woff2?|mp[34])$/i.test(permission.target.path));
        const workbookWriteAvailable = contentWrites.some(permission => permission.target.match === "tree" ||
          !/\.(xlsx|xlsm|csv|tsv|txt|md|json|jsonl|ya?ml|xml|html?|css|[cm]?js|[cm]?ts|py|png|jpe?g|gif|webp|pdf|zip)$/i.test(permission.target.path) ||
          (permission.operation === "create"
            ? /\.xlsx$/i.test(permission.target.path)
            : /\.(xlsx|xlsm|csv|tsv)$/i.test(permission.target.path)));
        const canReadContent = operations.has("read-content");
        const canReadMetadata = operations.has("read-metadata");
        const auxiliaryEnabled = contract ? enabledAuxiliaryTools(this.deps.db, this.sessionId, this.agentId) : undefined;
        const relevantTool = (name: string): boolean => {
          if (!contract) return true;
          if (isAuxiliaryTool(name)) return auxiliaryEnabled!.has(name);
          // Accepted enumeration-only tasks also need the lightweight discovery entry.
          if (name === "workbook_check") return true;
          if (name === "find")
            return operations.has("enumerate") || canReadContent || canReadMetadata || canWrite;
          if (name === "read" || name === "workbook_read")
            return canReadContent || canReadMetadata || canWrite;
          if (name === "workbook_query" || name === "workbook_analyze" || name === "workbook_render")
            return canReadContent || canWrite;
          // files also has a genuine read-only backup-list branch.
          if (name === "files") return canReadMetadata || canWrite;
          if (name === "write" || name === "edit") return textWriteAvailable;
          if (name === "workbook_edit") return workbookWriteAvailable;
          const effect = this.deps.tools.get(name)?.effect;
          if (effect === "write") return contentWrites.length > 0;
          if (effect === "destructive")
            return operations.has("remove") || operations.has("relocate");
          // Controls and unclassified mixed tools keep their execution-time checks.
          return true;
        };
        const staged = contract ? stagedCatalogState(this.deps.db, this.sessionId, this.agentId, turnId, taskBinding?.contractRef?.contractId) : undefined;
        if (staged) {
          staged.operations = operations;
          const targets = contract!.permissions.filter(permission => permission.state !== "denied");
          staged.workbook = targets.some(permission => permission.target.match === "tree" || /\.(xlsx|xlsm|csv|tsv)$/i.test(permission.target.path));
          staged.text = targets.some(permission => permission.target.match === "tree" || !/\.(xlsx|xlsm|xls|xlsb|ods|csv|tsv|png|jpe?g|gif|webp|pdf|zip)$/i.test(permission.target.path));
        }
        const history = this.history();
        if (contractPending) {
          let statusContext: unknown;
          try {
            const snapshot = this.deps.tools.get("contract")?.modelContext?.({
              sessionId: this.sessionId, agentId: this.agentId, turnId,
            });
            if (snapshot?.status === "ok") statusContext = snapshot.data;
          } catch { /* Keep the ordinary status tool available on projection failure. */ }
          history.push({
            kind: "user",
            text: statusContext
              ? `<context>当前任务契约待提案。以下是宿主当前 status 的只读结果（不是授权）：${JSON.stringify(statusContext)}。直接按 revision 作为 baseRevision 提交与用户要求一致的 proposal，无需再 status。未申请的范围默认无权；“其他文件或单元格保持不变”写入 obligations，不要用根目录 tree 禁止覆盖本次申请文件。已有用户禁止必须保留。提案未接受时先用 contract/ask_user；即使目录保留已加载工具，也不代表本轮已获授权。</context>`
              : "<context>当前任务契约待提案。先用 contract 查看状态和原文引用，再提交与用户要求一致的提案；提案未接受时先用 contract/ask_user；即使目录保留已加载工具，也不代表本轮已获授权。</context>",
          });
        }
        if (delivery.required)
          history.push({ kind: "user", text: `<context>${deliveryGuidance}</context>` });
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
          tools: forceFinal
            ? undefined
            : this.deps
                .toolSpecsFor(agent.role)
                .filter(
                  (tool) =>
                    (model.vision !== false ||
                      this.deps.tools.get(tool.name)?.requiresVision !== true) &&
                    (!progressStopping || tool.name === "deliver") &&
                    (!contractPending || tool.name === "contract" || tool.name === "ask_user") &&
                    relevantTool(tool.name),
                )
                .flatMap((tool) => {
                  if (!staged) return [tool];
                  const selected = stagedModelToolSpec(tool, staged);
                  return selected ? [selected] : [];
                })
                .map((tool) => staged ? tool : tool.name === "workbook_check"
                  ? canWrite ? compactWorkbookCheckSpec(tool) : {
                      ...tool,
                      description: "普通只读回答无需写出计划。类型化检查先 action=describe 获取 verification 格式。写后首次校验直接 action=execute 提交完整声明，宿主同一次登记并执行；已有计划直接 execute 引用 planId/version，不要先 register 再 execute。仅写入前需要 planId/version 时用 register；prepare 仅预检、不登记或执行。describe 可带 tool=workbook_edit, ops=[操作名] 查询编辑参数。需要辅助能力时 action=describe, auxiliaryGroups=[agents|presentation|skills|memory]：分别为委派协作、图表展示、技能、长期记忆，下一轮恢复所选族的原工具格式；不执行或授予文件权限。登记/描述不证明完成，完整运行期校验不变。",
                      inputSchema: withResultCursor({
                        type: "object",
                        properties: {
                          action: { type: "string", enum: ["describe", "register", "prepare", "execute"] },
                          auxiliaryGroups: { type: "array", items: { type: "string", enum: ["agents", "presentation", "skills", "memory"] }, minItems: 1, maxItems: 4, description: "仅 describe，不能同时传 tool/ops/verification。" },
                          tool: { type: "string", enum: ["workbook_edit"], description: "仅 describe 使用。" },
                          ops: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 8, description: "tool=workbook_edit 时必填。" },
                          verification: {
                            type: "object",
                            additionalProperties: true,
                            description: "describe 返回的完整声明格式，或现有计划的 planId/version；describe 时省略。",
                          },
                        },
                        required: ["action"],
                        additionalProperties: false,
                        oneOf: [
                          { properties: { action: { const: "describe" }, tool: false, ops: false, auxiliaryGroups: false, verification: false } },
                          { required: ["tool", "ops"], properties: { action: { const: "describe" }, auxiliaryGroups: false, verification: false } },
                          { required: ["auxiliaryGroups"], properties: { action: { const: "describe" }, tool: false, ops: false, verification: false } },
                          { required: ["verification"], properties: { action: { enum: ["register", "prepare", "execute"] }, tool: false, ops: false, auxiliaryGroups: false } },
                        ],
                      }),
                    }
                  : tool.name === "workbook_edit" ? compactWorkbookEditSpec(tool) : compactModelToolSpec(tool))
                .map(deduplicateModelToolSchema)
                .map(withStagedCapabilityDirectory),
          providerOptions: model.providerOptions,
          signal: ctrl.signal,
        };
        if (!forceFinal && !progressStopping && taskBinding?.contractRef) {
          const taskId = taskBinding.contractRef.contractId;
          const previous = this.stagedCatalog?.taskId === taskId ? this.stagedCatalog.tools : [];
          req.tools = appendStagedCatalog(previous, req.tools ?? []);
          this.stagedCatalog = {taskId,tools:req.tools};
        }
        for await (const ev of gateway.step(req)) {
          part += 1;
          switch (ev.kind) {
            case "text.delta": {
              sawContent = true;
              // Tool calls may arrive after text: nothing is public until this step is classified.
              const tail = text.charCodeAt(text.length - 1);
              const head = ev.text.charCodeAt(0);
              const joinedPair =
                tail >= 0xd800 && tail <= 0xdbff && head >= 0xdc00 && head <= 0xdfff;
              const bytes = Buffer.byteLength(ev.text, "utf8") - (joinedPair ? 2 : 0);
              if (bytes > textByteLimit - textBytes) {
                textOverflow = true;
                ctrl.abort();
                break;
              }
              textBytes += bytes;
              text += ev.text;
              break;
            }
            case "reasoning.delta":
              sawContent = true;
              reasoning += ev.text;
              reasoningStart ??= Date.now();
              reasoningEnd = Date.now();
              if (ev.providerMetadata !== undefined) {
                reasoningProviderOptions = ev.providerMetadata as Record<string, unknown>;
              }
              this.delta(stepId, part, "reasoning", ev.text);
              break;
            case "tool.args.delta": {
              if (ev.delta !== "") sawContent = true;
              if (!toolCallIdx.has(ev.toolCallId)) {
                toolCallIdx.set(ev.toolCallId, toolCallIdx.size);
              }
              const payload: ToolArgsDelta = {
                id: ev.toolCallId,
                ...(ev.toolName !== undefined ? { name: ev.toolName } : {}),
                delta: ev.delta,
              };
              this.delta(stepId, toolCallIdx.get(ev.toolCallId) ?? 0, "tool_args", payload);
              break;
            }
            case "tool.call":
              sawContent = true;
              toolCallIdx.set(ev.toolCallId, toolCallIdx.size);
              toolCalls.push({
                id: ev.toolCallId,
                name: ev.toolName,
                args: ev.args,
                ...(ev.inputError ? { inputError: ev.inputError } : {}),
              });
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
          if (textOverflow) break;
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

      if (textOverflow) {
        log.append(topic, this.agentId, [
          {
            type: "model.output",
            data: { stepId, withheldText: text, ...(toolCalls.length ? { toolCalls } : {}) },
          },
          {
            type: "context.notice",
            data: {
              kind: "model.text_buffer_exceeded",
              text: "本步正文超过 256 KiB UTF-8 缓冲上限，记录仅保留有界前缀；未公开正文或执行本步工具。",
            },
          },
          ...toolCalls.map((call) => ({
            type: "tool.result",
            data: {
              toolCallId: call.id,
              toolName: call.name,
              status: "not_executed",
              result: {
                status: "not_executed",
                error: {
                  code: "LIMIT_EXCEEDED",
                  message: "本步正文缓冲超限，工具未执行",
                  retryable: false,
                },
              },
            },
          })),
        ]);
        this.failTurn(turnId, {
          kind: "unknown",
          retryable: false,
          message: "模型正文超过单步 256 KiB 缓冲上限，本步已停止。",
        });
        return "failed";
      }

      if (!classified && (ctrl.signal.aborted || this.stopRequested || this.interruptRequested))
        classified = {
          kind: "aborted",
          retryable: false,
          message: "模型步骤已取消，缓存正文未公开。",
        };

      if (!classified) {
        if (usage !== undefined) this.budgetUsage = addUsage(this.budgetUsage, usage);
        // 提供商报告的本步上下文占用（04 §6.1）；无报告回退字符估算。
        this.lastContextTokens =
          usage !== undefined && (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) > 0
            ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
            : undefined;
        this.budgetUsage.toolCalls += toolCalls.length;
        if (progressStopping || admittedProgressDrain)
          log.append(topic, this.agentId, [
            {
              type: "harness.progress",
              data: { taskId: harness.taskId, kind: progressStopping ? "termination" : "drain" },
            },
          ]);
        const budgetRecord = usage !== undefined || toolCalls.length > 0;
        const finalizing = toolCalls.some((call) => {
          const tool = this.deps.tools.get(call.name);
          return tool?.finalizesTurn?.(call.args) === true;
        });
        if (delivery.required && toolCalls.length === 0) {
          log.append(topic, this.agentId, [
            {
              type: "model.output",
              data: {
                stepId,
                withheldText: text,
                deliveryStatus: "rejected",
                ...(reasoning !== "" ? { reasoning } : {}),
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
          if (delivery.rejected >= 1) {
            this.failNumericDelivery(turnId);
            return "failed";
          }
          log.append(topic, this.agentId, [
            {
              type: "context.notice",
              data: { kind: "numeric_delivery.required", text: deliveryGuidance },
            },
          ]);
          return "continue";
        }
        if (text !== "" && !delivery.required && !finalizing && toolCalls.length === 0)
          this.delta(stepId, part, "text", text);
        log.append(topic, this.agentId, [
          {
            type: "model.output",
            data: {
              stepId,
              ...(text !== ""
                ? delivery.required || finalizing || toolCalls.length > 0
                  ? { withheldText: text }
                  : { text }
                : {}),
              ...(reasoning !== "" ? { reasoning } : {}),
              ...(reasoningProviderOptions !== undefined ? { reasoningProviderOptions } : {}),
              ...(toolCalls.length > 0 ? { toolCalls } : {}),
              ...(reasoningStart !== undefined && reasoningEnd !== undefined
                ? { reasoningMs: reasoningEnd - reasoningStart }
                : {}),
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
        const outcome = await this.executeCalls(turnId, stepId, toolCalls, !progressStopping);
        if (
          text !== "" &&
          !finalizing &&
          outcome === "continue" &&
          !this.stopRequested &&
          !this.interruptRequested &&
          !numericDeliveryState(this.deps.db, this.sessionId, this.agentId, turnId).required &&
          !accessDeliveryRequired(this.deps.db, this.sessionId, this.agentId, turnId) &&
          !harnessState(this.deps.db, this.sessionId, harness.taskId).required &&
          toolCalls.every((call) => {
            const latest = this.deps.db
              .prepare(
                "SELECT json_extract(data,'$.status') AS status,json_extract(data,'$.result.status') AS resultStatus FROM session_log WHERE session_id=? AND agent_id=? AND type='tool.result' AND json_extract(data,'$.toolCallId')=? AND seq>(SELECT MAX(seq) FROM session_log WHERE session_id=? AND agent_id=? AND type='tool.intent' AND json_extract(data,'$.stepId')=? AND json_extract(data,'$.toolCallId')=?) ORDER BY seq DESC LIMIT 1",
              )
              .get(
                this.sessionId,
                this.agentId,
                call.id,
                this.sessionId,
                this.agentId,
                stepId,
                call.id,
              ) as { status: string; resultStatus: string } | undefined;
            return latest?.status === "ok" && latest.resultStatus === "ok";
          })
        ) {
          // Calls remain in their original record; this sole text record cannot duplicate them.
          this.delta(stepId, part, "text", text);
          log.append(topic, this.agentId, [{ type: "model.output", data: { stepId, text } }]);
        }
        return outcome;
      }

      // 错误路径
      const stopped =
        this.stopRequested || this.interruptRequested || classified.kind === "aborted";
      if (stopped) {
        // Incomplete model steps never release buffered text, including ordinary-looking prefixes.
        log.append(topic, this.agentId, [
          ...(text !== "" || reasoning !== ""
            ? [
                {
                  type: "model.output",
                  data: {
                    stepId,
                    ...(text !== "" ? { withheldText: text } : {}),
                    ...(reasoning !== "" ? { reasoning } : {}),
                    ...(reasoningProviderOptions !== undefined ? { reasoningProviderOptions } : {}),
                    ...(reasoningStart !== undefined && reasoningEnd !== undefined
                      ? { reasoningMs: reasoningEnd - reasoningStart }
                      : {}),
                  },
                },
              ]
            : []),
          { type: "turn.interrupted", data: this.interruptedTurnData(turnId) },
        ]);
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
              log.append(topic, this.agentId, [
                { type: "turn.interrupted", data: this.interruptedTurnData(turnId) },
              ]);
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
        // 04 §8.4：失败轮已流出的内容同样作废（P1-41，分支 models-ext-desktop 最小插入）
        if (overflowCompacted && sawContent) {
          log.append(topic, this.agentId, [{ type: "attempt.discarded", data: { stepId } }]);
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
          log.append(topic, this.agentId, [
            { type: "turn.interrupted", data: this.interruptedTurnData(turnId) },
          ]);
          return "interrupted";
        }
        continue;
      }
      // 04 §8.4：失败轮已流出的内容同样作废（P1-41，分支 models-ext-desktop 最小插入）
      if (sawContent) {
        log.append(topic, this.agentId, [{ type: "attempt.discarded", data: { stepId } }]);
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
    this.deps.log.append(this.sessionId, this.agentId, [
      ...ids.map((dispatchId) => ({
        type: "dispatch.updated",
        data: { dispatchId, status: "applied" },
      })),
      ...(this.currentTurnId
        ? [
            {
              type: "turn.access.updated",
              data: {
                turnId: this.currentTurnId,
                accessBinding: steeredTurnAccessBinding(this.deps.db, {
                  sessionId: this.sessionId,
                  agentId: this.agentId,
                  turnId: this.currentTurnId,
                  dispatchIds: ids,
                }),
              },
            },
          ]
        : []),
    ]);
  }

  /**
   * 步骤边界投递（05 §4.2）：本代理全部待投递的收件箱消息与环境通知按优先级
   * （urgent > 用户 > report/notice > 代理消息）一次写出 inbox.delivered；
   * agent_context 投影据此把这一批合并为一条 <inbox> 追加到对话末尾。
   */
  private deliverInbox(): void {
    const rows = this.deps.db
      .prepare(
        `SELECT message_id, to_agent_id FROM inbox_pending WHERE session_id = ? AND to_agent_id = ? AND status = 'pending'
         ORDER BY CASE WHEN urgent = 1 THEN 0 WHEN kind = 'user' THEN 1 WHEN kind IN ('report', 'notice') THEN 2 ELSE 3 END, created_at, rowid`,
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

  /**
   * afterTurn（04 §11）：异步收尾，不阻塞下一轮。
   * 1. 本轮工具调用提交的文档修订 → 从文档日志生成变更摘要，写 change.summary；
   * 2. 完成报告（05 §4.3、§3）：非 main 且有 parent_id 的代理每结束一轮，向父代理
   *    写一条 kind=report 的 inbox.sent 并唤醒它。结束原因取本轮终止记录；最终
   *    回复取本轮最后一条带 text 的 model.output；变更摘要复用第 1 步的文档摘要，
   *    非工作簿写入取本轮 status=ok 且 effect 为 write/destructive 的 tool.result。
   * 进程重启时由 recoverInterruptedAgents 合成的 turn.interrupted 不经此路径。
   */
  private async afterTurn(turnId: string | null): Promise<void> {
    if (this.userCancelledTurnId === turnId) this.userCancelledTurnId = null;
    if (turnId === null) return;
    await this.finishTurn(turnId).catch((err: unknown) => {
      this.deps.emit?.("turn.after_failed", {
        sessionId: this.sessionId,
        agentId: this.agentId,
        name: err instanceof Error ? err.name : "unknown",
      });
    });
  }

  private async finishTurn(turnId: string): Promise<void> {
    const { db } = this.deps;
    const start = db
      .prepare(
        "SELECT seq FROM session_log WHERE session_id = ? AND agent_id = ? AND type = 'turn.started' AND json_extract(data, '$.turnId') = ? ORDER BY seq DESC LIMIT 1",
      )
      .get(this.sessionId, this.agentId, turnId) as { seq: number } | undefined;
    const term = db
      .prepare(
        "SELECT seq, type, data FROM session_log WHERE session_id = ? AND agent_id = ? AND type IN ('turn.completed','turn.failed','turn.interrupted') AND json_extract(data, '$.turnId') = ? ORDER BY seq DESC LIMIT 1",
      )
      .get(this.sessionId, this.agentId, turnId) as
      | { seq: number; type: string; data: string }
      | undefined;
    if (!start || !term) return;

    // 1. 变更摘要：本轮全部工具调用提交的文档修订（不来自模型自述）。
    const toolCallIds = (
      db
        .prepare(
          "SELECT DISTINCT json_extract(data, '$.toolCallId') AS id FROM session_log WHERE session_id = ? AND agent_id = ? AND type = 'tool.result' AND seq > ? AND seq <= ?",
        )
        .all(this.sessionId, this.agentId, start.seq, term.seq) as { id: unknown }[]
    ).flatMap((r) => (typeof r.id === "string" ? [r.id] : []));
    const docs =
      this.deps.changeSummary && toolCallIds.length > 0
        ? await this.deps.changeSummary.summarize({
            sessionId: this.sessionId,
            workspaceRoot: this.deps.workspaceRoot(this.sessionId),
            toolCallIds,
            storedOnly: accessDeliveryRequired(this.deps.db, this.sessionId, this.agentId, turnId),
          })
        : [];
    if (docs.length > 0) {
      this.deps.log.append(this.sessionId, this.agentId, [
        {
          type: "change.summary",
          data: {
            docRevs: Object.fromEntries(docs.map((d) => [d.docId, d.toRev])),
            changes: { turnId, docs },
          },
        },
      ]);
    }

    const agent = this.agent();
    if (agent?.role === "main" && term.type === "turn.completed") void this.autoTitle(agent);

    // 2. 完成报告（仅子代理）。
    if (!agent || agent.role === "main" || !agent.parent_id) return;
    const termData = JSON.parse(term.data) as {
      reason?: string;
      error?: { message?: string };
    };
    const reason =
      term.type === "turn.completed"
        ? termData.reason === "budget_exceeded"
          ? "预算耗尽"
          : "已完成"
        : term.type === "turn.failed"
          ? `出错：${termData.error?.message ?? "未知错误"}`
          : "被停止";

    const replyRow = db
      .prepare(
        "SELECT json_extract(data, '$.text') AS t FROM session_log WHERE session_id = ? AND agent_id = ? AND type = 'model.output' AND seq > ? AND seq <= ? AND json_extract(data, '$.text') IS NOT NULL ORDER BY seq DESC LIMIT 1",
      )
      .get(this.sessionId, this.agentId, start.seq, term.seq) as { t: string | null } | undefined;
    let reply = replyRow?.t ?? "无";
    if (reply.length > 4000) {
      reply = `${reply.slice(0, 4000)}（已截断，可用 agent_status 查看全文）`;
    }

    const lines: string[] = docs.map(describeDocChange);
    const docPaths = new Set(docs.map((d) => d.path));
    const results = db
      .prepare(
        "SELECT data FROM session_log WHERE session_id = ? AND agent_id = ? AND type = 'tool.result' AND seq > ? AND seq <= ? ORDER BY seq",
      )
      .all(this.sessionId, this.agentId, start.seq, term.seq) as { data: string }[];
    for (const row of results) {
      const rec = JSON.parse(row.data) as {
        toolCallId?: string;
        toolName?: string;
        status?: string;
        result?: ToolResult;
      };
      if (rec.status !== "ok" || typeof rec.toolCallId !== "string") continue;
      const toolName = rec.toolName ?? "";
      const tool = this.deps.tools.get(toolName);
      if (!tool) continue;
      const intent = db
        .prepare(
          "SELECT json_extract(data, '$.args') AS a FROM session_log WHERE session_id = ? AND agent_id = ? AND type = 'tool.intent' AND json_extract(data, '$.toolCallId') = ? ORDER BY seq LIMIT 1",
        )
        .get(this.sessionId, this.agentId, rec.toolCallId) as { a: string | null } | undefined;
      const intentArgs = intent?.a ? JSON.parse(intent.a) : undefined;
      if (isResultPage(intentArgs)) continue;
      let effect: ToolEffect;
      try {
        effect =
          typeof tool.effect === "function"
            ? (tool.effect as (args: never) => ToolEffect)(intentArgs as never)
            : tool.effect;
      } catch {
        continue;
      }
      if (effect !== "write" && effect !== "destructive") continue;
      const data = (rec.result?.data ?? {}) as Record<string, unknown>;
      const docRevs = data.docRevs as Record<string, number> | undefined;
      const published = Array.isArray(data.published)
        ? (data.published as { path?: unknown; rev?: unknown }[])
        : [];
      const paths = new Set<string>();
      if (typeof data.path === "string") paths.add(data.path);
      if (typeof data.to === "string") paths.add(data.to);
      for (const p of published) {
        if (typeof p?.path === "string") paths.add(p.path);
      }
      const changes =
        data.changes !== undefined ? ` ${JSON.stringify(data.changes).slice(0, 200)}` : "";
      for (const path of paths) {
        if (docPaths.has(path)) continue;
        const pub = published.find((p) => p.path === path);
        const rev =
          (typeof pub?.rev === "number" ? pub.rev : undefined) ??
          (typeof data.rev === "number" ? data.rev : undefined) ??
          (typeof data.docId === "string" ? docRevs?.[data.docId] : undefined);
        lines.push(`${path}${rev !== undefined ? `（修订 rev${rev}）` : ""}${changes}`);
      }
    }

    const message = `子代理「${agent.name ?? this.agentId}」本轮${reason}。\n【最终回复】\n${reply}\n【变更摘要】\n${lines.length > 0 ? lines.join("\n") : "无写入"}`;
    this.deps.log.append(this.sessionId, this.agentId, [
      {
        type: "inbox.sent",
        data: {
          messageId: newId("msg"),
          fromAgentId: this.agentId,
          toAgentId: agent.parent_id,
          kind: "report",
          message,
          ...(numericDeliveryState(db, this.sessionId, this.agentId, turnId).required
            ? {
                numericDelivery: {
                  turnId,
                  outcome:
                    term.type === "turn.completed"
                      ? "completed"
                      : term.type === "turn.failed"
                        ? "failed"
                        : "interrupted",
                },
              }
            : {}),
        },
      },
    ]);
    this.deps.onInbox?.(this.sessionId, agent.parent_id);
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
    if (
      (input.effect === "write" || input.effect === "destructive" || input.effect === "external") &&
      this.chatMode() !== undefined
    )
      return {
        required: true,
        decision: "denied",
        reason:
          this.chatMode() === "plan"
            ? "当前是计划模式，不能修改文件。请把计划告诉用户，等用户确认后再执行"
            : "当前是只读问答模式，不能修改文件",
      };
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
      !isAutoApproved(this.deps.db, this.sessionId, input.toolName, input.targets, input.effect) &&
      this.deps.tools.get(input.toolName)?.autoApproved?.() !== true;
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
      workspaceRoot: this.deps.workspaceRoot(this.sessionId),
      effects: this.deps.tools.get(input.toolName)?.effectIntents?.(input.args, {
        workspaceRoot: this.deps.workspaceRoot(this.sessionId),
      }),
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
    if (this.host.isShuttingDown) return { required: true, decision: "denied" };
    if (approval.get(pending.id)?.status === "pending") {
      // 等待被中止（停止/打断）：以中止理由收口审批决定
      approval.decide(pending.id, "denied", this.abortReason, false, "cancelled");
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
    admittedBeforeProgressStop = false,
  ): Promise<StepOutcome> {
    const { log, tools } = this.deps;
    const agentRole = (this.agent()?.role ?? "main") as AgentRole;
    const terminalCalls = calls.filter((call) => {
      const tool = tools.get(call.name);
      return tool?.finalizesTurn?.(call.args) === true;
    });
    if (terminalCalls.length > 0 && calls.length !== 1) {
      log.append(this.sessionId, this.agentId, [
        ...calls.flatMap((call) => [
          {
            type: "tool.intent",
            data: {
              stepId,
              toolCallId: call.id,
              toolName: call.name,
              args: call.args,
              targets: [],
              replay: "safe",
            },
          },
          {
            type: "tool.result",
            data: {
              toolCallId: call.id,
              toolName: call.name,
              status: "not_executed",
              result: {
                status: "not_executed",
                error: {
                  code: "INVALID_ARGUMENT",
                  message: "证据终稿必须单独调用；本步所有调用均未执行。",
                  retryable: false,
                },
              },
            },
          },
        ]),
        { type: "model.output", data: { stepId, withheldText: "", deliveryStatus: "rejected" } },
      ]);
      if (numericDeliveryState(this.deps.db, this.sessionId, this.agentId, turnId).rejected > 1) {
        this.failNumericDelivery(turnId);
        return "failed";
      }
      return "continue";
    }
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
        { type: "turn.interrupted", data: this.interruptedTurnData(turnId) },
      ];
      log.append(this.sessionId, this.agentId, records);
      return "interrupted" as const;
    };

    for (let i = 0; i < calls.length; i++) {
      if (this.stopRequested || this.interruptRequested) return finishInterrupted(i);
      const call = calls[i];
      if (!call) continue;
      // 06 §1.2/§8：执行时同样按 roles 裁剪；角色不可用的工具按"不存在"处理。
      const callBinding = turnAccessBinding(this.deps.db, this.sessionId, this.agentId, turnId);
      const callProgress = harnessProgress(
        this.deps.db,
        this.sessionId,
        harnessTaskId({ sessionId: this.sessionId, agentId: this.agentId, turnId, ...callBinding }),
      );
      const declared =
        callProgress.exhausted && !admittedBeforeProgressStop && call.name !== "deliver"
          ? undefined
          : tools.get(call.name);
      const tool =
        declared !== undefined && (declared.roles as readonly string[]).includes(agentRole)
          ? isResultPage(call.args)
            ? resultPageTool(declared, this.deps.db)
            : declared
          : undefined;
      // 06 §2.1：targets/replay/effect 只对校验通过的参数求值；非法参数照常写 intent。
      const access = bindToolAccess({
        db: this.deps.db,
        log: this.deps.log,
        workspaceRoot: this.deps.workspaceRoot(this.sessionId),
        sessionId: this.sessionId,
        agentId: this.agentId,
        turnId,
        stepId,
        toolCallId: call.id,
      });
      const parsedArgs = tool?.input.safeParse(call.args);
      let targets: string[] = [];
      let targetError: { code: string; message: string } | undefined;
      let replay: ReplayKind = "unknown";
      if (tool !== undefined && parsedArgs?.success) {
        try {
          runWithToolAccess(access, () =>
            assertToolEffectsAllowed(
              tool.effectIntents?.(parsedArgs.data, {
                workspaceRoot: this.deps.workspaceRoot(this.sessionId),
              }) ?? [],
              this.deps.workspaceRoot(this.sessionId),
            ),
          );
          targets =
            runWithToolAccess(access, () =>
              tool.targets(parsedArgs.data, {
                workspaceId: this.deps.workspaceId(this.sessionId),
                workspaceRoot: this.deps.workspaceRoot(this.sessionId),
                access,
              }),
            ) ?? [];
        } catch (error) {
          const code = (error as { code?: unknown } | null)?.code;
          targetError = {
            code: typeof code === "string" ? toToolErrorCode(code) : "INVALID_ARGUMENT",
            message: error instanceof Error ? error.message : "无法解析工具目标，本次调用未执行",
          };
        }
        try {
          replay =
            typeof tool.replay === "function"
              ? (tool.replay as (args: unknown) => ReplayKind)(parsedArgs.data)
              : tool.replay;
        } catch {
          replay = "unknown";
        }
      }
      const scope = {
        workspaceId: this.deps.workspaceId(this.sessionId),
        workspaceRoot: this.deps.workspaceRoot(this.sessionId),
        sessionId: this.sessionId,
        agentId: this.agentId,
        ...(this.deps.resolveResource
          ? {
              resolveResource: (uri: string) =>
                (this.deps.resolveResource as NonNullable<AgentRuntimeDeps["resolveResource"]>)(
                  this.sessionId,
                  uri,
                ),
            }
          : {}),
      };
      // 发布时审批的工具在执行内自请审批（04 §5.2、08 §6）：等待只响应停止/打断，
      // 等待期间暂停工具超时计时，脚本超时单独计算。
      let stopSignal: AbortSignal | undefined;
      let execTimer: PausableTimeout | undefined;
      const ctx = {
        ...scope,
        access,
        toolTargets: targets,
        signal: AbortSignal.timeout(tool?.timeoutMs ?? 30000),
        toolCallId: call.id,
        turnId,
        stepId,
        role: agentRole,
        reads: this.reads,
        backups: runWithToolAccess(access, () =>
          (this.deps.backups ?? new BackupService(this.deps.db)).bind(scope),
        ),
        leases: this.deps.leases,
        agents: this.deps.agents,
        rawArgs: call.args,
        ...(tool?.approval === "publish"
          ? {
              requestApproval: (req: {
                targets: string[];
                args: unknown;
                effect: ApprovalEffect;
              }) => {
                execTimer?.pause();
                return this.gateApproval({
                  toolCallId: call.id,
                  toolName: call.name,
                  args: req.args,
                  targets: req.targets,
                  effect: req.effect,
                  turnId,
                  stepId,
                  // 发布计划的目标租约由工具在批准后自查；这里只为"发布"动作判定审批
                  leased: true,
                  waitSignal: stopSignal,
                })
                  .then((g) => ({
                    decision: g.decision,
                    ...(g.reason !== undefined ? { reason: g.reason } : {}),
                  }))
                  .finally(() => execTimer?.resume());
              },
            }
          : {}),
      };
      let intentMeta: FileIntentMeta | undefined;
      let metaError: { code: string; message: string } | undefined = targetError;
      let durationMs: number | undefined;
      try {
        if (!targetError && parsedArgs?.success)
          intentMeta = runWithToolAccess(access, () => tool?.intentMeta?.(parsedArgs.data, ctx));
      } catch (err) {
        // 保留原错误码（如越界路径 OUT_OF_WORKSPACE），未知异常按参数问题报告
        const code = (err as { code?: unknown } | null)?.code;
        metaError = {
          code: typeof code === "string" ? toToolErrorCode(code) : "INVALID_ARGUMENT",
          message: err instanceof Error ? err.message : "无法读取执行前文件状态，未执行写入",
        };
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
      try {
        if (call.inputError) {
          result = {
            status: "error",
            error: { code: "INVALID_ARGUMENT", message: call.inputError, retryable: false },
          };
        } else if (metaError) {
          result = {
            status: "error",
            error: { code: metaError.code, message: metaError.message, retryable: false },
          };
        } else if (!tool || !parsedArgs) {
          result = {
            status: "error",
            error: {
              code: "INVALID_ARGUMENT",
              message: `工具 ${call.name} 不存在`,
              retryable: false,
            },
          };
        } else {
          const parsed = parsedArgs;
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
                hint: `本次工具调用未执行。共 ${parsed.error.issues.length} 处校验问题（数组下标从 0 开始）：\n${parsed.error.issues
                  .map((item) => `${item.path.join(".") || "参数根节点"}: ${item.message}`)
                  .join("\n")}`,
                retryable: false,
              },
            };
          } else if (
            hasTaskContractRequirement(this.deps.db, this.sessionId, this.agentId, turnId) &&
            (tool.externalTransport === true ||
              (typeof tool.effect === "function"
                ? (tool.effect as (args: unknown) => string)(parsed.data)
                : tool.effect) === "external")
          ) {
            // Business external transfers have no contract authorization interface
            // in this stage. Ordinary approval/remember is not such authorization.
            // The model provider's existing request transport is not a tool effect.
            result = {
              status: "error",
              error: {
                code: "UNSUPPORTED_FEATURE",
                message: "当前任务契约不支持业务外发授权；普通审批不能允许该操作。",
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
            if (this.host.isShuttingDown && gate.required) return "done";
            // 04 §5.1：审批门放行（已批准、auto 模式或会话自动批准规则）即受信，
            // destructive 调用据此执行；未装配审批执行器时保持 fail-closed。
            // publish 工具的门是占位放行，不得注入（该标记对它表示"重启后已批准恢复"）。
            const approved =
              gate.decision === "approved" &&
              effect === "destructive" &&
              tool.approval !== "publish" &&
              this.deps.approval !== undefined;
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
              execTimer = pausableTimeout(tool.timeoutMs);
              stopSignal = ctrl.signal;
              const signal = AbortSignal.any([ctrl.signal, execTimer.signal]);
              const startedAt = Date.now();
              let activity: ReturnType<NonNullable<typeof tool.activity>> = null;
              try {
                activity = tool.activity?.(parsed.data as never) ?? null;
              } catch {
                activity = null;
              }
              if (activity)
                this.delta(stepId, 0, "workbook_activity", {
                  phase: "start",
                  toolCallId: call.id,
                  ...activity,
                });
              try {
                result = await runWithToolAccess(access, () =>
                  tool.execute(parsed.data, {
                    ...ctx,
                    signal,
                    ...(approved ? { destructiveApproved: true } : {}),
                  }),
                );
                durationMs = Date.now() - startedAt;
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
                  if (this.host.isShuttingDown) return "done";
                  if (resolution.aborted) {
                    // 超时、停止、打断都收口 pending 投影（与审批一致，04 §8.1）：
                    // 之后的用户回答返回幂等结果，不再恢复已结束的工具调用。
                    try {
                      this.deps.question.answer(questionId, null);
                    } catch {
                      // 竞态下可能已由 REST 回答，继续记录本次中止结果即可。
                    }
                    const cancelled =
                      this.stopRequested || this.interruptRequested || ctrl.signal.aborted;
                    result = {
                      status: "error",
                      error: {
                        code: cancelled ? "CANCELLED" : "TIMEOUT",
                        message: cancelled ? this.abortReason : "等待用户回答超时",
                        retryable: false,
                      },
                    };
                  } else {
                    result = {
                      ...result,
                      data: {
                        ...(result.data as Record<string, unknown>),
                        status: "answered",
                        ...(Object.hasOwn(resolution, "answer")
                          ? { answer: resolution.answer }
                          : {}),
                        ...(resolution.rev !== undefined ? { rev: resolution.rev } : {}),
                      },
                    };
                  }
                }
              } catch (err) {
                durationMs = Date.now() - startedAt;
                const cancelled = this.stopRequested || this.interruptRequested;
                const timedOut = err instanceof Error && err.name === "TimeoutError";
                result = {
                  status: "error",
                  error: {
                    code: cancelled
                      ? "CANCELLED"
                      : timedOut
                        ? "TIMEOUT"
                        : err instanceof TurnAccessError
                          ? "INVALID_ARGUMENT"
                          : "INTERNAL",
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
                execTimer?.clear();
                this.callAbort = null;
                if (activity)
                  this.delta(stepId, 0, "workbook_activity", { phase: "end", toolCallId: call.id });
              }
            }
          }
        }
      } catch (err) {
        // 审批/租约等执行器自身出错也必须写出 tool.result（04 §8.1），不能留下缺结果的调用
        result = {
          status: "error",
          error: {
            code: "INTERNAL",
            message: err instanceof Error ? err.message : String(err),
            retryable: false,
          },
        };
      }
      if (
        this.host.isShuttingDown &&
        this.deps.db
          .prepare(
            "SELECT 1 FROM pending_interactions WHERE session_id = ? AND agent_id = ? AND tool_call_id = ? AND status = 'pending'",
          )
          .get(this.sessionId, this.agentId, call.id)
      )
        return "done";
      if (call.name === "workbook_check" && parsedArgs && !parsedArgs.success) {
        const binding = turnAccessBinding(this.deps.db, this.sessionId, this.agentId, turnId);
        const taskId = harnessTaskId({
          sessionId: this.sessionId,
          agentId: this.agentId,
          turnId,
          ...binding,
        });
        log.append(this.sessionId, this.agentId, [
          {
            type: "harness.progress",
            data: {
              taskId,
              kind: "attempt",
              attemptKey: stableHarnessHash({
                kind: "check_schema_invalid",
                verification:
                  call.args && typeof call.args === "object"
                    ? (call.args as Record<string, unknown>).verification
                    : undefined,
                issues: parsedArgs.error.issues.map((issue) => ({
                  code: issue.code,
                  path: issue.path,
                })),
              }),
              progressKey: harnessUsefulProgress(
                harnessState(this.deps.db, this.sessionId, taskId),
              ),
              proofKeys: harnessUsefulProofs(harnessState(this.deps.db, this.sessionId, taskId)),
              nonproductivePreflight: true,
            },
          },
        ]);
      }
      const finalizing = tool?.finalizesTurn?.(call.args) === true;
      const nativeDelivery = call.name === "deliver" || call.name === "present";
      let hostFinalizationConflict = false;
      if (
        finalizing &&
        nativeDelivery &&
        result.status === "error" &&
        result.error?.code === "VERSION_CONFLICT" &&
        result.error.retryable === true
      ) {
        try {
          hostFinalizationConflict = tool?.isHostFinalizationConflict?.(result) === true;
        } catch {
          /* fail closed */
        }
      }
      // The callback authenticates the live result before normalization can clone it.
      // Never accept a serialized marker as retry authority.
      if (
        nativeDelivery &&
        result.data !== null &&
        typeof result.data === "object" &&
        !Array.isArray(result.data)
      ) {
        const data = { ...(result.data as Record<string, unknown>) };
        delete data.__hostFinalizationConflict;
        result = { ...result, data };
      }
      if (hostFinalizationConflict)
        result = {
          ...result,
          data: {
            ...(result.data !== null &&
            typeof result.data === "object" &&
            !Array.isArray(result.data)
              ? (result.data as Record<string, unknown>)
              : {}),
            __hostFinalizationConflict: { version: 1, kind: "state_changed", turnId },
          },
        };
      result = withVocabularyCode(result);
      let finalText: string | undefined;
      if (finalizing && parsedArgs?.success && result.status === "ok") {
        try {
          finalText = tool?.finalReply?.(parsedArgs.data, result);
          if (finalText === undefined) throw new Error("证据终稿没有返回服务端生成的文本");
        } catch (error) {
          result = {
            status: "error",
            error: {
              code: "INTERNAL",
              message: error instanceof Error ? error.message : "生成证据终稿失败",
              retryable: false,
            },
          };
        }
      }
      const stopped = this.stopRequested || this.interruptRequested;
      const finalizationStatus = (result.data as { finalizationStatus?: unknown } | undefined)
        ?.finalizationStatus;
      log.append(this.sessionId, this.agentId, [
        {
          type: "tool.result",
          data: {
            toolCallId: call.id,
            toolName: call.name,
            status: result.status,
            result,
            ...(durationMs !== undefined ? { durationMs } : {}),
          },
        },
        ...(finalText !== undefined && result.status === "ok" && !stopped
          ? [
              {
                type: "model.output",
                data: {
                  stepId,
                  text: finalText,
                  sourceToolCallId: call.id,
                  deliveryStatus: finalizationStatus === "incomplete" ? "incomplete" : "complete",
                },
              },
              { type: "turn.completed", data: { turnId, reason: "stop" } },
            ]
          : finalizing && result.status !== "ok" && !hostFinalizationConflict
            ? [
                {
                  type: "model.output",
                  data: { stepId, withheldText: "", deliveryStatus: "rejected" },
                },
              ]
            : []),
      ]);
      if (this.stopRequested || this.interruptRequested) return finishInterrupted(i + 1);
      if (finalText !== undefined && result.status === "ok") return "done";
      if (
        finalizing &&
        result.status !== "ok" &&
        !hostFinalizationConflict &&
        numericDeliveryState(this.deps.db, this.sessionId, this.agentId, turnId).rejected > 1
      ) {
        this.failNumericDelivery(turnId);
        return "failed";
      }
    }
    return "continue";
  }

  private failNumericDelivery(turnId: string): void {
    if (accessDeliveryRequired(this.deps.db, this.sessionId, this.agentId, turnId)) {
      this.completeAccessIncomplete(
        turnId,
        "本轮证据交付未完成：终稿仍未使用有效工具结果引用。已停止，已发生的文件操作不会自动撤销。",
      );
      return;
    }
    const message =
      "数值证据交付未完成：终稿仍未使用有效工具结果引用。已停止本轮；工作簿改动不会自动撤销。";
    this.deps.log.append(this.sessionId, this.agentId, [
      {
        type: "error.guidance",
        data: {
          kind: "unknown",
          message,
          actions: ["检查已完成的工作簿与工具结果", "继续核验后再交付"],
          retryable: false,
        },
      },
      {
        type: "turn.failed",
        data: { turnId, error: { kind: "unknown", message, retryable: false } },
      },
    ]);
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
          retryable: error.retryable,
        },
      },
      // 轮失败时最近一步仍缺结果的工具调用补 not_executed（04 §8.1），历史保持可发送
      ...missingResultRecords(
        this.deps.db,
        this.sessionId,
        this.agentId,
        "本轮已失败，该工具未执行",
      ),
      ...(accessDeliveryRequired(this.deps.db, this.sessionId, this.agentId, turnId)
        ? [
            {
              type: "model.output",
              data: {
                stepId: newId("stp"),
                text:
                  "本轮执行未完成。\n\n" +
                  renderAccessFacts(
                    turnAccessFacts(this.deps.db, {
                      sessionId: this.sessionId,
                      agentId: this.agentId,
                      turnId,
                    }),
                  ),
                deliveryStatus: "incomplete",
              },
            },
          ]
        : []),
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

/** 可暂停的超时（04 §5.2）：等待审批期间不计入工具执行超时。 */
interface PausableTimeout {
  signal: AbortSignal;
  pause(): void;
  resume(): void;
  clear(): void;
}

function pausableTimeout(ms: number): PausableTimeout {
  const ctrl = new AbortController();
  let remaining = ms;
  let startedAt = Date.now();
  const fire = () => ctrl.abort(new DOMException(`超过 ${ms}ms`, "TimeoutError"));
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(fire, ms);
  return {
    signal: ctrl.signal,
    pause() {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
      remaining -= Date.now() - startedAt;
    },
    resume() {
      if (timer !== undefined || ctrl.signal.aborted) return;
      startedAt = Date.now();
      timer = setTimeout(fire, Math.max(0, remaining));
    },
    clear() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

/** 写 tool.result 前把错误码收敛到 06 §9 词表（日志 schema 强制校验）。 */
function withVocabularyCode(result: ToolResult): ToolResult {
  if (!result.error) return result;
  const code = toToolErrorCode(result.error.code);
  return code === result.error.code ? result : { ...result, error: { ...result.error, code } };
}

/**
 * 最近一条 model.output 中既没有 tool.result、也不在 `skip` 里的工具调用，
 * 合成 not_executed 结果记录（04 §8.1：每个调用都要有结果，否则历史不可再发送）。
 */
function missingResultRecords(
  db: DatabaseSync,
  sessionId: string,
  agentId: string,
  message: string,
  skip: ReadonlySet<string> = new Set(),
): { type: string; data: unknown }[] {
  const row = db
    .prepare(
      "SELECT seq, data FROM session_log WHERE session_id = ? AND agent_id = ? AND type = 'model.output' ORDER BY seq DESC LIMIT 1",
    )
    .get(sessionId, agentId) as { seq: number; data: string } | undefined;
  if (!row) return [];
  const calls = (JSON.parse(row.data) as { toolCalls?: ToolCall[] }).toolCalls ?? [];
  if (calls.length === 0) return [];
  const answered = new Set(
    (
      db
        .prepare(
          "SELECT json_extract(data, '$.toolCallId') AS id FROM session_log WHERE session_id = ? AND agent_id = ? AND type = 'tool.result' AND seq > ?",
        )
        .all(sessionId, agentId, row.seq) as { id: string | null }[]
    ).map((r) => r.id),
  );
  return calls
    .filter((c) => !answered.has(c.id) && !skip.has(c.id))
    .map((c) => ({
      type: "tool.result",
      data: {
        toolCallId: c.id,
        toolName: c.name,
        status: "not_executed",
        result: {
          status: "not_executed",
          error: { code: "CANCELLED", message, retryable: false },
        },
      },
    }));
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
  // queued 子代理（05 §8 闸门排队）没有 open intents 也没有进行中的轮：
  // 只恢复为 interrupted 等待 resume，不写 turn.interrupted、不合成 tool.result。
  const queuedOnly = deps.db
    .prepare("SELECT id, session_id FROM agents WHERE status = 'queued'")
    .all() as { id: string; session_id: string }[];
  for (const agent of queuedOnly) {
    deps.log.append(agent.session_id, agent.id, [
      { type: "agent.status", data: { status: "interrupted" } },
    ]);
  }
  const running = deps.db
    .prepare("SELECT id, session_id FROM agents WHERE status IN ('running', 'waiting')")
    .all() as { id: string; session_id: string }[];
  for (const agent of running) {
    const intents = deps.db
      .prepare(
        "SELECT tool_call_id, tool_name, created_seq FROM open_intents WHERE session_id = ? AND agent_id = ? ORDER BY created_seq",
      )
      .all(agent.session_id, agent.id) as {
      tool_call_id: string;
      tool_name: string;
      created_seq: number;
    }[];
    const records: { type: string; data: unknown }[] = intents.map((it) => {
      const declared = deps.tools?.get(it.tool_name);
      const originalIntent = deps.db
        .prepare(
          "SELECT data FROM session_log WHERE session_id = ? AND agent_id = ? AND type = 'tool.intent' AND json_extract(data, '$.toolCallId') = ? ORDER BY seq DESC LIMIT 1",
        )
        .get(agent.session_id, agent.id, it.tool_call_id) as { data: string } | undefined;
      const originalArgs = originalIntent
        ? (JSON.parse(originalIntent.data) as { args?: unknown }).args
        : undefined;
      const tool =
        declared && isResultPage(originalArgs) ? resultPageTool(declared, deps.db) : declared;
      let recovered: ToolResult | undefined;
      let recoveryTurnId: string | undefined;
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
          const intent = originalIntent
            ? (JSON.parse(originalIntent.data) as { stepId?: string })
            : undefined;
          const step = intent?.stepId
            ? (deps.db
                .prepare(
                  "SELECT json_extract(data,'$.turnId') AS turnId FROM session_log WHERE session_id=? AND agent_id=? AND type='step.started' AND json_extract(data,'$.stepId')=? ORDER BY seq DESC LIMIT 1",
                )
                .get(agent.session_id, agent.id, intent.stepId) as { turnId: string } | undefined)
            : undefined;
          recoveryTurnId = step?.turnId;
          if (!step) {
            const last = deps.db
              .prepare(
                "SELECT json_extract(data,'$.turnId') AS turnId FROM session_log WHERE session_id=? AND agent_id=? AND type='turn.started' ORDER BY seq DESC LIMIT 1",
              )
              .get(agent.session_id, agent.id) as { turnId: string } | undefined;
            if (last && accessDeliveryRequired(deps.db, agent.session_id, agent.id, last.turnId))
              throw new Error("受限恢复缺少原始步骤归属");
          }
          let workspaceRoot: string | undefined;
          try {
            workspaceRoot = (
              deps.db
                .prepare(
                  "SELECT w.path FROM sessions s JOIN workspaces w ON w.id=s.workspace_id WHERE s.id=?",
                )
                .get(agent.session_id) as { path: string } | undefined
            )?.path;
          } catch {}
          const access =
            step && workspaceRoot
              ? bindToolAccess({
                  db: deps.db,
                  log: deps.log,
                  workspaceRoot,
                  sessionId: agent.session_id,
                  agentId: agent.id,
                  turnId: step.turnId,
                  toolCallId: it.tool_call_id,
                })
              : undefined;
          if (
            step &&
            !access &&
            accessDeliveryRequired(deps.db, agent.session_id, agent.id, step.turnId)
          )
            throw new Error("无法恢复受限任务的工作区");
          const invoke = () =>
            tool.recover!({
              sessionId: agent.session_id,
              agentId: agent.id,
              toolCallId: it.tool_call_id,
              args,
              intentMeta,
              intentSeq: it.created_seq,
              workspaceRoot,
              turnId: step?.turnId,
              access,
            });
          recovered = access ? runWithToolAccess(access, invoke) : invoke();
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
      // The recovery wrapper may not run when current access binding fails. An unsafe
      // invocation with unknown outcome remains a task obligation, never basic chat.
      let effect:
        | ReturnType<Extract<ToolDefinition["effect"], (...args: never[]) => unknown>>
        | ToolDefinition["effect"]
        | undefined;
      try {
        effect =
          tool &&
          (typeof tool.effect === "function" ? tool.effect(originalArgs as never) : tool.effect);
      } catch {
        effect = "write";
      }
      const observedWrite =
        effect !== "read" &&
        ([
          "workbook_edit",
          "workbook_analyze",
          "workbook_export",
          "run_script",
          "files",
          "write",
          "edit",
        ].includes(it.tool_name) ||
          it.tool_name.startsWith("mcp__"));
      const hasReceipt = deps.db
        .prepare(
          "SELECT 1 FROM session_log WHERE session_id=? AND agent_id=? AND seq>? AND type='harness.event' AND json_extract(data,'$.kind')='artifact' AND json_extract(data,'$.artifact.toolCallId')=? LIMIT 1",
        )
        .get(agent.session_id, agent.id, it.created_seq, it.tool_call_id);
      if (observedWrite && result.status !== "not_executed" && !hasReceipt) {
        const turnId =
          recoveryTurnId ??
          (
            deps.db
              .prepare(
                "SELECT json_extract(data,'$.turnId') AS turnId FROM session_log WHERE session_id=? AND agent_id=? AND type='turn.started' ORDER BY seq DESC LIMIT 1",
              )
              .get(agent.session_id, agent.id) as { turnId: string } | undefined
          )?.turnId ??
          "legacy";
        const origin = turnAccessBinding(deps.db, agent.session_id, agent.id, turnId);
        const taskId = harnessTaskId({
          sessionId: agent.session_id,
          agentId: agent.id,
          turnId,
          ...origin,
        });
        recordsNoopRecoveryGuard(
          deps.log,
          agent.session_id,
          agent.id,
          taskId,
          it.tool_call_id,
          it.tool_name,
        );
      }
      return {
        type: "tool.result",
        data: {
          toolCallId: it.tool_call_id,
          toolName: it.tool_name,
          status: result.status,
          result: withVocabularyCode(result),
        },
      };
    });
    // model.output 之后、后续调用写 tool.intent 之前被杀：这些调用既无 intent 也无
    // result，同样补 not_executed（04 §8.2"已流出的工具调用标记为未执行"）。
    records.push(
      ...missingResultRecords(
        deps.db,
        agent.session_id,
        agent.id,
        "进程中断，该工具未执行",
        new Set(intents.map((it) => it.tool_call_id)),
      ),
    );
    const turn = deps.db
      .prepare(
        "SELECT data FROM session_log WHERE session_id = ? AND agent_id = ? AND type = 'turn.started' ORDER BY seq DESC LIMIT 1",
      )
      .get(agent.session_id, agent.id) as { data: string } | undefined;
    if (turn) {
      const turnId = (JSON.parse(turn.data) as { turnId?: string }).turnId ?? "";
      records.push({ type: "turn.interrupted", data: { turnId, reason: "restart" } });
    } else {
      records.push({ type: "agent.status", data: { status: "interrupted" } });
    }
    if (records.length > 0) deps.log.append(agent.session_id, agent.id, records);
  }
  return running.length + queuedOnly.length;
}

/** Metadata-only uncertainty record. No path access, checkpoint, rollback or replay. */
function recordsNoopRecoveryGuard(
  log: SessionLog,
  sessionId: string,
  agentId: string,
  taskId: string,
  toolCallId: string,
  toolName: string,
): void {
  log.append(sessionId, agentId, [
    {
      type: "harness.event",
      data: {
        kind: "artifact",
        artifact: {
          id:
            "hartifact_recovery_" + stableHarnessHash({ sessionId, taskId, toolCallId, toolName }),
          taskId,
          toolCallId,
          path: "unresolved/" + toolName,
          effect: "external",
          execution: "uncertain",
          persistence: "unknown",
          footprint: ["*"],
          validation: "unverified",
          bindings: [],
          dependencyGaps: ["RECOVERY_IDENTITY_OR_ACCESS_UNAVAILABLE"],
        },
      },
    },
  ]);
}
