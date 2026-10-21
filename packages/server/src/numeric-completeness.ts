import type { DatabaseSync } from "node:sqlite";
import { formatRange, parseRange } from "@excelmanus/core";
import { numericExecutionReceiptScope } from "@excelmanus/kernel";
import {
  currentMacroEvidence,
  type MacroEvidence,
  type NumericPointer,
  type NumericSource,
  numericEvidence,
  numericPointerTokens,
  numericResultContract,
} from "@excelmanus/protocol";
import { ChangeOp } from "@excelmanus/workbook";

type Json = Record<string, unknown>;
const object = (value: unknown): Json =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
type Input = {
  sessionId: string;
  agentId: string;
  turnId?: string;
  sources: NumericPointer[];
  currentDocument(docId: string): { path: string; rev: number } | undefined;
};
export type CompletenessGap = {
  kind:
    | "sort_preflight"
    | "sort_readback"
    | "sort_preservation"
    | "external_links"
    | "macro_evidence"
    | "macro_preservation"
    | "limit";
  docId: string;
  path: string;
  targetRange?: string;
  hasHeader?: boolean;
  reason: string;
  reread?: { toolName: string; args: Record<string, unknown> };
};
export type SortExecutionFact = {
  outcome: "executed" | "preflight_only" | "unknown";
  docId: string;
  path: string;
  targetRange: string;
  hasHeader: boolean;
  toolCallId?: string;
  agentId?: string;
  seq?: number;
  rev?: number;
  keys?: { column: number; order: "asc" | "desc" }[];
};
export type NumericReadbackCoverage = {
  toolCallId: string;
  seq: number;
  targetRange: string;
  returnedRange: string;
  source: NumericSource;
  displayedInFull: boolean;
};
type SavedSheetSource = {
  toolCallId: string;
  seq: number;
  source: NumericSource;
  worksheetPart: string;
  worksheetSha256: string;
  supportingPartsSha256: string;
};
export type SortPreservationFact = {
  docId: string;
  path: string;
  targetRange: string;
  hasHeader: boolean;
  scope: "worksheet_xml_and_nonworksheet_package_parts";
  outcome: "saved_equal" | "worksheet_bytes_differ" | "supporting_parts_differ";
  copy: {
    toolCallId: string;
    seq: number;
    sourcePath: string;
    outputPath: string;
    sourceSha256: string;
  };
  baseline: {
    kind: "copy_receipt" | "historical_read";
    toolCallId: string;
    seq: number;
    rev?: number;
    sha256: string;
  };
  before: SavedSheetSource;
  after: SavedSheetSource;
};
type MacroSource = {
  toolCallId: string;
  seq: number;
  source: NumericSource;
  evidence: MacroEvidence;
};
export type MacroPreservationFact = {
  docId: string;
  path: string;
  outcome: "equal" | "different" | "unavailable";
  copy: {
    toolCallId: string;
    seq: number;
    sourcePath: string;
    outputPath: string;
    sourceSha256: string;
  };
  before: MacroSource;
  after: MacroSource;
  checks: Record<
    "vba" | "relationships" | "contentTypes" | "codeNames",
    "equal" | "different" | "unavailable"
  >;
};
function macroSource(row: Receipt): MacroSource | undefined {
  if (row.name !== "workbook_read" || !["objects", "overview"].includes(String(row.data.mode)))
    return;
  const source = numericResultContract(row.name, row.result)?.sources[0];
  const evidence = source && currentMacroEvidence(row.data.macroEvidence, source);
  return source && evidence ? { toolCallId: row.id, seq: row.seq, source, evidence } : undefined;
}
function compareMacros(
  before: MacroEvidence,
  after: MacroEvidence,
): MacroPreservationFact["checks"] {
  const complete = [before, after].every(
    (evidence) =>
      evidence.inspection.status === "complete" &&
      evidence.project.status === "present" &&
      evidence.signatureStatus === "absent",
  );
  const equal = (a: unknown, b: unknown) =>
    !complete ? "unavailable" : JSON.stringify(a) === JSON.stringify(b) ? "equal" : "different";
  return {
    vba: equal(before.project, after.project),
    relationships: equal(before.relationships, after.relationships),
    contentTypes: equal([before.format, before.contentTypes], [after.format, after.contentTypes]),
    codeNames: equal(before.codeNames, after.codeNames),
  };
}
type Target = { docId: string; path: string; targetRange: string; hasHeader: boolean };
type Receipt = {
  seq: number;
  agentId: string;
  name: string;
  id: string;
  result: Json;
  data: Json;
};
const pointKey = (source: NumericPointer) => JSON.stringify([source.toolCallId, source.pointer]);
function normalizedRange(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  try {
    const range = parseRange(value);
    return range.sheet ? formatRange(range) : undefined;
  } catch {
    return;
  }
}
function contains(outer: unknown, inner: string): boolean {
  if (typeof outer !== "string") return false;
  try {
    const a = parseRange(outer),
      b = parseRange(inner);
    return (
      a.sheet === b.sheet &&
      a.startRow <= b.startRow &&
      a.endRow >= b.endRow &&
      a.startCol <= b.startCol &&
      a.endCol >= b.endCol
    );
  } catch {
    return false;
  }
}
function at(value: unknown, pointer: string): unknown {
  let result = value;
  for (const key of numericPointerTokens(pointer) ?? []) {
    if (!result || typeof result !== "object" || !Object.hasOwn(result, key)) return undefined;
    result = (result as Json)[key];
  }
  return result;
}
function targetOf(row: Receipt): Target | undefined {
  const p = object(row.data.sortPreflight),
    targetRange = normalizedRange(p.targetRange);
  if (
    row.name !== "workbook_analyze" ||
    row.data.mode !== "sort_preflight" ||
    !targetRange ||
    typeof p.hasHeader !== "boolean" ||
    p.execution !== "not_executed" ||
    !["safe", "blocked"].includes(String(p.status)) ||
    !Array.isArray(p.merges) ||
    !numericResultContract(row.name, row.result)
  )
    return;
  if (parseRange(targetRange).sheet !== p.sheet) return;
  return {
    docId: String(row.data.docId),
    path: String(row.data.path),
    targetRange,
    hasHeader: p.hasHeader,
  };
}
const targetKey = (target: Target) =>
  JSON.stringify([target.docId, target.path, target.targetRange, target.hasHeader]);
