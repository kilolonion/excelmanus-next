import { createHash } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { formatRange, indexToCol, parseRange } from "@excelmanus/core";
import {
  assertToolAccess,
  currentToolAccess,
  numericDeliveryState,
  numericExecutionFacts,
  numericExecutionReceiptScope,
  renderAccessFacts,
  resolveWorkspacePath,
  type SessionLog,
  type ToolContext,
  turnAccessFacts,
  withFileAccessSync,
} from "@excelmanus/kernel";
import {
  currentMacroEvidence,
  decodeNumericBindingId,
  decodeNumericRefId,
  type HarnessBinding,
  type MacroEvidence,
  type NumericLabelBinding,
  type NumericPointer,
  type NumericSource,
  numericEvidence,
  numericLabelUnit,
  numericReadSources,
  numericResultContract,
  numericRefId,
  type ToolResult,
  toToolErrorCode,
} from "@excelmanus/protocol";
import { type DocumentService, displayText } from "@excelmanus/workbook";
import { z } from "zod";
import {
  type MacroPreservationFact,
  planNumericCompleteness,
  type SortPreservationFact,
} from "./numeric-completeness.ts";

const legacyReference = z.strictObject({
  toolCallId: z.string().min(1).max(200),
  pointer: z
    .string()
    .min(1)
    .max(1000)
    .describe(
      "成功 ToolResult 内的 JSON Pointer，例如 /data/values、/data/rows/0/0、/data/value/total",
    ),
});
const reference = z.strictObject({
  refId: z
    .string()
    .min(1)
    .max(7300)
    .describe("只复制当前可见工具正文 numericEvidence 中的 refId；不要构造或改写"),
});
const labelBinding = z.strictObject({
  bindingId: z
    .string()
    .min(1)
    .max(13400)
    .describe(
      "只复制 numericEvidence.bindingCandidates 中当前数值对应的 bindingId；同一值最多一个，不能构造关系",
    ),
});
export const numericFinalization = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("complete"),
    sources: z.array(reference).min(1).max(32),
    bindings: z.array(labelBinding).max(32).optional(),
    presentation: z.enum(["evidence", "summary"]).optional().describe("默认完整证据；summary仅支持完整 range /data/values 或真实 SQL /data/rows，小表含 SQL 表头合计不超过32格；保留实际查询及全部来源，SQL 列名不认证单位，不能生成自由总结"),
  }),
  z.strictObject({ status: z.literal("incomplete"), sources: z.array(reference).length(0) }),
]);
type Finalization = z.infer<typeof numericFinalization>;
const legacyFinalization = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("complete"),
    sources: z.array(legacyReference).min(1).max(32),
  }),
  z.strictObject({ status: z.literal("incomplete"), sources: z.array(legacyReference).length(0) }),
]);
type LegacyFinalization = z.infer<typeof legacyFinalization>;
type Json = Record<string, unknown>;
const object = (value: unknown): Json =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
const MAX_CELLS = 200;
const MAX_TEXT = 24_000;

class EvidenceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
const invalid = (message: string): never => {
  throw new EvidenceError("INVALID_ARGUMENT", message);
};
const evidenceRecovery =
  "不要构造或改写 refId；先用 workbook_read 读取保留标签与单位的小范围，获取新的 numericEvidence，再原样复制合法 sources。";
const tooLarge = (
  reason:
    | "selected_cells"
    | "selected_text"
    | "rendered_text"
    | "incomplete_window"
    | "input_sources",
  observed?: number,
  limit?: number,
): never => {
  throw new EvidenceError(
    "LIMIT_EXCEEDED",
    `证据不能完整交付：reason=${reason}${limit === undefined ? "" : `；limit=${limit}；observed=${observed}（触发时已累计，非完整选择总量）`}。` +
      (reason === "selected_cells"
        ? "整块引用中的表头、字符串和空白也计入标量格预算。"
        : reason === "incomplete_window"
          ? "当前读取窗口或保存缓存已截断，不得把局部引用冒称全量。"
          : "请减少引用范围或重复来源，不会自动截断为完整结果。") +
      evidenceRecovery,
  );
};


/** Only host tool receipts enter this record, never the script's returned value. */
export function captureNumericRead(toolName: string, result: ToolResult): Json | undefined {
  if (result.status !== "ok") return undefined;
  const data = object(result.data);
  const docRevs = object(result.docRevs ?? data.docRevs);
  return {
    toolName,
    docRevs,
    ...Object.fromEntries(
      ["docId", "path", "mode", "sheet", "range", "readWindow", "sourceFile", "sources", "sql"]
        .filter((key) => Object.hasOwn(data, key))
        .map((key) => [key, data[key]]),
    ),
  };
}

function tokens(pointer: string): string[] {
  if (!pointer.startsWith("/") || /~(?:[^01]|$)/.test(pointer))
    return invalid("引用必须是有效 JSON Pointer。");
  return pointer
    .slice(1)
    .split("/")
    .map((key) => key.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function at(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (Array.isArray(current) && !/^(0|[1-9]\d*)$/.test(key)) return invalid("引用数组下标无效。");
    if (!current || typeof current !== "object" || !Object.hasOwn(current, key))
      return invalid("引用指针不存在或不在可见结果中。");
    current = (current as Json)[key];
  }
  return current;
}

function scalar(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}
function cell(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "&#124;")
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n");
}

type Source = NumericSource;
function sourcesOf(read: Json): Source[] {
  return (
    numericReadSources(read) ??
    invalid("来源缺少实际读取范围、受支持的元数据范围、修订或文件状态，请重新读取。")
  );
}
function rejected(message: string): ToolResult {
  return { status: "error", error: { code: "INVALID_ARGUMENT", message, retryable: false } };
}

function scalarLeaves(value: unknown): number {
  return value !== null && typeof value === "object"
    ? Object.values(value).reduce<number>((n, part) => n + scalarLeaves(part), 0)
    : 1;
}
const macroRuntimeBoundary =
  "本次宏核验仅静态读取或比较 OOXML 包及 VBA 二进制数据，没有执行宏，也没有验证宏运行结果。静态存在或保留一致不代表宏能在 Excel 中运行。";
