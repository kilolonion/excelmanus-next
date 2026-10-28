import type { DatabaseSync } from "node:sqlite";
import { newId } from "@excelmanus/core";
import type {
  ApprovalDecision,
  PermissionMode,
  ApprovalEffect as ProtocolApprovalEffect,
} from "@excelmanus/protocol";

export type ApprovalEffect = ProtocolApprovalEffect;

import { knownApprovalEffects } from "./denial-fence.ts";
import type { SessionLog } from "./session-log.ts";
import { bindToolAccess, captureApprovalEffects, runWithToolAccess } from "./tool-access.ts";
import type { EffectIntent } from "./tools.ts";
import { turnAccessBinding } from "./turn-access.ts";

export interface ApprovalSpec {
  toolCallId: string;
  toolName: string;
  args: unknown;
  targets: string[];
  effect: ApprovalEffect;
  /** Host-only context and pure tool effect mapping, not model-supplied authority. */
  workspaceRoot?: string;
  effects?: EffectIntent[];
  /** 运行时恢复所需的 step 上下文。 */
  turnId?: string;
  stepId?: string;
  step?: number;
}

export interface ApprovalRow {
  id: string;
  session_id: string;
  agent_id: string;
  tool_call_id: string | null;
  spec: string;
  status: "pending" | "approved" | "denied";
  decision: ApprovalDecision | null;
  reason: string | null;
}

export type ApprovalDecisionCause = "user" | "cancelled" | "timeout" | "system";
export interface ApprovalResolution {
  decision: ApprovalDecision;
  reason?: string;
  cause?: ApprovalDecisionCause;
}

/** 权限表（04 §5.1）。interactive 是代理向用户提问本身，不再套审批。 */
export function needsApproval(
  mode: PermissionMode | string,
  effect: ApprovalEffect | string,
): boolean {
  if (
    mode === "auto" ||
    effect === "read" ||
    effect === "state" ||
    effect === "interactive" ||
    effect === "agent"
  ) {
    return false;
  }
  if (mode === "confirm")
    return effect === "write" || effect === "destructive" || effect === "external";
  return effect === "destructive" || effect === "external";
}