function savedSheetSource(row: Receipt): SavedSheetSource | undefined {
  const preflight = object(row.data.sortPreflight),
    saved = object(preflight.savedSheet);
  const source = numericResultContract(row.name, row.result)?.sources[0];
  const hash = (value: unknown): value is string =>
    typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  if (
    !source ||
    saved.scope !== "worksheet_xml_and_nonworksheet_package_parts" ||
    saved.status !== "confirmed_checkpoint" ||
    saved.sheet !== preflight.sheet ||
    saved.checkpointRev !== source.rev ||
    saved.packageSha256 !== source.sourceFile.currentSha256 ||
    source.sourceFile.pendingWrite !== false ||
    !hash(saved.packageSha256) ||
    typeof saved.worksheetPart !== "string" ||
    !saved.worksheetPart ||
    !hash(saved.worksheetSha256) ||
    !hash(saved.supportingPartsSha256)
  )
    return;
  return {
    toolCallId: row.id,
    seq: row.seq,
    source,
    worksheetPart: saved.worksheetPart,
    worksheetSha256: saved.worksheetSha256,
    supportingPartsSha256: saved.supportingPartsSha256,
  };
}

/** Close only host-observed families for selected documents, not arbitrary natural-language duties.
 * Old/child receipts establish targets only. Added references still require the finalizer's
 * session/visibility/value/revision/SHA checks; this helper never reads a workbook or refreshes it.
 */