function renderMacroEvidence(evidence: MacroEvidence): string[] {
  const { package: pkg, checkpoint, project, format, contentTypes, codeNames } = evidence;
  const nullable = (value: unknown) => (value === null ? "未提供" : cell(value));
  const type = (value: MacroEvidence["contentTypes"]["vba"]) =>
    `${nullable(value.contentType)} · 声明=${nullable(value.source)} · 匹配=${nullable(value.match)}`;
  return [
    `宏对象静态保存包：${cell(pkg.path)} · packageSHA256=${cell(pkg.sha256)} · packageBytes=${pkg.byteLength} · checkpointRev=${checkpoint.checkpointRev} · currentRev=${checkpoint.currentRev} · packageRev=${checkpoint.packageRev} · packageState=${checkpoint.packageState}。`,
    `真实包类型：${nullable(format.workbookContentType)} · macroEnabled=${format.macroEnabled}。VBA 工程：status=${project.status} · part=${nullable(project.part)} · byteLength=${nullable(project.byteLength)} · SHA256=${nullable(project.sha256)} · cfbHeaderPresent=${nullable(project.cfbHeaderPresent)}。二进制头仅为静态观察，不证明工程可编译、可运行或安全。`,
    `内容类型：workbook=${type(contentTypes.workbook)}；VBA=${type(contentTypes.vba)}；[Content_Types].xml SHA256=${contentTypes.partSha256}。`,
    ...evidence.relationships.map(
      (relation) =>
        `VBA 关系：sourcePart=${cell(relation.sourcePart)} · id=${cell(relation.id)} · type=${cell(relation.type)} · target=${cell(relation.target)} · targetMode=${nullable(relation.targetMode)} · resolvedPart=${nullable(relation.resolvedPart)} · relsPart=${cell(relation.relsPart)} · relsSHA256=${relation.relsSha256}。`,
    ),
    `工作簿 codeName=${nullable(codeNames.workbook)}。`,
    ...codeNames.sheets.map(
      (sheet) =>
        `工作表：${cell(sheet.name)} · codeName=${nullable(sheet.codeName)} · sheetId=${cell(sheet.sheetId)} · relationshipId=${cell(sheet.relationshipId)} · part=${cell(sheet.part)}。`,
    ),
    `静态解析=${evidence.inspection.status} · reasonCode=${evidence.inspection.reasonCode} · signatureStatus=${evidence.signatureStatus}；普通值编辑支持=${evidence.cellEditSupport.status} · reasonCode=${evidence.cellEditSupport.reasonCode}。${evidence.inspection.status === "unsupported" ? "解析范围不受支持，不给出宏保留通过结论。" : "这不是整个工作簿所有单元格不变的证明。"}`,
    macroRuntimeBoundary,
  ];
}
function renderMacroPreservation(fact: MacroPreservationFact): { text: string; leaves: number } {
  const { copy, checks } = fact;
  const endpoints = [fact.before, fact.after].map((endpoint) => ({
    path: endpoint.source.path,
    rev: endpoint.source.rev,
    packageSha256: endpoint.evidence.package.sha256,
    toolCallId: endpoint.toolCallId,
    seq: endpoint.seq,
  }));
  const conclusion =
    fact.outcome === "equal"
      ? "宏静态保留核验一致：VBA SHA-256/字节长度、关系、内容类型和工作簿及工作表 codeName 映射相同。"
      : fact.outcome === "different"
        ? "宏静态比较发现差异，不能声称宏原样保留。"
        : "宏静态比较不可确认，不能声称宏原样保留。";
  return {
    leaves: scalarLeaves({ copy, checks, endpoints }),
    text: `${conclusion}\n真实复制：${cell(copy.sourcePath)} → ${cell(copy.outputPath)} · ${cell(copy.toolCallId)} · from_seq=${copy.seq} · copyBaseline.sourceSha256=${copy.sourceSha256}。复制回执已匹配 intent 及目标初始 SHA；不是以相同 VBA 指纹猜测谱系。\n当前原件与当前保存副本：${endpoints.map((endpoint) => `${cell(endpoint.path)} · rev=${endpoint.rev} · packageSHA256=${endpoint.packageSha256} · ${cell(endpoint.toolCallId)} · from_seq=${endpoint.seq}`).join("；")}。\n静态分项：VBA=${checks.vba}；关系=${checks.relationships}；内容类型=${checks.contentTypes}；codeName映射=${checks.codeNames}。仅为明确静态范围的端点比较，不证明其余单元格均未改变，也不等同运行验证。`,
  };
}
/** Exact workbook host family, not arbitrary preserved metadata or script-returned text. */
function renderExternalLinks(details: Json): string[] {
  if (
    details.source !== "preserved_package" ||
    details.updated !== false ||
    !Array.isArray(details.links) ||
    !Array.isArray(details.formulaCaches)
  )
    return invalid("外链事实不是受支持的保存包读取结果。");
  if (details.truncated === true) tooLarge("incomplete_window");
  const sections = ["外链对象与保存缓存（未重新获取目标，不把缓存视为实时值）："];
  const cacheText = (value: Json) =>
    `type=${cell(value.type ?? "未提供")} · present=${cell(value.present)} · rawValue=${cell(scalar(value.rawValue ?? null))}${typeof value.reason === "string" ? ` · reason=${cell(value.reason)}` : ""}`;
  sections.push(
    `保存公式缓存覆盖：formulaCoverage=${cell(details.formulaCoverage ?? "未提供")} · totalFormulaCells=${cell(details.totalFormulaCells ?? "未提供")} · returnedFormulaCells=${cell(details.returnedFormulaCells ?? "未提供")} · truncated=${cell(details.truncated ?? "未提供")} · unresolvedSharedFormulaCells=${cell(details.unresolvedSharedFormulaCells ?? "未提供")}。未提供字段不补猜，不将此范围称为全工作簿全部外部公式。`,
  );
  for (const entry of details.links) {
    const link = object(entry),
      target = object(link.target),
      cache = object(link.cache);
    sections.push(
      `外链：index=${cell(link.index)} · relationshipId=${cell(link.relationshipId)} · part=${cell(link.part ?? "未提供")} · kind=${cell(link.kind)} · linked=${cell(link.linked)}；目标原文=${cell(target.raw === undefined ? "未提供" : scalar(target.raw))} · mode=${cell(target.mode ?? "未提供")} · relationshipId=${cell(target.relationshipId ?? "未提供")}（目标原文不是已读取路径声明）。${typeof link.reason === "string" ? ` 原因=${cell(link.reason)}` : ""}`,
    );
    if (!Array.isArray(cache.cells) || cache.source !== "saved_external_link") {
      if (link.linked === false && typeof link.reason === "string") {
        sections.push(
          "保存外链缓存 saved_external_link：未提供可确认的缓存；以上宿主原因不代表目标已读取或缓存为空。",
        );
        continue;
      }
      return invalid("外链保存缓存缺少真实来源。");
    }
    if (cache.truncated === true) tooLarge("incomplete_window");
    sections.push(
      `保存外链缓存覆盖：totalCells=${cell(cache.totalCells ?? "未提供")} · returnedCells=${cell(cache.returnedCells ?? "未提供")} · truncated=${cell(cache.truncated ?? "未提供")}。`,
    );
    for (const entry of cache.cells) {
      const value = object(entry);
      sections.push(
        `保存外链缓存 saved_external_link：${cell(value.sheet ?? value.sheetId)}!${cell(value.cell)} · ${cacheText(value)}。`,
      );
    }
  }
  for (const entry of details.formulaCaches) {
    const formula = object(entry),
      cache = object(formula.cache);
    if (cache.source !== "saved_worksheet") return invalid("公式保存缓存缺少真实来源。");
    sections.push(
      `保存公式：${cell(formula.sheet)}!${cell(formula.cell)} = ${cell(formula.formula)}；保存公式缓存 saved_worksheet：${cacheText(cache)}。${typeof formula.reason === "string" ? ` 关联限制=${cell(formula.reason)}` : ""}`,
    );
  }
  if (Array.isArray(details.limitations))
    for (const limitation of details.limitations)
      if (typeof limitation === "string")
        sections.push(`此保存包解析调用的限制：${cell(limitation)}`);
  sections.push(
    "本次读取的外链缓存未更新；关联原件的独立读取不等于工作簿外链刷新。实际访问路径另见本轮宿主记录。",
  );
  return sections;
}
function renderReportFacts(report: Json): {
  sections: string[];
  leaves: number;
  numericCount: number;
} {
  if (report.version !== 1 || !Array.isArray(report.pivots) || !Array.isArray(report.sheets))
    return invalid("报告事实不完整，请重新读取对象。");
  const sections = [
    "工具实际读到的工作簿对象（保存状态，不是刷新结果）",
    `工作表：${report.sheets
      .map((entry) => {
        const sheet = object(entry);
        return `${cell(sheet.name)}（id=${cell(sheet.id)}）`;
      })
      .join("；")}`,
  ];
  let numericCount = 0;
  for (const entry of report.pivots) {
    const pivot = object(entry),
      source = object(pivot.source),
      checkpoint = object(pivot.checkpoint);
    sections.push(
      `透视表：${cell(pivot.name)} · sheet=${cell(pivot.sheet)} · range=${cell(pivot.range)} · part=${cell(pivot.part)} · linked=${cell(pivot.linked)} · cacheId=${cell(pivot.cacheId)} · cachePart=${cell(pivot.cachePart)}`,
    );
    sections.push(
      `源数据区域：type=${cell(source.type)} · sheet=${cell(source.sheet ?? "未提供")} · ref=${cell(source.ref ?? "未提供")} · name=${cell(source.name ?? "未提供")}；缓存记录数=${cell(pivot.recordCount ?? "未提供")}（不是合计金额或业务总计）。`,
    );
    for (const field of ["slicerCaches", "slicers"] as const) {
      if (!Array.isArray(pivot[field])) return invalid("透视关联事实不完整。");
      sections.push(
        `${field === "slicers" ? "关联切片器" : "关联切片器缓存"}：${
          pivot[field]
            .map((entry) => {
              const item = object(entry);
              return `${cell(item.name)}（${cell(item.part)}）`;
            })
            .join("；") || "无已识别关联"
        }`,
      );
    }
    sections.push(
      `保存当前性：checkpointRev=${cell(checkpoint.rev)} · currentRev=${cell(checkpoint.currentRev)} · isCurrent=${cell(checkpoint.isCurrent)}。`,
    );
    for (const field of ["refreshOnLoad", "enableRefresh"] as const) {
      const flag = object(pivot[field]);
      sections.push(
        `${field}：raw=${cell(scalar(flag.raw))} · effective=${cell(flag.effective)} · defaulted=${cell(flag.defaulted)}。${field === "refreshOnLoad" && flag.effective === true ? "此标记请求 Excel 下次打开时刷新，不代表已实际刷新。" : ""}`,
      );
    }
    const total = object(pivot.savedDisplayTotal);
    if (total.status === "supported") {
      if (
        pivot.linked !== true ||
        checkpoint.isCurrent !== true ||
        typeof total.value !== "number" ||
        !Number.isFinite(total.value) ||
        typeof total.cell !== "string"
      )
        return invalid("保存透视总计缺少当前、关联或真实数值依据。");
      numericCount++;
      const field = object(total.dataField);
      sections.push(
        `当前保存的透视显示总计：${cell(pivot.sheet)}!${cell(total.cell)} = ${cell(total.value)}；透视表=${cell(pivot.name)}；dataField=${cell(field.name)} · field=${cell(field.field)} · subtotal=${cell(field.subtotal)}；rowGrandIndex=${cell(total.rowGrandIndex)} · columnGrandIndex=${cell(total.columnGrandIndex)}。单位未提供，不能推断。这是已保存显示单元格，不是此次重新聚合 cacheRecords 的结果。`,
      );
    } else if (total.status === "unsupported")
      sections.push(
        `保存透视显示总计：尚未暴露受支持的位置和值；原因=${cell(total.reason ?? "未知布局")}，不猜测。`,
      );
    else return invalid("保存总计事实缺少明确支持状态。");
    if (pivot.refreshExecuted !== false || pivot.cacheRecordsAggregated !== false)
      return invalid("报告刷新状态不是受支持的宿主事实。");
    sections.push("本次对象读取未实际刷新，未重新聚合 cacheRecords；不把保存值说成刷新结果。");
  }
  sections.push(
    "尚未暴露的信息：未提供或不支持的字段仍为未知。需要 Excel 验证的交互：切片器点击联动、实际刷新成功及原生交互，本次静态读取未验证。",
  );
  return { sections, leaves: scalarLeaves(report), numericCount };
}
function renderSortPreflight(preflight: Json): string {
  if (
    !["safe", "blocked"].includes(String(preflight.status)) ||
    preflight.execution !== "not_executed" ||
    !Array.isArray(preflight.merges)
  )
    return invalid("排序预检不是受支持的宿主几何事实。");
  const merges = preflight.merges.map((entry) => {
    const merge = object(entry);
    const relation = {
      crosses_boundary: "跨越排序数据边界",
      inside_data: "位于排序数据区域内",
      outside_data: "位于排序数据区域外，不因它阻断",
    }[String(merge.relation)];
    if (!relation) return invalid("未知合并几何关系。");
    const risk = {
      crosses_boundary: "合并跨越本次排序数据边界，不能只重排边界内的部分单元格",
      spans_data_rows:
        "合并跨多条待独立重排的数据行，无法保证合并结构与行记录关联同时保留；此处是实际行几何风险，不认证业务实体",
      inside_data_single_row: "合并位于同一条排序数据行内，当前工具仍不支持该合并区域排序",
      outside_data: "合并在本次排序数据区域外",
    }[String(merge.risk)];
    if (merge.risk !== undefined && !risk) return invalid("未知合并排序风险。");
    return `${cell(merge.range)}（${relation}${risk ? `；${risk}` : ""}）`;
  });
  return `排序预检：${cell(preflight.sheet)} · targetRange=${cell(preflight.targetRange)} · dataRange=${cell(preflight.dataRange)} · hasHeader=${cell(preflight.hasHeader)}。${preflight.status === "blocked" ? "当前预检阻断" : "当前合并几何预检通过"}，本次只读预检未执行排序；原因=${cell(preflight.reason)}。合并依据：${merges.join("；") || "无合并"}。只说明本次预检，不证明整张表始终未变，也不否定此前已执行的排序；实际执行另见宿主回执。`;
}

function renderSortPreservation(fact: SortPreservationFact): { text: string; leaves: number } {
  if (
    fact.scope !== "worksheet_xml_and_nonworksheet_package_parts" ||
    !["saved_equal", "worksheet_bytes_differ", "supporting_parts_differ"].includes(fact.outcome)
  )
    return invalid("保存包比较不是受支持的宿主事实。");
  const endpoint = (value: SortPreservationFact["before"]) => ({
    path: value.source.path,
    rev: value.source.rev,
    sha256: value.source.sourceFile.currentSha256,
    toolCallId: value.toolCallId,
    seq: value.seq,
    worksheetPart: value.worksheetPart,
    worksheetSha256: value.worksheetSha256,
    supportingPartsSha256: value.supportingPartsSha256,
  });
  const before = endpoint(fact.before),
    after = endpoint(fact.after);
  const showEndpoint = (value: typeof before) =>
    `${cell(value.path)} · rev=${value.rev} · SHA256=${cell(value.sha256)} · ${cell(value.toolCallId)} · from_seq=${value.seq} · worksheetPart=${cell(value.worksheetPart)} · worksheetSHA256=${cell(value.worksheetSha256)} · supportingPartsSHA256=${cell(value.supportingPartsSha256)}`;
  const conclusion =
    fact.outcome === "saved_equal"
      ? "保存后整表及所核共享支持部件与复制源保持原样：该工作表 XML 和其余包部件集合的名称及字节一致（排除实际识别出的各工作表 XML，仍保留工作表关系部件）。"
      : fact.outcome === "worksheet_bytes_differ"
        ? "保存后该工作表 XML 的部件位置或字节不同，不能证明该表原样；这不单独判定数据损坏。"
        : "该工作表 XML 字节相同，但所核共享支持部件集合不同，不能证明该表连同共享依赖原样；不把共享差异说成该表一定被改。";
  return {
    leaves: scalarLeaves({
      targetRange: fact.targetRange,
      copy: fact.copy,
      baseline: fact.baseline,
      before,
      after,
    }),
    text: `拒绝目标保存端点核验：${cell(fact.targetRange)}。${conclusion}\n覆盖边界：预检目标范围仍是 ${cell(fact.targetRange)}；保存包比较覆盖完整 worksheetPart 及所核其余包部件，不限于该局部读窗，不是整个工作簿所有工作表比较。\n真实复制：${cell(fact.copy.sourcePath)} → ${cell(fact.copy.outputPath)} · ${cell(fact.copy.toolCallId)} · from_seq=${fact.copy.seq} · 源 SHA256=${cell(fact.copy.sourceSha256)}。基线=${fact.baseline.kind === "copy_receipt" ? "成功复制边界回执" : "复制后首次写入前的历史读取"} · ${cell(fact.baseline.toolCallId)} · from_seq=${fact.baseline.seq}${fact.baseline.rev === undefined ? "" : ` · rev=${fact.baseline.rev}`} · SHA256=${cell(fact.baseline.sha256)}。\n当前原件：${showEndpoint(before)}\n当前已保存输出：${showEndpoint(after)}\n这是实际复制基线与当前已保存双方的端点证据，不宣称历史从未写入，也不把当前预检阻断当作此前拒绝执行证明。`,
  };
}

