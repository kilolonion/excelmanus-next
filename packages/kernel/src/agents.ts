import type { DatabaseSync } from "node:sqlite";
import { newId } from "@excelmanus/core";
import type { AgentRole, DispatchMode, ToolResult } from "@excelmanus/protocol";
import type { LeaseService } from "./leases.ts";
import type { SessionLog } from "./session-log.ts";
import type { AgentCoordinator } from "./tools.ts";

type Enqueue = (sessionId: string, agentId: string, dispatchId: string, mode: DispatchMode) => void;
type InboxEnqueue = (sessionId: string, agentId: string) => void;
type StopAgent = (sessionId: string, agentId: string) => boolean;

const ok = (data: unknown): ToolResult => ({ status: "ok", data });
const err = (code: string, message: string): { error: ToolResult } => ({
  error: { status: "error", error: { code, message, retryable: false } },
});

const roleRank: Record<string, number> = { reader: 0, worker: 1, lead: 2, main: 3 };
const isDescendant = (db: DatabaseSync, parent: string, candidate: string): boolean => {
  let current: string | null = candidate;
  for (let i = 0; i < 8 && current; i += 1) {
    if (current === parent) return true;
    const row = db.prepare("SELECT parent_id FROM agents WHERE id = ?").get(current) as
      | { parent_id: string | null }
      | undefined;
    current = row?.parent_id ?? null;
  }
  return false;
};

export class TeamCoordinator implements AgentCoordinator {
  private enqueue: Enqueue | undefined;
  private enqueueInbox: InboxEnqueue | undefined;
  private stopAgent: StopAgent | undefined;

  private readonly db: DatabaseSync;
  private readonly log: SessionLog;
  private readonly leases?: LeaseService;
  constructor(db: DatabaseSync, log: SessionLog, leases?: LeaseService) {
    this.db = db;
    this.log = log;
    this.leases = leases;
  }

  bindRuntime(enqueue: Enqueue, enqueueInbox: InboxEnqueue, stopAgent?: StopAgent): void {
    this.enqueue = enqueue;
    this.enqueueInbox = enqueueInbox;
    this.stopAgent = stopAgent;
  }

  spawn(args: {
    sessionId: string;
    parentAgentId: string;
    name: string;
    role: AgentRole;
    task: string;
    files?: string[];
    modelProfileId?: string;
    budget?: Record<string, unknown>;
  }): { agentId: string; name: string; status: string } | { error: ToolResult } {
    const parent = this.db
      .prepare(
        "SELECT id, role, parent_id, model_profile_id FROM agents WHERE session_id = ? AND id = ?",
      )
      .get(args.sessionId, args.parentAgentId) as
      | { id: string; role: string; parent_id: string | null; model_profile_id: string | null }
      | undefined;
    if (!parent) return err("NOT_FOUND", "派生者不存在");
    if (parent.role !== "main" && parent.role !== "lead") {
      return err("INVALID_ARGUMENT", "只有 main 或 lead 可以派生子代理");
    }
    if ((roleRank[args.role] ?? -1) > (roleRank[parent.role] ?? -1) || args.role === "main") {
      return err("INVALID_ARGUMENT", "子代理角色权限不能高于派生者");
    }
    let depth = 0;
    let p: string | null = parent.parent_id;
    while (p) {
      depth += 1;
      const row = this.db.prepare("SELECT parent_id FROM agents WHERE id = ?").get(p) as
        | { parent_id: string | null }
        | undefined;
      p = row?.parent_id ?? null;
    }
    if (depth >= 2) return err("LIMIT_EXCEEDED", "派生深度最多为 2");
    const count = (
      this.db
        .prepare("SELECT COUNT(*) AS c FROM agents WHERE session_id = ?")
        .get(args.sessionId) as {
        c: number;
      }
    ).c;
    if (count >= 17) return err("LIMIT_EXCEEDED", "会话内子代理数量已达上限");
    const active = (
      this.db
        .prepare(
          "SELECT COUNT(*) AS c FROM agents WHERE session_id = ? AND role != 'main' AND status IN ('running','blocked')",
        )
        .get(args.sessionId) as { c: number }
    ).c;
    if (active >= 4) return err("LIMIT_EXCEEDED", "同时运行的子代理已达上限");
    const duplicate = this.db
      .prepare("SELECT id FROM agents WHERE session_id = ? AND name = ?")
      .get(args.sessionId, args.name);
    if (duplicate) return err("INVALID_ARGUMENT", `代理名称已存在：${args.name}`);
    const agentId = newId("agt");
    if (args.files && args.files.length > 0 && this.leases) {
      try {
        this.leases.acquire({ sessionId: args.sessionId, agentId, targets: args.files });
      } catch (cause) {
        if (
          cause instanceof Error &&
          "code" in cause &&
          (cause as { code?: unknown }).code === "FILE_LEASED"
        ) {
          return err("FILE_LEASED", cause.message);
        }
        return err("INTERNAL", "登记文件租约失败");
      }
    }
    const modelProfileId = args.modelProfileId ?? parent.model_profile_id;
    const prompt = `你是 ${args.role} 角色的子代理。你的任务是：${args.task}`;
    this.log.append(args.sessionId, agentId, [
      {
        type: "agent.spawned",
        data: {
          role: args.role,
          parentId: args.parentAgentId,
          name: args.name,
          modelProfileId: modelProfileId ?? null,
          systemPrompt: prompt,
          task: args.task,
          ...(args.files ? { files: args.files } : {}),
          ...(args.budget ? { budget: args.budget } : {}),
        },
      },
    ]);
    const dispatchId = newId("dsp");
    this.log.append(args.sessionId, agentId, [
      {
        type: "user.message",
        data: {
          dispatchId,
          clientMessageId: `spawn:${agentId}`,
          text: args.task,
          mode: "queue",
        },
      },
      { type: "dispatch.updated", data: { dispatchId, status: "accepted" } },
    ]);
    this.enqueue?.(args.sessionId, agentId, dispatchId, "queue");
    return { agentId, name: args.name, status: "idle" };
  }

