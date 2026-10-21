import type { DatabaseSync } from "node:sqlite";
import { parseRange } from "@excelmanus/core";

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

function containsNumber(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.some(containsNumber);
  const object = record(value);
  return object !== undefined && Object.values(object).some(containsNumber);
}

/** A narrow task trigger, not a detector or verifier of numbers in natural language. */
function producesNumericEvidence(data: Record<string, unknown>): boolean {
  const result = record(data.result);
  if (data.status !== "ok" || result?.status !== "ok") return false;
  const out = record(result.data);
  if (!out) return false;
  if (data.toolName === "workbook_edit")
    return out.dryRun !== true && containsNumber(out.formulaValues);
  if (data.toolName === "workbook_analyze")
    return (
      typeof out.docId === "string" &&
      ((out.mode === "sql" && containsNumber(out.rows)) ||
        (out.mode === "profile" && containsNumber(out.columns)))
    );
  if (data.toolName === "run_script") {
    const provenance = record(out.provenance);
    return (
      Array.isArray(provenance?.reads) && provenance.reads.length > 0 && containsNumber(out.value)
    );
  }
  return false;
}

type WorkbookRead = { identity: string; rev: number; data: Record<string, unknown> };
function workbookRead(data: Record<string, unknown>): WorkbookRead | undefined {
  const result = record(data.result);
  const out = record(result?.data);
  if (data.toolName !== "workbook_read" || data.status !== "ok" || result?.status !== "ok" || !out)
    return;
  const rev = record(result.docRevs ?? out.docRevs)?.[String(out.docId)];
  const sha = record(out.sourceFile)?.currentSha256;
  if (
    typeof out.docId !== "string" ||
    !out.docId ||
    typeof out.path !== "string" ||
    !out.path ||
    typeof rev !== "number" ||
    !Number.isInteger(rev) ||
    rev < 0 ||
    typeof sha !== "string" ||
    !sha
  )
    return;
  return { identity: JSON.stringify([out.docId, out.path, rev, sha]), rev, data: out };
}

/** A saved linked pivot plus complete actual numeric coverage, not all read-only chats. */
function requiresPivotReport(reads: WorkbookRead[]): boolean {
  for (const objectRead of reads) {
    if (objectRead.data.mode !== "objects") continue;
    const facts = record(objectRead.data.reportFacts);
    if (facts?.version !== 1 || !Array.isArray(facts.pivots)) continue;
    for (const value of facts.pivots) {
      const pivot = record(value);
      const checkpoint = record(pivot?.checkpoint);
      if (
        pivot?.linked !== true ||
        typeof pivot.sheet !== "string" ||
        typeof pivot.range !== "string" ||
        checkpoint?.isCurrent !== true ||
        checkpoint.rev !== objectRead.rev ||
        checkpoint.currentRev !== objectRead.rev
      )
        continue;
      for (const rangeRead of reads) {
        if (rangeRead.identity !== objectRead.identity || rangeRead.data.mode !== "range") continue;
        const returned = record(rangeRead.data.readWindow)?.returnedRange;
        const values = rangeRead.data.values;
        if (typeof returned !== "string" || !Array.isArray(values)) continue;
        try {
          const area = parseRange(pivot.range),
            actual = parseRange(returned);
          if (
            (area.sheet !== undefined && area.sheet !== pivot.sheet) ||
            (actual.sheet ?? rangeRead.data.sheet) !== pivot.sheet ||
            actual.startRow > area.startRow ||
            actual.endRow < area.endRow ||
            actual.startCol > area.startCol ||
            actual.endCol < area.endCol
          )
            continue;
          let complete = true,
            numeric = false;
          for (let row = area.startRow; row <= area.endRow; row++) {
            const cells = values[row - actual.startRow];
            if (!Array.isArray(cells) || cells.length <= area.endCol - actual.startCol) {
              complete = false;
              break;
            }
            for (let col = area.startCol; col <= area.endCol; col++) {
              const cell = cells[col - actual.startCol];
              if (typeof cell === "number" && Number.isFinite(cell)) numeric = true;
            }
          }
          if (complete && numeric) return true;
        } catch {
          // Unknown/malformed metadata cannot broaden the report trigger.
        }
      }
    }
  }
  return false;
}

