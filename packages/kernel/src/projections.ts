// M1 内核投影（10 §3.3）：sessions、agents、agent_context、dispatches、open_intents。
// 全部从 session_log 增量维护、可清表重建。

import type { DatabaseSync } from "node:sqlite";
import type { ContextItem, LogRecord, ToolResult } from "@excelmanus/protocol";
import type { Projection } from "./session-log.ts";

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** 会话行兜底：任何记录到达都确保 sessions 行存在并推进 last_seq。 */
function ensureSession(db: DatabaseSync, rec: LogRecord): void {
  db.prepare(
    `INSERT INTO sessions (id, workspace_id, created_at, updated_at, last_seq)
     VALUES (?, '', ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET last_seq = MAX(last_seq, excluded.last_seq), updated_at = excluded.updated_at`,
  ).run(rec.sessionId, rec.createdAt, rec.createdAt, rec.seq);
}

const sessions: Projection = {
  name: "sessions",
  tables: ["sessions"],
  apply(db, rec) {
    ensureSession(db, rec);
    const d = rec.data;
    if (rec.type === "session.created") {
      db.prepare(
        `UPDATE sessions SET workspace_id = ?, permission_mode = ?,
         title = COALESCE(?, title), created_at = ? WHERE id = ?`,
      ).run(
        str(d.workspaceId) ?? "",
        str(d.permissionMode) ?? "standard",
        str(d.title),
        rec.createdAt,
        rec.sessionId,
      );
    } else if (rec.type === "session.updated") {
      const title = str(d.title);
      const mode = str(d.permissionMode);
      if (title !== null || mode !== null) {
        db.prepare(
          `UPDATE sessions SET title = COALESCE(?, title), permission_mode = COALESCE(?, permission_mode), updated_at = ? WHERE id = ?`,
        ).run(title, mode, rec.createdAt, rec.sessionId);
      }
    } else if (rec.type === "user.message") {
      // 04 §11.3：首条用户消息前 30 字作为临时标题
      const text = str(d.text);
      if (text !== null) {
        db.prepare(
          `UPDATE sessions SET title = ? WHERE id = ? AND (title IS NULL OR title = '')`,
        ).run(text.slice(0, 30), rec.sessionId);
      }
    }
  },
  clear(db, sessionId) {
    if (sessionId === undefined) db.exec("DELETE FROM sessions");
    else db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
  },
};

const agents: Projection = {
  name: "agents",
  tables: ["agents"],
  apply(db, rec) {
    const d = rec.data;
    if (rec.type === "agent.spawned") {
      db.prepare(
        `INSERT INTO agents (id, session_id, parent_id, name, role, status, model_profile_id, system_prompt, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?, 'idle', ?, ?, ?, ?)
         ON CONFLICT(session_id, id) DO UPDATE SET
           name = excluded.name, role = excluded.role,
           model_profile_id = excluded.model_profile_id,
           system_prompt = excluded.system_prompt, updated_at = excluded.updated_at`,
      ).run(
        rec.agentId,
        rec.sessionId,
        str(d.name),
        str(d.role) ?? "main",
        str(d.modelProfileId),
        str(d.systemPrompt),
        rec.createdAt,
        rec.createdAt,
      );
      return;
    }
    if (rec.agentId === null) return;
    const statusMap: Record<string, string> = {
      "turn.started": "running",
      "turn.completed": "idle",
      "turn.failed": "failed",
      "turn.interrupted": "interrupted",
    };
    if (rec.type === "agent.status") {
      const status = str(d.status);
      if (status !== null) {
        db.prepare(
          "UPDATE agents SET status = ?, updated_at = ? WHERE session_id = ? AND id = ?",
        ).run(status, rec.createdAt, rec.sessionId, rec.agentId);
      }
      return;
    }
    const status = statusMap[rec.type];
    if (status !== undefined) {
      db.prepare(
        "UPDATE agents SET status = ?, updated_at = ? WHERE session_id = ? AND id = ?",
      ).run(status, rec.createdAt, rec.sessionId, rec.agentId);
    }
    if (rec.type === "usage.updated") {
      const usage = d.cumulative ?? d.usage;
      if (usage !== undefined) {
        db.prepare(
          "UPDATE agents SET usage = ?, updated_at = ? WHERE session_id = ? AND id = ?",
        ).run(JSON.stringify(usage), rec.createdAt, rec.sessionId, rec.agentId);
      }
    }
  },
  clear(db, sessionId) {
    if (sessionId === undefined) db.exec("DELETE FROM agents");
    else db.prepare("DELETE FROM agents WHERE session_id = ?").run(sessionId);
  },
};

/** user.message 进入上下文时：本轮变化的上下文包进 <context> 块放在消息前（04 §7.3）。 */
function userText(d: Record<string, unknown>): string {
  const text = str(d.text) ?? "";
  const refs = Array.isArray(d.context)
    ? (d.context as { docId?: unknown; rev?: unknown; range?: unknown }[])
    : [];
  if (refs.length === 0) return text;
  const lines = refs.map(
    (r) =>
      `- 用户当前选区：文档 ${String(r.docId ?? "")}（rev ${String(r.rev ?? "?")}）区域 ${String(r.range ?? "")}`,
  );
  return `<context>\n${lines.join("\n")}\n</context>\n\n${text}`;
}

