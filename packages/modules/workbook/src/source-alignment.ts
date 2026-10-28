import { indexToCol, parseRange } from "@excelmanus/core";
import { z } from "zod";

const column = z.string().min(1).max(200);
const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const targetColumn = column.describe("目标表头原文，不是列字母或源格坐标。");
const common = {
  column: targetColumn,
  source: z.string().min(1).describe("来源别名，必须与 sources[].name 完全一致。"),
};
export const SourceAlignmentInput = z.object({
  headerRow: z
    .int()
    .positive()
    .describe("目标工作表实际 Excel 1 基表头行号；必须在 range 数据行之前。"),
  requiredColumns: z
    .array(column)
    .min(1)
    .max(100)
    .refine((a) => new Set(a).size === a.length)
    .meta({ uniqueItems: true })
    .describe("目标表头原文且不重复；只声明这些字段的校验义务，不代表整表业务要求。"),
  bindings: z
    .array(
      z.discriminatedUnion("kind", [
        z
          .object({
            ...common,
            kind: z.literal("cell"),
            referenceColumn: targetColumn.describe(
              "目标表头原文；该列每行存放含源工作表名的单格引用，如 原表!B8。",
            ),
            scale: z.number().finite().optional(),
            mergeAnchor: z
              .boolean()
              .default(false)
              .describe("true 仅按真实合并几何读取锚点；不向前填充普通空白或相邻列。"),
            rowColumn: targetColumn
              .optional()
              .describe(
                "目标表头原文；该列存放源工作表实际 Excel 1 基行号（数值），不是输出行序号。声明后核对引用行或真实合并覆盖行。",
              ),
            sameColumnAs: targetColumn
              .optional()
              .describe(
                "目标中的另一个来源引用列的表头；核对两处源引用同列，或本引用位于另一引用的真实合并列跨度内，不是比较目标值。",
              ),
          })
          .strict(),
        z
          .object({
            ...common,
            kind: z.literal("period"),
            yearReferenceColumn: targetColumn.describe("存放四位年份源格引用的目标表头。"),
            monthReferenceColumn: targetColumn.describe("存放 1–12 月源格引用的目标表头。"),
            valueReferenceColumn: targetColumn.describe(
              "存放数值源格引用的目标表头；用于核对真实月份列位置。",
            ),
          })
          .strict(),
        z
          .object({
            ...common,
            kind: z.literal("lookup"),
            keys: z
              .array(
                z
                  .object({
                    targetColumn,
                    sourceColumn: column.describe("来源范围首行的表头原文。"),
                  })
                  .strict(),
              )
              .min(1)
              .max(10),
            valueColumn: column.describe("来源范围首行的值列标题，不是目标列。"),
            where: z
              .array(z.object({ column, equals: scalar }).strict())
              .max(10)
              .default([]),
            duplicatePolicy: z.enum(["reject", "identical_rows"]).default("reject"),
            duplicateColumns: z.array(column).min(1).max(100).optional(),
            conflictPolicy: z.enum(["unverified", "expect_blank"]).default("unverified"),
          })
          .strict(),
      ]),
    )
    .min(1)
    .max(100),
});
export type AlignmentDeclaration = z.input<typeof SourceAlignmentInput>;
type Value = string | number | boolean | null;
type Cell = { v?: unknown; f?: unknown; p?: unknown; t?: unknown } | null;
type Merge = { startRow: number; endRow: number; startColumn: number; endColumn: number };
export interface AlignmentSheet {
  name?: string;
  id?: string;
  rowCount: number;
  columnCount: number;
  cellData?: Record<number, Record<number, Cell>>;
  mergeData?: Merge[];
}
export interface AlignmentDocument {
  docId: string;
  path: string;
  rev: number;
  sheets: Record<string, AlignmentSheet>;
}
export interface AlignmentSource extends AlignmentDocument {
  name: string;
  range: string;
  sheet?: string;
}
interface Failure {
  targetCell: string;
  ruleIndex: number;
  code: string;
  sourceCell?: string;
  expected?: unknown;
  actual?: unknown;
}
class CannotVerify extends Error {}
function region(doc: AlignmentDocument, range: string, sheet?: string) {
  const r = parseRange(range),
    s = Object.values(doc.sheets).find(
      (s) => s.name === (r.sheet ?? sheet) || s.id === (r.sheet ?? sheet),
    );
  if (
    !s ||
    !Number.isSafeInteger(r.endRow) ||
    r.startRow < 1 ||
    r.startCol < 1 ||
    r.endRow > s.rowCount ||
    r.endCol > s.columnCount
  )
    throw new CannotVerify("RANGE_UNAVAILABLE");
  return {
    sheet: s,
    sheetName: s.name ?? s.id ?? "",
    r0: r.startRow - 1,
    r1: r.endRow - 1,
    c0: r.startCol - 1,
    c1: r.endCol - 1,
  };
}
type Region = ReturnType<typeof region>;
const address = (r: Region, row: number, col: number) =>
  `${r.sheetName}!${indexToCol(col + 1)}${row + 1}`;
