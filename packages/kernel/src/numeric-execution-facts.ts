import type { DatabaseSync } from "node:sqlite";

type Json = Record<string, unknown>;
type Row = { seq: number; agentId: string; type: string; data: string };
type Start = { seq: number; data: string };
const object = (value: unknown): Json =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
const text = (value: unknown): string =>
  (typeof value === "string" ? value : "未提供")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "&#124;")
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n");
const json = (value: unknown): string =>
  value === undefined ? "未提供" : text(JSON.stringify(value));
const revisions = (value: unknown): unknown => {
  const entries = Object.entries(object(value));
  return entries.length &&
    entries.every(([, rev]) => typeof rev === "number" && Number.isFinite(rev))
    ? Object.fromEntries(entries)
    : undefined;
};

/** Shared host receipt scope; preserves the existing trusted resume and child boundaries. */
export function numericExecutionReceiptScope(
  db: DatabaseSync,
  sessionId: string,
  agentId: string,
  turnId?: string,
): { startSeq?: number; receipts: Row[]; scopes: string[] } {
  const startOf = (id: string, turn: string) =>
    db
      .prepare(
        "SELECT seq,data FROM session_log WHERE session_id=? AND agent_id=? AND type='turn.started' AND json_extract(data,'$.turnId')=? ORDER BY seq DESC LIMIT 1",
      )
      .get(sessionId, id, turn) as Start | undefined;
  const initial = turnId ? startOf(agentId, turnId) : undefined;
  if (!initial) return { receipts: [], scopes: [] };

  const receipts = new Map<number, Row>();
  const visited = new Set<string>();
  const scopes: string[] = [];
  const visit = (id: string, start: Start, terminal?: number) => {
    const key = `${id}:${start.seq}`;
    if (visited.has(key)) return;
    visited.add(key);
    const next = db
      .prepare(
        "SELECT MIN(seq) AS seq FROM session_log WHERE session_id=? AND agent_id=? AND type='turn.started' AND seq>?",
      )
      .get(sessionId, id, start.seq) as { seq: number | null };
    const rows = db
      .prepare(
        "SELECT seq,agent_id AS agentId,type,data FROM session_log WHERE session_id=? AND agent_id=? AND seq>? AND seq<COALESCE(?,9223372036854775807) AND seq<=COALESCE(?,9223372036854775807) AND type IN ('tool.result','inbox.delivered') ORDER BY seq",
      )
      .all(sessionId, id, start.seq, next.seq, terminal ?? null) as Row[];
    for (const row of rows) {
      if (row.type === "tool.result") {
        receipts.set(row.seq, row);
        continue;
      }
      const delivered = object(JSON.parse(row.data));
      if (delivered.toAgentId !== id || typeof delivered.messageId !== "string") continue;
      // Same trusted child association as numericDeliveryState, never inbox prose.
      const sent = db
        .prepare(
          "SELECT l.seq,l.agent_id AS sender,l.data FROM session_log l JOIN agents a ON a.session_id=l.session_id AND a.id=l.agent_id WHERE l.session_id=? AND l.type='inbox.sent' AND json_extract(l.data,'$.messageId')=? AND json_extract(l.data,'$.kind')='report' AND json_extract(l.data,'$.toAgentId')=? AND a.parent_id=? AND l.seq<? ORDER BY l.seq DESC LIMIT 1",
        )
        .get(sessionId, delivered.messageId, id, id, row.seq) as
        | { seq: number; sender: string; data: string }
        | undefined;
      if (!sent) continue;
      const report = object(JSON.parse(sent.data));
      const metadata = object(report.numericDelivery);
      if (
        report.fromAgentId !== sent.sender ||
        typeof metadata.turnId !== "string" ||
        !["completed", "failed", "interrupted"].includes(String(metadata.outcome))
      )
        continue;
      const end = db
        .prepare(
          "SELECT seq FROM session_log WHERE session_id=? AND agent_id=? AND type=? AND json_extract(data,'$.turnId')=? AND seq<? ORDER BY seq DESC LIMIT 1",
        )
        .get(
          sessionId,
          sent.sender,
          `turn.${String(metadata.outcome)}`,
          metadata.turnId,
          sent.seq,
        ) as { seq: number } | undefined;
      const child = startOf(sent.sender, metadata.turnId);
      if (!end || !child || child.seq >= end.seq) continue;
      const childKey = `${sent.sender}:${child.seq}`;
      if (!visited.has(childKey))
        scopes.push(
          `子代理终态：agentId=${text(sent.sender)} · turnId=${text(metadata.turnId)} · outcome=${text(metadata.outcome)}`,
        );
      visit(sent.sender, child, end.seq);
    }
    // This marker is only persisted by runTurn for explicit numeric resume.
    if (object(JSON.parse(start.data)).numericDeliveryRequired === true) {
      const previous = db
        .prepare(
          "SELECT seq,data FROM session_log WHERE session_id=? AND agent_id=? AND type='turn.started' AND seq<? ORDER BY seq DESC LIMIT 1",
        )
        .get(sessionId, id, start.seq) as Start | undefined;
      if (previous) visit(id, previous);
      else scopes.push("继承轮次范围未取得；执行事实未完整。");
    }
  };
  visit(agentId, initial);
  return {
    startSeq: initial.seq,
    receipts: [...receipts.values()].sort((a, b) => a.seq - b.seq),
    scopes,
  };
}