type VerifiedFile = { path: string; sha256: string; docId?: string; rev?: number; saved: boolean };
function downloadableSha(abs: string): string {
  return withFileAccessSync(
    { kind: "file-bytes", path: abs, purpose: "final-delivery-sha" },
    () => {
      const fd = openSync(abs, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      try {
        if (!fstatSync(fd).isFile()) return invalid("交付目标不是可下载的工作区文件。");
        return createHash("sha256").update(readFileSync(fd)).digest("hex");
      } finally {
        closeSync(fd);
      }
    },
  );
}
export async function verifiedDeliveryFile(
  log: SessionLog,
  documents: DocumentService | undefined,
  path: string,
  ctx: ToolContext,
): Promise<VerifiedFile> {
  documents?.assertSavedReadOpen(ctx.workspaceId, ctx.workspaceRoot, { path });
  const resolved = resolveWorkspacePath(ctx.workspaceRoot, path);
  const sha256 = downloadableSha(resolved.abs);
  const row = documents
    ? (log.dbHandle
        .prepare("SELECT id FROM documents WHERE workspace_id=? AND path=?")
        .get(ctx.workspaceId, resolved.rel) as { id: string } | undefined)
    : undefined;
  if (row && documents) {
    const status = await documents.sourceStatus(row.id, ctx.workspaceRoot);
    const meta = documents.meta(row.id);
    if (
      !meta ||
      meta.workspaceId !== ctx.workspaceId ||
      meta.path !== resolved.rel ||
      meta.externalConflict ||
      meta.checkpointError ||
      status.pendingWrite ||
      meta.checkpointRev !== meta.rev ||
      status.currentSha256 !== sha256
    )
      throw new EvidenceError(
        "VERSION_CONFLICT",
        "交付文件尚未保存为当前修订，或文件存在冲突。请等待已有自动保存完成，再重新读取来源后交付；不会暗中写回只读原件。",
      );
    return {
      path: resolved.rel,
      docId: row.id,
      rev: meta.rev,
      sha256: status.currentSha256,
      saved: true,
    };
  }
  return {
    path: resolved.rel,
    sha256,
    saved: true,
  };
}
function fileNote(file: VerifiedFile): string {
  return `已保存工作区文件${file.rev === undefined ? "" : ` · rev ${file.rev}`} · SHA256 ${file.sha256}。可下载；不代表业务核验或刷新已完成。`;
}

/** Last synchronous pass after all awaits: every source and output remains current and permitted. */
export function assertDeliveryBindings(
  documents: DocumentService,
  bindings: Pick<HarnessBinding, "path" | "docId" | "rev" | "sha256" | "expectedAbsent">[],
  ctx: ToolContext,
): void {
  for (const binding of bindings) {
    assertToolAccess(binding.path, ctx.workspaceRoot);
    if (binding.expectedAbsent) {
      const path = resolveWorkspacePath(ctx.workspaceRoot, binding.path);
      const present = withFileAccessSync({ kind: "file-metadata", path: path.abs, purpose: "final-delivery-move-source-absence" }, () => lstatSync(path.abs, { throwIfNoEntry: false }));
      if (present) throw new EvidenceError("VERSION_CONFLICT", "移动前来源路径重新出现，请重新检查字节转移事实。");
      continue;
    }
    documents.assertSavedReadOpen(ctx.workspaceId, ctx.workspaceRoot, { path: binding.path, ...(binding.docId ? { docId: binding.docId } : {}) });
    if (binding.docId) {
      const meta = documents.meta(binding.docId);
      if (!meta || meta.workspaceId !== ctx.workspaceId || meta.path !== binding.path || meta.rev !== binding.rev || meta.checkpointRev !== meta.rev || meta.externalConflict || meta.checkpointError) throw new EvidenceError("VERSION_CONFLICT", "交付前来源或输出修订发生变化。");
    }
    if (downloadableSha(resolveWorkspacePath(ctx.workspaceRoot, binding.path).abs) !== binding.sha256) throw new EvidenceError("VERSION_CONFLICT", "交付前来源或输出字节发生变化。");
  }
}
/** File-card notes are host-rendered, not a second unverified final-answer channel. */
export async function presentVerifiedFile(
  log: SessionLog,
  documents: DocumentService | undefined,
  path: string,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const file = await verifiedDeliveryFile(log, documents, path, ctx);
    log.append(ctx.sessionId, ctx.agentId, [
      { type: "ui.present", data: { kind: "file", path: file.path, note: fileNote(file) } },
    ]);
    return { status: "ok", data: { presented: true, verifiedFile: file } };
  } catch (error) {
    return {
      status: "error",
      error: {
        code: toToolErrorCode(error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "INVALID_ARGUMENT"),
        message: error instanceof Error ? error.message : "交付文件核验失败。",
        retryable: false,
      },
    };
  }
}
async function prepareSelectedFiles(
  log: SessionLog,
  documents: DocumentService,
  sources: Source[],
  reportDocs: Set<string>,
  ctx: ToolContext,
  scopedDelivery = false,
): Promise<{ files: VerifiedFile[]; cards: { kind: "file"; path: string; note: string }[] }> {
  if (!ctx.turnId) return { files: [], cards: [] };
  const { startSeq, receipts } = numericExecutionReceiptScope(
    log.dbHandle,
    ctx.sessionId,
    ctx.agentId,
    ctx.turnId,
  );
  if (startSeq === undefined) return { files: [], cards: [] };
  const rows = log.dbHandle
    .prepare(
      "SELECT type,data FROM session_log WHERE session_id=? AND agent_id=? AND seq>? AND seq<COALESCE((SELECT MIN(seq) FROM session_log WHERE session_id=? AND agent_id=? AND type='turn.started' AND seq>?),9223372036854775807) AND type='ui.present'",
    )
    .all(ctx.sessionId, ctx.agentId, startSeq, ctx.sessionId, ctx.agentId, startSeq) as {
    type: string;
    data: string;
  }[];
  const written = new Set<string>();
  for (const row of receipts) {
    const receipt = object(JSON.parse(row.data)),
      result = object(receipt.result),
      data = object(result.data);
    if (receipt.status !== "ok" || result.status !== "ok" || data.dryRun === true) continue;
    const changes = object(data.changes);
    if (
      receipt.toolName === "workbook_edit" &&
      typeof data.docId === "string" &&
      (data.created === true ||
        [changes.ranges, changes.structural, changes.added].some(
          (value) => Array.isArray(value) && value.length,
        ) ||
        Object.values(object(changes.cellsBySheet)).some(
          (value) => typeof value === "number" && value > 0,
        ))
    )
      written.add(data.docId);
    if (["workbook_analyze", "workbook_query"].includes(String(receipt.toolName)) && data.mode === "sql") {
      const saved = object(data.saved);
      if (
        typeof saved.docId === "string" &&
        typeof saved.rev === "number" &&
        Number.isInteger(saved.rev) &&
        saved.rev >= 0
      )
        written.add(saved.docId);
    }
    if (receipt.toolName === "run_script" && Array.isArray(data.published))
      for (const item of data.published) {
        const published = object(item);
        if (typeof published.docId === "string" && typeof published.rev === "number")
          written.add(published.docId);
      }
  }
  const files: VerifiedFile[] = [];
  for (const source of new Map(sources.map((source) => [source.docId, source])).values()) {
    if (!scopedDelivery && !written.has(source.docId) && !reportDocs.has(source.docId)) continue;
    const file = await verifiedDeliveryFile(log, documents, source.path, ctx);
    if (
      file.docId !== source.docId ||
      file.rev !== source.rev ||
      file.sha256 !== source.sourceFile.currentSha256
    )
      throw new EvidenceError("VERSION_CONFLICT", "交付文件与最后核验的来源修订或 SHA 不一致。");
    files.push(file);
  }
  // Finish all validation before producing any card. Never checkpoint or refresh here.
  const cards: { kind: "file"; path: string; note: string }[] = [];
  for (const file of files) {
    const meta = file.docId ? documents.meta(file.docId) : undefined;
    const sha256 = downloadableSha(resolveWorkspacePath(ctx.workspaceRoot, file.path).abs);
    if (
      !meta ||
      meta.workspaceId !== ctx.workspaceId ||
      meta.path !== file.path ||
      meta.rev !== file.rev ||
      meta.checkpointRev !== file.rev ||
      meta.externalConflict ||
      meta.checkpointError ||
      sha256 !== file.sha256
    )
      throw new EvidenceError("VERSION_CONFLICT", "交付核验过程中工作簿已变化，请重新读取后交付。");
  }
  for (const file of files) {
    const note = fileNote(file);
    const alreadyPresented = rows.some((row) => {
      const data = object(JSON.parse(row.data));
      return (
        row.type === "ui.present" &&
        data.kind === "file" &&
        data.path === file.path &&
        data.note === note
      );
    });
    if (!alreadyPresented) cards.push({ kind: "file", path: file.path, note });
  }
  return { files, cards };
}
/** The live tool has only this refId entry point. Decoding is location, not authorization. */
export async function finalizeNumeric(
  log: SessionLog,
  documents: DocumentService | undefined,
  args: Finalization,
  ctx: ToolContext,
  options: { suppressCards?: boolean } = {},
): Promise<ToolResult> {
  const parsed = numericFinalization.safeParse(args);
  if (!parsed.success) return rejected("只接受当前可见候选的 refId，不接受旧指针或自报内容。");
  const sources: NumericPointer[] = [];
  for (const ref of parsed.data.sources) {
    const decoded = decodeNumericRefId(ref.refId);
    if (!decoded) return rejected("无效数值引用，请复制当前可见候选 refId。");
    sources.push(decoded);
  }
  const bindings: NumericLabelBinding[] = [];
  if (parsed.data.status === "complete") {
    for (const selection of parsed.data.bindings ?? []) {
      const decoded = decodeNumericBindingId(selection.bindingId);
      if (!decoded) return rejected("无效标签引用，请只复制当前数值的可见 bindingId。");
      bindings.push({
        valueRefId: numericRefId({ toolCallId: decoded.toolCallId, pointer: decoded.valuePointer }),
        labelRefId: numericRefId({ toolCallId: decoded.toolCallId, pointer: decoded.labelPointer }),
        relation: decoded.relation,
      });
    }
  }
  return finalizeResolved(
    log,
    documents,
    { status: parsed.data.status, sources } as LegacyFinalization,
    ctx,
    true,
    bindings,
    parsed.data.status === "complete" ? parsed.data.presentation : undefined,
    undefined,
    options.suppressCards,
  );
}
/** Internal historical-selector validation only; never connected to present.input or execute. */
export async function finalizeNumericPointers(
  log: SessionLog,
  documents: DocumentService | undefined,
  args: LegacyFinalization,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = legacyFinalization.safeParse(args);
  return parsed.success
    ? finalizeResolved(log, documents, parsed.data, ctx, false)
    : rejected("无效历史数值引用。");
}


/** Diagnostics read only the same visible host catalogs; they never authorize a selection. */
function visibleNumericReceipt(log: SessionLog, ctx: ToolContext, toolCallId: string) {
  const row = log.dbHandle.prepare(
    "SELECT c.item, l.data FROM agent_context c JOIN session_log l ON l.session_id=c.session_id AND l.seq=c.from_seq WHERE c.session_id=? AND c.agent_id=? AND c.superseded=0 AND l.agent_id=? AND l.type='tool.result' AND json_extract(c.item,'$.kind')='toolResult' AND json_extract(c.item,'$.toolCallId')=? ORDER BY c.idx DESC LIMIT 1",
  ).get(ctx.sessionId, ctx.agentId, ctx.agentId, toolCallId) as { item: string; data: string } | undefined;
  if (!row) return;
  const visible = object(JSON.parse(row.item)), recorded = object(JSON.parse(row.data));
  const result = object(recorded.result), output = object(visible.output);
  const toolName = String(recorded.toolName);
  if (recorded.toolCallId !== toolCallId || recorded.status !== "ok" || result.status !== "ok" ||
      output.status !== "ok" || visible.isError === true || visible.toolName !== toolName) return;
  const shown = numericEvidence(toolCallId, toolName, output);
  const actual = numericEvidence(toolCallId, toolName, result);
  if (!shown || !actual || JSON.stringify(shown.sourceScopes) !== JSON.stringify(actual.sourceScopes)) return;
  return { toolName, result, output, shown, actual };
}

/** Public fact sets expose typed values and provenance, never model-authored pointers or units. */
export interface NumericFactSet {
  id: string;
  toolName: string;
  sourceToolCallId: string;
  field: string;
  value: unknown;
  valueType: string;
  provenance: NumericSource[];
  unit: "not_asserted";
}
type ResolvedFactSet = { fact: NumericFactSet; source: NumericPointer };

async function resolveNumericFactSets(
  log: SessionLog,
  documents: DocumentService,
  ctx: ToolContext,
): Promise<ResolvedFactSet[]> {
  const rows = log.dbHandle.prepare(
    "SELECT DISTINCT json_extract(item,'$.toolCallId') AS id FROM agent_context WHERE session_id=? AND agent_id=? AND superseded=0 AND json_extract(item,'$.kind')='toolResult' ORDER BY idx DESC",
  ).all(ctx.sessionId, ctx.agentId) as { id: string }[];
  const sets: ResolvedFactSet[] = [];
  for (const row of rows) {
    const receipt = visibleNumericReceipt(log, ctx, row.id);
    if (!receipt) continue;
    const contract = numericResultContract(receipt.toolName, receipt.result);
    const visibleContract = numericResultContract(receipt.toolName, receipt.output);
    if (!contract || !visibleContract || JSON.stringify(contract.sources) !== JSON.stringify(visibleContract.sources)) continue;
    try {
      for (const source of contract.sources) {
        const current = await verifiedDeliveryFile(log, documents, source.path, ctx);
        if (current.docId !== source.docId || current.rev !== source.rev || current.sha256 !== source.sourceFile.currentSha256) throw new Error("stale fact source");
      }
      for (const field of contract.fields) {
        if (!visibleContract.fields.includes(field)) continue;
        const pointer = `/data/${field}`;
        const value = at(receipt.result, tokens(pointer));
        if (JSON.stringify(value) !== JSON.stringify(at(receipt.output, tokens(pointer)))) continue;
        const data = object(receipt.result.data);
        if (data.truncated === true || object(data.readWindow).complete === false) continue;
        const identity = [ctx.sessionId, ctx.agentId, row.id, field, value, contract.sources];
        const fact: NumericFactSet = {
          id: `hfs1_${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`,
          toolName: receipt.toolName, sourceToolCallId: row.id, field, value,
          valueType: value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
          provenance: contract.sources, unit: "not_asserted",
        };
        sets.push({ fact, source: { toolCallId: row.id, pointer } });
      }
    } catch {
      // Old visible receipts are not a continuing read grant or current fact. Re-read to restore.
    }
  }
  // A later awaited read can change a prior source. Return no mixed-version fact sets.
  return sets.filter(({ fact }) => fact.provenance.every((source) => {
    try {
      documents.assertSavedReadOpen(ctx.workspaceId, ctx.workspaceRoot, { docId: source.docId, path: source.path });
      const meta = documents.meta(source.docId);
      return meta?.workspaceId === ctx.workspaceId && meta.path === source.path && meta.rev === source.rev &&
        meta.checkpointRev === meta.rev && !meta.externalConflict && !meta.checkpointError &&
        downloadableSha(resolveWorkspacePath(ctx.workspaceRoot, source.path).abs) === source.sourceFile.currentSha256;
    } catch { return false; }
  }));
}