function value(s: AlignmentSheet, r: number, c: number): Value {
  const cell = s.cellData?.[r]?.[c];
  if (cell?.f || cell?.p) throw new CannotVerify("FORMULA_OR_RICH_TEXT_UNSUPPORTED");
  let v = cell?.v ?? null;
  if (cell?.t === 2 && v !== null && typeof v !== "number")
    throw new CannotVerify("DECLARED_NUMERIC_TYPE_MISMATCH");
  if (cell?.t === 3) {
    if (v === 0 || v === 1) v = v === 1;
    else if (typeof v !== "boolean" && v !== null)
      throw new CannotVerify("DECLARED_BOOLEAN_TYPE_MISMATCH");
  }
  if (cell?.t !== undefined && ![1, 2, 3].includes(cell.t as number))
    throw new CannotVerify("CELL_TYPE_UNSUPPORTED");
  if (v !== null && typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean")
    throw new CannotVerify("VALUE_TYPE_UNSUPPORTED");
  if (typeof v === "number" && !Number.isFinite(v)) throw new CannotVerify("NONFINITE_VALUE");
  return v;
}
const same = (a: unknown, b: unknown) => typeof a === typeof b && a === b;
function headers(r: Region, headerRow: number) {
  if (headerRow < 1 || headerRow > r.sheet.rowCount || headerRow - 1 >= r.r0)
    throw new CannotVerify("HEADER_NOT_BEFORE_DATA");
  const cols = new Map<string, number>();
  for (let c = r.c0; c <= r.c1; c++) {
    const v = value(r.sheet, headerRow - 1, c);
    if (typeof v !== "string" || !v || cols.has(v))
      throw new CannotVerify("HEADER_MISSING_OR_DUPLICATE");
    cols.set(v, c);
  }
  return cols;
}
export function verifySourceAlignment(
  input: {
    target: AlignmentDocument;
    range: string;
    sheet?: string;
    sources: AlignmentSource[];
  } & AlignmentDeclaration,
) {
  const failures: Failure[] = [];
  let failedCount = 0,
    unverifiedCount = 0,
    checkedCellCount = 0,
    declaredCellCount = 0,
    conflictKeyCount = 0,
    work = 0;
  const deadline = Date.now() + 3000;
  const tick = (n = 1) => {
    work += n;
    if (work > 500000 || Date.now() > deadline) throw new CannotVerify("WORK_BUDGET_EXCEEDED");
  };
  const add = (failure: Failure, unknown = false) => {
    if (unknown) unverifiedCount++;
    else failedCount++;
    if (failures.length < 100) failures.push(failure);
  };
  const covered = new Set<string>(),
    uncoveredColumns: string[] = [],
    allColumns: string[] = [];
  const sourcePolicies: unknown[] = [];
  let targetRange: Region | undefined;
  try {
    const declaration = SourceAlignmentInput.parse(input),
      r = region(input.target, input.range, input.sheet);
    targetRange = r;
    const rowCount = r.r1 - r.r0 + 1,
      cols = headers(r, declaration.headerRow);
    declaredCellCount = rowCount * declaration.requiredColumns.length;
    allColumns.push(...cols.keys());
    if (
      rowCount * (r.c1 - r.c0 + 1) > 200000 ||
      declaredCellCount > 200000 ||
      rowCount * declaration.bindings.length > 200000
    )
      throw new CannotVerify("CELL_BUDGET_EXCEEDED");
    const sources = new Map<string, { doc: AlignmentSource; region: Region }>();
    let sourceCells = 0;
    for (const source of input.sources) {
      if (sources.has(source.name)) throw new CannotVerify("SOURCE_ALIAS_DUPLICATE");
      const sr = region(source, source.range, source.sheet);
      sourceCells += (sr.r1 - sr.r0 + 1) * (sr.c1 - sr.c0 + 1);
      if (sourceCells > 200000) throw new CannotVerify("SOURCE_CELL_BUDGET_EXCEEDED");
      sources.set(source.name, { doc: source, region: sr });
    }
    const targetCol = (name: string) => {
      const c = cols.get(name);
      if (c === undefined) throw new CannotVerify("TARGET_COLUMN_MISSING");
      return c;
    };
    const ref = (sourceName: string, text: Value, mergeAnchor = false) => {
      tick();
      if (typeof text !== "string" || !text || /[[\]]/.test(text))
        throw new CannotVerify("SOURCE_REFERENCE_INVALID");
      const source = sources.get(sourceName);
      if (!source) throw new CannotVerify("SOURCE_ALIAS_MISSING");
      const p = parseRange(text),
        sr = source.region;
      if (p.startRow !== p.endRow || p.startCol !== p.endCol || p.sheet !== sr.sheetName)
        throw new CannotVerify("SOURCE_REFERENCE_NOT_SINGLE_CELL");
      const row = p.startRow - 1,
        col = p.startCol - 1;
      if (row < sr.r0 || row > sr.r1 || col < sr.c0 || col > sr.c1)
        throw new CannotVerify("SOURCE_REFERENCE_OUTSIDE_DECLARED_RANGE");
      tick((sr.sheet.mergeData ?? []).length);
      const merges = (sr.sheet.mergeData ?? []).filter(
        (m) => row >= m.startRow && row <= m.endRow && col >= m.startColumn && col <= m.endColumn,
      );
      if (merges.length > 1) throw new CannotVerify("MERGE_AMBIGUOUS");
      const m = merges[0],
        rr = mergeAnchor && m ? m.startRow : row,
        cc = mergeAnchor && m ? m.startColumn : col;
      if (rr < sr.r0 || cc < sr.c0) throw new CannotVerify("MERGE_ANCHOR_OUTSIDE_DECLARED_RANGE");
      return { value: value(sr.sheet, rr, cc), row, col, merge: m, address: address(sr, rr, cc) };
    };
    for (const name of cols.keys())
      if (!declaration.bindings.some((b) => b.column === name)) uncoveredColumns.push(name);
    for (const name of declaration.requiredColumns)
      if (!cols.has(name) || declaration.bindings.filter((b) => b.column === name).length !== 1)
        for (let row = r.r0; row <= r.r1; row++)
          add(
            {
              targetCell: cols.has(name) ? address(r, row, cols.get(name)!) : name,
              ruleIndex: -1,
              code: "REQUIRED_COLUMN_UNBOUND_OR_DUPLICATE",
            },
            true,
          );
    for (const [ruleIndex, b] of declaration.bindings.entries()) {
      const c = targetCol(b.column);
      let valid = true;
      let lookup:
        | Map<string, { v: Value; signature: string; conflict: boolean; sourceCell: string }>
        | undefined;
      try {
        if (b.kind === "lookup") {
          const source = sources.get(b.source);
          if (!source) throw new CannotVerify("SOURCE_ALIAS_MISSING");
          const sr = source.region,
            sc = headers({ ...sr, r0: sr.r0 + 1 }, sr.r0 + 1);
          const col = (name: string) => {
            const c = sc.get(name);
            if (c === undefined) throw new CannotVerify("SOURCE_COLUMN_MISSING");
            return c;
          };
          const selected = b.duplicatePolicy === "identical_rows" ? b.duplicateColumns : undefined;
          if (
            b.duplicatePolicy === "identical_rows" &&
            (!selected ||
              selected.length !== sc.size ||
              new Set(selected).size !== sc.size ||
              selected.some((x) => !sc.has(x)))
          )
            throw new CannotVerify("DUPLICATE_COLUMNS_MUST_COVER_SOURCE");
          const keyCols = b.keys.map((k) => col(k.sourceColumn)),
            valueCol = col(b.valueColumn),
            where = b.where.map((w) => ({ ...w, c: col(w.column) }));
          sourcePolicies.push({
            ruleIndex,
            source: b.source,
            where: b.where,
            duplicatePolicy: b.duplicatePolicy,
            duplicateColumns: selected ?? [],
            conflictPolicy: b.conflictPolicy,
          });
          lookup = new Map();
          for (let row = sr.r0 + 1; row <= sr.r1; row++) {
            tick(sc.size + where.length);
            if (!where.every((w) => same(value(sr.sheet, row, w.c), w.equals))) continue;
            const keys = keyCols.map((c) => value(sr.sheet, row, c));
            if (keys.some((k) => k === null || k === ""))
              throw new CannotVerify("SOURCE_KEY_BLANK");
            const key = JSON.stringify(keys),
              v = value(sr.sheet, row, valueCol),
              signature = JSON.stringify((selected ?? []).map((k) => value(sr.sheet, row, col(k)))),
              old = lookup.get(key);
            if (old) {
              if (
                !old.conflict &&
                (b.duplicatePolicy === "reject" || old.signature !== signature)
              ) {
                old.conflict = true;
                conflictKeyCount++;
              }
            } else
              lookup.set(key, {
                v,
                signature,
                conflict: false,
                sourceCell: address(sr, row, valueCol),
              });
          }
        }
      } catch (e) {
        if (e instanceof CannotVerify && e.message === "WORK_BUDGET_EXCEEDED") throw e;
        valid = false;
        for (let row = r.r0; row <= r.r1; row++)
          add(
            {
              targetCell: address(r, row, c),
              ruleIndex,
              code: e instanceof CannotVerify ? e.message : "INVALID_DECLARATION",
            },
            true,
          );
      }
      if (!valid) continue;
      let ruleUnknown = false;
      for (let row = r.r0; row <= r.r1; row++) {
        try {
          tick();
          const actual = value(r.sheet, row, c);
          let expected: Value;
          let sourceCell: string | undefined;
          if (b.kind === "cell") {
            const s = ref(
              b.source,
              value(r.sheet, row, targetCol(b.referenceColumn)),
              b.mergeAnchor,
            );
            sourceCell = s.address;
            expected = s.value;
            if (b.rowColumn) {
              const targetRow = value(r.sheet, row, targetCol(b.rowColumn));
              if (
                typeof targetRow !== "number" ||
                !Number.isSafeInteger(targetRow) ||
                (s.merge && b.mergeAnchor
                  ? targetRow - 1 < s.merge.startRow || targetRow - 1 > s.merge.endRow
                  : targetRow - 1 !== s.row)
              ) {
                add({ targetCell: address(r, row, c), ruleIndex, code: "SOURCE_ROW_MISMATCH" });
                continue;
              }
            }
            if (b.sameColumnAs) {
              const axis = ref(b.source, value(r.sheet, row, targetCol(b.sameColumnAs)), true);
              if (
                axis.merge
                  ? s.col < axis.merge.startColumn || s.col > axis.merge.endColumn
                  : s.col !== axis.col
              ) {
                add({ targetCell: address(r, row, c), ruleIndex, code: "SOURCE_COLUMN_MISMATCH" });
                continue;
              }
            }
            if (b.scale !== undefined && expected !== null) {
              if (typeof expected !== "number") throw new CannotVerify("SCALE_REQUIRES_NUMBER");
              expected *= b.scale;
              if (!Number.isFinite(expected)) throw new CannotVerify("SCALE_NONFINITE");
            }
          } else if (b.kind === "period") {
            const y = ref(b.source, value(r.sheet, row, targetCol(b.yearReferenceColumn)), true),
              m = ref(b.source, value(r.sheet, row, targetCol(b.monthReferenceColumn)), true),
              v = ref(b.source, value(r.sheet, row, targetCol(b.valueReferenceColumn)));
            sourceCell = m.address;
            if (
              m.merge ? v.col < m.merge.startColumn || v.col > m.merge.endColumn : m.col !== v.col
            ) {
              add({ targetCell: address(r, row, c), ruleIndex, code: "SOURCE_COLUMN_MISMATCH" });
              continue;
            }
            if (
              y.merge ? v.col < y.merge.startColumn || v.col > y.merge.endColumn : y.col !== v.col
            ) {
              add({ targetCell: address(r, row, c), ruleIndex, code: "YEAR_COLUMN_MISMATCH" });
              continue;
            }
            const year = /^(\d{4})(?:年)?$/.exec(String(y.value)),
              month = /^(0?[1-9]|1[0-2])(?:月)?$/.exec(String(m.value));
            if (!year || !month) throw new CannotVerify("PERIOD_FORMAT_UNSUPPORTED");
            expected = `${year[1]}-${String(Number(month[1])).padStart(2, "0")}`;
          } else {
            const keys = b.keys.map((k) => value(r.sheet, row, targetCol(k.targetColumn)));
            if (keys.some((k) => k === null || k === ""))
              throw new CannotVerify("TARGET_KEY_BLANK");
            const entry = lookup!.get(JSON.stringify(keys));
            sourceCell = entry?.sourceCell;
            if (entry?.conflict && b.conflictPolicy !== "expect_blank")
              throw new CannotVerify("SOURCE_KEY_CONFLICT");
            expected = entry?.conflict ? null : (entry?.v ?? null);
          }
          checkedCellCount++;
          if (!same(actual, expected))
            add({
              targetCell: address(r, row, c),
              ruleIndex,
              code: "VALUE_OR_TYPE_MISMATCH",
              sourceCell,
              expected,
              actual,
            });
        } catch (e) {
          if (e instanceof CannotVerify && e.message === "WORK_BUDGET_EXCEEDED") throw e;
          const unknown = e instanceof CannotVerify;
          ruleUnknown ||= unknown;
          add(
            {
              targetCell: address(r, row, c),
              ruleIndex,
              code: e instanceof Error ? e.message : "INVALID_DECLARATION",
            },
            unknown,
          );
        }
      }
      if (!ruleUnknown) covered.add(b.column);
    }
  } catch (e) {
    add(
      {
        targetCell: input.range,
        ruleIndex: -1,
        code: e instanceof CannotVerify ? e.message : "INVALID_DECLARATION",
      },
      true,
    );
  }
  uncoveredColumns.splice(0, uncoveredColumns.length, ...allColumns.filter((c) => !covered.has(c)));
  return {
    status: failedCount ? "failed" : unverifiedCount ? "unverified" : "verified",
    scope: "declared_fields_only",
    target: {
      docId: input.target.docId,
      path: input.target.path,
      rev: input.target.rev,
      sheet: targetRange?.sheetName,
      range: input.range,
    },
    sources: input.sources.map((s) => ({
      name: s.name,
      docId: s.docId,
      path: s.path,
      rev: s.rev,
      sheet: s.sheet,
      range: s.range,
    })),
    requiredColumns: input.requiredColumns,
    coveredColumns: [...covered],
    uncoveredColumns,
    declaredCellCount,
    checkedCellCount,
    failedCount,
    unverifiedCount,
    conflictKeyCount,
    sourcePolicies,
    failures,
    failuresTruncated: failedCount + unverifiedCount > failures.length,
    limitation:
      "仅按当前工作簿值类型核验声明字段、来源范围和规则，不证明原包全类型保真、全部业务要求或未声明列；verified 不代表整个工作簿正确。",
  };
}