  send(args: {
    sessionId: string;
    fromAgentId: string;
    to: string[];
    message: string;
    urgent?: boolean;
  }): { messageIds: string[] } | { error: ToolResult } {
    const sender = this.db
      .prepare("SELECT role, parent_id FROM agents WHERE session_id = ? AND id = ?")
      .get(args.sessionId, args.fromAgentId) as
      | { role: string; parent_id: string | null }
      | undefined;
    if (!sender) return err("NOT_FOUND", "发送方代理不存在");
    const rows = this.db
      .prepare("SELECT id, name, parent_id, status FROM agents WHERE session_id = ?")
      .all(args.sessionId) as {
      id: string;
      name: string | null;
      parent_id: string | null;
      status: string;
    }[];
    const recipients: string[] = [];
    for (const target of args.to) {
      const found = rows.find((r) => r.id === target || r.name === target);
      if (target === "parent" && sender.parent_id) recipients.push(sender.parent_id);
      else if (target === "children")
        recipients.push(...rows.filter((r) => r.parent_id === args.fromAgentId).map((r) => r.id));
      else if (found) recipients.push(found.id);
      else return err("NOT_FOUND", `找不到目标代理：${target}`);
    }
    const unique = [...new Set(recipients)].filter((id) => id !== args.fromAgentId);
    if (unique.length === 0) return err("NOT_FOUND", "没有可投递的目标代理");
    if (
      unique.some((id) => {
        const target = rows.find((r) => r.id === id);
        const sibling = sender.parent_id !== null && target?.parent_id === sender.parent_id;
        return (
          !sibling &&
          !isDescendant(this.db, args.fromAgentId, id) &&
          !isDescendant(this.db, id, args.fromAgentId)
        );
      })
    ) {
      return err("INVALID_ARGUMENT", "只能给父代理、子代理或兄弟代理发消息");
    }
    const messageIds: string[] = [];
    for (const toAgentId of unique) {
      const messageId = newId("msg");
      messageIds.push(messageId);
      this.log.append(args.sessionId, args.fromAgentId, [
        {
          type: "inbox.sent",
          data: {
            messageId,
            fromAgentId: args.fromAgentId,
            toAgentId,
            kind: "agent",
            message: args.message,
            ...(args.urgent ? { urgent: true } : {}),
          },
        },
      ]);
      this.enqueueInbox?.(args.sessionId, toAgentId);
    }
    for (const toAgentId of unique) {
      this.guardPingPong(args.sessionId, args.fromAgentId, toAgentId);
    }
    return { messageIds };
  }

