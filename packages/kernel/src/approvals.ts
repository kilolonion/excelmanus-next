import type { DatabaseSync } from "node:sqlite";
import { newId } from "@excelmanus/core";
import type {
  ApprovalDecision,
  PermissionMode,
  ApprovalEffect as ProtocolApprovalEffect,
} from "@excelmanus/protocol";

export type ApprovalEffect = ProtocolApprovalEffect;

import type { SessionLog } from "./session-log.ts";

export interface ApprovalSpec {
  toolCallId: string;
  toolName: string;
  args: unknown;
  targets: string[];
  effect: ApprovalEffect;
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

export interface ApprovalResolution {
  decision: ApprovalDecision;
  reason?: string;
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

/** 数据库中的会话级自动批准规则匹配。 */
export function isAutoApproved(
  db: DatabaseSync,
  sessionId: string,
  toolName: string,
  targets: string[],
): boolean {
  const rows = db
    .prepare("SELECT tool_name, path_pattern FROM auto_approve_rules WHERE session_id = ?")
    .all(sessionId) as { tool_name: string; path_pattern: string }[];
  return rows.some(
    (row) =>
      row.tool_name === toolName &&
      (targets.length === 0 || targets.some((target) => globMatches(row.path_pattern, target))),
  );
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
          spec: { ...spec, approvalId: id },
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
        resolve({ decision, ...(reason !== undefined ? { reason } : {}) });
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
          resolve({ decision: "denied", reason: "代理已停止" });
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