const agentContext: Projection = {
  name: "agent_context",
  tables: ["agent_context"],
  apply(db, rec) {
    if (rec.agentId === null) return;
    const d = rec.data;
    let item: ContextItem | null = null;
    if (rec.type === "user.message") {
      item = { kind: "user", text: userText(d) };
    } else if (rec.type === "model.output") {
      item = {
        kind: "assistant",
        ...(d.text !== undefined ? { text: d.text as string } : {}),
        ...(d.reasoning !== undefined ? { reasoning: d.reasoning as string } : {}),
        ...(d.reasoningProviderOptions !== undefined
          ? { reasoningProviderOptions: d.reasoningProviderOptions as Record<string, unknown> }
          : {}),
        ...(d.toolCalls !== undefined
          ? { toolCalls: d.toolCalls as ContextItem extends { toolCalls?: infer T } ? T : never }
          : {}),
      };
    } else if (rec.type === "tool.result") {
      const result = d.result as ToolResult | undefined;
      const status = str(d.status) ?? result?.status ?? "error";
      const isError = status !== "ok" && status !== "partial";
      item = {
        kind: "toolResult",
        toolCallId: str(d.toolCallId) ?? "",
        toolName: str(d.toolName) ?? "",
        output: result ?? {
          status,
          error: { code: "INTERNAL", message: "缺失结果", retryable: false },
        },
        ...(isError ? { isError: true } : {}),
      };
    }
    if (item === null) return;
    const idx = (
      db
        .prepare(
          "SELECT COALESCE(MAX(idx), -1) + 1 AS i FROM agent_context WHERE session_id = ? AND agent_id = ?",
        )
        .get(rec.sessionId, rec.agentId) as { i: number }
    ).i;
    db.prepare(
      "INSERT INTO agent_context (agent_id, session_id, idx, item, from_seq) VALUES (?, ?, ?, ?, ?)",
    ).run(rec.agentId, rec.sessionId, idx, JSON.stringify(item), rec.seq);
  },
  clear(db, sessionId) {
    if (sessionId === undefined) {
      db.exec("DELETE FROM agent_context");
    } else {
      db.prepare("DELETE FROM agent_context WHERE session_id = ?").run(sessionId);
    }
  },
};

const dispatches: Projection = {
  name: "dispatches",
  tables: ["dispatches"],
  apply(db, rec) {
    const d = rec.data;
    if (rec.type === "user.message" && rec.agentId !== null) {
      db.prepare(
        `INSERT INTO dispatches (id, session_id, agent_id, client_message_id, mode, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'accepted', ?, ?)
         ON CONFLICT(session_id, agent_id, client_message_id) DO NOTHING`,
      ).run(
        str(d.dispatchId) ?? "",
        rec.sessionId,
        rec.agentId,
        str(d.clientMessageId) ?? "",
        str(d.mode) ?? "queue",
        rec.createdAt,
        rec.createdAt,
      );
    } else if (rec.type === "dispatch.updated") {
      db.prepare(
        "UPDATE dispatches SET status = ?, updated_at = ? WHERE id = ? AND session_id = ?",
      ).run(str(d.status) ?? "accepted", rec.createdAt, str(d.dispatchId) ?? "", rec.sessionId);
    }
  },
  clear(db, sessionId) {
    if (sessionId === undefined) db.exec("DELETE FROM dispatches");
    else db.prepare("DELETE FROM dispatches WHERE session_id = ?").run(sessionId);
  },
};

const openIntents: Projection = {
  name: "open_intents",
  tables: ["open_intents"],
  apply(db, rec) {
    const d = rec.data;
    if (rec.type === "tool.intent" && rec.agentId !== null) {
      db.prepare(
        `INSERT INTO open_intents (agent_id, session_id, tool_call_id, step_id, tool_name, targets, replay, created_seq, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, agent_id, tool_call_id) DO NOTHING`,
      ).run(
        rec.agentId,
        rec.sessionId,
        str(d.toolCallId) ?? "",
        str(d.stepId) ?? "",
        str(d.toolName) ?? "",
        JSON.stringify(d.targets ?? []),
        str(d.replay) ?? "unknown",
        rec.seq,
        rec.createdAt,
      );
    } else if (rec.type === "tool.result" && rec.agentId !== null) {
      db.prepare(
        "DELETE FROM open_intents WHERE session_id = ? AND agent_id = ? AND tool_call_id = ?",
      ).run(rec.sessionId, rec.agentId, str(d.toolCallId) ?? "");
    }
  },
  clear(db, sessionId) {
    if (sessionId === undefined) db.exec("DELETE FROM open_intents");
    else db.prepare("DELETE FROM open_intents WHERE session_id = ?").run(sessionId);
  },
};

/** M1 内核投影集（顺序与重建顺序一致）。 */
export function kernelProjections(): Projection[] {
  return [sessions, agents, agentContext, dispatches, openIntents];
}
