import { z } from "zod";

const macroHash = z.string().regex(/^[a-f0-9]{64}$/);
const macroText = z.string().max(1000);
const macroContentType = z.strictObject({
  contentType: macroText.nullable(),
  source: z.enum(["Default", "Override"]).nullable(),
  match: macroText.nullable(),
});
/** A closed static host report. It contains neither executable VBA nor model-authored prose. */
export const MacroEvidence = z.strictObject({
  version: z.literal(1),
  source: z.literal("current_disk_bytes"),
  package: z.strictObject({
    path: macroText.min(1),
    sha256: macroHash,
    byteLength: z.number().int().nonnegative(),
  }),
  checkpoint: z.strictObject({
    checkpointRev: z.number().int().nonnegative(),
    currentRev: z.number().int().nonnegative(),
    packageRev: z.number().int().nonnegative().nullable(),
    isCurrent: z.boolean(),
    packageState: z.enum([
      "confirmed_checkpoint",
      "saved_checkpoint_not_current",
      "unconfirmed_disk",
    ]),
  }),
  format: z.strictObject({ workbookContentType: macroText.nullable(), macroEnabled: z.boolean() }),
  project: z.strictObject({
    status: z.enum(["present", "absent", "unsupported"]),
    part: macroText.nullable(),
    byteLength: z.number().int().nonnegative().nullable(),
    sha256: macroHash.nullable(),
    cfbHeaderPresent: z.boolean().nullable(),
  }),
  relationships: z
    .array(
      z.strictObject({
        sourcePart: macroText,
        relsPart: macroText,
        relsSha256: macroHash,
        id: macroText,
        type: macroText,
        target: macroText,
        targetMode: macroText.nullable(),
        resolvedPart: macroText.nullable(),
      }),
    )
    .max(32),
  contentTypes: z.strictObject({
    partSha256: macroHash,
    workbook: macroContentType,
    vba: macroContentType,
  }),
  codeNames: z.strictObject({
    workbook: macroText.nullable(),
    sheets: z
      .array(
        z.strictObject({
          name: macroText,
          sheetId: macroText,
          relationshipId: macroText,
          part: macroText,
          codeName: macroText.nullable(),
        }),
      )
      .max(200),
  }),
  signatureStatus: z.enum(["absent", "present", "unknown"]),
  inspection: z.strictObject({
    status: z.enum(["complete", "unsupported"]),
    reasonCode: z.enum([
      "none",
      "unsupported_package",
      "ambiguous_graph",
      "missing_project",
      "unsupported_content_type",
      "unsupported_xml",
    ]),
  }),
  cellEditSupport: z.strictObject({
    status: z.enum(["conditional", "blocked", "not_applicable"]),
    reasonCode: z.enum([
      "literal_cells_only",
      "signature_present",
      "inspection_unsupported",
      "not_macro",
    ]),
  }),
  capabilities: z.strictObject({
    macroExecution: z.literal(false),
    runtimeValidation: z.literal(false),
    inspection: z.literal("static_package_only"),
  }),
});
export type MacroEvidence = z.infer<typeof MacroEvidence>;

/** Shared, bounded selectors for visible numeric evidence. Handles locate; they never authorize. */
type Json = Record<string, unknown>;
const object = (value: unknown): Json =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
const escapePointerToken = (key: string) => key.replaceAll("~", "~0").replaceAll("/", "~1");
export interface NumericPointer {
  toolCallId: string;
  pointer: string;
}
export interface NumericLabelBinding {
  valueRefId: string;
  labelRefId: string;
  relation: "same_row" | "same_column";
}
export interface NumericBindingPointer {
  toolCallId: string;
  valuePointer: string;
  labelPointer: string;
  relation: NumericLabelBinding["relation"];
}
export interface NumericBindingSelection {
  bindingId: string;
}
interface NumericCellPosition {
  returnedRange: string;
  rowOffset: number;
  columnOffset: number;
}
export interface NumericBindingCandidate extends NumericLabelBinding, NumericBindingSelection {
  value: { pointer: string; value: number; position: NumericCellPosition };
  label: { pointer: string; text: string; position: NumericCellPosition };
  unit: { value: string; sourcePointer?: string };
}