/** Host receipts only. This is not a general audit or a proof of authorization/recovery. */
export function numericExecutionFacts(
  db: DatabaseSync,
  sessionId: string,
  agentId: string,
  turnId?: string,
): string {
  const heading = [
    "实际工具执行事实（宿主回执）",
    "仅列本轮工作簿修改、脚本提交／发布／回滚回执及失败工具状态，不是全工具副作用审计。" +
      "不等同任务完成或恢复证明，也不证明授权或目标选择正确；重复写入不证明恢复完成。" +
      "提交不等同检查点或发布完成，回滚不等同从未发生提交或发布；未提供的备份或恢复状态不作推断。",
  ];
  const { startSeq, receipts, scopes } = numericExecutionReceiptScope(
    db,
    sessionId,
    agentId,
    turnId,
  );
  if (startSeq === undefined)
    return [...heading, "未取得本轮范围；未扫描会话历史，无法列出本轮执行事实。"].join("\n\n");

  const lines: string[] = [];
  for (const row of receipts) {
    const receipt = object(JSON.parse(row.data));
    const result = object(receipt.result);
    const data = object(result.data);
    const name = receipt.toolName;
    const prefix = `${text(name)} · ${text(receipt.toolCallId)} · agentId=${text(row.agentId)} · status=${text(result.status)}`;
    if (receipt.status !== result.status) {
      lines.push(`${prefix} · 回执状态不一致，执行事实未完整。`);
      continue;
    }
    if (result.status !== "ok")
      lines.push(`${prefix} · error.code=${text(object(result.error).code)}`);
    if (name !== "workbook_edit" && name !== "run_script") continue;
    if (result.truncated || data.truncated === true) {
      lines.push(`${prefix} · 回执已截断，执行事实未完整；未将预览当作完整清单。`);
      continue;
    }
    if (name === "workbook_edit") {
      if (result.status !== "ok" || data.dryRun === true) continue;
      const changes = object(data.changes);
      const hasChanges =
        data.created === true ||
        [changes.ranges, changes.structural, changes.added].some(
          (value) => Array.isArray(value) && value.length > 0,
        ) ||
        Object.values(object(changes.cellsBySheet)).some(
          (value) => typeof value === "number" && value > 0,
        );
      lines.push(
        `${prefix} · ${hasChanges ? "写入回执" : "修改回执（未提供写入变更证明）"} · path=${text(data.path)} · docId=${text(data.docId)} · docRevs=${json(revisions(result.docRevs ?? data.docRevs))} · backupPath=${text(data.backupPath)}`,
      );
      const ranges =
        Array.isArray(changes.ranges) && changes.ranges.every((range) => typeof range === "string")
          ? changes.ranges
          : undefined;
      lines.push(`工具回执报告的变更范围=${json(ranges)}；不是用户指定唯一变更或全部副作用证明。`);
      continue;
    }
    const published = data.published;
    // Successful read-only scripts have no publication; returned value is never inspected.
    if (result.status === "ok" && Array.isArray(published) && published.length === 0) continue;
    lines.push(prefix);
    for (const field of ["committedRevs", "published"] as const) {
      const entries = data[field];
      if (!Array.isArray(entries)) {
        lines.push(`${field}=未提供`);
        continue;
      }
      if (!entries.length) {
        lines.push(`${field}=[]`);
        continue;
      }
      for (const entry of entries) {
        const item = object(entry);
        lines.push(
          `${field} · path=${text(item.path)} · docId=${text(item.docId)} · rev=${json(typeof item.rev === "number" && Number.isFinite(item.rev) ? item.rev : undefined)} · backupPath=${text(item.backupPath)}`,
        );
      }
    }
    for (const field of ["rolledBack", "unrecovered"] as const) {
      const entries = data[field];
      lines.push(
        `${field}=${Array.isArray(entries) && entries.every((entry) => typeof entry === "string") ? json(entries) : "未提供"}`,
      );
    }
  }
  return [
    ...heading,
    ...scopes,
    ...(lines.length
      ? lines
      : ["本轮范围内未取得上述工具的写入／发布或失败回执；不据此推断没有其他副作用。"]),
  ].join("\n\n");
}