export function planNumericCompleteness(
  db: DatabaseSync,
  input: Input,
): {
  sources: NumericPointer[];
  missing: CompletenessGap[];
  sortExecutions: SortExecutionFact[];
  readbacks: NumericReadbackCoverage[];
  sortPreservations: SortPreservationFact[];
  macroPreservations: MacroPreservationFact[];
} {
  const sources = [...input.sources],
    missing: CompletenessGap[] = [],
    sortExecutions: SortExecutionFact[] = [],
    readbacks: NumericReadbackCoverage[] = [],
    sortPreservations: SortPreservationFact[] = [],
    macroPreservations: MacroPreservationFact[] = [];
  const scope = numericExecutionReceiptScope(db, input.sessionId, input.agentId, input.turnId);
  if (scope.startSeq === undefined)
    return { sources, missing, sortExecutions, readbacks, sortPreservations, macroPreservations };
  const scoped = new Map<number, Receipt>();
  const observed: Receipt[] = [];
  const executionReceipts: Receipt[] = [];
  for (const row of scope.receipts) {
    const receipt = object(JSON.parse(row.data)),
      result = object(receipt.result);
    if (typeof receipt.toolCallId !== "string" || typeof receipt.toolName !== "string") continue;
    const entry: Receipt = {
      seq: row.seq,
      agentId: row.agentId,
      name: receipt.toolName,
      id: receipt.toolCallId,
      result,
      data: object(result.data),
    };
    observed.push(entry);
    // Failed scripts may already have committed or published before rollback failed.
    // They affect historical execution uncertainty only, never evidence or coverage.
    if (
      receipt.status === result.status &&
      ((receipt.toolName === "run_script" &&
        ["ok", "partial", "error", "uncertain"].includes(String(result.status))) ||
        (receipt.toolName === "workbook_edit" && result.status === "ok"))
    )
      executionReceipts.push(entry);
    if (receipt.status === "ok" && result.status === "ok") scoped.set(row.seq, entry);
  }
  const visible = db
    .prepare(
      "SELECT c.item,l.seq,l.data FROM agent_context c JOIN session_log l ON l.session_id=c.session_id AND l.seq=c.from_seq WHERE c.session_id=? AND c.agent_id=? AND c.superseded=0 AND l.agent_id=? AND l.type='tool.result' AND json_extract(c.item,'$.kind')='toolResult' ORDER BY c.idx DESC",
    )
    .all(input.sessionId, input.agentId, input.agentId) as {
    item: string;
    seq: number;
    data: string;
  }[];
  const candidates = new Map<string, { row: Receipt; pointers: Set<string>; visibleData: Json }>();
  const visibleReceipts = new Map<number, Receipt>();
  for (const row of visible) {
    const shown = object(JSON.parse(row.item)),
      record = object(JSON.parse(row.data)),
      result = object(record.result);
    const id = record.toolCallId,
      name = record.toolName;
    if (
      typeof id !== "string" ||
      typeof name !== "string" ||
      candidates.has(id) ||
      shown.toolCallId !== id ||
      shown.toolName !== name ||
      shown.isError === true ||
      record.status !== "ok" ||
      result.status !== "ok"
    )
      continue;
    const visibleData = object(object(shown.output).data);
    if (
      object(shown.output).status === "ok" &&
      ["docId", "path", "mode", "sourceFile", "docRevs", "results"].every(
        (key) => JSON.stringify(object(result.data)[key]) === JSON.stringify(visibleData[key]),
      )
    ) {
      visibleReceipts.set(row.seq, {
        seq: row.seq,
        agentId: input.agentId,
        name,
        id,
        result,
        data: object(result.data),
      });
    }
    const actual = numericEvidence(id, name, result),
      display = numericEvidence(id, name, shown.output);
    if (
      !actual ||
      !display ||
      JSON.stringify(actual.sourceScopes) !== JSON.stringify(display.sourceScopes)
    )
      continue;
    const pointers = new Set(
      actual.candidates.items
        .filter(
          (candidate) =>
            display.candidates.items.some((item) => item.pointer === candidate.pointer) &&
            JSON.stringify(at(result, candidate.pointer)) ===
              JSON.stringify(at(shown.output, candidate.pointer)),
        )
        .map((candidate) => candidate.pointer),
    );
    candidates.set(id, {
      row: { seq: row.seq, agentId: input.agentId, name, id, result, data: object(result.data) },
      pointers,
      visibleData: object(object(shown.output).data),
    });
  }
  const selectedDocs = new Map<string, string>();
  for (const source of input.sources) {
    const candidate = candidates.get(source.toolCallId);
    if (!candidate?.pointers.has(source.pointer)) continue;
    for (const origin of numericResultContract(candidate.row.name, candidate.row.result)?.sources ??
      [])
      selectedDocs.set(origin.docId, origin.path);
  }
  const selected = (row: Receipt) => selectedDocs.get(String(row.data.docId)) === row.data.path;
  const current = (row: Receipt) => {
    const meta = input.currentDocument(String(row.data.docId));
    const revs = object(row.result.docRevs ?? row.data.docRevs);
    return !!meta && meta.path === row.data.path && revs[String(row.data.docId)] === meta.rev;
  };
  const available = [...candidates.values()].filter(
    ({ row }) => scoped.has(row.seq) && selected(row) && current(row),
  );
  const currentCandidates = [...candidates.values()].filter(
    ({ row }) => scoped.has(row.seq) && current(row),
  );
  const intentOf = (row: Receipt): { seq: number; data: Json } | undefined => {
    const found = db
      .prepare(
        "SELECT seq,data FROM session_log WHERE session_id=? AND agent_id=? AND type='tool.intent' AND seq<? AND seq>COALESCE((SELECT MAX(seq) FROM session_log WHERE session_id=? AND agent_id=? AND type='turn.started' AND seq<?),0) AND json_extract(data,'$.toolCallId')=? ORDER BY seq DESC LIMIT 1",
      )
      .get(input.sessionId, row.agentId, row.seq, input.sessionId, row.agentId, row.seq, row.id) as
      | { seq: number; data: string }
      | undefined;
    return found ? { seq: found.seq, data: object(JSON.parse(found.data)) } : undefined;
  };
  const copies = observed.flatMap((row) => {
    if (row.name !== "files") return [];
    const intent = intentOf(row),
      args = object(intent?.data.args);
    if (intent?.data.toolName !== "files" || !Array.isArray(args.ops)) return [];
    return args.ops.map(object).flatMap((op) =>
      op.op === "copy" && typeof op.path === "string" && typeof op.to === "string"
        ? [
            {
              row,
              intent,
              sourcePath: op.path,
              outputPath: op.to,
              sourceSha256: object(object(intent.data.intentMeta).paths)[op.path],
              destinationBefore: object(object(intent.data.intentMeta).paths)[op.to],
            },
          ]
        : [],
    );
  });
  const used = new Set(sources.map(pointKey));
  const referenceBudget = new Set(used);
  const append = (row: Receipt, pointer: string) => {
    const source = { toolCallId: row.id, pointer },
      key = pointKey(source);
    if (used.has(key)) return;
    if (!referenceBudget.has(key) && referenceBudget.size >= 32) {
      if (!missing.some((gap) => gap.kind === "limit"))
        missing.push({
          kind: "limit",
          docId: String(row.data.docId),
          path: String(row.data.path),
          reason: "完整目标证据超过32处引用；请缩小当前读窗，不会截断为完整交付。",
        });
      return;
    }
    used.add(key);
    referenceBudget.add(key);
    sources.push(source);
  };
  const targets = new Map<string, Target>();
  const external = new Map<string, string>();
  // An XLSM extension only requests inspection; it is never proof that VBA exists.
  const macros = new Map([...selectedDocs].filter(([, path]) => /\.xlsm$/i.test(path)));
  for (const row of scoped.values()) {
    if (!selected(row)) continue;
    const target = targetOf(row);
    if (target) targets.set(targetKey(target), target);
    if (
      row.name === "workbook_read" &&
      (row.data.macroEvidence !== undefined ||
        object(row.data.preserved).hasMacros === true ||
        object(row.data.packageFormat).macroEnabled === true)
    )
      macros.set(String(row.data.docId), String(row.data.path));
    const links = object(object(row.data.preserved).externalLinkDetails);
    if (
      row.name === "workbook_read" &&
      ["overview", "objects"].includes(String(row.data.mode)) &&
      links.source === "preserved_package" &&
      [links.links, links.formulaCaches].some((value) => Array.isArray(value) && value.length)
    )
      external.set(String(row.data.docId), String(row.data.path));
  }
  if (targets.size + external.size + macros.size > 32) {
    missing.push({
      kind: "limit",
      docId: "",
      path: "",
      reason: "本轮已检查目标超过32项，无法作为有界完整交付。",
    });
    return { sources, missing, sortExecutions, readbacks, sortPreservations, macroPreservations };
  }
  for (const target of targets.values()) {
    const preflight = available.find(
      ({ row, pointers }) =>
        pointers.has("/data/sortPreflight") &&
        targetKey(targetOf(row) ?? { docId: "", path: "", targetRange: "", hasHeader: false }) ===
          targetKey(target),
    );
    if (preflight) append(preflight.row, "/data/sortPreflight");
    else
      missing.push({
        kind: "sort_preflight",
        ...target,
        reason: "缺少当前修订、当前代理可见的同目标排序预检；旧预检只用于确定待重取目标。",
        reread: {
          toolName: "workbook_analyze",
          args: {
            path: target.path,
            mode: "sort_preflight",
            range: target.targetRange,
            hasHeader: target.hasHeader,
          },
        },
      });
    const readback = available.find(
      ({ row, visibleData }) =>
        row.name === "workbook_read" &&
        row.data.mode === "range" &&
        row.data.docId === target.docId &&
        row.data.path === target.path &&
        !row.result.truncated &&
        row.data.truncated !== true &&
        object(row.data.readWindow).complete === true &&
        object(row.data.readWindow).offset === 0 &&
        contains(object(row.data.readWindow).returnedRange, target.targetRange) &&
        Array.isArray(row.data.values) &&
        Array.isArray(row.data.formulas) &&
        JSON.stringify(row.data.values) === JSON.stringify(visibleData.values) &&
        JSON.stringify(row.data.formulas) === JSON.stringify(visibleData.formulas) &&
        JSON.stringify(row.data.readWindow) === JSON.stringify(visibleData.readWindow),
    );
    if (readback) {
      const source = numericResultContract(readback.row.name, readback.row.result)?.sources[0];
      if (source)
        readbacks.push({
          toolCallId: readback.row.id,
          seq: readback.row.seq,
          targetRange: target.targetRange,
          returnedRange: String(object(readback.row.data.readWindow).returnedRange),
          source,
          displayedInFull: false,
        });
    } else
      missing.push({
        kind: "sort_readback",
        ...target,
        reason:
          "缺少覆盖该目标的当前完整行值和公式读回；不以少量数字代替记录关联，不能拼接不完整分页。",
        reread: {
          toolName: "workbook_read",
          args: {
            path: target.path,
            mode: "range",
            range: target.targetRange,
            facets: ["values", "formulas"],
            offset: 0,
          },
        },
      });
    const fact: SortExecutionFact = { ...target, outcome: "preflight_only" };
    for (const row of executionReceipts) {
      if (row.name === "run_script") {
        // Script receipts identify commits/publications here, not in top-level docId/path.
        // Neither returned value nor code proves which operation actually ran.
        if (
          [row.data.published, row.data.committedRevs].some(
            (entries) =>
              Array.isArray(entries) &&
              entries.some((entry) => {
                const document = object(entry);
                return document.docId === target.docId && document.path === target.path;
              }),
          )
        )
          fact.outcome = "unknown";
        continue;
      }
      if (
        row.data.docId !== target.docId ||
        row.data.path !== target.path ||
        row.name !== "workbook_edit"
      )
        continue;
      if (row.data.dryRun === true) continue;
      const previousOutcome = fact.outcome;
      fact.outcome = "unknown";
      if (
        row.name !== "workbook_edit" ||
        row.data.dryRun !== false ||
        row.result.truncated ||
        row.data.truncated
      )
        continue;
      const intentRow = db
        .prepare(
          "SELECT data FROM session_log WHERE session_id=? AND agent_id=? AND type='tool.intent' AND seq<? AND seq>COALESCE((SELECT MAX(seq) FROM session_log WHERE session_id=? AND agent_id=? AND type='turn.started' AND seq<?),0) AND json_extract(data,'$.toolCallId')=? ORDER BY seq DESC LIMIT 1",
        )
        .get(
          input.sessionId,
          row.agentId,
          row.seq,
          input.sessionId,
          row.agentId,
          row.seq,
          row.id,
        ) as { data: string } | undefined;
      const intent = object(intentRow ? JSON.parse(intentRow.data) : undefined),
        args = object(intent.args);
      if (
        intent.toolName !== "workbook_edit" ||
        (args.docId !== target.docId && args.path !== target.path) ||
        !Array.isArray(args.ops)
      )
        continue;
      // A successful explicit sort of a different sheet is not an unknown operation
      // on this target. This does not assert that this sheet was never otherwise changed.
      if (
        args.ops.length &&
        args.ops.map(object).every((op) => {
          const range = normalizedRange(op.range);
          return (
            op.op === "sort" &&
            range &&
            parseRange(range).sheet !== parseRange(target.targetRange).sheet
          );
        })
      ) {
        fact.outcome = previousOutcome;
        continue;
      }
      // tool.intent retains raw arguments. Apply the execution schema's defaults,
      // notably sort.header=true (unlike sort_preflight.hasHeader=false).
      const operation = args.ops
        .flatMap((value) => {
          const parsed = ChangeOp.safeParse(value);
          return parsed.success && parsed.data.op === "sort" ? [parsed.data] : [];
        })
        .find(
          (op) =>
            normalizedRange(op.range) === target.targetRange && op.header === target.hasHeader,
        );
      const rev = object(row.result.docRevs ?? row.data.docRevs)[target.docId];
      if (operation && typeof rev === "number" && Number.isInteger(rev)) {
        Object.assign(fact, {
          outcome: "executed",
          toolCallId: row.id,
          agentId: row.agentId,
          seq: row.seq,
          rev,
          keys: operation.keys,
        });
        break;
      }
    }
    sortExecutions.push(fact);
    // Only copied outputs have this bounded two-file obligation. A standalone read-only
    // preflight does not silently become a general preservation audit.
    const copy = copies.filter((entry) => entry.outputPath === target.path).at(-1);
    if (!copy || object(preflight?.row.data.sortPreflight).status !== "blocked") continue;
    const gap = (reason: string, path?: string) =>
      missing.push({
        kind: "sort_preservation",
        ...target,
        reason,
        ...(path
          ? {
              reread: {
                toolName: "workbook_analyze",
                args: {
                  path,
                  mode: "sort_preflight",
                  range: target.targetRange,
                  hasHeader: target.hasHeader,
                },
              },
            }
          : {}),
      });
    const matchedCopyResult = Array.isArray(copy.row.data.results)
      ? copy.row.data.results
          .map(object)
          .find((entry) => entry.path === copy.sourcePath && entry.to === copy.outputPath)
      : undefined;
    if (
      !scoped.has(copy.row.seq) ||
      !visibleReceipts.has(copy.row.seq) ||
      copy.row.result.truncated === true ||
      copy.row.data.truncated === true ||
      copy.destinationBefore !== null ||
      typeof copy.sourceSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(copy.sourceSha256) ||
      !matchedCopyResult
    ) {
      gap("复制来源缺少本轮真实、可见成功回执及对应源 SHA／目标原不存在身份，不能声明原样。");
      continue;
    }
    const sourceHash = copy.sourceSha256;
    let baseline: SortPreservationFact["baseline"] | undefined;
    const receiptBaseline = object(matchedCopyResult.copyBaseline);
    if (Object.hasOwn(matchedCopyResult, "copyBaseline")) {
      if (
        receiptBaseline.version === 1 &&
        receiptBaseline.sourceSha256 === sourceHash &&
        receiptBaseline.destinationSha256 === sourceHash &&
        receiptBaseline.destinationWasAbsent === true
      )
        baseline = {
          kind: "copy_receipt",
          toolCallId: copy.row.id,
          seq: copy.row.seq,
          sha256: sourceHash,
        };
    } else {
      // Legacy receipts can use a real copy-after/write-before revision-zero observation only
      // as historical file identity. It never enters the current-value reference list.
      const initialRead = [...visibleReceipts.values()]
        .filter(
          (row) =>
            scoped.has(row.seq) &&
            row.seq > copy.row.seq &&
            row.data.docId === target.docId &&
            row.data.path === target.path &&
            ["workbook_read", "workbook_analyze"].includes(row.name) &&
            object(row.result.docRevs ?? row.data.docRevs)[target.docId] === 0 &&
            object(row.data.sourceFile).openedSha256 === sourceHash &&
            object(row.data.sourceFile).currentSha256 === sourceHash &&
            object(row.data.sourceFile).pendingWrite === false,
        )
        .sort((a, b) => a.seq - b.seq)[0];
      if (initialRead) {
        const intervening = db
          .prepare(
            "SELECT data FROM session_log WHERE session_id=? AND type='tool.intent' AND seq>? AND seq<? ORDER BY seq",
          )
          .all(input.sessionId, copy.row.seq, initialRead.seq) as { data: string }[];
        const wroteBeforeRead = intervening.some((entry) => {
          const intent = object(JSON.parse(entry.data)),
            args = object(intent.args);
          if (intent.toolName === "run_script") return true;
          if (intent.toolName === "workbook_edit")
            return args.path === target.path || args.docId === target.docId;
          if (["write", "edit"].includes(String(intent.toolName))) return args.path === target.path;
          return (
            intent.toolName === "files" &&
            Array.isArray(args.ops) &&
            args.ops
              .map(object)
              .some(
                (op) =>
                  op.to === target.path ||
                  (op.path === target.path && ["move", "delete"].includes(String(op.op))),
              )
          );
        });
        if (!wroteBeforeRead)
          baseline = {
            kind: "historical_read",
            toolCallId: initialRead.id,
            seq: initialRead.seq,
            rev: 0,
            sha256: sourceHash,
          };
      }
    }
    if (!baseline) {
      gap(
        "缺少真实复制边界基线，或旧复制回执之后、首次输出写入之前的 rev0 读取；当前重读不能补造历史身份。",
      );
      continue;
    }
    const sourcePreflight = currentCandidates.find(({ row, pointers }) => {
      const origin = targetOf(row);
      return (
        pointers.has("/data/sortPreflight") &&
        origin?.path === copy.sourcePath &&
        origin.targetRange === target.targetRange &&
        origin.hasHeader === target.hasHeader
      );
    });
    if (!sourcePreflight) {
      gap("缺少当前代理可见、当前修订的真实复制源整表保存包事实。", copy.sourcePath);
      continue;
    }
    const before = savedSheetSource(sourcePreflight.row),
      after = preflight && savedSheetSource(preflight.row);
    if (!before) {
      gap("复制源尚无已确认当前检查点的完整工作表及共享支持部件事实。", copy.sourcePath);
      continue;
    }
    if (before.source.sourceFile.currentSha256 !== sourceHash) {
      gap("当前原件 SHA 与复制时源 SHA 不同，不能将现在的源表冒充原始复制基线。");
      continue;
    }
    if (!after) {
      gap("输出尚无已确认当前检查点的完整工作表及共享支持部件事实。", target.path);
      continue;
    }
    const proofReferences = [before, after].map((entry) =>
      pointKey({
        toolCallId: entry.toolCallId,
        pointer: "/data/sortPreflight",
      }),
    );
    if (new Set([...referenceBudget, ...proofReferences]).size > 32) {
      missing.push({
        kind: "limit",
        ...target,
        reason: "整表保存比较的两个真实来源也计入32处引用，当前证据超出预算，不会隐藏追加来源。",
      });
      continue;
    }
    for (const key of proofReferences) referenceBudget.add(key);
    sortPreservations.push({
      ...target,
      scope: "worksheet_xml_and_nonworksheet_package_parts",
      outcome:
        before.worksheetPart !== after.worksheetPart ||
        before.worksheetSha256 !== after.worksheetSha256
          ? "worksheet_bytes_differ"
          : before.supportingPartsSha256 !== after.supportingPartsSha256
            ? "supporting_parts_differ"
            : "saved_equal",
      copy: {
        toolCallId: copy.row.id,
        seq: copy.row.seq,
        sourcePath: copy.sourcePath,
        outputPath: copy.outputPath,
        sourceSha256: sourceHash,
      },
      baseline,
      before,
      after,
    });
  }
  for (const [docId, path] of external) {
    const report = available.find(
      ({ row, pointers }) =>
        row.data.docId === docId &&
        row.data.path === path &&
        pointers.has("/data/preserved/externalLinkDetails") &&
        object(row.data.checkpointExternalLinks).isCurrent === true &&
        object(row.data.checkpointExternalLinks).packageState === "confirmed_checkpoint",
    );
    if (report) append(report.row, "/data/preserved/externalLinkDetails");
    else
      missing.push({
        kind: "external_links",
        docId,
        path,
        reason: "已检查的外链目标缺少当前、可见且完整的目标与两层保存缓存事实。",
        reread: { toolName: "workbook_read", args: { path, mode: "objects" } },
      });
  }
  for (const [docId, path] of macros) {
    const afterEntry = available.find(
      ({ row, pointers }) =>
        row.data.docId === docId &&
        row.data.path === path &&
        pointers.has("/data/macroEvidence") &&
        macroSource(row),
    );
    const after = afterEntry && macroSource(afterEntry.row);
    if (!afterEntry || !after) {
      missing.push({
        kind: "macro_evidence",
        docId,
        path,
        reason: "宏对象缺少当前修订、当前代理可见且与保存包 SHA 一致的完整静态证据。",
        reread: { toolName: "workbook_read", args: { path, mode: "objects" } },
      });
      continue;
    }
    append(afterEntry.row, "/data/macroEvidence");
    const matching = copies.filter((copy) => copy.outputPath === path);
    if (!matching.length) continue;
    const gap = (reason: string, sourcePath = path) =>
      missing.push({
        kind: "macro_preservation",
        docId,
        path,
        reason,
        reread: { toolName: "workbook_read", args: { path: sourcePath, mode: "objects" } },
      });
    if (matching.length !== 1) {
      gap("宏副本的复制链存在歧义，不能以相同 VBA 指纹代替真实来源。");
      continue;
    }
    const copy = matching[0]!;
    const results = Array.isArray(copy.row.data.results)
      ? copy.row.data.results
          .map(object)
          .filter((entry) => entry.path === copy.sourcePath && entry.to === path)
      : [];
    const baseline = object(results[0]?.copyBaseline);
    if (
      !scoped.has(copy.row.seq) ||
      !visibleReceipts.has(copy.row.seq) ||
      copy.row.result.truncated === true ||
      copy.row.data.truncated === true ||
      results.length !== 1 ||
      copy.destinationBefore !== null ||
      typeof copy.sourceSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(copy.sourceSha256) ||
      baseline.version !== 1 ||
      baseline.sourceSha256 !== copy.sourceSha256 ||
      baseline.destinationSha256 !== copy.sourceSha256 ||
      baseline.destinationWasAbsent !== true ||
      after.seq <= copy.row.seq
    ) {
      gap("缺少与复制 intent、源和目标路径完全匹配的成功 copyBaseline 回执，不能确认宏保留谱系。");
      continue;
    }
    const beforeEntry = currentCandidates.find(
      ({ row, pointers }) =>
        row.data.path === copy.sourcePath &&
        pointers.has("/data/macroEvidence") &&
        macroSource(row)?.evidence.package.sha256 === copy.sourceSha256,
    );
    const before = beforeEntry && macroSource(beforeEntry.row);
    if (!beforeEntry || !before) {
      gap(
        "复制源缺少当前可见且 package SHA 等于 copyBaseline.sourceSha256 的静态宏证据。",
        copy.sourcePath,
      );
      continue;
    }
    append(beforeEntry.row, "/data/macroEvidence");
    const checks = compareMacros(before.evidence, after.evidence);
    macroPreservations.push({
      docId,
      path,
      outcome: Object.values(checks).includes("unavailable")
        ? "unavailable"
        : Object.values(checks).every((value) => value === "equal")
          ? "equal"
          : "different",
      copy: {
        toolCallId: copy.row.id,
        seq: copy.row.seq,
        sourcePath: copy.sourcePath,
        outputPath: path,
        sourceSha256: copy.sourceSha256,
      },
      before,
      after,
      checks,
    });
  }
  // Data coverage is independent of the presentation budget. Small complete rows are useful
  // to display, but a large fully observed window is not forced into the final text.
  const proofScalars = (value: unknown): number =>
    value !== null && typeof value === "object"
      ? Object.values(value).reduce<number>((count, part) => count + proofScalars(part), 0)
      : 1;
  // Reserve conservatively for the required compact proof before optional full windows.
  // The finalizer still counts its actual rendered projection against the same hard limit.
  const preservationBudget = proofScalars(sortPreservations);
  const scalarCount = (refs: NumericPointer[]) => {
    const leaves = new Set<string>();
    const visit = (toolCallId: string, value: unknown, pointer: string): void => {
      if (leaves.size > 200) return;
      if (value !== null && typeof value === "object") {
        for (const [key, part] of Object.entries(value))
          visit(toolCallId, part, `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`);
      } else leaves.add(pointKey({ toolCallId, pointer }));
    };
    for (const ref of refs)
      visit(
        ref.toolCallId,
        at(candidates.get(ref.toolCallId)?.row.result, ref.pointer),
        ref.pointer,
      );
    return leaves.size + preservationBudget;
  };
  for (const readback of readbacks) {
    const candidate = candidates.get(readback.toolCallId);
    if (!candidate) continue;
    const roots = ["/data/values", "/data/formulas"].map((pointer) => ({
      toolCallId: readback.toolCallId,
      pointer,
    }));
    const added = roots.filter((source) => !used.has(pointKey(source)));
    if (
      roots.every((source) => candidate.pointers.has(source.pointer)) &&
      new Set([...referenceBudget, ...added.map(pointKey)]).size <= 32 &&
      scalarCount([...sources, ...added]) <= 200
    ) {
      for (const source of added) append(candidate.row, source.pointer);
      readback.displayedInFull = true;
    }
  }
  return { sources, missing, sortExecutions, readbacks, sortPreservations, macroPreservations };
}