  /**
   * 代理间连续互发消息超过 10 条且没有其它工具调用时暂停双方。
   * 计数从持久化日志重算，跨进程重启后仍然有效；通知只写一次。
   */
  private guardPingPong(sessionId: string, first: string, second: string): void {
    const rows = this.db
      .prepare(
        "SELECT type, agent_id, data FROM session_log WHERE session_id = ? ORDER BY seq DESC LIMIT 200",
      )
      .all(sessionId) as { type: string; agent_id: string | null; data: string }[];
    const pair = new Set([first, second]);
    const directions = new Set<string>();
    let count = 0;
    for (const row of rows) {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(row.data) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (row.type === "tool.intent") {
        // tool.intent 是唯一能证明发生了非通信工具调用的记录。
        if (data.toolName !== "agent_send") break;
        continue;
      }
      if (row.type !== "inbox.sent") continue;
      const from = typeof data.fromAgentId === "string" ? data.fromAgentId : "";
      const to = typeof data.toAgentId === "string" ? data.toAgentId : "";
      if (!pair.has(from) || !pair.has(to) || from === to) break;
      count += 1;
      directions.add(`${from}->${to}`);
      if (count > 10 && directions.size >= 2) break;
    }
    if (count <= 10 || directions.size < 2) return;
    const states = this.db
      .prepare("SELECT id, status FROM agents WHERE session_id = ? AND id IN (?, ?)")
      .all(sessionId, first, second) as { id: string; status: string }[];
    if (
      states.length !== 2 ||
      states.some((row) => ["interrupted", "paused", "closed", "failed"].includes(row.status))
    )
      return;
    const main = this.db
      .prepare("SELECT id FROM agents WHERE session_id = ? AND role = 'main' LIMIT 1")
      .get(sessionId) as { id: string } | undefined;
    const notice = "检测到两个代理连续互发消息超过 10 条，已暂停它们，请检查任务分工。";
    const seen = this.db
      .prepare(
        "SELECT 1 FROM session_log WHERE session_id = ? AND type = 'inbox.sent' AND json_extract(data, '$.kind') = 'notice' AND json_extract(data, '$.message') = ? LIMIT 1",
      )
      .get(sessionId, notice);
    this.stopAgent?.(sessionId, first);
    this.stopAgent?.(sessionId, second);
    this.log.append(sessionId, first, [{ type: "agent.status", data: { status: "interrupted" } }]);
    this.log.append(sessionId, second, [{ type: "agent.status", data: { status: "interrupted" } }]);
    if (!seen && main) {
      this.log.append(sessionId, "system", [
        {
          type: "inbox.sent",
          data: {
            messageId: newId("msg"),
            fromAgentId: "system",
            toAgentId: main.id,
            kind: "notice",
            message: notice,
          },
        },
      ]);
      this.enqueueInbox?.(sessionId, main.id);
    }
  }

  status(sessionId: string, requesterAgentId: string, agentId?: string): unknown {
    const rows = this.db
      .prepare(
        "SELECT id, name, parent_id, role, status, model_profile_id AS modelProfileId, usage FROM agents WHERE session_id = ? ORDER BY created_at",
      )
      .all(sessionId) as Record<string, unknown>[];
    const visible = rows.filter((r) => {
      const id = String(r.id);
      return (
        id === requesterAgentId ||
        isDescendant(this.db, requesterAgentId, id) ||
        isDescendant(this.db, id, requesterAgentId)
      );
    });
    return agentId ? (visible.find((r) => r.id === agentId) ?? null) : visible;
  }

  control(args: {
    sessionId: string;
    requesterAgentId: string;
    agentId: string;
    action: "pause" | "resume" | "close" | "release_lease";
  }): { ok: true } | { error: ToolResult } {
    const target = this.db
      .prepare("SELECT id, status FROM agents WHERE session_id = ? AND id = ?")
      .get(args.sessionId, args.agentId) as { id: string; status: string } | undefined;
    if (!target) return err("NOT_FOUND", "代理不存在");
    if (!isDescendant(this.db, args.requesterAgentId, args.agentId))
      return err("INVALID_ARGUMENT", "只能管理自己的后代代理");
    if (args.action === "release_lease") {
      this.leases?.releaseForAgent(args.sessionId, args.agentId);
      return { ok: true };
    }
    const status = args.action === "close" ? "closed" : args.action === "pause" ? "paused" : "idle";
    const targets =
      args.action === "close"
        ? [
            args.agentId,
            ...(
              this.db.prepare("SELECT id FROM agents WHERE session_id = ?").all(args.sessionId) as {
                id: string;
              }[]
            )
              .map((row) => row.id)
              .filter((id) => id !== args.agentId && isDescendant(this.db, args.agentId, id)),
          ]
        : [args.agentId];
    for (const targetId of targets) {
      if (args.action === "pause" || args.action === "close")
        this.stopAgent?.(args.sessionId, targetId);
      this.log.append(args.sessionId, targetId, [{ type: "agent.status", data: { status } }]);
      if (args.action === "close") this.leases?.releaseForAgent(args.sessionId, targetId);
      if (args.action === "resume") this.enqueueInbox?.(args.sessionId, targetId);
    }
    return { ok: true };
  }