/** Reconstruct from the log so stop/resume and process recovery cannot erase the obligation. */
export function numericDeliveryState(
  db: DatabaseSync,
  sessionId: string,
  agentId: string,
  turnId: string,
): { required: boolean; rejected: number } {
  const start = db
    .prepare(
      "SELECT seq, data FROM session_log WHERE session_id=? AND agent_id=? AND type='turn.started' AND json_extract(data,'$.turnId')=? ORDER BY seq DESC LIMIT 1",
    )
    .get(sessionId, agentId, turnId) as { seq: number; data: string } | undefined;
  if (!start) return { required: false, rejected: 0 };
  let required = JSON.parse(start.data).numericDeliveryRequired === true;
  let rejected = 0;
  const rows = db
    .prepare(
      "SELECT type,data FROM session_log WHERE session_id=? AND agent_id=? AND seq>? AND seq<COALESCE((SELECT MIN(seq) FROM session_log WHERE session_id=? AND agent_id=? AND type='turn.started' AND seq>?),9223372036854775807) AND type IN ('tool.result','model.output','inbox.delivered') ORDER BY seq",
    )
    .all(sessionId, agentId, start.seq, sessionId, agentId, start.seq) as {
    type: string;
    data: string;
  }[];
  const workbookReads: WorkbookRead[] = [];
  for (const row of rows) {
    const data = JSON.parse(row.data) as Record<string, unknown>;
    if (row.type === "tool.result" && producesNumericEvidence(data)) required = true;
    if (row.type === "tool.result") {
      const read = workbookRead(data);
      if (read) workbookReads.push(read);
    }
    if (row.type === "model.output" && data.deliveryStatus === "rejected") rejected += 1;
    if (
      row.type === "inbox.delivered" &&
      data.toAgentId === agentId &&
      typeof data.messageId === "string"
    ) {
      const sent = db
        .prepare(
          "SELECT l.agent_id AS sender,l.data FROM session_log l JOIN agents a ON a.session_id=l.session_id AND a.id=l.agent_id WHERE l.session_id=? AND l.type='inbox.sent' AND json_extract(l.data,'$.messageId')=? AND json_extract(l.data,'$.kind')='report' AND json_extract(l.data,'$.toAgentId')=? AND a.parent_id=? ORDER BY l.seq DESC LIMIT 1",
        )
        .get(sessionId, data.messageId, agentId, agentId) as
        | { sender: string; data: string }
        | undefined;
      if (!sent) continue;
      const report = JSON.parse(sent.data) as Record<string, unknown>;
      const metadata = record(report.numericDelivery);
      if (
        !metadata ||
        report.fromAgentId !== sent.sender ||
        typeof metadata.turnId !== "string" ||
        !["completed", "failed", "interrupted"].includes(String(metadata.outcome))
      )
        continue;
      // Check the persisted child terminal event, not the report's free-form prose.
      const terminal = db
        .prepare(
          "SELECT 1 FROM session_log WHERE session_id=? AND agent_id=? AND type=? AND json_extract(data,'$.turnId')=? LIMIT 1",
        )
        .get(sessionId, sent.sender, `turn.${String(metadata.outcome)}`, metadata.turnId);
      if (terminal) required = true;
    }
  }
  return { required: required || requiresPivotReport(workbookReads), rejected };
}

export const NUMERIC_DELIVERY_GUIDANCE =
  "本轮已产生工作簿数值证据，最终回复必须用 present 的 finalize 分支交付，不再接受自由文本终稿。" +
  "只能复制当前可见工具正文 numericEvidence.sources 中的 refId；若只报部分指标，从 candidates.items 改选对应 refId，不填写数值、标题或说明，不构造指针。" +
  "先完成必要回读；额外中间合计、差值、舍入增量或字符数解释必须先用 workbook_analyze SQL 或只读 run_script 实际计算，随后引用结果。" +
  '例：{finalize:{status:"complete",sources:[{refId:"从工具正文复制的refId"}]}}。' +
  "完整交付必须包含用户要求的全部结果和解释证据，不能只选主表省略必报项。非数值解释候选须从目录选择并与真实数值来源一起提交。" +
  '用户要求单位或指标说明时，先读回当前文件的真实表头或行标签，在finalize.bindings中复制{valueRefId,labelRefId,relation:"same_row"或"same_column"}，不自填单位或把SQL别名当业务身份。' +
  "透视报告同时选择objects结果中reportFacts整体候选，引用真实对象关联及保存总计事实；保存值不等于已刷新，读窗只按各次来源说明，不能把较早的大范围称为最近读取。" +
  "逐表排序说明使用workbook_analyze mode=sort_preflight的真实整体候选及执行回执，未执行不能说执行失败。文件交付由宿主按选定证据核验当前已保存文件并生成卡片，不能只写文件名或用自由note补事实；若尚未保存，等待已有自动保存后重新回读。" +
  '无法交付时用 {finalize:{status:"incomplete",sources:[]}} 明确结束为数值交付未完成。';