const explicitUnits = new Set([
  "元",
  "万元",
  "亿元",
  "人民币元",
  "美元",
  "欧元",
  "日元",
  "港元",
  "英镑",
  "CNY",
  "USD",
  "EUR",
  "JPY",
  "HKD",
  "GBP",
  "%",
  "％",
  "百分比",
  "件",
  "个",
  "台",
  "套",
  "份",
  "人",
  "次",
  "笔",
  "条",
  "行",
  "项",
  "只",
  "箱",
  "包",
  "吨",
  "千克",
  "公斤",
  "克",
  "毫克",
  "kg",
  "g",
  "mg",
  "t",
  "米",
  "厘米",
  "毫米",
  "千米",
  "m",
  "cm",
  "mm",
  "km",
  "平方米",
  "立方米",
  "㎡",
  "m²",
  "m³",
  "升",
  "毫升",
  "L",
  "mL",
  "秒",
  "分钟",
  "小时",
  "天",
  "日",
  "月",
  "年",
  "s",
  "min",
  "h",
  "KB",
  "MB",
  "GB",
  "TB",
  "kWh",
]);
/** A literal, recognized unit (or ratio), not every parenthesized label qualifier. */
export function numericLabelUnit(label: string): string | undefined {
  const unit = /[（(]([^()（）\r\n]{1,20})[）)]\s*$/.exec(label)?.[1]?.trim();
  if (
    unit &&
    unit.split("/").length <= 2 &&
    unit.split("/").every((part) => explicitUnits.has(part))
  )
    return unit;
  if (/^(?:明细|数据|记录)?行数$/.test(label.trim())) return "行";
  return undefined;
}
export interface NumericSource {
  docId: string;
  path: string;
  rev: number;
  scope: { kind: "range"; range: string } | { kind: "document"; mode: "overview" | "objects" };
  sourceFile: Json & { currentSha256: string };
  name?: string;
}
export function currentMacroEvidence(
  value: unknown,
  source: NumericSource,
): MacroEvidence | undefined {
  const parsed = MacroEvidence.safeParse(value);
  if (!parsed.success) return;
  const evidence = parsed.data;
  if (
    evidence.package.path !== source.path ||
    evidence.package.sha256 !== source.sourceFile.currentSha256 ||
    source.sourceFile.pendingWrite !== false ||
    evidence.checkpoint.isCurrent !== true ||
    evidence.checkpoint.packageState !== "confirmed_checkpoint" ||
    evidence.checkpoint.checkpointRev !== source.rev ||
    evidence.checkpoint.currentRev !== source.rev ||
    evidence.checkpoint.packageRev !== source.rev
  )
    return;
  return evidence;
}
export function numericPointerTokens(pointer: string): string[] | undefined {
  if (!pointer.startsWith("/") || pointer.length > 1000 || /~(?:[^01]|$)/.test(pointer)) return;
  return pointer
    .slice(1)
    .split("/")
    .map((key) => key.replaceAll("~1", "/").replaceAll("~0", "~"));
}
export function numericRefId({ toolCallId, pointer }: NumericPointer): string {
  // JSON's escaping also preserves Unicode (including lone surrogates) without Buffer/browser APIs.
  return `nr1:${JSON.stringify([toolCallId, pointer])}`;
}
export function decodeNumericRefId(refId: string): NumericPointer | undefined {
  if (!refId.startsWith("nr1:") || refId.length > 7300) return;
  try {
    const pair: unknown = JSON.parse(refId.slice(4));
    if (!Array.isArray(pair) || pair.length !== 2) return;
    const [toolCallId, pointer] = pair;
    if (
      typeof toolCallId !== "string" ||
      !toolCallId.length ||
      toolCallId.length > 200 ||
      typeof pointer !== "string" ||
      !numericPointerTokens(pointer)
    )
      return;
    const result = { toolCallId, pointer };
    return numericRefId(result) === refId ? result : undefined;
  } catch {
    return;
  }
}
export function numericBindingId(binding: NumericBindingPointer): string {
  return `nb1:${JSON.stringify([
    binding.toolCallId,
    binding.valuePointer,
    binding.labelPointer,
    binding.relation,
  ])}`;
}
export function decodeNumericBindingId(bindingId: string): NumericBindingPointer | undefined {
  if (!bindingId.startsWith("nb1:") || bindingId.length > 13400) return;
  try {
    const parts: unknown = JSON.parse(bindingId.slice(4));
    if (!Array.isArray(parts) || parts.length !== 4) return;
    const [toolCallId, valuePointer, labelPointer, relation] = parts;
    if (
      typeof toolCallId !== "string" ||
      !toolCallId.length ||
      toolCallId.length > 200 ||
      typeof valuePointer !== "string" ||
      !numericPointerTokens(valuePointer) ||
      typeof labelPointer !== "string" ||
      !numericPointerTokens(labelPointer) ||
      (relation !== "same_row" && relation !== "same_column")
    )
      return;
    const binding = { toolCallId, valuePointer, labelPointer, relation };
    return numericBindingId(binding) === bindingId ? binding : undefined;
  } catch {
    return;
  }
}