export async function numericFactSets(log: SessionLog, documents: DocumentService, ctx: ToolContext): Promise<NumericFactSet[]> {
  return (await resolveNumericFactSets(log, documents, ctx)).map(({ fact }) => fact);
}

/** Only reconstructed host roots enter this adapter; public legacy selectors retain old checks. */
export async function finalizeNumericFactSets(
  log: SessionLog, documents: DocumentService, factSetIds: string[], ctx: ToolContext,
): Promise<ToolResult> {
  const current = await resolveNumericFactSets(log, documents, ctx);
  const selected = [...new Set(factSetIds)].map((id) => current.find(({ fact }) => fact.id === id));
  if (!selected.length || selected.some((entry) => !entry)) return rejected("事实集不可见、已过期或权限已变化；请重新读取并检查交付目录。");
  const sources = selected.map((entry) => entry!.source);
  return finalizeResolved(log, documents, { status: "complete", sources }, ctx, true, [], "evidence", new Set(sources.map(numericRefId)), true);
}
function selectedCellDiagnostic(log: SessionLog, ctx: ToolContext, sources: NumericPointer[]): string {
  try {
    const seen = new Set<string>(), parts: string[] = [];
    let visited = 0, count = 0;
    const grouped = new Map<string, NumericPointer[]>();
    for (const source of sources) {
      const group = grouped.get(source.toolCallId) ?? [];
      group.push(source); grouped.set(source.toolCallId, group);
    }
    for (const source of [...grouped.values()].flat()) {
      const receipt = visibleNumericReceipt(log, ctx, source.toolCallId);
      if (!receipt || receipt.toolName !== "workbook_read" ||
          object(receipt.result.data).mode !== "range" ||
          !/^\/data\/(values|formulas)(\/|$)/.test(source.pointer) ||
          !receipt.shown.candidates.items.some((item) => item.pointer === source.pointer) ||
          !receipt.actual.candidates.items.some((item) => item.pointer === source.pointer)) return "";
      const path = tokens(source.pointer), selected = at(receipt.result, path);
      if (JSON.stringify(selected) !== JSON.stringify(at(receipt.output, path))) return "";
      const before = count;
      const visit = (value: unknown, trail: string[]) => {
        if (++visited > 20_000 || trail.length > 32) throw new Error("diagnostic bound");
        if (value !== null && typeof value === "object") {
          for (const [key, part] of Object.entries(value)) visit(part, [...trail, key]);
          return;
        }
        if (trail.length !== 4) throw new Error("not a range cell");
        const key = JSON.stringify([source.toolCallId, trail]);
        if (seen.has(key)) return;
        seen.add(key); count++;
        if (trail[1] === "values") {
          const formulaTrail = ["data", "formulas", trail[2]!, trail[3]!];
          try {
            const formula = at(receipt.result, formulaTrail);
            if (formula !== undefined && formula === at(receipt.output, formulaTrail))
              seen.add(JSON.stringify([source.toolCallId, formulaTrail]));
          } catch { /* A missing formula is not an extra verified leaf. */ }
        }
      };
      visit(selected, path);
      parts.push(`${source.toolCallId}${source.pointer}=${count - before}`);
    }
    return ` 实际可见选择去重计数：selectedTotal=${count}；逐项新增标量=${parts.join("，")}。同一call重叠叶子去重，不跨call按同值合并；这不是完成核验或允许超额的证明。`;
  } catch { return " 完整选择计数未在诊断预算内取得，仍按原限制拒绝，不自动删减来源。"; }
}

type SummaryBlocker = {
  code: "SOURCE_WINDOW_UNSUPPORTED" | "WINDOW_HEADERS_INVALID" | "WINDOW_CELLS_INVALID" |
    "SUMMARY_CELL_LIMIT" | "SUMMARY_TEXT_LIMIT" | "SUMMARY_WINDOW_MISSING" |
    "EXECUTION_SCOPE_UNKNOWN" | "RECEIPT_INCONSISTENT" | "RECEIPT_WARNINGS" |
    "FAILURE_STATE_UNKNOWN" | "SCRIPT_PUBLICATION_UNKNOWN" | "SPECIAL_OBLIGATIONS" |
    "ALIGNMENT_DISCLOSURE_LIMIT" | "ACCESS_FACTS_REQUIRED";
  category: "selection" | "mandatory-disclosure";
  reason: string;
  toolCallId?: string;
  refId?: string;
  actual?: number;
  limit?: number;
};
function summaryDiagnostics() {
  const blockers: SummaryBlocker[] = [];
  const seen = new Set<string>();
  let overflow = false;
  return {
    add(blocker: SummaryBlocker) {
      const key = JSON.stringify(blocker);
      if (seen.has(key)) return;
      if (blockers.length >= 32) { overflow = true; return; }
      seen.add(key);
      blockers.push(blocker);
    },
    result: () => ({ blockers, limit: 32, overflow, complete: !overflow }),
  };
}
type SummaryDiagnostics = ReturnType<typeof summaryDiagnostics>;
type SummaryWindow = {
  values: unknown; toolCallId: string; refId: string;
} & ({ kind: "range"; path: string; range: string } |
  { kind: "sql"; columns: unknown; sql: string; sources: Source[] });

/** SQL receipts record effective ranges only; the matching host intent owns requested bounds. */
function sqlSummaryInputsComplete(log: SessionLog, ctx: ToolContext, toolCallId: string,
  fromSeq: number, inputs: Source[]): boolean {
  const intents = log.dbHandle.prepare(
    "SELECT data FROM session_log WHERE session_id=? AND agent_id=? AND type='tool.intent' AND seq<? AND seq>COALESCE((SELECT MAX(seq) FROM session_log WHERE session_id=? AND agent_id=? AND type='turn.started' AND seq<?),0) AND json_extract(data,'$.toolCallId')=? ORDER BY seq DESC LIMIT 2",
  ).all(ctx.sessionId, ctx.agentId, fromSeq, ctx.sessionId, ctx.agentId, fromSeq, toolCallId) as { data: string }[];
  if (intents.length !== 1) return false;
  const intent = object(JSON.parse(intents[0]!.data)), args = object(intent.args);
  if (intent.toolName !== "workbook_analyze" || args.mode !== "sql" ||
      typeof args.sql !== "string" || (args.sources !== undefined && !Array.isArray(args.sources))) return false;
  const primary = inputs.find((input) => input.name === "data");
  if (!primary) return false;
  const requested: Json[] = [{ ...args, name: "data" }, ...(Array.isArray(args.sources) ? args.sources.map(object) : [])];
  if (requested.length !== inputs.length || new Set(requested.map((source) => typeof source.name === "string" ? source.name.toLowerCase() : source.name)).size !== inputs.length) return false;
  return requested.every((source) => {
    const input = inputs.find((entry) => entry.name === source.name);
    if (!input || input.scope.kind !== "range") return false;
    if (source.docId !== undefined && source.docId !== input.docId) return false;
    if (source.path !== undefined && source.path !== input.path) return false;
    if (source.docId === undefined && source.path === undefined && input.docId !== primary.docId) return false;
    try {
      const effective = parseRange(input.scope.range);
      if (source.range === undefined)
        return source.sheet === undefined || source.sheet === effective.sheet;
      if (typeof source.range !== "string" || !source.range.trim()) return false;
      const request = parseRange(source.range);
      return (request.sheet ?? source.sheet ?? effective.sheet) === effective.sheet &&
        request.startRow === effective.startRow && request.endRow === effective.endRow &&
        request.startCol === effective.startCol && request.endCol === effective.endCol;
    } catch { return false; }
  });
}
function sqlSummaryReceiptComplete(data: Json, shown: Json, result: Json, visible: Json,
  inputs: Source[]): boolean {
  const metadata = ["columns", "rows", "rowCount", "truncated", "sql", "sources"];
  if (data.mode !== "sql" || shown.mode !== "sql" ||
      metadata.some((key) => !Object.hasOwn(data, key) || !Object.hasOwn(shown, key) ||
        JSON.stringify(data[key]) !== JSON.stringify(shown[key])) ||
      data.truncated !== false || typeof data.sql !== "string" || !data.sql.trim() ||
      !Array.isArray(data.rows) || !Number.isInteger(data.rowCount) ||
      data.rowCount !== data.rows.length || !data.rows.length) return false;
  // The current SQL producer has one complete result set, never pagination metadata.
  const receipts = [data, shown, result, visible,
    ...(Array.isArray(data.sources) ? data.sources.map(object) : []),
    ...(Array.isArray(shown.sources) ? shown.sources.map(object) : [])];
  if (receipts.some((receipt) => Object.hasOwn(receipt, "error") ||
      (Object.hasOwn(receipt, "truncated") && receipt.truncated !== false) ||
      (Object.hasOwn(receipt, "clipped") && receipt.clipped !== false) ||
      (Object.hasOwn(receipt, "complete") && receipt.complete !== true) ||
      (Object.hasOwn(receipt, "warnings") && (!Array.isArray(receipt.warnings) || receipt.warnings.length > 0)) ||
      ["readWindow", "offset", "page", "cursor", "nextCursor", "nextOffset", "hasMore", "resultSets", "results"]
        .some((key) => Object.hasOwn(receipt, key)))) return false;
  return inputs.every((input) => input.scope.kind === "range" && !!input.name &&
    input.sourceFile.pendingWrite === false &&
    input.sourceFile.calculation === "no-unpersisted-calculation-observed");
}
const sqlIndexHeader = (value: string) =>
  /^(0|[1-9][0-9]*)$/.test(value) && Number(value) < 4294967295;
