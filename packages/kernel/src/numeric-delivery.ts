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
  if (data.toolName === "workbook_analyze" || data.toolName === "workbook_query")
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
  "本轮已有工作簿结果需要受控交付。先用 deliver 的 inspect 获取当前可见事实、文件、检查与说明回执，再用 finalize 选择这些宿主标识；不再接受自由文本结果终稿。" +
  "需要额外数字解释时，先用 workbook_query 或只读 run_script 计算并取得可见事实，不手工填写值、标签、单位、指针或来源证明。查询别名不是已认证业务身份或单位。" +
  "检查覆盖以原始来源和明确声明为准，不能把采样、截断结果或局部通过说成全量正确；文件保存成功不代表业务检查通过。宿主核验所有来源与目标修订、保存字节、计划版本、当前授权及引用可见性，失效时重新观察或核验。" +
  "required_output 失败、unverified 或修复未完成必须保留，不能改为 findings、改写说明或删去引用绕过；源数据诊断发现差异本身可以作为调查结果。只能选择 allowedOutcomes 中当前允许的结果。" +
  "文件内容核验与最终展示分开：展示预算和分页不改变业务状态，不能遗漏用户必报结果、必报计数、各文件结果及必要限制。只读结果无需创建输出文件。" +
  "finalize 成功即终结，由宿主生成最终回复，之后不能追加自由文字；尚未完成则按实际状态交付 partial 或 blocked。";
