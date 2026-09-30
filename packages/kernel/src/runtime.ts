// Agent actor（04 §3 子集，M1）：邮箱串行；Preparing→Calling→Executing→循环；
// Retrying（网络/429/5xx/流中断，指数退避最多 5 次，尊重 retryAfterMs，写
// retry.scheduled；流中断写 attempt.discarded）；不可重试写 error.guidance +
// turn.failed；最大步数到顶做一次无工具总结调用。每个工具调用先写 tool.intent
// 再执行再写 tool.result。delta 经总线瞬时推送不入库。
// M1 消息策略只实现 queue（04 §4.1）：运行中到达的消息排队，轮结束后各自开始新一轮。

import type { DatabaseSync } from "node:sqlite";
import { newId } from "@excelmanus/core";
import type {
  ClassifiedError,
  ContextItem,
  DeltaKind,
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
import type { ToolDefinition } from "./tools.ts";

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
  maxSteps?: number;
  /** 最多重试次数（04 §9）。 */
  maxRetries?: number;
  /** 无 Retry-After 时的指数退避基数（测试可调小）。 */
  retryBaseMs?: number;
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

  /** 派发受理后调用：agent 空闲则开始新一轮，运行中则排队（M1 只实现 queue）。 */
  enqueue(sessionId: string, agentId: string, dispatchId: string): void {
    this.actor(sessionId, agentId).enqueue(dispatchId);
  }

  /** 停止：中止当前模型请求/工具，返回是否有运行中的轮。 */
  stop(sessionId: string, agentId: string): boolean {
    return this.actors.get(`${sessionId}/${agentId}`)?.requestStop() ?? false;
  }

  isRunning(sessionId: string, agentId: string): boolean {
    return this.actors.get(`${sessionId}/${agentId}`)?.running ?? false;
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

type StepOutcome = "continue" | "done" | "failed" | "interrupted";

class AgentActor {
  private readonly queue: string[] = [];
  private _running = false;
  private stopRequested = false;
  private callAbort: AbortController | null = null;
  private currentTurnId: string | null = null;
  private readonly deps: AgentRuntimeDeps;
  private readonly sessionId: string;
  private readonly agentId: string;

  constructor(deps: AgentRuntimeDeps, sessionId: string, agentId: string) {
    this.deps = deps;
    this.sessionId = sessionId;
    this.agentId = agentId;
  }

  get running(): boolean {
    return this._running;
  }

  enqueue(dispatchId: string): void {
    this.queue.push(dispatchId);
    void this.pump();
  }

  requestStop(): boolean {
    if (!this._running) return false;
    this.stopRequested = true;
    this.callAbort?.abort();
    return true;
  }

  private async pump(): Promise<void> {
    if (this._running) return;
    const dispatchId = this.queue.shift();
    if (dispatchId === undefined) return;
    this._running = true;
    this.stopRequested = false;
    try {
      await this.runTurn(dispatchId);
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

  private async runTurn(dispatchId: string): Promise<void> {
    const { log } = this.deps;
    const turnId = newId("trn");
    this.currentTurnId = turnId;
    log.append(this.sessionId, this.agentId, [
      { type: "dispatch.updated", data: { dispatchId, status: "applied" } },
      { type: "turn.started", data: { turnId } },
    ]);

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

    const maxSteps = this.deps.maxSteps ?? 200;
    let step = 0;
    for (;;) {
      if (this.stopRequested) {
        log.append(this.sessionId, this.agentId, [{ type: "turn.interrupted", data: { turnId } }]);
        return;
      }
      step += 1;
      const overLimit = step > maxSteps;
      const outcome = await this.runStep(turnId, step, resolved, agent, overLimit);
      if (outcome === "continue") continue;
      return;
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

    for (;;) {
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
            ...(usage !== undefined
              ? [
                  {
                    type: "usage.updated",
                    data: { turnId, usage },
                  },
                ]
              : []),
          ]);
          return "done";
        }
        return this.executeCalls(turnId, stepId, toolCalls);
      }

      // 错误路径
      const stopped = this.stopRequested || classified.kind === "aborted";
      if (stopped) {
        if (sawContent) {
          log.append(topic, this.agentId, [{ type: "attempt.discarded", data: { stepId } }]);
        }
        log.append(topic, this.agentId, [{ type: "turn.interrupted", data: { turnId } }]);
        return "interrupted";
      }
      // context_overflow 在 M1 没有压缩可实现，直接失败并给出指引
      const retryable = classified.retryable && classified.kind !== "context_overflow";
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
        continue;
      }
      this.failTurn(turnId, classified);
      return "failed";
    }
  }

  /** Executing：顺序执行本步工具调用（04 §3；M1 顺序，只读工具可并行属 P1 优化）。 */
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
      if (this.stopRequested) return finishInterrupted(i);
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
          },
        },
      ]);

      let result: ToolResult;
      if (!tool) {
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
          const ctrl = new AbortController();
          this.callAbort = ctrl;
          const signal = AbortSignal.any([ctrl.signal, AbortSignal.timeout(tool.timeoutMs)]);
          try {
            result = await tool.execute(parsed.data, {
              workspaceId: this.deps.workspaceId(this.sessionId),
              workspaceRoot: this.deps.workspaceRoot(this.sessionId),
              signal,
              sessionId: this.sessionId,
              agentId: this.agentId,
              toolCallId: call.id,
            });
          } catch (err) {
            const cancelled = this.stopRequested;
            const timedOut = err instanceof Error && err.name === "TimeoutError";
            result = {
              status: "error",
              error: {
                code: cancelled ? "CANCELLED" : timedOut ? "TIMEOUT" : "INTERNAL",
                message: cancelled
                  ? "已被用户停止"
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
      log.append(this.sessionId, this.agentId, [
        {
          type: "tool.result",
          data: { toolCallId: call.id, toolName: call.name, status: result.status, result },
        },
      ]);
      if (this.stopRequested) return finishInterrupted(i + 1);
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
 * 启动恢复最小版（04 §8.2）：running 代理的 open_intents 写合成 tool.result
 * （M1 全是只读工具 → 一律 not_executed），状态设 interrupted。
 */
export function recoverInterruptedAgents(deps: { db: DatabaseSync; log: SessionLog }): number {
  const running = deps.db
    .prepare("SELECT id, session_id FROM agents WHERE status = 'running'")
    .all() as { id: string; session_id: string }[];
  for (const agent of running) {
    const intents = deps.db
      .prepare(
        "SELECT tool_call_id, tool_name FROM open_intents WHERE session_id = ? AND agent_id = ? ORDER BY created_seq",
      )
      .all(agent.session_id, agent.id) as { tool_call_id: string; tool_name: string }[];
    const records: { type: string; data: unknown }[] = intents.map((it) => ({
      type: "tool.result",
      data: {
        toolCallId: it.tool_call_id,
        toolName: it.tool_name,
        status: "not_executed",
        result: {
          status: "not_executed",
          error: {
            code: "CANCELLED",
            message: "进程中断，该工具未执行",
            retryable: false,
          },
        },
      },
    }));
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