function globMatches(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

/** 被记住的 effect 是否覆盖本次 effect：同级，或记住删除时覆盖写入；external 只认同级。 */
function effectCovered(remembered: string | undefined, requested: string): boolean {
  if (remembered === requested) return true;
  return remembered === "destructive" && requested === "write";
}

/**
 * 会话级自动批准（04 §5.1"工具名 + 目标路径模式"）：本次每个目标都必须被同一工具、
 * effect 不低于本次的规则覆盖；没有目标的调用只认 "*" 规则。规则的 effect 取自
 * 生成它的审批记录（规则 id = `<审批 id>:rule[:n]`）。
 */
export function isAutoApproved(
  db: DatabaseSync,
  sessionId: string,
  toolName: string,
  targets: string[],
  effect: ApprovalEffect | string,
): boolean {
  const rows = (
    db
      .prepare(
        "SELECT id, path_pattern FROM auto_approve_rules WHERE session_id = ? AND tool_name = ?",
      )
      .all(sessionId, toolName) as { id: string; path_pattern: string }[]
  ).filter((row) => {
    const approvalId = row.id.slice(0, Math.max(0, row.id.indexOf(":rule")));
    const spec = db.prepare("SELECT spec FROM pending_interactions WHERE id = ?").get(approvalId) as
      | { spec: string }
      | undefined;
    if (!spec) return false;
    const remembered = (JSON.parse(spec.spec) as { effect?: unknown }).effect;
    return effectCovered(typeof remembered === "string" ? remembered : undefined, effect);
  });
  if (rows.length === 0) return false;
  if (targets.length === 0) return rows.some((row) => row.path_pattern === "*");
  return targets.every((target) => rows.some((row) => globMatches(row.path_pattern, target)));
}

/** 审批持久化协调器：日志是事实源，waiter 只保存进程内的暂停 continuation。 */
export class ApprovalCoordinator {
  private readonly waiters = new Map<string, Array<(value: ApprovalResolution) => void>>();
  private readonly db: DatabaseSync;
  private readonly log: SessionLog;

  constructor(db: DatabaseSync, log: SessionLog) {
    this.db = db;
    this.log = log;
  }

  get(id: string): ApprovalRow | undefined {
    return this.db.prepare("SELECT * FROM pending_interactions WHERE id = ?").get(id) as
      | ApprovalRow
      | undefined;
  }

  pendingForSession(sessionId: string): ApprovalRow[] {
    return this.db
      .prepare(
        "SELECT * FROM pending_interactions WHERE session_id = ? AND kind = 'approval' ORDER BY created_at",
      )
      .all(sessionId) as unknown as ApprovalRow[];
  }

  request(sessionId: string, agentId: string, spec: ApprovalSpec): ApprovalRow {
    const id = newId("apr");
    const binding = spec.turnId
      ? turnAccessBinding(this.db, sessionId, agentId, spec.turnId)
      : undefined;
    // Rebuild every effect from host declarations. Ignore any accidental identity fields.
    const effects = (
      spec.effects ?? knownApprovalEffects(spec.toolName, spec.args, spec.targets, spec.effect)
    ).map(({ kind, path, to }) => ({ kind, path, ...(to !== undefined ? { to } : {}) }));
    const captureKnown =
      spec.effects !== undefined || ["files", "write", "edit"].includes(spec.toolName);
    const workspaceRoot = spec.workspaceRoot;
    const captured =
      captureKnown && workspaceRoot && spec.turnId
        ? runWithToolAccess(
            bindToolAccess({
              db: this.db,
              log: this.log,
              workspaceRoot,
              sessionId,
              agentId,
              turnId: spec.turnId,
              toolCallId: spec.toolCallId,
            }),
            () => captureApprovalEffects(effects, workspaceRoot),
          )
        : effects;
    const persisted = {
      ...spec,
      effects: captured,
      originAgentId: binding?.originAgentId ?? agentId,
      ...((binding?.originTurnId ?? spec.turnId)
        ? { originTurnId: binding?.originTurnId ?? spec.turnId }
        : {}),
    };
    this.log.append(sessionId, agentId, [
      {
        type: "approval.requested",
        data: {
          approvalId: id,
          toolCallId: spec.toolCallId,
          toolName: spec.toolName,
          args: spec.args,
          targets: spec.targets,
          effect: spec.effect,
          spec: { ...persisted, approvalId: id },
        },
      },
    ]);
    const row = this.get(id);
    if (!row) throw new Error("审批记录写入失败");
    return row;
  }

  decide(
    id: string,
    decision: ApprovalDecision,
    reason?: string,
    remember = false,
    cause: ApprovalDecisionCause = "user",
  ): { row: ApprovalRow; idempotent: boolean } {
    const row = this.get(id);
    if (!row) throw new Error("审批不存在");
    if (row.status !== "pending") return { row, idempotent: true };
    this.log.append(row.session_id, row.agent_id, [
      {
        type: "approval.decided",
        data: {
          approvalId: id,
          decision,
          cause,
          ...(reason !== undefined ? { reason } : {}),
          ...(remember ? { remember: true } : {}),
        },
      },
    ]);
    const updated = this.get(id) ?? row;
    const waiters = this.waiters.get(id);
    if (waiters) {
      this.waiters.delete(id);
      for (const resolve of waiters)
        resolve({ decision, cause, ...(reason !== undefined ? { reason } : {}) });
    }
    return { row: updated, idempotent: false };
  }

  wait(id: string, signal?: AbortSignal): Promise<ApprovalResolution> {
    const row = this.get(id);
    if (!row) return Promise.reject(new Error("审批不存在"));
    if (row.status !== "pending" && row.decision) {
      return Promise.resolve({
        decision: row.decision,
        ...(row.reason ? { reason: row.reason } : {}),
      });
    }
    return new Promise((resolve) => {
      const list = this.waiters.get(id) ?? [];
      list.push(resolve);
      this.waiters.set(id, list);
      if (signal) {
        const abort = () => {
          signal.removeEventListener("abort", abort);
          const current = this.waiters.get(id) ?? [];
          this.waiters.set(
            id,
            current.filter((r) => r !== resolve),
          );
          resolve({
            decision: "denied",
            cause: signal.reason?.name === "TimeoutError" ? "timeout" : "cancelled",
            reason: "代理已停止",
          });
        };
        signal.addEventListener("abort", abort, { once: true });
      }
    });
  }

  hasWaiter(id: string): boolean {
    return (this.waiters.get(id)?.length ?? 0) > 0;
  }
}

export function approvalDto(row: ApprovalRow) {
  const spec = JSON.parse(row.spec) as { toolName?: string };
  return {
    id: row.id,
    sessionId: row.session_id,
    agentId: row.agent_id,
    toolCallId: row.tool_call_id ?? "",
    toolName: spec.toolName ?? "",
    status: row.status,
    ...(row.decision ? { decision: row.decision } : {}),
    reason: row.reason,
  };
}
