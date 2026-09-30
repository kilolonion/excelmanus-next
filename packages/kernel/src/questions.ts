import type { DatabaseSync } from "node:sqlite";
import { newId } from "@excelmanus/core";
import type { SessionLog } from "./session-log.ts";

export interface QuestionSpec {
  questionType: "choice" | "text" | "range_confirm" | "range_pick" | "change_confirm";
  spec: Record<string, unknown>;
  toolCallId?: string;
  turnId?: string;
  stepId?: string;
  timeoutSeconds?: number;
}

export interface QuestionRow {
  id: string;
  session_id: string;
  agent_id: string;
  tool_call_id: string | null;
  spec: string;
  status: "pending" | "approved";
  decision: "approved" | null;
  reason: string | null;
}

export interface QuestionResolution {
  answer?: unknown;
  rev?: number;
  aborted?: boolean;
}

/** 持久化问题协调器；waiter 只保存当前进程里的 actor continuation。 */
export class QuestionCoordinator {
  private readonly waiters = new Map<string, Array<(value: QuestionResolution) => void>>();
  private readonly db: DatabaseSync;
  private readonly log: SessionLog;

  constructor(db: DatabaseSync, log: SessionLog) {
    this.db = db;
    this.log = log;
  }

  get(id: string): QuestionRow | undefined {
    return this.db
      .prepare("SELECT * FROM pending_interactions WHERE id = ? AND kind = 'question'")
      .get(id) as QuestionRow | undefined;
  }

  pendingForSession(sessionId: string): QuestionRow[] {
    return this.db
      .prepare(
        "SELECT * FROM pending_interactions WHERE session_id = ? AND kind = 'question' AND status = 'pending' ORDER BY created_at",
      )
      .all(sessionId) as unknown as QuestionRow[];
  }

  request(sessionId: string, agentId: string, spec: QuestionSpec): QuestionRow {
    const id = newId("qst");
    this.log.append(sessionId, agentId, [
      {
        type: "question.asked",
        data: {
          questionId: id,
          questionType: spec.questionType,
          spec: {
            ...spec.spec,
            _runtime: {
              ...(spec.toolCallId ? { toolCallId: spec.toolCallId } : {}),
              ...(spec.turnId ? { turnId: spec.turnId } : {}),
              ...(spec.stepId ? { stepId: spec.stepId } : {}),
              ...(spec.timeoutSeconds ? { timeoutSeconds: spec.timeoutSeconds } : {}),
            },
          },
        },
      },
    ]);
    const row = this.get(id);
    if (!row) throw new Error("问题记录写入失败");
    return row;
  }

  answer(id: string, answer: unknown, rev?: number): { row: QuestionRow; idempotent: boolean } {
    const row = this.get(id);
    if (!row) throw new Error("问题不存在");
    if (row.status !== "pending") return { row, idempotent: true };
    this.log.append(row.session_id, row.agent_id, [
      {
        type: "question.answered",
        data: { questionId: id, answer, ...(rev !== undefined ? { rev } : {}) },
      },
    ]);
    const updated = this.get(id) ?? row;
    const waiters = this.waiters.get(id);
    if (waiters) {
      this.waiters.delete(id);
      for (const resolve of waiters) resolve({ answer, ...(rev !== undefined ? { rev } : {}) });
    }
    return { row: updated, idempotent: false };
  }

  wait(id: string, signal?: AbortSignal): Promise<QuestionResolution> {
    const row = this.get(id);
    if (!row) return Promise.reject(new Error("问题不存在"));
    if (row.status !== "pending") return Promise.resolve(this.resolutionFromRow(row));
    return new Promise((resolve) => {
      const list = this.waiters.get(id) ?? [];
      list.push(resolve);
      this.waiters.set(id, list);
      if (signal) {
        const abort = () => {
          signal.removeEventListener("abort", abort);
          const remaining = (this.waiters.get(id) ?? []).filter((r) => r !== resolve);
          if (remaining.length > 0) this.waiters.set(id, remaining);
          else this.waiters.delete(id);
          resolve({ aborted: true });
        };
        signal.addEventListener("abort", abort, { once: true });
      }
    });
  }

  hasWaiter(id: string): boolean {
    return (this.waiters.get(id)?.length ?? 0) > 0;
  }

  private resolutionFromRow(row: QuestionRow): QuestionResolution {
    if (!row.reason) return {};
    try {
      const value = JSON.parse(row.reason) as { answer?: unknown; rev?: unknown };
      return {
        ...(Object.hasOwn(value, "answer") ? { answer: value.answer } : {}),
        ...(typeof value.rev === "number" ? { rev: value.rev } : {}),
      };
    } catch {
      return { answer: row.reason };
    }
  }
}