const sqlSummaryCell = (value: unknown) =>
  (typeof value === "string" && value.trim().length > 0 &&
    !/^#(?:NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|SPILL!|CALC!|GETTING_DATA|CONNECT!|BLOCKED!|UNKNOWN!|FIELD!)$/i.test(value.trim())) ||
  (typeof value === "number" && Number.isFinite(value) &&
    (!Number.isInteger(value) || Number.isSafeInteger(value)));

const sqlSummaryText = (value: unknown) => cell(value).replace(/[\\\u0060*_~[\]]/g, (match) => "\\" + match);

function renderSummaryWindows(windows: SummaryWindow[], diagnostics: SummaryDiagnostics): string | undefined {
  let count = 0;
  const sections: string[] = [];
  for (const window of windows) {
    const { toolCallId, refId } = window;
    const values = window.kind === "sql"
      ? (Array.isArray(window.values) ? [window.columns, ...window.values] : undefined)
      : window.values;
    if (Array.isArray(values) && values.every(Array.isArray))
      count += values.reduce((n, row) => n + row.length, 0);
    const validHeaders = Array.isArray(values) && values.length >= 2 && Array.isArray(values[0]) &&
      values[0].length > 0 && values[0].every((v) => typeof v === "string" && v.trim() &&
        (window.kind !== "sql" || !sqlIndexHeader(v))) &&
      new Set(values[0]).size === values[0].length;
    if (!validHeaders)
      diagnostics.add({ code: "WINDOW_HEADERS_INVALID", category: "selection", toolCallId, refId,
        reason: "小汇总窗口须完整保留非空且无歧义的原文表头与数据行；SQL 不支持整数索引列名" });
    const width = Array.isArray(values) && Array.isArray(values[0]) ? values[0].length : undefined;
    const validCells = Array.isArray(values) && values.slice(1).every((row) =>
      Array.isArray(row) && (width === undefined || row.length === width) &&
      (window.kind === "sql"
        ? Array.from({ length: row.length }, (_, index) => Object.hasOwn(row, index) && sqlSummaryCell(row[index])).every(Boolean)
        : row.every((v) => (typeof v === "string" && v.trim().length > 0) || (typeof v === "number" && Number.isFinite(v)))));
    if (!validCells)
      diagnostics.add({ code: "WINDOW_CELLS_INVALID", category: "selection", toolCallId, refId,
        reason: "小汇总窗口含缺失、空白、不支持或精度不明确的单元格，不能猜测标签或身份" });
    if (!validHeaders || !validCells) continue;
    const renderCell = window.kind === "sql"
      ? (value: unknown) => sqlSummaryText(typeof value === "string" ? JSON.stringify(value) : value)
      : cell;
    const table = values.map((row, index) => "| " + row.map(renderCell).join(" | ") + " |" +
      (index === 0 ? "\n| " + row.map(() => "---").join(" | ") + " |" : "")).join("\n");
    sections.push(window.kind === "range" ? cell(window.path) + " · " + cell(window.range) + "\n" + table :
      ["SQL 查询结果 · " + sqlSummaryText(toolCallId) + "（下列范围上该查询的完整返回结果）：",
        ...window.sources.map((input) =>
          "来源 " + sqlSummaryText(input.name) + "：" + sqlSummaryText(input.path) + " · " +
          sqlSummaryText(input.scope.kind === "range" ? input.scope.range : "") + " · rev " + input.rev +
          " · calculation=" + cell(input.sourceFile.calculation) + " · pendingWrite=false"),
        "实际 SQL：" + sqlSummaryText(window.sql), table,
        "列名/单位仅查询输出原文，不认证业务口径或单位；非 Excel 格式化显示，不证明原始行覆盖。"].join("\n"));
  }
  if (count > 32) diagnostics.add({ code: "SUMMARY_CELL_LIMIT", category: "selection", actual: count, limit: 32,
    reason: "所有小汇总窗口合计超过32个标量格（含 SQL 表头），未自动挑选或删减" });
  if (!windows.length) diagnostics.add({ code: "SUMMARY_WINDOW_MISSING", category: "selection",
    reason: "没有可安全压缩的完整小汇总窗口" });
  const text = sections.join("\n\n");
  if (text.length > 2000) diagnostics.add({ code: "SUMMARY_TEXT_LIMIT", category: "selection", actual: text.length, limit: 2000,
    reason: "原文小窗口文本仍过长，未截断内容" });
  return text || undefined;
}
function summaryExecutionNotes(log: SessionLog, ctx: ToolContext, diagnostics: SummaryDiagnostics): string[] {
  const scope = numericExecutionReceiptScope(log.dbHandle, ctx.sessionId, ctx.agentId, ctx.turnId);
  if (scope.startSeq === undefined || scope.scopes.length)
    diagnostics.add({ code: "EXECUTION_SCOPE_UNKNOWN", category: "mandatory-disclosure",
      reason: "执行范围缺失或含关联轮次状态，保留完整执行事实" });
  const failures: string[] = [];
  const warnings: string[] = [];
  for (const row of scope.receipts) {
    const receipt = object(JSON.parse(row.data)), result = object(receipt.result), data = object(result.data);
    const toolCallId = typeof receipt.toolCallId === "string" ? receipt.toolCallId : undefined;
    const inconsistent = receipt.status !== result.status || result.truncated || data.truncated === true;
    if (inconsistent) diagnostics.add({ code: "RECEIPT_INCONSISTENT", category: "mandatory-disclosure", toolCallId,
      reason: "工具回执状态不一致或截断，保留完整执行事实" });
    if (Array.isArray(result.warnings) && result.warnings.length) {
      diagnostics.add({ code: "RECEIPT_WARNINGS", category: "mandatory-disclosure", toolCallId,
        reason: "工具回执含警告，需要完整披露" });
      warnings.push(`${cell(receipt.toolName)} · ${cell(receipt.toolCallId)}：${cell(JSON.stringify(result.warnings))}`);
    }
    // Only the host top-level prepublication receipt is authoritative. Nested value/stdout is not.
    const prepublication = receipt.toolName === "run_script" && result.status === "error" && !inconsistent &&
      data.publicationPhase === "not_started" &&
      ["published", "committedRevs"].every((field) => Array.isArray(data[field]) && (data[field] as unknown[]).length === 0) &&
      ["rolledBack", "unrecovered"].every((field) => !Object.hasOwn(data, field) ||
        (Array.isArray(data[field]) && (data[field] as unknown[]).length === 0));
    if (result.status !== "ok") {
      const error = object(result.error);
      failures.push(`${cell(receipt.toolName)}(${cell(error.code ?? result.status)}) · ${cell(receipt.toolCallId)}：${cell(error.message ?? "回执未给出失败详情")}` +
        (prepublication ? "；宿主确认本次调用未进入发布阶段（可能已有读取或暂存，不证明清理或恢复成功）" : ""));
      const parameterRejection = result.status === "error" &&
        ["workbook_read", "workbook_analyze", "workbook_query", "present", "deliver"].includes(String(receipt.toolName)) &&
        (error.code === "INVALID_ARGUMENT" || (receipt.toolName === "present" && error.code === "LIMIT_EXCEEDED"));
      if (!parameterRejection && !prepublication)
        diagnostics.add({ code: "FAILURE_STATE_UNKNOWN", category: "mandatory-disclosure", toolCallId,
          reason: "失败回执不是明确参数拒绝，执行或恢复状态未知，保留完整执行事实" });
    }
    if (receipt.toolName === "run_script" && !prepublication &&
        (result.status !== "ok" || !Array.isArray(data.published) ||
         ["rolledBack", "unrecovered"].some((field) => Object.hasOwn(data, field) &&
           (!Array.isArray(data[field]) || (data[field] as unknown[]).length > 0)))) {
      diagnostics.add({ code: "SCRIPT_PUBLICATION_UNKNOWN", category: "mandatory-disclosure", toolCallId,
        reason: "脚本发布、回滚或恢复状态需要完整披露" });
      warnings.push(`${cell(receipt.toolName)} · ${cell(receipt.toolCallId)}：${["publicationPhase", "published", "committedRevs", "rolledBack", "unrecovered"].map((field) => `${field}=${cell(Object.hasOwn(data, field) ? JSON.stringify(data[field]) : "未提供")}`).join("；")}`);
    }
  }
  return [
    ...(failures.length ? [`本轮有${failures.length}次工具失败回执：${failures.join("；")}。后续成功读取不等同这些失败已恢复。`] : []),
    ...(warnings.length ? [`工具警告：${warnings.join("；")}`] : []),
  ];
}


const alignmentLocation = z.object({
  docId: z.string().min(1), path: z.string().min(1), rev: z.number().int().nonnegative(),
  sheet: z.string().optional(), range: z.string().min(1),
});
const alignmentReceipt = z.object({
  docId: z.string().min(1), path: z.string().min(1),
  docRevs: z.record(z.string(), z.number().int().nonnegative()),
  verification: z.object({
    status: z.enum(["verified", "failed", "unverified"]), scope: z.literal("declared_fields_only"),
    target: alignmentLocation, sources: z.array(alignmentLocation.extend({ name: z.string().min(1) })).min(1),
    requiredColumns: z.array(z.string().min(1)), coveredColumns: z.array(z.string().min(1)),
    uncoveredColumns: z.array(z.string().min(1)),
    declaredCellCount: z.number().int().nonnegative(), checkedCellCount: z.number().int().nonnegative(),
    failedCount: z.number().int().nonnegative(), unverifiedCount: z.number().int().nonnegative(),
    conflictKeyCount: z.number().int().nonnegative(), sourcePolicies: z.array(z.object({
      ruleIndex: z.number().int().nonnegative(), source: z.string().min(1),
      where: z.array(z.object({ column: z.string().min(1), equals: z.union([z.string(), z.number(), z.boolean(), z.null()]) }).strict()),
      duplicatePolicy: z.enum(["reject", "identical_rows"]), duplicateColumns: z.array(z.string().min(1)),
      conflictPolicy: z.enum(["unverified", "expect_blank"]),
    }).strict()),
    failures: z.array(z.object({ targetCell: z.string(), ruleIndex: z.number().int(), code: z.string() })),
    failuresTruncated: z.boolean(), limitation: z.string().min(1),
  }),
  versionBindings: z.array(z.object({
    docId: z.string().min(1), path: z.string().min(1), rev: z.number().int().nonnegative(),
    sha256: z.string().optional(), checkpointRev: z.number().int().nonnegative().optional(),
    isCurrentSaved: z.boolean(),
  })).min(1),
});

/** Display host declarations only; never promote a historical green receipt to current certification. */
function alignmentReceiptNotes(log: SessionLog, ctx: ToolContext, documents: DocumentService): string[] {
  const latest = new Map<string, { text: string; nonSuccess: boolean; priorNonSuccess: number }>();
  for (const row of numericExecutionReceiptScope(log.dbHandle, ctx.sessionId, ctx.agentId, ctx.turnId).receipts) {
    const receipt = object(JSON.parse(row.data)), result = object(receipt.result), data = object(result.data);
    if (receipt.toolName !== "workbook_analyze" || data.mode !== "source_alignment") continue;
    const raw = object(data.verification);
    const key = typeof data.docId === "string" ? data.docId : `unknown:${row.seq}`;
    const previous = latest.get(key);
    const priorNonSuccess = (previous?.priorNonSuccess ?? 0) + (previous?.nonSuccess ? 1 : 0);
    const parsed = alignmentReceipt.safeParse(data);
    const prefix = `字段校验回执 · ${cell(receipt.toolCallId)}`;
    let text = `字段校验回执未知 · ${cell(receipt.toolCallId)}：缺字段、版本绑定或形状不完整；回执报告status=${cell(raw.status ?? "未提供")}，未作为证明。`;
    let nonSuccess = true;
    if (parsed.success && receipt.status === "ok" && result.status === "ok" && !result.truncated) {
      const { verification: v, versionBindings, docRevs } = parsed.data;
      const locations = [v.target, ...v.sources];
      const bound = v.target.docId === data.docId && v.target.path === data.path &&
        locations.every((loc) => docRevs[loc.docId] === loc.rev &&
          versionBindings.some((b) => b.docId === loc.docId && b.path === loc.path && b.rev === loc.rev));
      const greenConsistent = v.status !== "verified" || (v.failedCount === 0 && v.unverifiedCount === 0 &&
        locations.every((loc) => versionBindings.some((b) => b.docId === loc.docId && b.rev === loc.rev &&
          b.isCurrentSaved && b.checkpointRev === loc.rev && /^[a-f0-9]{64}$/i.test(b.sha256 ?? ""))));
      if (bound && greenConsistent) {
        const current = documents.meta(v.target.docId);
        const revisionNote = current && current.rev !== v.target.rev
          ? `；当前修订${current.rev}，该回执不认证此修订` : "";
        text = `${prefix}：${cell(v.target.path)} · ${cell(v.target.range)} · 基于修订${v.target.rev}的声明字段校验，status=${v.status}${revisionNote}；仅覆盖：${v.coveredColumns.map(cell).join("、") || "无"}；未覆盖：${v.uncoveredColumns.map(cell).join("、") || "无"}；failed=${v.failedCount}，unverified=${v.unverifiedCount}；来源：${v.sources.map((s) => `${cell(s.name)}=${cell(s.path)} · ${cell(s.range)}@${s.rev}`).join("、")}。交付时未重新校验；不证明全部业务要求或未声明列。`;
        if (v.sourcePolicies.length)
          text += ` 源策略原文（where按严格类型匹配）：${cell(JSON.stringify(v.sourcePolicies))}。`;
        nonSuccess = v.status !== "verified";
      }
    }
    latest.set(key, { text, nonSuccess, priorNonSuccess });
  }
  return [...latest.values()].map((entry) => entry.text + (entry.priorNonSuccess
    ? ` 更早还有${entry.priorNonSuccess}次failed/unverified/未知回执，完整事实保留在工具日志中，不推断已恢复。` : ""));
}

async function finalizeResolved(
  log: SessionLog,
  documents: DocumentService | undefined,
  args: LegacyFinalization,
  ctx: ToolContext,
  requireCandidates: boolean,
  bindings: NumericLabelBinding[] = [],
  presentation: "evidence" | "summary" = "evidence",
  hostRoots?: ReadonlySet<string>,
  suppressCards = false,
): Promise<ToolResult> {
  const accessReport = () =>
    ctx.turnId
      ? turnAccessFacts(log.dbHandle, {
          sessionId: ctx.sessionId,
          agentId: ctx.agentId,
          turnId: ctx.turnId,
        })
      : undefined;
  const initialAccess = accessReport();
  const scopedDelivery = initialAccess?.required === true;
  if (scopedDelivery && initialAccess.decision.kind === "unresolved")
    return {
      status: "ok",
      data: {
        finalizationStatus: "incomplete",
        finalText:
          "任务交付未完成。请明确本轮允许访问的明确文件或工作区相对目录，再继续核验；不会把未知范围当作已获准范围。\n\n" +
          renderAccessFacts(initialAccess),
      },
    };
  if (args.status === "incomplete")
    return {
      status: "ok",
      data: {
        finalizationStatus: "incomplete",
        finalText:
          "数值交付未完成。尚未取得足够且有效的工具结果证据，不能确认数值结果已完成核验或交付。" +
          "\n\n" +
          numericExecutionFacts(log.dbHandle, ctx.sessionId, ctx.agentId, ctx.turnId) +
          (scopedDelivery ? "\n\n" + renderAccessFacts(initialAccess) : ""),
      },
    };
  try {
    const access = currentToolAccess();
    if (
      scopedDelivery &&
      (!["restricted", "files"].includes(initialAccess.decision.kind) ||
        initialAccess.coverage !== "complete" ||
        !access ||
        access.auditFailed ||
        access.sessionId !== ctx.sessionId ||
        access.agentId !== ctx.agentId ||
        access.turnId !== ctx.turnId)
    )
      return invalid("本轮访问范围或访问事实尚未完整确认，不能完成交付。");
    if (!documents) return invalid("工作簿模块未装配，无法核验数值来源。");
    const completeness = requireCandidates
      ? planNumericCompleteness(log.dbHandle, {
          sessionId: ctx.sessionId,
          agentId: ctx.agentId,
          turnId: ctx.turnId,
          sources: args.sources,
          currentDocument: (docId) => documents.meta(docId),
        })
      : undefined;
    if (completeness?.missing.length)
      return invalid(
        "本轮已检查目标的交付证据不完整，请一次补齐后交付：" +
          completeness.missing
            .map(
              (gap) =>
                `${gap.path}${gap.targetRange ? ` ${gap.targetRange}` : ""}：${gap.reason}${gap.reread ? `；重取 ${gap.reread.toolName} ${JSON.stringify(gap.reread.args)}` : ""}`,
            )
            .join("；"),
      );
    if (completeness) args = { ...args, sources: completeness.sources };
    const sections: string[] = [
      "以下内容直接来自已执行工具的结果；来源与执行表达式列于下方，不代表业务口径已获独立验证。",
    ];
    const verifiedSources: Source[] = [];
    const summaryWindows = new Map<string, SummaryWindow>();
    const diagnostics = summaryDiagnostics();
    const verifySource = async (input: Source) => {
      documents.assertSavedReadOpen(ctx.workspaceId, ctx.workspaceRoot, { docId: input.docId, path: input.path });
      const currentFile = await documents.sourceStatus(input.docId, ctx.workspaceRoot);
      const meta = documents.meta(input.docId);
      if (currentFile.pendingWrite)
        throw new EvidenceError(
          "VERSION_CONFLICT",
          "引用来源仍有待保存的变更；请等待已有自动保存完成，再重新读取来源后交付，不会额外保存或刷新只读文件。",
        );
      if (
        !meta ||
        meta.externalConflict ||
        meta.checkpointError ||
        meta.checkpointRev !== meta.rev ||
        meta.workspaceId !== ctx.workspaceId ||
        meta.rev !== input.rev ||
        meta.path !== input.path ||
        currentFile.currentSha256 !== input.sourceFile.currentSha256
      )
        throw new EvidenceError(
          "VERSION_CONFLICT",
          "引用来源已发生修订或文件变化，请重新读取或分析后交付。",
        );
      verifiedSources.push(input);
    };
    const renderedTools = new Set<string>();
    const renderedLeaves = new Set<string>();
    const boundLabels = new Map<
      string,
      { text: string; unit?: string; address: string; relation: string }
    >();
    const reportDocs = new Set<string>();
    const macroDocs = new Set<string>();
    const macroRangeDocs = new Set<string>();
    const macroTurn = ctx.turnId
      ? numericExecutionReceiptScope(log.dbHandle, ctx.sessionId, ctx.agentId, ctx.turnId)
      : undefined;
    let onlyMacroAndRanges = true;
    let macroRootsInTurn = true;
    let count = 0;
    let numericCount = 0;
    let hasDirectWorkbookFacts = false;
    const groups = new Map<string, NumericPointer[]>();
    for (const source of args.sources) {
      const group = groups.get(source.toolCallId) ?? [];
      group.push(source);
      groups.set(source.toolCallId, group);
    }
    // A binding may only annotate a value already included in the selected sources.
    for (const binding of bindings) {
      const value = decodeNumericRefId(binding.valueRefId),
        label = decodeNumericRefId(binding.labelRefId);
      if (
        !value ||
        !label ||
        value.toolCallId !== label.toolCallId ||
        !args.sources.some(
          (source) =>
            source.toolCallId === value.toolCallId &&
            (value.pointer === source.pointer || value.pointer.startsWith(`${source.pointer}/`)),
        )
      ) {
        const repairRefs = new Set<string>();
        // Same 32-binding cap as the public schema; diagnostics never broaden acceptance.
        for (const missing of bindings.slice(0, 32)) {
          const missingValue = decodeNumericRefId(missing.valueRefId);
          const missingLabel = decodeNumericRefId(missing.labelRefId);
          if (!missingValue || !missingLabel || missingValue.toolCallId !== missingLabel.toolCallId ||
              args.sources.some((source) => source.toolCallId === missingValue.toolCallId &&
                (missingValue.pointer === source.pointer || missingValue.pointer.startsWith(`${source.pointer}/`)))) continue;
          const receipt = visibleNumericReceipt(log, ctx, missingValue.toolCallId);
          const matches = (candidate: NumericLabelBinding) =>
            candidate.valueRefId === missing.valueRefId &&
            candidate.labelRefId === missing.labelRefId && candidate.relation === missing.relation;
          if (receipt && receipt.shown.bindingCandidates.items.some(matches) &&
              receipt.actual.bindingCandidates.items.some(matches) &&
              receipt.shown.candidates.items.some((entry) => entry.refId === missing.valueRefId) &&
              receipt.actual.candidates.items.some((entry) => entry.refId === missing.valueRefId) &&
              JSON.stringify(at(receipt.result, tokens(missingValue.pointer))) ===
                JSON.stringify(at(receipt.output, tokens(missingValue.pointer)))) {
            for (const input of receipt.actual.sourceScopes) await verifySource(input);
            repairRefs.add(missing.valueRefId);
          }
        }
        const repair = repairRefs.size
          ? ` 当前输入中未覆盖但逐项验证通过的同次读取数值：sources=${JSON.stringify([...repairRefs].map((refId) => ({ refId })))}。仅在确需这些项时显式合并选择并重新核验预算；否则删除相应绑定并从所选来源的可见候选重新选择。`
          : "";
        return invalid("标签只能绑定已选择且同一次真实读取的数值。" + repair +
          "不会自动跨call按相同数值替换来源或绑定。");
      }
      if (boundLabels.has(binding.valueRefId)) return invalid("同一数值只能选择一个标签关系。");
      boundLabels.set(binding.valueRefId, { text: "", address: "", relation: binding.relation });
    }
    for (const source of [...groups.values()].flat()) {
      const row = log.dbHandle
        .prepare(
          "SELECT c.item, c.from_seq AS fromSeq, l.data FROM agent_context c JOIN session_log l ON l.session_id=c.session_id AND l.seq=c.from_seq WHERE c.session_id=? AND c.agent_id=? AND c.superseded=0 AND l.agent_id=? AND l.type='tool.result' AND json_extract(c.item,'$.kind')='toolResult' AND json_extract(c.item,'$.toolCallId')=? ORDER BY c.idx DESC LIMIT 1",
        )
        .get(ctx.sessionId, ctx.agentId, ctx.agentId, source.toolCallId) as
        | { item: string; data: string; fromSeq: number }
        | undefined;
      if (!row) return invalid("引用必须是当前会话、当前代理仍可见的真实工具结果。");
      const visible = object(JSON.parse(row.item));
      const recorded = object(JSON.parse(row.data));
      const result = object(recorded.result);
      const data = object(result.data);
      const visibleData = object(object(visible.output).data);
      if (
        recorded.toolCallId !== source.toolCallId ||
        recorded.status !== "ok" ||
        result.status !== "ok" ||
        object(visible.output).status !== "ok"
      )
        return invalid("失败、部分或不可见结果不能作为完整数值交付证据。");
      const toolName = String(recorded.toolName);
      if (visible.toolName !== toolName || visible.isError === true)
        return invalid("可见结果与真实工具记录不一致。");
      if (requireCandidates) {
        const shown = numericEvidence(source.toolCallId, toolName, visible.output);
        const actual = numericEvidence(source.toolCallId, toolName, result);
        if (
          !shown || !actual ||
          (!hostRoots?.has(numericRefId(source)) && (!shown?.candidates.items.some((candidate) => candidate.pointer === source.pointer) ||
          !actual?.candidates.items.some((candidate) => candidate.pointer === source.pointer))) ||
          JSON.stringify(shown.sourceScopes) !== JSON.stringify(actual.sourceScopes)
        )
          return invalid(
            `引用不在当前可见且真实的候选目录中：selector=${JSON.stringify(source)}；` +
              `shownCandidatesTruncated=${shown?.candidates.truncated ?? "unknown"}；` +
              `actualCandidatesTruncated=${actual?.candidates.truncated ?? "unknown"}。` +
              evidenceRecovery,
          );
        // A unique, explicitly labelled unit may accompany a selected cell automatically.
        // The relation must exist in both actual and visible host catalogs; no sheet-wide borrowing.
        const automatic = new Map<string, NumericLabelBinding[]>();
        for (const candidate of shown.bindingCandidates.items) {
          const value = decodeNumericRefId(candidate.valueRefId)!;
          if (
            !candidate.unit.sourcePointer ||
            !actual.bindingCandidates.items.some(
              (entry) => JSON.stringify(entry) === JSON.stringify(candidate),
            ) ||
            !args.sources.some(
              (selected) =>
                selected.toolCallId === value.toolCallId &&
                (selected.pointer === value.pointer ||
                  value.pointer.startsWith(`${selected.pointer}/`)),
            )
          )
            continue;
          const choices = automatic.get(candidate.valueRefId) ?? [];
          choices.push(candidate);
          automatic.set(candidate.valueRefId, choices);
        }
        for (const [valueRefId, choices] of automatic) {
          if (bindings.some((binding) => binding.valueRefId === valueRefId)) continue;
          // Count the actual geometric alternatives, not only budget-retained candidates.
          const coords = tokens(decodeNumericRefId(valueRefId)!.pointer);
          const r = Number(coords[2]),
            c = Number(coords[3]);
          const matrix = Array.isArray(data.values) ? data.values : [];
          const rowValues = Array.isArray(matrix[r]) ? matrix[r] : [];
          const headerValues = Array.isArray(matrix[0]) ? matrix[0] : [];
          const possible = [
            c > 0 ? rowValues[c - 1] : undefined,
            r > 0 ? headerValues[c] : undefined,
          ].filter((label) => typeof label === "string" && numericLabelUnit(label) !== undefined);
          if (possible.length > 1 && hostRoots) continue;
          if (possible.length > 1)
            return invalid(
              "所选数值存在多个标签单位关系，不能自动择一；请从该值当前可见 bindingCandidates 复制一个 bindingId，无法确认则交付 incomplete。",
            );
          if (choices.length === 1 && possible.length === 1) bindings.push(choices[0]!);
        }
        for (const binding of bindings.filter(
          (binding) => decodeNumericRefId(binding.valueRefId)?.toolCallId === source.toolCallId,
        )) {
          const matches = (candidate: NumericLabelBinding) =>
            candidate.valueRefId === binding.valueRefId &&
            candidate.labelRefId === binding.labelRefId &&
            candidate.relation === binding.relation;
          if (
            !shown.bindingCandidates.items.some(matches) ||
            !actual.bindingCandidates.items.some(matches)
          )
            return invalid("标签关系不在真实且可见的绑定候选中。");
          const decoded = decodeNumericRefId(binding.labelRefId)!;
          const label = at(result, tokens(decoded.pointer));
          if (
            typeof label !== "string" ||
            JSON.stringify(at(visible.output, tokens(decoded.pointer))) !== JSON.stringify(label)
          )
            return invalid("标签不是当前可见真实字符串。");
          const range = parseRange(String(object(data.readWindow).returnedRange));
          const coords = tokens(decoded.pointer);
          const row = range.startRow + Number(coords[2]),
            col = range.startCol + Number(coords[3]);
          boundLabels.set(binding.valueRefId, {
            text: label,
            unit: numericLabelUnit(label),
            address: formatRange({
              sheet: range.sheet,
              startRow: row,
              endRow: row,
              startCol: col,
              endCol: col,
            }),
            relation: binding.relation,
          });
        }
      }
      const path = tokens(source.pointer);
      if (path[0] !== "data") return invalid("只能引用工具结果的实际数据。");
      let reads: Json[];
      if (
        toolName === "workbook_read" &&
        data.mode === "range" &&
        ["values", "formulas"].includes(path[1] ?? "")
      ) {
        reads = [{ ...data, toolName, docRevs: result.docRevs ?? data.docRevs }];
      } else if (
        (toolName === "workbook_read" &&
          data.mode === "objects" &&
          path[1] === "reportFacts" &&
          path.length === 2 &&
          object(data.reportFacts).version === 1) ||
        (toolName === "workbook_read" &&
          ["objects", "overview"].includes(String(data.mode)) &&
          source.pointer === "/data/preserved/externalLinkDetails") ||
        (toolName === "workbook_read" &&
          ["objects", "overview"].includes(String(data.mode)) &&
          source.pointer === "/data/macroEvidence") ||
        (["workbook_analyze", "workbook_query"].includes(toolName) &&
          data.mode === "sort_preflight" &&
          path[1] === "sortPreflight" &&
          path.length === 2)
      ) {
        reads = [{ ...data, toolName, docRevs: result.docRevs ?? data.docRevs }];
      } else if (
        ["workbook_analyze", "workbook_query"].includes(toolName) &&
        ((data.mode === "sql" && path[1] === "rows") ||
          (data.mode === "profile" && ["columns", "dataRows"].includes(path[1] ?? "")))
      ) {
        reads = [{ ...data, toolName, docRevs: result.docRevs ?? data.docRevs }];
      } else if (toolName === "run_script" && path[1] === "value") {
        const provenance = object(data.provenance);
        if (
          !Array.isArray(provenance.reads) ||
          !provenance.reads.length ||
          typeof provenance.code !== "string"
        )
          return invalid("脚本没有宿主记录的真实工作簿读取来源。");
        reads = provenance.reads.map(object);
      } else if (toolName === "workbook_edit") {
        return invalid("修改回执不作为最终核验证据；请在最后一次写入后重新读取或分析结果。");
      } else return invalid("该工具或结果字段不支持数值交付，请引用实际读取、分析或脚本结果。");
      const selected = at(result, path);
      if (
        path.length === 2 &&
        (data.truncated === true || object(data.readWindow).complete === false)
      )
        tooLarge("incomplete_window");
      // Projection truncation does not give the model access to hidden full-log values.
      if (JSON.stringify(at(visible.output, path)) !== JSON.stringify(selected))
        return invalid("引用结果不在当前可见上下文中，请缩小范围重新获取。");
      if (
        (toolName === "workbook_read" ||
          (["workbook_analyze", "workbook_query"].includes(toolName) && data.mode === "sort_preflight")) &&
        scalarLeaves(selected) > 0
      )
        hasDirectWorkbookFacts = true;
      const inputs = [
        ...new Map(
          reads
            .flatMap(sourcesOf)
            .map((input) => [
              JSON.stringify([
                input.docId,
                input.path,
                input.rev,
                input.sourceFile.currentSha256,
                input.scope,
                input.name,
              ]),
              input,
            ]),
        ).values(),
      ];
      if (!inputs.length) return invalid("结果没有可验证的输入来源。");
      if (inputs.length > 32) tooLarge("input_sources", inputs.length, 32);
      for (const input of inputs) {
        // meta is refreshed by entry/sourceStatus, including reopened documents after restart.
        await verifySource(input);
      }
      if (presentation === "summary") {
        const window = object(data.readWindow);
        if (["workbook_analyze", "workbook_query"].includes(toolName) && data.mode === "sql" && source.pointer === "/data/rows") {
          if (!sqlSummaryReceiptComplete(data, visibleData, result, object(visible.output), inputs) ||
              !sqlSummaryInputsComplete(log, ctx, source.toolCallId, row.fromSeq, inputs)) {
            diagnostics.add({ code: "SOURCE_WINDOW_UNSUPPORTED", category: "selection",
              toolCallId: source.toolCallId, refId: numericRefId(source),
              reason: "SQL 须有同次真实可见的完整表头、行数、查询及全部未裁剪来源和保存状态" });
          } else summaryWindows.set(source.toolCallId, {
            kind: "sql", columns: data.columns, sql: data.sql as string, sources: inputs,
            values: selected, toolCallId: source.toolCallId, refId: numericRefId(source),
          });
        } else if (toolName !== "workbook_read" || data.mode !== "range" ||
            source.pointer !== "/data/values" || inputs.length !== 1 ||
            window.complete !== true || window.clipped === true ||
            (typeof window.offset === "number" && window.offset !== 0) ||
            data.truncated === true || result.truncated === true ||
            (Array.isArray(result.warnings) && result.warnings.length > 0)) {
          diagnostics.add({ code: "SOURCE_WINDOW_UNSUPPORTED", category: "selection",
            toolCallId: source.toolCallId, refId: numericRefId(source),
            reason: "选择含非完整原文小读窗、分页裁剪、警告或特殊证据义务" });
        } else summaryWindows.set(source.toolCallId, {
          kind: "range", path: inputs[0]!.path, range: String(window.returnedRange), values: selected,
          toolCallId: source.toolCallId, refId: numericRefId(source),
        });
      }
      if (source.pointer === "/data/macroEvidence") {
        const evidence = currentMacroEvidence(selected, inputs[0]!);
        const meta = documents.meta(inputs[0]!.docId);
        if (!evidence || !meta || meta.checkpointRev !== inputs[0]!.rev || meta.checkpointError)
          return invalid(
            "宏静态证据不是与当前文件 SHA 和修订一致的已确认保存包，请等待已有保存完成后重新读取。",
          );
        macroDocs.add(inputs[0]!.docId);
        macroRootsInTurn &&=
          macroTurn?.receipts.some((receipt) => receipt.seq === row.fromSeq) === true;
      } else if (
        toolName === "workbook_read" &&
        data.mode === "range" &&
        ["values", "formulas"].includes(path[1] ?? "")
      ) {
        for (const input of inputs) macroRangeDocs.add(input.docId);
      } else onlyMacroAndRanges = false;
      if (source.pointer === "/data/preserved/externalLinkDetails") {
        const checkpoint = object(data.checkpointExternalLinks);
        if (
          JSON.stringify(object(object(visible.output).data).checkpointExternalLinks) !==
            JSON.stringify(checkpoint) ||
          checkpoint.source !== "preserved_package" ||
          checkpoint.isCurrent !== true ||
          checkpoint.checkpointRev !== inputs[0]!.rev ||
          checkpoint.currentRev !== inputs[0]!.rev ||
          checkpoint.packageState !== "confirmed_checkpoint"
        )
          return invalid("外链保存缓存不是已确认的当前保存修订，请等待已有保存完成后重新读取。");
      }
      if (!renderedTools.has(source.toolCallId)) {
        renderedTools.add(source.toolCallId);
        sections.push(
          `来源工具：${cell(toolName)} · ${cell(source.toolCallId)} · from_seq=${row.fromSeq}`,
        );
        sections.push(
          ...inputs.map(
            (input) =>
              `来源：${cell(input.path)} · ${cell(input.scope.kind === "range" ? input.scope.range : "document metadata (" + input.scope.mode + ")")} · rev ${input.rev}${input.name ? ` · 来源名称 ${cell(input.name)}` : ""}`,
          ),
        );
        if (["workbook_analyze", "workbook_query"].includes(toolName) && data.mode === "sql") {
          if (typeof data.sql !== "string")
            return invalid("SQL 结果缺少实际执行语句，请重新分析。");
          sections.push(`实际 SQL：${cell(data.sql)}`);
        }
        if (toolName === "run_script") {
          sections.push(`实际脚本：${cell(object(data.provenance).code)}`);
          for (const sql of new Set(
            reads.map((read) => read.sql).filter((sql): sql is string => typeof sql === "string"),
          ))
            sections.push(`脚本内实际 SQL：${cell(sql)}`);
        }
        for (const [index, read] of reads.entries()) {
          if (read.toolName !== "workbook_read" || read.mode !== "range") continue;
          const window = object(read.readWindow);
          sections.push(
            `读窗（${cell(source.toolCallId)} · from_seq=${row.fromSeq} · read=${index + 1}）：requestedRange=${cell(window.requestedRange ?? "未提供")} · effectiveRange=${cell(window.effectiveRange ?? read.range ?? "未提供")} · returnedRange=${cell(window.returnedRange ?? "未提供")} · clipped=${cell(window.clipped ?? "未提供")} · offset=${cell(window.offset ?? "未提供")} · returnedRows=${cell(window.returnedRows ?? "未提供")} · totalRows=${cell(window.totalRows ?? "未提供")} · complete=${cell(window.complete ?? "未提供")} · remainingRange=${cell(window.remainingRange ?? "无")}`,
          );
          if (window.clipped === true)
            sections.push(
              "范围说明：原请求超出当前工作表有效范围，返回经过裁剪；complete 仅指有效范围分页无剩余，不是原请求全部单元格已返回。",
            );
          if (typeof window.offset === "number" && window.offset > 0)
            sections.push(
              "范围说明：分页末页只证明该 offset 之后已读至末尾，不代表原请求的全部数据；读取行数不是业务记录数。",
            );
        }
        if (data.truncated === true || object(data.readWindow).complete === false)
          sections.push("范围说明：本次只引用实际返回的数据，不代表原请求的全部数据。");
      }
      if (source.pointer === "/data/macroEvidence") {
        if (!renderedLeaves.has(`${source.toolCallId}:macroEvidence`)) {
          renderedLeaves.add(`${source.toolCallId}:macroEvidence`);
          sections.push(...renderMacroEvidence(currentMacroEvidence(selected, inputs[0]!)!));
          count += scalarLeaves(selected);
          reportDocs.add(inputs[0]!.docId);
        }
          continue;
      }
      if (path[1] === "reportFacts") {
        if (!renderedLeaves.has(`${source.toolCallId}:reportFacts`)) {
          renderedLeaves.add(`${source.toolCallId}:reportFacts`);
          const report = renderReportFacts(object(selected));
          sections.push(...report.sections);
          numericCount += report.numericCount;
          count += report.leaves;
          reportDocs.add(inputs[0]!.docId);
        }
          continue;
      }
      if (path[1] === "sortPreflight") {
        if (!renderedLeaves.has(`${source.toolCallId}:sortPreflight`)) {
          renderedLeaves.add(`${source.toolCallId}:sortPreflight`);
          sections.push(renderSortPreflight(object(selected)));
          count += scalarLeaves(selected);
        }
          continue;
      }
      if (source.pointer === "/data/preserved/externalLinkDetails") {
        if (!renderedLeaves.has(`${source.toolCallId}:externalLinkDetails`)) {
          renderedLeaves.add(`${source.toolCallId}:externalLinkDetails`);
          sections.push(...renderExternalLinks(object(selected)));
          count += scalarLeaves(selected);
        }
          continue;
      }
      const rows: string[] = [
        "| 位置／指标 | 原始值 | 公式 | 格式化显示 |",
        "| --- | --- | --- | --- |",
      ];
      const add = (
        position: string,
        value: unknown,
        formula = "未提供",
        display = "未提供格式信息",
        raw = scalar(value),
      ) => {
        count += 1;
        if (typeof value === "number" && Number.isFinite(value)) numericCount++;
        rows.push(`| ${cell(position)} | ${cell(raw)} | ${cell(formula)} | ${cell(display)} |`);
      };
      const visit = (value: unknown, trail: string[]) => {
        if (value && typeof value === "object") {
          for (const [key, part] of Object.entries(value)) visit(part, [...trail, key]);
          return;
        }
        const leafKey = JSON.stringify([source.toolCallId, trail]);
        if (renderedLeaves.has(leafKey)) return;
        renderedLeaves.add(leafKey);
        if (toolName === "workbook_read") {
          if (trail.length !== 4) return invalid("只能引用读取结果的完整行列数据或单元格。");
          const r = Number(trail[2]),
            c = Number(trail[3]);
          const input = inputs[0];
          const range = parseRange(
            input?.scope.kind === "range" ? input.scope.range : invalid("缺少实际读取区域。"),
          );
          const ref = formatRange({
            sheet: range.sheet,
            startRow: range.startRow + r,
            endRow: range.startRow + r,
            startCol: range.startCol + c,
            endCol: range.startCol + c,
          });
          const formula = Array.isArray(data.formulas) ? data.formulas[r] : undefined;
          const visibleFormula = Array.isArray(visibleData.formulas)
            ? visibleData.formulas[r]
            : undefined;
          const formulaValue =
            Array.isArray(formula) &&
            Array.isArray(visibleFormula) &&
            c < formula.length &&
            c < visibleFormula.length &&
            formula[c] === visibleFormula[c]
              ? formula[c]
              : undefined;
          if (trail[1] === "formulas") {
            add(
              ref,
              value,
              typeof value === "string" ? value : "无／未提供",
              "仅引用公式，非计算值",
            );
            return;
          }
          const styles = Array.isArray(data.styles) ? data.styles[r] : undefined;
          let shown = "未提供格式信息";
          const displays = Array.isArray(data.displayValues) ? data.displayValues[r] : undefined;
          const visibleDisplays = Array.isArray(visibleData.displayValues)
            ? visibleData.displayValues[r]
            : undefined;
          const visibleStyles = Array.isArray(visibleData.styles)
            ? visibleData.styles[r]
            : undefined;
          if (
            data.displayBasis === "same_snapshot_number_format" &&
            visibleData.displayBasis === data.displayBasis &&
            Array.isArray(displays) &&
            Array.isArray(visibleDisplays) &&
            c < displays.length &&
            c < visibleDisplays.length &&
            displays[c] === visibleDisplays[c]
          ) {
            shown = typeof displays[c] === "string" ? displays[c] : "格式不受支持，仅列原始值";
          } else if (
            Array.isArray(styles) &&
            c < styles.length &&
            Array.isArray(visibleStyles) &&
            c < visibleStyles.length &&
            JSON.stringify(styles[c]) === JSON.stringify(visibleStyles[c])
          ) {
            let supported = true;
            shown = displayText(
              value,
              object(object(styles[c]).n).pattern as string | undefined,
              () => {
                supported = false;
              },
            );
            if (!supported) shown = "格式不受支持，仅列原始值";
          }
          const address = `${indexToCol(range.startCol + c)}${range.startRow + r}`;
          if (formulaValue !== undefined)
            renderedLeaves.add(
              JSON.stringify([source.toolCallId, ["data", "formulas", String(r), String(c)]]),
            );
          const trueBlank = Array.isArray(data.blankCells) && data.blankCells.includes(address);
          add(
            ref,
            value,
            typeof formulaValue === "string" ? formulaValue : "无／未提供",
            shown,
            trueBlank ? "真空白（blankCells）" : scalar(value),
          );
          const label = boundLabels.get(
            numericRefId({ toolCallId: source.toolCallId, pointer: `/${trail.join("/")}` }),
          );
          if (label)
            sections.push(
              `标签绑定：${cell(ref)} ← ${cell(label.address)} 原文“${cell(label.text)}”（${label.relation === "same_row" ? "同一行紧邻左侧" : "同一列上方读窗首行"}，仅位置关系，不认证业务口径）；单位：${cell(label.unit ?? "未提供，不能推断")}。`,
            );
        } else if (["workbook_analyze", "workbook_query"].includes(toolName) && data.mode === "sql") {
          const column = Array.isArray(data.columns) ? data.columns[Number(trail[3])] : undefined;
          add(
            `结果行 ${Number(trail[2]) + 1} · ${String(column ?? indexToCol(Number(trail[3]) + 1))}`,
            value,
          );
        } else {
          const metric = trail.slice(2).join(" / ") || "脚本结果";
          const column =
            data.mode === "profile" && path[1] === "columns" && Array.isArray(data.columns)
              ? object(data.columns[Number(trail[2])]).name
              : undefined;
          add(column ? `${String(column)} / ${metric}` : metric, value);
        }
      };
      visit(selected, path);
      if (rows.length > 2) sections.push(`选择：${cell(source.pointer)}`, rows.join("\n"));
    }
    for (const readback of completeness?.readbacks ?? []) {
      await verifySource(readback.source);
      sections.push(
        `排序目标写后读取覆盖：${cell(readback.source.path)} · ${cell(readback.targetRange)} · rev ${readback.source.rev}；当前完整窗口已读取 values/formulas，returnedRange=${cell(readback.returnedRange)} · ${cell(readback.toolCallId)} · from_seq=${readback.seq}。${readback.displayedInFull ? "本窗口值与公式随证据逐项列出。" : "终稿只展示选定细项，不是全部记录；完整读取覆盖不等于业务记录关联已独立校验通过。"}`,
      );
    }
    for (const fact of completeness?.sortExecutions ?? []) {
      sections.push(
        `本轮实际排序执行：${cell(fact.path)} · ${cell(fact.targetRange)} · hasHeader=${fact.hasHeader}；${
          fact.outcome === "executed"
            ? `已取得该目标成功排序回执 · ${cell(fact.toolCallId)} · from_seq=${fact.seq} · 执行后 rev=${fact.rev} · keys=${cell(JSON.stringify(fact.keys))}。这是历史实际执行，不用写后预检冒充。`
            : fact.outcome === "preflight_only"
              ? "本轮仅取得该目标只读预检，未取得成功排序回执；不据此宣称整张表从未修改。"
              : "本轮存在文档写入，但未取得可确定匹配该目标的成功排序回执；执行状态未确认，不按当前预检推断。"
        }`,
      );
    }
    for (const fact of completeness?.sortPreservations ?? []) {
      await verifySource(fact.before.source);
      await verifySource(fact.after.source);
      const rendered = renderSortPreservation(fact);
      count += rendered.leaves;
      sections.push(rendered.text);
    }
    for (const fact of completeness?.macroPreservations ?? []) {
      await verifySource(fact.before.source);
      await verifySource(fact.after.source);
      const rendered = renderMacroPreservation(fact);
      count += rendered.leaves;
      sections.push(rendered.text);
    }
    const pendingNumeric =
      ctx.turnId !== undefined &&
      numericDeliveryState(log.dbHandle, ctx.sessionId, ctx.agentId, ctx.turnId).required;
    // This exception is only a verified macro report plus raw cells of those same documents.
    // It never turns metadata counters, SQL/script prose or unrelated text into numeric proof.
    const macroOnlyReport =
      requireCandidates &&
      macroTurn?.startSeq !== undefined &&
      !pendingNumeric &&
      macroDocs.size > 0 &&
      macroRootsInTurn &&
      onlyMacroAndRanges &&
      [...macroRangeDocs].every((docId) => macroDocs.has(docId));
    const numericRequired = (!scopedDelivery && !macroOnlyReport) || pendingNumeric;
    if (!numericCount && numericRequired)
      return invalid("引用结果没有实际数值，不能用标签或文字代替数值交付。");
    if (!numericCount && !hasDirectWorkbookFacts)
      return invalid(
        "受限非数值交付需要真实工作簿原始数据、公式或受支持的宿主事实，不能仅用脚本或 SQL 自造文字完成。",
      );
    const prepared = requireCandidates
      ? await prepareSelectedFiles(log, documents, verifiedSources, reportDocs, ctx, scopedDelivery)
      : { files: [], cards: [] };
    // A later awaited source check can let another document's revision change.
    // Recheck all revisions synchronously; this does not claim cross-file disk locking.
    for (const source of verifiedSources) {
      const meta = documents.meta(source.docId);
      if (
        !meta ||
        meta.externalConflict ||
        meta.workspaceId !== ctx.workspaceId ||
        meta.rev !== source.rev ||
        meta.path !== source.path ||
        meta.checkpointRev !== meta.rev ||
        meta.checkpointError ||
        downloadableSha(resolveWorkspacePath(ctx.workspaceRoot, source.path).abs) !== source.sourceFile.currentSha256
      )
        throw new EvidenceError(
          "VERSION_CONFLICT",
          "核验过程中来源已发生修订，请重新读取或分析后交付。",
        );
    }
    const finalAccess = accessReport();
    if (
      scopedDelivery &&
      (!finalAccess?.required ||
        finalAccess.coverage !== "complete" ||
        currentToolAccess()?.auditFailed ||
        JSON.stringify(finalAccess.decision) !== JSON.stringify(initialAccess.decision))
    )
      return invalid("核验过程中的访问范围或访问事实未完整确认，不能完成交付。");
    if (scopedDelivery && access && documents.hasPendingWritesForOrigin(ctx.workspaceId, access))
      throw new EvidenceError(
        "VERSION_CONFLICT",
        "本轮仍有工作簿计算或保存未完成，不能通过省略该文件完成交付。请等待已有计算和保存完成，再重新读取来源；不会暗中保存或刷新。",
      );
    const alignmentNotes = alignmentReceiptNotes(log, ctx, documents);
    const auditText = [
      ...sections,
      ...alignmentNotes,
      numericExecutionFacts(log.dbHandle, ctx.sessionId, ctx.agentId, ctx.turnId),
      ...(scopedDelivery && finalAccess ? [renderAccessFacts(finalAccess)] : []),
    ].join("\n\n");
    let finalText = auditText;
    let presentationUsed: "evidence" | "summary" = "evidence";
    let summaryFallback: string | undefined;
    if (presentation === "summary") {
      if (completeness && [completeness.readbacks, completeness.sortExecutions,
          completeness.sortPreservations, completeness.macroPreservations].some((facts) => facts.length))
        diagnostics.add({ code: "SPECIAL_OBLIGATIONS", category: "mandatory-disclosure",
          reason: "本轮存在排序或宏保留义务，需要完整呈现范围和限制" });
      const compact = renderSummaryWindows([...summaryWindows.values()], diagnostics);
      const execution = summaryExecutionNotes(log, ctx, diagnostics);
      if (alignmentNotes.join("\n").length > 2000)
        diagnostics.add({ code: "ALIGNMENT_DISCLOSURE_LIMIT", category: "mandatory-disclosure",
          actual: alignmentNotes.join("\n").length, limit: 2000,
          reason: "声明字段校验状态与范围过长，保留完整披露" });
      if (finalAccess && (finalAccess.rejected.length || finalAccess.failed.length ||
          finalAccess.coverage !== "complete" || finalAccess.priorUnscopedActivity ||
          finalAccess.pendingProducers.length))
        diagnostics.add({ code: "ACCESS_FACTS_REQUIRED", category: "mandatory-disclosure",
          reason: "本轮有拒绝、失败或未完整确认的访问事实，保留完整记录" });
      summaryFallback = diagnostics.result().blockers[0]?.reason;
      if (summaryFallback) finalText = [`摘要未压缩，简短呈现要求未满足：${summaryFallback}。以下保留完整核验证据；已核验文件仍按实际状态交付，不表示文件缺失或业务核验失败。`, ...execution, auditText].join("\n\n");
      else {
        presentationUsed = "summary";
        finalText = [
          "已核验的原文小汇总（只呈现所选窗口，不认证全部业务口径；单位与对象按原文保留，不补猜）：",
          compact!,
          ...execution,
          ...alignmentNotes,
          ...(prepared.files.length ? [`已保存并交付：${prepared.files.map((file) => cell(file.path)).join("、")}。`] : []),
          "完整来源、公式、执行与访问记录保留在本次工具结果中。",
        ].join("\n\n");
      }
    }
    if (!suppressCards && prepared.cards.length)
      log.append(
        ctx.sessionId,
        ctx.agentId,
        prepared.cards.map((data) => ({ type: "ui.present", data })),
      );
    return {
      status: "ok",
      data: {
        finalizationStatus: "complete",
        presentationOverflow: { cells: count > MAX_CELLS, text: finalText.length > MAX_TEXT },
        deliveredFiles: prepared.files,
        sourceDependencies: verifiedSources,
        finalText,
        ...(presentation === "summary" ? { auditText, presentationUsed,
          presentationSatisfied: !summaryFallback, summaryDiagnostics: diagnostics.result(),
          ...(summaryFallback ? { fallbackReason: summaryFallback } : {}) } : {}),
      },
    };
  } catch (error) {
    return {
      status: "error",
      error: {
        code: toToolErrorCode(error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "INVALID_ARGUMENT"),
        message: error instanceof Error ? error.message +
          (error instanceof EvidenceError && error.code === "LIMIT_EXCEEDED" &&
           error.message.includes("reason=selected_cells") ? selectedCellDiagnostic(log, ctx, args.sources) : "")
          : "数值证据核验失败，请重新获取来源。",
        retryable: false,
      },
    };
  }
}
