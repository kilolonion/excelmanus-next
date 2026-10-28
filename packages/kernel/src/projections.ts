import { resultCursor } from "./result-pages.ts";
// M1 内核投影（10 §3.3）：sessions、agents、agent_context、dispatches、open_intents。
// 全部从 session_log 增量维护、可清表重建。

import type { DatabaseSync } from "node:sqlite";
import type { ContextItem, LogRecord, ToolResult } from "@excelmanus/protocol";
import { changeSummariesProjection } from "./change-summary.ts";
import { tailFrom } from "./compaction.ts";
import type { Projection } from "./session-log.ts";

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/**
 * 会话行：只由 session.created 建行；其余记录只推进 last_seq。不为没有
 * session.created 的会话补建行——否则删除后迟到的记录会"复活"出空工作区会话。
 */
function ensureSession(db: DatabaseSync, rec: LogRecord): void {
  if (rec.type === "session.created") {
    db.prepare(
      `INSERT INTO sessions (id, workspace_id, created_at, updated_at, last_seq)
       VALUES (?, '', ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_seq = MAX(last_seq, excluded.last_seq), updated_at = excluded.updated_at`,
    ).run(rec.sessionId, rec.createdAt, rec.createdAt, rec.seq);
    return;
  }
  db.prepare("UPDATE sessions SET last_seq = MAX(last_seq, ?), updated_at = ? WHERE id = ?").run(
    rec.seq,
    rec.createdAt,
    rec.sessionId,
  );
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
        `INSERT INTO agents (id, session_id, parent_id, name, role, status, model_profile_id, system_prompt, budget, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, id) DO UPDATE SET
           parent_id = excluded.parent_id, name = excluded.name, role = excluded.role,
           model_profile_id = excluded.model_profile_id,
           system_prompt = excluded.system_prompt, budget = excluded.budget, updated_at = excluded.updated_at`,
      ).run(
        rec.agentId,
        rec.sessionId,
        str(d.parentId),
        str(d.name),
        str(d.role) ?? "main",
        str(d.modelProfileId),
        str(d.systemPrompt),
        d.budget && typeof d.budget === "object" ? JSON.stringify(d.budget) : null,
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
    // 05 §3：closed 是终态；paused 只经继续（idle）或关闭离开。停止是异步的，
    // 被关闭/暂停代理随后收尾写的 turn.interrupted 等记录不得覆盖它们。
    const setStatus = (status: string): void => {
      db.prepare(
        `UPDATE agents SET status = ?, updated_at = ? WHERE session_id = ? AND id = ?
         AND status != 'closed' AND (status != 'paused' OR ? IN ('idle', 'closed'))`,
      ).run(status, rec.createdAt, rec.sessionId, rec.agentId, status);
    };
    if (rec.type === "agent.status") {
      const status = str(d.status);
      if (status !== null) setStatus(status);
      return;
    }
    if (rec.type === "approval.requested" && rec.agentId !== null) {
      setStatus("blocked");
      return;
    }
    if (rec.type === "approval.decided" && rec.agentId !== null) {
      db.prepare(
        "UPDATE agents SET status = 'running', updated_at = ? WHERE session_id = ? AND id = ? AND status = 'blocked'",
      ).run(rec.createdAt, rec.sessionId, rec.agentId);
      return;
    }
    if (rec.type === "question.asked" && rec.agentId !== null) {
      setStatus("blocked");
      return;
    }
    if (rec.type === "question.answered" && rec.agentId !== null) {
      db.prepare(
        "UPDATE agents SET status = 'running', updated_at = ? WHERE session_id = ? AND id = ? AND status = 'blocked'",
      ).run(rec.createdAt, rec.sessionId, rec.agentId);
      return;
    }
    const status = statusMap[rec.type];
    if (status !== undefined) setStatus(status);
    if (rec.type === "agent.updated" && rec.agentId !== null) {
      db.prepare(
        "UPDATE agents SET model_profile_id = ?, updated_at = ? WHERE session_id = ? AND id = ?",
      ).run(str(d.modelProfileId), rec.createdAt, rec.sessionId, rec.agentId);
    }
    if (rec.type === "usage.updated") {
      const usage = d.cumulative ?? d.usage;
      if (usage !== undefined) {
        const persisted = {
          ...(usage as Record<string, unknown>),
          ...(typeof d.steps === "number" ? { steps: d.steps } : {}),
          ...(typeof d.toolCalls === "number" ? { toolCalls: d.toolCalls } : {}),
        };
        db.prepare(
          "UPDATE agents SET usage = ?, updated_at = ? WHERE session_id = ? AND id = ?",
        ).run(JSON.stringify(persisted), rec.createdAt, rec.sessionId, rec.agentId);
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
  const memories = Array.isArray(d.memories)
    ? (d.memories as { category?: unknown; content?: unknown }[])
    : [];
  const skill =
    d.skill && typeof d.skill === "object"
      ? (d.skill as { name?: unknown; body?: unknown })
      : undefined;
  const lines = refs.map(
    (r) =>
      `- 用户当前选区：文档 ${String(r.docId ?? "")}（rev ${String(r.rev ?? "?")}）区域 ${String(r.range ?? "")}`,
  );
  if (Array.isArray(d.attachments) && d.attachments.length > 0) {
    const names = d.attachments.map((a: { name?: unknown }) => typeof a.name === "string" ? a.name : "未命名图片");
    lines.push(`- 本次消息图片附件：${JSON.stringify(names)}（消息附件存储，非工作区文件路径；未指定关联文件）。`);
  }
  if (memories.length > 0) {
    lines.push("相关记忆：");
    for (const m of memories)
      lines.push(`- [${String(m.category ?? "")}] ${String(m.content ?? "")}`);
  }
  if (d.chatMode === "ask")
    lines.push("本条消息是只读问答：只读取、分析并回答，不要修改任何文件。");
  else if (d.chatMode === "plan")
    lines.push(
      "本条消息是计划模式：先读取需要的内容，给出分步执行计划（涉及哪些文件、区域、怎么改），不要修改任何文件；用户确认后会切回执行模式再让你执行。",
    );
  if (skill && typeof skill.body === "string") {
    lines.push(`<skill name="${String(skill.name ?? "")}">\n${skill.body}\n</skill>`);
  }
  if (lines.length === 0) return text;
  return `<context>\n${lines.join("\n")}\n</context>\n\n${text}`;
}

/** 该代理在 beforeSeq 之前最近一次压缩的 seq（没有为 0）；回退不能越过它。 */
export function lastCompactionSeq(
  db: DatabaseSync,
  sessionId: string,
  agentId: string,
  beforeSeq = Number.MAX_SAFE_INTEGER,
): number {
  return (
    db
      .prepare(
        "SELECT COALESCE(MAX(seq), 0) AS s FROM session_log WHERE session_id = ? AND agent_id = ? AND type = 'compaction' AND seq < ?",
      )
      .get(sessionId, agentId, beforeSeq) as { s: number }
  ).s;
}

/** context.notice 在 inbox_pending 中的发送方标记（环境变化说明，04 §7.3）。 */
const ENV_NOTICE_SENDER = "environment";

/** 06 §2.3：工具结果给模型的文本上限（不含图片）。 */
export const TOOL_RESULT_MAX_CHARS = 16_000;

/**
 * 工具结果进入上下文时统一截断（06 §2.3、04 §6.2：产生时即有上限，之后不再改写）。
 * 日志保留完整结果；超限时只给模型状态、错误、修订号与前段预览。
 */
export function capToolOutput(result: ToolResult, sourceSeq?: number): ToolResult {
  const { images, ...rest } = result;
  const json = JSON.stringify(rest);
  if (json.length <= TOOL_RESULT_MAX_CHARS) return result;
  const shown = TOOL_RESULT_MAX_CHARS - 1_000;
  return {
    status: result.status,
    ...(result.error
      ? { error: { ...result.error, message: result.error.message.slice(0, 2_000) } }
      : {}),
    ...(result.docRevs ? { docRevs: result.docRevs } : {}),
    ...(result.versions ? { versions: result.versions } : {}),
    ...(sourceSeq !== undefined
      ? { truncated: { shown, total: json.length, cursor: resultCursor(sourceSeq, shown) } }
      : result.truncated
        ? { truncated: result.truncated }
        : {}),
    data: {
      preview: json.slice(0, shown),
      note: `结果过长（${json.length} 字符），只显示前 ${shown} 字符；请缩小范围或保留原参数并携带 truncated.cursor 分批获取`,
    },
    ...(images ? { images } : {}),
  };
}

const agentContext: Projection = {
  name: "agent_context",
  tables: ["agent_context"],
  apply(db, rec) {
    const d = rec.data;
    let item: ContextItem | null = null;
    let targetAgentId = rec.agentId;
    if (rec.type === "inbox.delivered") {
      // 收件箱消息与环境通知只在步骤边界投递时进入上下文（05 §4.2、04 §3 第 1 步）：
      // inbox.sent / context.notice 只入 inbox_pending。同一次投递（seq 连续的
      // inbox.delivered）合并为一条 <inbox>，顺序即运行时按优先级写出的顺序。
      targetAgentId = str(d.toAgentId);
      const messageId = str(d.messageId);
      if (targetAgentId === null || !messageId) return;
      const msg = db
        .prepare(
          "SELECT from_agent_id AS fromAgentId, kind, message, urgent FROM inbox_pending WHERE message_id = ?",
        )
        .get(messageId) as
        | { fromAgentId: string; kind: string; message: string; urgent: number }
        | undefined;
      if (!msg) return;
      const entry =
        msg.fromAgentId === ENV_NOTICE_SENDER
          ? msg.message
          : `<message id="${messageId}" from="${msg.fromAgentId}" kind="${msg.kind}"${msg.urgent ? ' urgent="true"' : ""}>\n${msg.message}\n</message>`;
      const last = db
        .prepare(
          "SELECT idx, item, from_seq AS fromSeq FROM agent_context WHERE session_id = ? AND agent_id = ? AND superseded = 0 ORDER BY idx DESC LIMIT 1",
        )
        .get(rec.sessionId, targetAgentId) as
        | { idx: number; item: string; fromSeq: number }
        | undefined;
      const prevDelivered =
        last !== undefined &&
        last.fromSeq === rec.seq - 1 &&
        db
          .prepare(
            "SELECT 1 FROM session_log WHERE session_id = ? AND seq = ? AND type = 'inbox.delivered' AND json_extract(data, '$.toAgentId') = ?",
          )
          .get(rec.sessionId, rec.seq - 1, targetAgentId) !== undefined;
      if (last !== undefined && prevDelivered) {
        const prev = JSON.parse(last.item) as ContextItem;
        if (prev.kind === "user" && prev.text.endsWith("\n</inbox>")) {
          const merged: ContextItem = {
            ...prev,
            text: `${prev.text.slice(0, -"\n</inbox>".length)}\n${entry}\n</inbox>`,
          };
          db.prepare(
            "UPDATE agent_context SET item = ?, from_seq = ? WHERE session_id = ? AND agent_id = ? AND idx = ?",
          ).run(JSON.stringify(merged), rec.seq, rec.sessionId, targetAgentId, last.idx);
          return;
        }
      }
      item = { kind: "user", text: `<inbox>\n${entry}\n</inbox>` };
    } else if (rec.type === "dispatch.updated" && str(d.status) === "applied") {
      // 用户消息在派发应用时才进入上下文（04 §4.1）：排队中的消息对当前轮不可见，
      // 撤回后永不进入。session_log 行先于投影写入，同事务可查。
      const dispatchId = str(d.dispatchId) ?? "";
      const msg = db
        .prepare(
          "SELECT agent_id, data FROM session_log WHERE session_id = ? AND type = 'user.message' AND json_extract(data, '$.dispatchId') = ? ORDER BY seq LIMIT 1",
        )
        .get(rec.sessionId, dispatchId) as { agent_id: string | null; data: string } | undefined;
      if (!msg || msg.agent_id === null) return;
      targetAgentId = msg.agent_id;
      const data = JSON.parse(msg.data) as Record<string, unknown>;
      // 图片附件只存引用（10 §2 blobs），调用模型前由运行时读出
      const images = Array.isArray(data.attachments)
        ? (data.attachments as { sha256?: unknown; mediaType?: unknown }[])
            .filter(
              (a) =>
                typeof a.sha256 === "string" &&
                typeof a.mediaType === "string" &&
                a.mediaType.startsWith("image/"),
            )
            .map((a) => ({ sha256: a.sha256 as string, mediaType: a.mediaType as string }))
        : [];
      item = {
        kind: "user",
        text: userText(data),
        ...(images.length > 0 ? { images } : {}),
      };
    } else if (rec.type === "history.rewound") {
      // 从某条用户消息起重新开始：该代理 from_seq ≥ fromSeq 的条目标记 superseded，
      // 日志只追加、条目保留在表内，重建结果确定。不越过最近一次压缩（摘要与保留尾部
      // 都在压缩之前开始），越界的记录不生效。
      const fromSeq = typeof d.fromSeq === "number" ? d.fromSeq : null;
      if (targetAgentId === null || fromSeq === null) return;
      if (fromSeq <= lastCompactionSeq(db, rec.sessionId, targetAgentId, rec.seq)) return;
      db.prepare(
        "UPDATE agent_context SET superseded = 1 WHERE session_id = ? AND agent_id = ? AND superseded = 0 AND from_seq >= ?",
      ).run(rec.sessionId, targetAgentId, fromSeq);
      return;
    } else if (rec.type === "compaction") {
      // 压缩是唯一的历史改写（04 §6.3）：旧条目标记 superseded 保留在表内，
      // 追加摘要条目 + 原样复制保留尾部（from_seq 保留原值），重放结果确定。
      if (targetAgentId === null) return;
      const keepFromSeq = typeof d.keepFromSeq === "number" ? (d.keepFromSeq as number) : null;
      const current = db
        .prepare(
          "SELECT idx, item, from_seq AS fromSeq FROM agent_context WHERE session_id = ? AND agent_id = ? AND superseded = 0 ORDER BY idx",
        )
        .all(rec.sessionId, targetAgentId) as unknown as {
        idx: number;
        item: string;
        fromSeq: number;
      }[];
      db.prepare(
        "UPDATE agent_context SET superseded = 1 WHERE session_id = ? AND agent_id = ? AND superseded = 0",
      ).run(rec.sessionId, targetAgentId);
      const nextIdx = () =>
        (
          db
            .prepare(
              "SELECT COALESCE(MAX(idx), -1) + 1 AS i FROM agent_context WHERE session_id = ? AND agent_id = ?",
            )
            .get(rec.sessionId, targetAgentId) as { i: number }
        ).i;
      db.prepare(
        "INSERT INTO agent_context (agent_id, session_id, idx, item, from_seq) VALUES (?, ?, ?, ?, ?)",
      ).run(
        targetAgentId,
        rec.sessionId,
        nextIdx(),
        JSON.stringify({
          kind: "user",
          text: `<summary>\n${str(d.summary) ?? ""}\n</summary>`,
        } satisfies ContextItem),
        rec.seq,
      );
      if (keepFromSeq === null) return;
      const copy = db.prepare(
        "INSERT INTO agent_context (agent_id, session_id, idx, item, from_seq) VALUES (?, ?, ?, ?, ?)",
      );
      for (const row of tailFrom(current, keepFromSeq)) {
        copy.run(targetAgentId, rec.sessionId, nextIdx(), row.item, row.fromSeq);
      }
      return;
    }
    if (targetAgentId === null) return;
    if (rec.type === "model.output") {
      // The rejected draft remains in the log, but is neither visible text nor model history.
      if (d.deliveryStatus === "rejected") return;
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
        output: result
          ? capToolOutput(result, rec.seq)
          : {
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
        .get(rec.sessionId, targetAgentId) as { i: number }
    ).i;
    db.prepare(
      "INSERT INTO agent_context (agent_id, session_id, idx, item, from_seq) VALUES (?, ?, ?, ?, ?)",
    ).run(targetAgentId, rec.sessionId, idx, JSON.stringify(item), rec.seq);
  },
  clear(db, sessionId) {
    if (sessionId === undefined) {
      db.exec("DELETE FROM agent_context");
    } else {
      db.prepare("DELETE FROM agent_context WHERE session_id = ?").run(sessionId);
    }
  },
};

const inboxPending: Projection = {
  name: "inbox_pending",
  tables: ["inbox_pending"],
  apply(db, rec) {
    const d = rec.data;
    if (rec.type === "inbox.sent") {
      const id = str(d.messageId);
      if (!id) return;
      db.prepare(
        `INSERT INTO inbox_pending (message_id, session_id, from_agent_id, to_agent_id, kind, message, urgent, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
         ON CONFLICT(message_id) DO NOTHING`,
      ).run(
        id,
        rec.sessionId,
        str(d.fromAgentId) ?? rec.agentId ?? "",
        str(d.toAgentId) ?? "",
        str(d.kind) ?? "agent",
        str(d.message) ?? "",
        d.urgent === true ? 1 : 0,
        rec.createdAt,
      );
    } else if (rec.type === "context.notice") {
      // 环境变化说明同样等到步骤边界才注入（04 §3 第 1 步）：每个接收方一条待投递项；
      // agentId 为空时发给会话内全部未关闭代理。id 由 seq 派生，重建结果确定。
      const targets =
        rec.agentId !== null
          ? [rec.agentId]
          : (
              db
                .prepare("SELECT id FROM agents WHERE session_id = ? AND status != 'closed'")
                .all(rec.sessionId) as { id: string }[]
            ).map((r) => r.id);
      const text = `<notice kind="${str(d.kind) ?? ""}">${str(d.text) ?? ""}</notice>`;
      const insert = db.prepare(
        `INSERT INTO inbox_pending (message_id, session_id, from_agent_id, to_agent_id, kind, message, urgent, status, created_at)
         VALUES (?, ?, ?, ?, 'notice', ?, 0, 'pending', ?)
         ON CONFLICT(message_id) DO NOTHING`,
      );
      for (const agentId of targets) {
        insert.run(
          `ntc_${rec.sessionId}_${rec.seq}_${agentId}`,
          rec.sessionId,
          ENV_NOTICE_SENDER,
          agentId,
          text,
          rec.createdAt,
        );
      }
    } else if (rec.type === "inbox.delivered") {
      const id = str(d.messageId);
      if (!id) return;
      db.prepare(
        "UPDATE inbox_pending SET status = 'delivered', delivered_at = ? WHERE message_id = ?",
      ).run(rec.createdAt, id);
    }
  },
  clear(db, sessionId) {
    if (sessionId === undefined) db.exec("DELETE FROM inbox_pending");
    else db.prepare("DELETE FROM inbox_pending WHERE session_id = ?").run(sessionId);
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

const pendingInteractions: Projection = {
  name: "pending_interactions",
  tables: ["pending_interactions"],
  apply(db, rec) {
    const d = rec.data;
    if (rec.type === "approval.requested") {
      const id = str(d.approvalId);
      if (!id || rec.agentId === null) return;
      const spec =
        d.spec && typeof d.spec === "object"
          ? d.spec
          : {
              toolCallId: d.toolCallId,
              toolName: d.toolName,
              args: d.args,
              targets: d.targets,
              effect: d.effect,
            };
      db.prepare(
        `INSERT INTO pending_interactions
         (id, session_id, agent_id, kind, tool_call_id, spec, status, created_at, updated_at)
         VALUES (?, ?, ?, 'approval', ?, ?, 'pending', ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      ).run(
        id,
        rec.sessionId,
        rec.agentId,
        str(d.toolCallId),
        JSON.stringify(spec),
        rec.createdAt,
        rec.createdAt,
      );
    } else if (rec.type === "approval.decided") {
      const id = str(d.approvalId);
      const decision = str(d.decision);
      if (!id || (decision !== "approved" && decision !== "denied")) return;
      db.prepare(
        `UPDATE pending_interactions
         SET status = ?, decision = ?, reason = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`,
      ).run(decision, decision, str(d.reason), rec.createdAt, id);
      if (d.remember === true && decision === "approved") {
        const row = db
          .prepare("SELECT session_id, spec FROM pending_interactions WHERE id = ?")
          .get(id) as { session_id: string; spec: string } | undefined;
        if (row) {
          const spec = JSON.parse(row.spec) as { toolName?: unknown; targets?: unknown };
          const toolName = str(spec.toolName);
          const targets = Array.isArray(spec.targets) ? spec.targets : [];
          if (toolName) {
            // 04 §5.1：每个目标各一条规则；规则 id 以审批 id 开头，匹配时据此取回
            // 被记住的 effect（isAutoApproved）。同一目标再次记住以最新决定为准。
            const patterns = targets.length > 0 ? targets.map(String) : ["*"];
            const insert = db.prepare(
              `INSERT INTO auto_approve_rules (id, session_id, tool_name, path_pattern, created_at)
               VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id, tool_name, path_pattern)
               DO UPDATE SET id = excluded.id, created_at = excluded.created_at`,
            );
            patterns.forEach((pathPattern, i) => {
              insert.run(`${id}:rule:${i}`, row.session_id, toolName, pathPattern, rec.createdAt);
            });
          }
        }
      }
    } else if (rec.type === "question.asked") {
      const id = str(d.questionId);
      if (!id || rec.agentId === null) return;
      const spec = d.spec && typeof d.spec === "object" ? (d.spec as Record<string, unknown>) : {};
      const runtime =
        spec._runtime && typeof spec._runtime === "object"
          ? (spec._runtime as Record<string, unknown>)
          : {};
      db.prepare(
        `INSERT INTO pending_interactions
         (id, session_id, agent_id, kind, tool_call_id, spec, status, created_at, updated_at)
         VALUES (?, ?, ?, 'question', ?, ?, 'pending', ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      ).run(
        id,
        rec.sessionId,
        rec.agentId,
        typeof runtime.toolCallId === "string" ? runtime.toolCallId : null,
        JSON.stringify({ questionType: d.questionType, spec: d.spec }),
        rec.createdAt,
        rec.createdAt,
      );
    } else if (rec.type === "question.answered") {
      const id = str(d.questionId);
      if (!id) return;
      db.prepare(
        "UPDATE pending_interactions SET status = 'approved', decision = 'approved', reason = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
      ).run(
        JSON.stringify({
          answer: d.answer,
          ...(typeof d.rev === "number" ? { rev: d.rev } : {}),
        }),
        rec.createdAt,
        id,
      );
    }
  },
  clear(db, sessionId) {
    if (sessionId === undefined) db.exec("DELETE FROM pending_interactions");
    else db.prepare("DELETE FROM pending_interactions WHERE session_id = ?").run(sessionId);
  },
};

const autoApproveRules: Projection = {
  name: "auto_approve_rules",
  tables: ["auto_approve_rules"],
  apply(_db, rec) {
    // Rules are inserted by pendingInteractions in the same projection pass.
    // This projection exists separately so rebuild tooling can assert the table.
    if (rec.type !== "approval.decided" || rec.data.remember !== true) return;
  },
  clear(db, sessionId) {
    if (sessionId === undefined) db.exec("DELETE FROM auto_approve_rules");
    else db.prepare("DELETE FROM auto_approve_rules WHERE session_id = ?").run(sessionId);
  },
};

const todos: Projection = {
  name: "todos",
  tables: ["todos"],
  apply(db, rec) {
    if (rec.agentId === null) return;
    if (rec.type === "todo.set") {
      db.prepare(
        `INSERT INTO todos (session_id, agent_id, items, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id, agent_id) DO UPDATE SET items = excluded.items, updated_at = excluded.updated_at`,
      ).run(rec.sessionId, rec.agentId, JSON.stringify(rec.data.items ?? []), rec.createdAt);
    } else if (rec.type === "todo.updated") {
      const row = db
        .prepare("SELECT items FROM todos WHERE session_id = ? AND agent_id = ?")
        .get(rec.sessionId, rec.agentId) as { items: string } | undefined;
      if (!row) return;
      const items = JSON.parse(row.items) as Record<string, unknown>[];
      const id = str(rec.data.todoId);
      const next = items.map((item) => (id && item.id === id ? { ...item, ...rec.data } : item));
      db.prepare(
        "UPDATE todos SET items = ?, updated_at = ? WHERE session_id = ? AND agent_id = ?",
      ).run(JSON.stringify(next), rec.createdAt, rec.sessionId, rec.agentId);
    }
  },
  clear(db, sessionId) {
    if (sessionId === undefined) db.exec("DELETE FROM todos");
    else db.prepare("DELETE FROM todos WHERE session_id = ?").run(sessionId);
  },
};

/** M1 内核投影集（顺序与重建顺序一致）。 */
export function kernelProjections(): Projection[] {
  return [
    sessions,
    agents,
    agentContext,
    dispatches,
    inboxPending,
    openIntents,
    pendingInteractions,
    autoApproveRules,
    todos,
    changeSummariesProjection,
  ];
}
