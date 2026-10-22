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
  '用户要求简短时，例：{finalize:{status:"complete",presentation:"summary",sources:[{refId:"当前小汇总读窗的refId"}]}}；无简短要求默认 evidence，显式 evidence 仍合法。' +
  "文件内容核验与最终展示是两件事：先验证全部任务、必需表列及业务来源，再选择终稿须报告的完整原文小窗口，不把全部验证明细当成终稿必选来源。" +
  "简短窗口须在最后写入并保存后重新读取，保留完整表头、数据行、原文单位和对象身份；合计最多32个标量格。不猜标题、币种或总计，不遗漏必报计数、异常及各文件结果。" +
  "只能复制当前可见工具正文 numericEvidence.sources 或 candidates.items 的 refId；不能填写值、标题、说明或构造指针。额外中间合计、差值等须先用 workbook_analyze SQL 或只读 run_script 实际计算再引用。" +
  '绑定只复制 numericEvidence.bindings 或 bindingCandidates.items 中与所选数值同次读取的 {bindingId} 到 finalize.bindings，每值最多一个；无合法候选时不自造关系或单位，不把SQL别名当业务身份。' +
  "每个必交文件须有当前已保存文档的真实选定证据，宿主按文档身份、修订和SHA核验并生成文件卡；不要求该文件全部表都进入终稿sources，也不因此减免文件内容核验。" +
  "透视报告选择objects的reportFacts整体候选；保存值不等于已刷新。排序使用sort_preflight真实整体候选与执行回执，未执行不能说执行失败；外链、访问范围和实际失败等必要事实不得省略。" +
  "finalize成功返回就是终结，由宿主生成最终回复，之后不能追加一条简短文字。若显式summary不能安全呈现，宿主保留完整审计和有效文件卡，终结为incomplete并说明简短呈现未满足，不会另开重试机会。" +
  '来源不可见或过期须重新获取，原有200格、24000字符等核验不变；任务尚未完成用 {finalize:{status:"incomplete",sources:[]}} 明确结束。';