  async wait(args: {
    sessionId: string;
    requesterAgentId: string;
    for: "any_message" | "messages_from" | "all_idle";
    agents?: string[];
    timeoutSeconds: number;
    signal: AbortSignal;
  }): Promise<ToolResult> {
    this.log.append(args.sessionId, args.requesterAgentId, [
      { type: "agent.status", data: { status: "waiting" } },
    ]);
    const finish = (result: ToolResult): ToolResult => {
      this.log.append(args.sessionId, args.requesterAgentId, [
        { type: "agent.status", data: { status: "running" } },
      ]);
      return result;
    };
    const deadline = Date.now() + Math.min(args.timeoutSeconds, 1800) * 1000;
    while (Date.now() < deadline) {
      if (args.signal.aborted)
        return finish({
          status: "error",
          error: { code: "CANCELLED", message: "等待已取消", retryable: false },
        });
      if (args.for === "any_message") {
        const row = this.db
          .prepare(
            "SELECT message_id FROM inbox_pending WHERE session_id = ? AND to_agent_id = ? AND status = 'pending' LIMIT 1",
          )
          .get(args.sessionId, args.requesterAgentId);
        if (row)
          return finish(
            ok({ reason: "message", messageId: (row as { message_id: string }).message_id }),
          );
      } else if (args.for === "messages_from") {
        const ids = args.agents ?? [];
        const placeholders = ids.map(() => "?").join(",") || "''";
        const row = this.db
          .prepare(
            `SELECT message_id FROM inbox_pending WHERE session_id = ? AND to_agent_id = ? AND from_agent_id IN (${placeholders}) AND status = 'pending' LIMIT 1`,
          )
          .get(args.sessionId, args.requesterAgentId, ...ids);
        if (row)
          return finish(
            ok({ reason: "message", messageId: (row as { message_id: string }).message_id }),
          );
      } else {
        const ids = args.agents ?? [];
        if (ids.length > 0) {
          const rows = this.db
            .prepare(
              `SELECT status FROM agents WHERE session_id = ? AND id IN (${ids.map(() => "?").join(",")})`,
            )
            .all(args.sessionId, ...ids) as { status: string }[];
          if (
            rows.length === ids.length &&
            rows.every((r) => ["idle", "closed", "failed", "interrupted"].includes(r.status))
          )
            return finish(ok({ reason: "all_idle" }));
        }
      }
      if (args.for === "all_idle") {
        const active = this.db
          .prepare(
            "SELECT id, status FROM agents WHERE session_id = ? AND status NOT IN ('closed','failed','idle','interrupted','paused')",
          )
          .all(args.sessionId) as { id: string; status: string }[];
        const pending = this.db
          .prepare(
            "SELECT 1 FROM inbox_pending WHERE session_id = ? AND status = 'pending' LIMIT 1",
          )
          .get(args.sessionId);
        if (active.length > 0 && active.every((row) => row.status === "waiting") && !pending) {
          const notice = "所有代理都在等待且没有待投递消息，已结束等待。";
          const seen = this.db
            .prepare(
              "SELECT 1 FROM session_log WHERE session_id = ? AND type = 'inbox.sent' AND json_extract(data, '$.kind') = 'notice' AND json_extract(data, '$.message') = ? LIMIT 1",
            )
            .get(args.sessionId, notice);
          const main = this.db
            .prepare("SELECT id FROM agents WHERE session_id = ? AND role = 'main' LIMIT 1")
            .get(args.sessionId) as { id: string } | undefined;
          if (!seen && main) {
            this.log.append(args.sessionId, "system", [
              {
                type: "inbox.sent",
                data: {
                  messageId: newId("msg"),
                  fromAgentId: "system",
                  toAgentId: main.id,
                  kind: "notice",
                  message: notice,
                },
              },
            ]);
            this.enqueueInbox?.(args.sessionId, main.id);
          }
          return finish(ok({ reason: "all_waiting", message: "无人会再发消息" }));
        }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    return finish(ok({ reason: "timeout" }));
  }
}