/** All reads must normalize, including document metadata. Never filter out an unknown read. */
export function numericReadSources(read: Json): NumericSource[] | undefined {
  if (
    ["workbook_analyze", "workbook_query"].includes(String(read.toolName)) &&
    read.mode === "sort_preflight"
  ) {
    const source = sourceOf(read, object(read.docRevs)[String(read.docId)], {
      kind: "range",
      range: object(read.sortPreflight).targetRange,
    });
    return source ? [source] : undefined;
  }
  if (
    ["workbook_analyze", "workbook_query"].includes(String(read.toolName)) &&
    ["sql", "profile"].includes(String(read.mode)) &&
    Array.isArray(read.sources) &&
    read.sources.length
  ) {
    const sources: NumericSource[] = [];
    for (const entry of read.sources) {
      const source = object(entry);
      const normalized = sourceOf(source, source.rev, { kind: "range", range: source.range });
      if (!normalized || object(read.docRevs)[normalized.docId] !== normalized.rev) return;
      sources.push(normalized);
    }
    return sources;
  }
  if (read.toolName !== "workbook_read") return;
  const scope =
    read.mode === "range"
      ? { kind: "range", range: object(read.readWindow).returnedRange }
      : read.mode === "overview" || read.mode === "objects"
        ? { kind: "document", mode: read.mode }
        : undefined;
  if (!scope) return;
  const source = sourceOf(read, object(read.docRevs)[String(read.docId)], scope);
  return source ? [source] : undefined;
}
function sourceOf(source: Json, rev: unknown, scope: Json): NumericSource | undefined {
  const file = object(source.sourceFile);
  if (
    typeof source.docId !== "string" ||
    !source.docId ||
    typeof source.path !== "string" ||
    !source.path ||
    typeof rev !== "number" ||
    !Number.isInteger(rev) ||
    rev < 0 ||
    typeof file.currentSha256 !== "string" ||
    !file.currentSha256 ||
    (scope.kind === "range" && (typeof scope.range !== "string" || !scope.range))
  )
    return;
  return {
    docId: source.docId,
    path: source.path,
    rev,
    scope: scope as NumericSource["scope"],
    sourceFile: file as NumericSource["sourceFile"],
    ...(typeof source.name === "string" ? { name: source.name } : {}),
  };
}
export function numericResultContract(
  toolName: string,
  output: unknown,
): { fields: string[]; reads: Json[]; sources: NumericSource[] } | undefined {
  const result = object(output),
    data = object(result.data);
  if (result.status !== "ok" || Object.hasOwn(data, "preview")) return;
  let fields: string[], reads: Json[];
  if (toolName === "workbook_read" && data.mode === "range") fields = ["values", "formulas"];
  else if (toolName === "workbook_read" && ["objects", "overview"].includes(String(data.mode))) {
    fields = [];
    if (MacroEvidence.safeParse(data.macroEvidence).success) fields.push("macroEvidence");
    if (data.mode === "objects" && object(data.reportFacts).version === 1)
      fields.push("reportFacts");
    const links = object(object(data.preserved).externalLinkDetails);
    if (
      links.source === "preserved_package" &&
      object(data.checkpointExternalLinks).source === "preserved_package" &&
      [links.links, links.formulaCaches].some((value) => Array.isArray(value) && value.length)
    )
      fields.push("preserved/externalLinkDetails");
    if (!fields.length) return;
  } else if (
    ["workbook_analyze", "workbook_query"].includes(toolName) &&
    data.mode === "sort_preflight"
  )
    fields = ["sortPreflight"];
  else if (["workbook_analyze", "workbook_query"].includes(toolName) && data.mode === "sql")
    fields = ["rows"];
  else if (["workbook_analyze", "workbook_query"].includes(toolName) && data.mode === "profile")
    fields = ["columns", "dataRows"];
  else if (toolName === "run_script") {
    const provenance = object(data.provenance);
    if (
      typeof provenance.code !== "string" ||
      !Array.isArray(provenance.reads) ||
      !provenance.reads.length
    )
      return;
    reads = provenance.reads.map(object);
    fields = ["value"];
  } else return;
  reads ??= [{ ...data, toolName, docRevs: result.docRevs ?? data.docRevs }];
  const sources: NumericSource[] = [];
  for (const read of reads) {
    const normalized = numericReadSources(read);
    if (!normalized?.length) return;
    sources.push(...normalized);
  }
  // An older read cannot borrow a newer published revision, nor can a mixed readset look current.
  if (
    sources.some((source) =>
      sources.some((other) => other.docId === source.docId && other.rev !== source.rev),
    )
  )
    return;
  return { fields, reads, sources };
}
export interface NumericCandidate {
  refId: string;
  pointer: string;
  valueType: "array" | "object" | "null" | "string" | "number" | "boolean";
  field: { name: string; pointer: string };
  column?: { name: string; pointer: string };
  unit: "未提供";
}
export const NUMERIC_CATALOG_MAX_ITEMS = 160;
export const NUMERIC_CATALOG_MAX_CHARS = 12000;
export function numericEvidence(toolCallId: string, toolName: string, output: unknown) {
  const contract = numericResultContract(toolName, output);
  if (!contract || !toolCallId.length || toolCallId.length > 200) return;
  const data = object(object(output).data);
  const items: NumericCandidate[] = [];
  // The value catalog, relation catalog and copyable selections share one text budget.
  let chars = 6;
  const choices: {
    candidate: NumericCandidate;
    priority: number;
    number: boolean;
    field: string;
  }[] = [];
  const roots: { field: string; root: string; whole: boolean }[] = [];
  const defaults: string[] = [];
  let subset = false;
  const summary = (value: unknown): { leaves: number; numbers: number } => {
    if (value !== null && typeof value === "object")
      return Object.values(value).reduce<{ leaves: number; numbers: number }>(
        (sum, v) => {
          const n = summary(v);
          return { leaves: sum.leaves + n.leaves, numbers: sum.numbers + n.numbers };
        },
        { leaves: 0, numbers: 0 },
      );
    return { leaves: 1, numbers: typeof value === "number" && Number.isFinite(value) ? 1 : 0 };
  };
  for (const field of contract.fields) {
    const value =
      field === "preserved/externalLinkDetails"
        ? object(data.preserved).externalLinkDetails
        : data[field];
    if (value === undefined) continue;
    const root = `/data/${field}`,
      stats = summary(value);
    const complete = data.truncated !== true && object(data.readWindow).complete !== false;
    const whole =
      complete &&
      field !== "preserved/externalLinkDetails" &&
      stats.numbers > 0 &&
      stats.leaves <= 100 &&
      JSON.stringify(value).length <= 6000;
    const pending: (() => void)[] = [];
    const visit = (
      value: unknown,
      pointer: string,
      trail: string[],
      fieldOrigin = { name: field, pointer: root },
    ): void => {
      const stats = summary(value);
      const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
      if (!["null", "array", "object", "string", "number", "boolean"].includes(type)) return;
      let origin = fieldOrigin;
      if (
        ["workbook_analyze", "workbook_query"].includes(toolName) &&
        data.mode === "sql" &&
        trail.length === 2 &&
        Array.isArray(data.columns) &&
        typeof data.columns[Number(trail[1])] === "string"
      )
        origin = {
          name: String(data.columns[Number(trail[1])]),
          pointer: `/data/columns/${trail[1]}`,
        };
      else if (trail.length && !/^\d+$/.test(trail.at(-1)!))
        origin = { name: trail.at(-1)!, pointer };
      const candidate: NumericCandidate = {
        refId: numericRefId({ toolCallId, pointer }),
        pointer,
        valueType: type as NumericCandidate["valueType"],
        field: origin,
        unit: "未提供",
      };
      const column =
        data.mode === "profile" && field === "columns" && trail.length
          ? object(Array.isArray(data.columns) ? data.columns[Number(trail[0])] : undefined).name
          : undefined;
      if (typeof column === "string")
        candidate.column = { name: column, pointer: `/data/columns/${trail[0]}/name` };
      if (
        numericPointerTokens(pointer) &&
        stats.leaves <= 200 &&
        JSON.stringify(value).length <= 6000 &&
        (pointer !== root || complete) &&
        // Host reports are selected atomically. No arbitrary metadata pointers.
        (![
          "reportFacts",
          "sortPreflight",
          "preserved/externalLinkDetails",
          "macroEvidence",
        ].includes(field) ||
          pointer === root)
      ) {
        choices.push({
          candidate,
          priority:
            pointer === root
              ? 0
              : !Array.isArray(data[field]) && trail.length === 1
                ? 1
                : value === null || typeof value !== "object"
                  ? 2
                  : 3,
          number: typeof value === "number" && Number.isFinite(value),
          field,
        });
      }
      if (value !== null && typeof value === "object")
        for (const [key, part] of Object.entries(value))
          pending.push(() =>
            visit(part, `${pointer}/${escapePointerToken(key)}`, [...trail, key], origin),
          );
    };
    visit(value, root, []);
    for (let index = 0; index < pending.length; index++) pending[index]?.();
    roots.push({ field, root, whole });
  }
  // Reserve roots and one numeric fallback per family before optional detail catalogs.
  for (const { field } of roots) {
    const fallback = choices.find((choice) => choice.field === field && choice.number);
    if (fallback) fallback.priority = -1;
  }
  const possibleBindings: { binding: NumericBindingCandidate; explicitUnit: boolean }[] = [];
  const byRef = new Map(choices.map((choice) => [choice.candidate.refId, choice]));
  if (toolName === "workbook_read" && data.mode === "range" && Array.isArray(data.values)) {
    const values = data.values;
    for (const { candidate } of choices) {
      const match = /^\/data\/values\/(\d+)\/(\d+)$/.exec(candidate.pointer);
      if (!match || candidate.valueType !== "number") continue;
      const r = Number(match[1]),
        c = Number(match[2]);
      for (const label of [
        { r, c: c - 1, relation: "same_row" as const },
        { r: 0, c, relation: "same_column" as const },
      ]) {
        if (label.c < 0 || (label.relation === "same_column" && r === 0)) continue;
        const row = values[label.r],
          value = Array.isArray(row) ? row[label.c] : undefined;
        if (typeof value !== "string" || !value.trim() || value.length > 200) continue;
        const labelPointer = `/data/values/${label.r}/${label.c}`;
        const labelRefId = numericRefId({ toolCallId, pointer: labelPointer });
        const unit = numericLabelUnit(value);
        const number = Array.isArray(values[r]) ? values[r][c] : undefined;
        const returnedRange = String(object(data.readWindow).returnedRange);
        if (byRef.has(labelRefId) && typeof number === "number" && Number.isFinite(number))
          possibleBindings.push({
            binding: {
              bindingId: numericBindingId({
                toolCallId,
                valuePointer: candidate.pointer,
                labelPointer,
                relation: label.relation,
              }),
              valueRefId: candidate.refId,
              labelRefId,
              relation: label.relation,
              value: {
                pointer: candidate.pointer,
                value: number,
                position: { returnedRange, rowOffset: r, columnOffset: c },
              },
              label: {
                pointer: labelPointer,
                text: value,
                position: { returnedRange, rowOffset: label.r, columnOffset: label.c },
              },
              unit: unit ? { value: unit, sourcePointer: labelPointer } : { value: "未提供" },
            },
            explicitUnit: unit !== undefined,
          });
      }
    }
  }
  possibleBindings.sort((a, b) => Number(b.explicitUnit) - Number(a.explicitUnit));
  // Keep a bounded set of real pairs discoverable before spending the shared budget on details.
  for (const { binding } of possibleBindings.slice(0, 8)) {
    byRef.get(binding.valueRefId)!.priority = -2;
    byRef.get(binding.labelRefId)!.priority = -2;
  }
  const bindingBudget = Math.min(
    6000,
    possibleBindings.reduce(
      (sum, { binding }) =>
        sum +
        JSON.stringify(binding).length +
        JSON.stringify({ bindingId: binding.bindingId }).length +
        2,
      0,
    ),
  );
  for (const { candidate } of choices.sort((a, b) => a.priority - b.priority)) {
    const size = JSON.stringify(candidate).length + (items.length ? 1 : 0);
    if (
      items.length >= NUMERIC_CATALOG_MAX_ITEMS ||
      chars + size > NUMERIC_CATALOG_MAX_CHARS - bindingBudget
    )
      continue;
    items.push(candidate);
    chars += size;
  }
  const shown = new Set(items.map((item) => item.refId));
  for (const { field, root, whole } of roots) {
    const pivots = object(data.reportFacts).pivots;
    // Empty pivot reports remain selectable, but are not useful defaults for a macro-only report.
    if (
      field === "reportFacts" &&
      contract.fields.includes("macroEvidence") &&
      Array.isArray(pivots) &&
      pivots.length === 0
    )
      continue;
    const rootCandidate = items.find((item) => item.pointer === root);
    const firstNumber = choices.find(
      (choice) => choice.field === field && choice.number && shown.has(choice.candidate.refId),
    );
    if (whole && rootCandidate) defaults.push(rootCandidate.refId);
    else if (firstNumber) {
      defaults.push(firstNumber.candidate.refId);
      subset = true;
    }
  }
  const total = choices.length;
  if (!items.length) return;
  const bindings: NumericBindingSelection[] = [];
  const bindingCandidates: NumericBindingCandidate[] = [];
  const boundDefaults = new Set<string>();
  // Count the full relation set: clipping an alternative must never create a unique default.
  const bindingCounts = new Map<string, { total: number; units: number }>();
  for (const { binding, explicitUnit } of possibleBindings) {
    const counts = bindingCounts.get(binding.valueRefId) ?? { total: 0, units: 0 };
    counts.total++;
    counts.units += Number(explicitUnit);
    bindingCounts.set(binding.valueRefId, counts);
  }
  const defaultRefs = new Set(defaults);
  const defaultPointers = items
    .filter((candidate) => defaultRefs.has(candidate.refId))
    .map((candidate) => candidate.pointer);
  for (const { binding, explicitUnit } of possibleBindings) {
    if (!shown.has(binding.valueRefId) || !shown.has(binding.labelRefId)) continue;
    const selection = { bindingId: binding.bindingId };
    const counts = bindingCounts.get(binding.valueRefId);
    const selected =
      (counts?.units === 1 ? explicitUnit : counts?.units === 0 && counts.total === 1) &&
      !boundDefaults.has(binding.valueRefId) &&
      defaultPointers.some(
        (pointer) =>
          binding.value.pointer === pointer || binding.value.pointer.startsWith(`${pointer}/`),
      );
    const size =
      JSON.stringify(binding).length +
      (bindingCandidates.length ? 1 : 0) +
      (selected ? JSON.stringify(selection).length + (bindings.length ? 1 : 0) : 0);
    if (bindingCandidates.length >= 32 || chars + size > NUMERIC_CATALOG_MAX_CHARS) continue;
    bindingCandidates.push(binding);
    if (selected) {
      bindings.push(selection);
      boundDefaults.add(binding.valueRefId);
    }
    chars += size;
  }
  return {
    sources: defaults.map((refId) => ({ refId })),
    candidates: { items, shown: items.length, total, truncated: items.length < total },
    docRevs: Object.fromEntries(contract.sources.map((source) => [source.docId, source.rev])),
    sourceScopes: contract.sources,
    bindings,
    bindingCandidates: {
      items: bindingCandidates,
      shown: bindingCandidates.length,
      total: possibleBindings.length,
      truncated: bindingCandidates.length < possibleBindings.length,
      selection: "at-most-one-per-value" as const,
    },
    bindingCoverage: {
      shown: bindingCandidates.length,
      total: possibleBindings.length,
      truncated: bindingCandidates.length < possibleBindings.length,
    },
    scope: subset ? "visible-subset" : "returned-data",
    notice:
      "只复制所需 sources；候选目录用于改选具体指标，不要把 root 与全部子项一起照抄。bindings 是当前默认 sources 所含数值的可复制选择，只含 bindingId；多个显式单位关系或多个无单位标签不默认选择，须明确择一。bindingCandidates 是互斥选项，不要把候选全部复制：每个数值最多选择一个；换 sources 时，只从该数值的候选复制 bindingId，无候选时不得构造。位置使用真实 returnedRange 与从0起算的行列偏移。标签仅为同次读取的紧邻左侧或读窗首行原文，关系只证明位置，不认证业务语义。单位只从标签末尾显式括号或明确行数标签读取，并给出 sourcePointer，其他不得推断。" +
      (subset ? "这里只引用当前可见数值子集，不代表完整结果。" : "") +
      (!defaults.length
        ? "这里只提供非数值解释候选；目录受限且无数值义务的任务可单独引用，不能单独完成数值交付。"
        : "") +
      (items.length < total ? "候选目录已截断；未展示的候选不可提交，请缩小范围重新读取。" : "") +
      (bindingCandidates.length < possibleBindings.length
        ? "标签绑定目录已截断（见 bindingCandidates 与 bindingCoverage）；未展示的关系须缩小范围重新读取。"
        : "") +
      "引用仍须服务器核验当前可见性、来源和修订。",
  };
}
