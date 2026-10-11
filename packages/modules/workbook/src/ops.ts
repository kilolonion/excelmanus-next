// workbook_edit 的 ChangeOp 判别联合 → Univer 命令序列（07 §3.3 编译步）。
// 写集与结构操作直接从 op 推导（agent 来源，坐标用变换前的写入坐标）。

import {
  indexToCol,
  MAX_C,
  MAX_R,
  newId,
  parseRange,
  type RangeRef,
  rangeRefToA1,
  type StructuralOp,
  structuralTouchesInterior,
  transformRange,
} from "@excelmanus/core";
import {
  AXIS_GROUP_MUTATION,
  ChartObject,
  ImageObject,
  OBJECT_LAYER_MUTATION,
} from "@excelmanus/protocol";
import { Direction, type IWorkbookData, type IWorksheetData } from "@univerjs/core";
import { z } from "zod";
import { FIND_REPLACE_COMMAND } from "./find-replace.ts";
import {
  AXIS_SIZE_COMMAND,
  COPY_SHEET_COMMAND,
  FILL_COMMAND,
  FILTER_COMMAND,
  LINK_COMMAND,
} from "./layout-commands.ts";
import { objectsOf } from "./objects.ts";
import { CF_RESOURCE, DV_RESOURCE, rulesResource, setRulesResource } from "./rule-codec.ts";
import { BORDER_STYLES } from "./style-constants.ts";
import { sheetNamesOf } from "./summary.ts";

// ---------- 输入 schema ----------

const cellScalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const sheetAdd = z.strictObject({
  op: z.literal("sheet.add"),
  name: z.string().min(1),
  index: z.int().nonnegative().optional(),
});
const sheetRename = z.strictObject({
  op: z.literal("sheet.rename"),
  sheet: z.string().min(1),
  name: z.string().min(1),
});
const sheetDelete = z.strictObject({ op: z.literal("sheet.delete"), sheet: z.string().min(1) });
const sheetCopy = z.strictObject({
  op: z.literal("sheet.copy"),
  sheet: z.string(),
  name: z.string().min(1),
  index: z.int().nonnegative().optional(),
});
const sheetMove = z.strictObject({
  op: z.literal("sheet.move"),
  sheet: z.string(),
  index: z.int().nonnegative(),
});
const sheetHide = z.strictObject({
  op: z.literal("sheet.hide"),
  sheet: z.string(),
  hidden: z.boolean(),
});
const cellsFill = z.strictObject({
  op: z.literal("cells.fill"),
  source: z.string(),
  range: z.string(),
  mode: z.enum(["copy", "series"]).default("copy"),
});
const axisSize = z.strictObject({
  op: z.literal("axis.size"),
  sheet: z.string(),
  axis: z.enum(["rows", "cols"]),
  at: z.int().positive(),
  count: z.int().positive().max(1000),
  mode: z.enum(["pixels", "scale", "auto"]),
  value: z.number().positive().max(2000).optional(),
});
const filterSet = z.strictObject({
  op: z.literal("filter.set"),
  range: z.string(),
  clear: z.boolean().default(false),
  columns: z
    .array(
      z.object({
        column: z.int().positive(),
        values: z.array(z.union([z.string(), z.number(), z.boolean()])).max(1000),
        blank: z.boolean().default(false),
      }),
    )
    .max(100)
    .default([]),
});
const hyperlinkSet = z.strictObject({
  op: z.literal("hyperlink.set"),
  range: z.string(),
  url: z
    .string()
    .max(2048)
    .regex(/^(?:https?:\/\/|mailto:|#)/i)
    .nullable(),
  label: z.string().max(32767).optional(),
});
const cellsSet = z.strictObject({
  op: z.literal("cells.set"),
  range: z.string().min(1),
  values: z.array(z.array(cellScalar)).min(1),
});
const cellsClear = z.strictObject({
  op: z.literal("cells.clear"),
  range: z.string().min(1),
  what: z.enum(["contents", "formats", "all"]).default("all"),
});
const borderSide = z
  .object({
    style: z.enum(BORDER_STYLES),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .default("#000000"),
  })
  .nullable();
const styleSet = z.strictObject({
  op: z.literal("style.set"),
  range: z.string().min(1),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  fontColor: z.string().optional(),
  fill: z.string().optional(),
  numFmt: z.string().optional(),
  hAlign: z.enum(["left", "center", "right"]).optional(),
  vAlign: z.enum(["top", "center", "bottom"]).optional(),
  fontSize: z.number().min(1).max(409).optional(),
  fontFamily: z.string().min(1).max(100).optional(),
  indent: z.int().min(0).max(250).optional(),
  borders: z
    .object({
      top: borderSide.optional(),
      bottom: borderSide.optional(),
      left: borderSide.optional(),
      right: borderSide.optional(),
    })
    .optional(),
  wrap: z.boolean().optional(),
});
const mergeOp = z.strictObject({ op: z.literal("merge"), range: z.string().min(1) });
const unmergeOp = z.strictObject({ op: z.literal("unmerge"), range: z.string().min(1) });
const rowsInsert = z.strictObject({
  op: z.literal("rows.insert"),
  sheet: z.string().min(1),
  at: z.int().positive(),
  count: z.int().positive(),
});
const rowsDelete = z.strictObject({
  op: z.literal("rows.delete"),
  sheet: z.string().min(1),
  at: z.int().positive(),
  count: z.int().positive(),
});
const colsInsert = z.strictObject({
  op: z.literal("cols.insert"),
  sheet: z.string().min(1),
  at: z.int().positive(),
  count: z.int().positive(),
});
const colsDelete = z.strictObject({
  op: z.literal("cols.delete"),
  sheet: z.string().min(1),
  at: z.int().positive(),
  count: z.int().positive(),
});
const freezeOp = z.strictObject({
  op: z.literal("freeze"),
  sheet: z.string().min(1),
  rows: z.int().nonnegative(),
  cols: z.int().nonnegative(),
});
/** ADR 0002：同步等待进行中的公式重算完成（受工具 timeoutMs 约束），不产生写入。 */
const recalculateOp = z.strictObject({ op: z.literal("recalculate") });

const findReplace = z.strictObject({
  op: z.literal("find_replace"),
  range: z.string(),
  find: z.string().min(1).max(10000),
  replacement: z.string().max(32767),
  caseSensitive: z.boolean().default(false),
  formulas: z.boolean().default(false),
});
const axisHide = z.strictObject({
  op: z.literal("axis.hide"),
  sheet: z.string(),
  axis: z.enum(["rows", "cols"]),
  at: z.int().positive(),
  count: z.int().positive().max(10000),
  hidden: z.boolean(),
});
const axisGroup = z.strictObject({
  op: z.literal("axis.group"),
  sheet: z.string(),
  axis: z.enum(["rows", "cols"]),
  at: z.int().positive(),
  count: z.int().positive().max(10000),
  level: z.int().min(0).max(7),
});
const imageAdd = z.strictObject({
  op: z.literal("image.add"),
  sheet: z.string(),
  path: z.string().min(1),
  anchor: z.string().default("E2"),
  width: z.int().min(1).max(4000).default(320),
  height: z.int().min(1).max(4000).default(240),
  title: z.string().max(500).default(""),
});
const chartFields = ChartObject.omit({ id: true, chartPart: true, drawingPart: true });
const chartAdd = chartFields.extend({
  op: z.literal("chart.add"),
  sheet: z.string().min(1),
  id: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,100}$/)
    .optional(),
});
const chartUpdate = chartFields
  .partial()
  .extend({ op: z.literal("chart.update"), sheet: z.string().min(1), id: z.string().min(1) });
const chartRemove = z.strictObject({
  op: z.literal("chart.delete"),
  sheet: z.string().min(1),
  id: z.string().min(1),
});
const rowHeight = z.strictObject({
  op: z.literal("rows.height"),
  sheet: z.string(),
  at: z.int().positive(),
  count: z.int().positive(),
  pixels: z.number().min(1).max(1000),
});
const colWidth = z.strictObject({
  op: z.literal("cols.width"),
  sheet: z.string(),
  at: z.int().positive(),
  count: z.int().positive(),
  pixels: z.number().min(1).max(2000),
});
const sortRange = z.strictObject({
  op: z.literal("sort"),
  range: z.string(),
  header: z.boolean().default(true),
  keys: z
    .array(z.object({ column: z.int().positive(), order: z.enum(["asc", "desc"]) }))
    .min(1)
    .max(32),
});
const ruleOperator = z.enum([
  "between",
  "notBetween",
  "equal",
  "notEqual",
  "greaterThan",
  "greaterThanOrEqual",
  "lessThan",
  "lessThanOrEqual",
]);
const cfSet = z.strictObject({
  op: z.literal("cf.add"),
  range: z.string(),
  id: z.string().optional(),
  kind: z.enum(["formula", "number", "blank", "duplicate", "unique"]),
  formula: z.string().optional(),
  operator: ruleOperator.optional(),
  values: z.array(z.number()).max(2).optional(),
  fill: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  fontColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  bold: z.boolean().optional(),
});
const cfRemove = z.strictObject({
  op: z.literal("cf.remove"),
  sheet: z.string(),
  id: z.string(),
});
const dvSet = z.strictObject({
  op: z.literal("dv.add"),
  range: z.string(),
  id: z.string().optional(),
  type: z.enum(["whole", "decimal", "list", "date", "time", "textLength", "custom"]),
  operator: ruleOperator.optional(),
  formula1: z.string(),
  formula2: z.string().optional(),
  allowBlank: z.boolean().default(true),
  error: z.string().max(255).optional(),
});
const dvRemove = z.strictObject({
  op: z.literal("dv.remove"),
  sheet: z.string(),
  id: z.string(),
});
export const ChangeOp = z.discriminatedUnion("op", [
  filterSet,
  hyperlinkSet,
  sheetCopy,
  sheetMove,
  sheetHide,
  cellsFill,
  axisSize,
  findReplace,
  axisHide,
  axisGroup,
  imageAdd,
  cfSet,
  cfRemove,
  dvSet,
  dvRemove,
  chartAdd,
  chartUpdate,
  chartRemove,
  rowHeight,
  colWidth,
  sortRange,
  sheetAdd,
  sheetRename,
  sheetDelete,
  cellsSet,
  cellsClear,
  styleSet,
  mergeOp,
  unmergeOp,
  rowsInsert,
  rowsDelete,
  colsInsert,
  colsDelete,
  freezeOp,
  recalculateOp,
]);
export type ChangeOp = z.infer<typeof ChangeOp>;

// ---------- 编译 ----------

export interface CompiledCommand {
  id: string;
  params: Record<string, unknown>;
}

interface SheetCtx {
  id: string;
  data: IWorksheetData;
}

export interface CompiledOps {
  commands: CompiledCommand[];
  /** op 推导的写集（变换前坐标）。 */
  ranges: RangeRef[];
  structural: StructuralOp[];
  /** 写入的公式单元格 A1（sheet!A1）。 */
  formulas: string[];
  /** 写集估算单元格数（20 万格限制用；无界区域不计入）。 */
  estCells: number;
  /** 含需快照回滚的操作（remove-sheet）。 */
  needsSnapshot: boolean;
  sheetNames: Map<string, string>;
}

export class OpCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpCompileError";
  }
}

interface CompileCtx {
  images?: Record<string, { data: string; mediaType: ImageObject["mediaType"] }>;
  unitId: string;
  snapshot: IWorkbookData;
}

function resolveSheet(ctx: CompileCtx, idOrName: string | undefined): SheetCtx {
  const sheets = (ctx.snapshot.sheets ?? {}) as Record<string, IWorksheetData>;
  if (idOrName === undefined) {
    const first = ctx.snapshot.sheetOrder?.[0];
    const s = first ? sheets[first] : undefined;
    if (!first || !s) throw new OpCompileError("工作簿没有工作表");
    return { id: first, data: s };
  }
  if (sheets[idOrName]) return { id: idOrName, data: sheets[idOrName] as IWorksheetData };
  for (const [id, s] of Object.entries(sheets)) {
    if (s.name === idOrName) return { id, data: s };
  }
  throw new OpCompileError(`工作表不存在：${idOrName}`);
}

/** A1 区域（可带 Sheet! 前缀）→ 表 + 0 基矩形。 */
function regionOf(
  ctx: CompileCtx,
  a1: string,
  defaultSheet?: string,
): { sheet: SheetCtx; ref: RangeRef } {
  const parsed = parseRange(a1);
  const sheet = resolveSheet(ctx, parsed.sheet ?? defaultSheet);
  return {
    sheet,
    ref: {
      sheetId: sheet.id,
      r0: parsed.startRow - 1,
      c0: parsed.startCol - 1,
      r1: parsed.endRow - 1,
      c1: parsed.endCol - 1,
    },
  };
}

const univerRange = (r: RangeRef) => ({
  startRow: r.r0,
  startColumn: r.c0,
  endRow: r.r1,
  endColumn: r.c1,
});

const cellData = (v: string | number | boolean | null): Record<string, unknown> => {
  if (v === null) return { v: null };
  if (typeof v === "number") return { v, t: 2 };
  if (typeof v === "boolean") return { v, t: 3 };
  if (v.startsWith("=")) return { f: v };
  return { v, t: 1 };
};

/** cells.set 实际写入的矩形：range 左上角 + values 尺寸。 */
function cellsSetTarget(sheetId: string, ref: RangeRef, values: unknown[][]): RangeRef {
  const rows = values.length;
  const cols = Math.max(1, ...values.map((r) => r.length));
  return { sheetId, r0: ref.r0, c0: ref.c0, r1: ref.r0 + rows - 1, c1: ref.c0 + cols - 1 };
}

const HALIGN = { left: 1, center: 2, right: 3 } as const;

export function compileOps(ctx: CompileCtx, ops: ChangeOp[]): CompiledOps {
  ctx = { ...ctx, snapshot: structuredClone(ctx.snapshot) };
  const sheetNames = sheetNamesOf(ctx.snapshot);
  const commands: CompiledCommand[] = [];
  const ranges: RangeRef[] = [];
  const structural: StructuralOp[] = [];
  const formulas: string[] = [];
  let estCells = 0;
  let needsSnapshot = false;
  const unitId = ctx.unitId;

  for (const op of ops) {
    switch (op.op) {
      case "image.add": {
        const sheet = resolveSheet(ctx, op.sheet),
          image = ctx.images?.[op.path];
        if (!image) throw new OpCompileError("图片必须是工作区内可读取的 PNG/JPEG/GIF 文件");
        parseRange(op.anchor);
        const objects = objectsOf(sheet.data);
        objects.images.push(
          ImageObject.parse({
            id: newId("img"),
            title: op.title,
            anchor: op.anchor,
            width: op.width,
            height: op.height,
            ...image,
          }),
        );
        sheet.data.custom = { ...sheet.data.custom, excelmanusObjects: objects };
        commands.push({
          id: OBJECT_LAYER_MUTATION,
          params: { unitId, subUnitId: sheet.id, objects },
        });
        ranges.push({ sheetId: sheet.id, r0: 0, c0: 0, r1: MAX_R, c1: MAX_C });
        break;
      }
      case "cf.add":
      case "dv.add": {
        const { sheet, ref } = regionOf(ctx, op.range);
        const isCf = op.op === "cf.add";
        const resource = isCf ? CF_RESOURCE : DV_RESOURCE;
        const stored = rulesResource(ctx.snapshot, resource);
        const rules = stored[sheet.id] ?? [];
        const id = op.id ?? newId(isCf ? "cf" : "dv");
        const old = rules.find((r) => (isCf ? r.cfId : r.uid) === id);
        if (old)
          commands.push({
            id: isCf
              ? "sheet.mutation.delete-conditional-rule"
              : "data-validation.mutation.removeRule",
            params: { unitId, subUnitId: sheet.id, ...(isCf ? { cfId: id } : { ruleId: id }) },
          });
        let rule: Record<string, unknown>;
        if (op.op === "cf.add") {
          if (op.fill === undefined && op.fontColor === undefined && op.bold === undefined)
            throw new OpCompileError("条件格式至少需要一个样式字段");
          const style = {
            ...(op.fill ? { bg: { rgb: op.fill } } : {}),
            ...(op.fontColor ? { cl: { rgb: op.fontColor } } : {}),
            ...(op.bold !== undefined ? { bl: op.bold ? 1 : 0 } : {}),
          };
          let condition: Record<string, unknown>;
          if (op.kind === "formula") {
            if (!op.formula) throw new OpCompileError("公式条件格式需要 formula");
            condition = {
              subType: "formula",
              value: op.formula.startsWith("=") ? op.formula : `=${op.formula}`,
            };
          } else if (op.kind === "number") {
            const between = op.operator === "between" || op.operator === "notBetween";
            if (!op.operator || op.values?.length !== (between ? 2 : 1))
              throw new OpCompileError("数值条件格式需要 operator 及相应1或2个 values");
            condition = {
              subType: "number",
              operator: op.operator,
              value: between ? op.values : op.values[0],
            };
          } else if (op.kind === "blank")
            condition = { subType: "text", operator: "containsBlanks" };
          else
            condition = { subType: op.kind === "duplicate" ? "duplicateValues" : "uniqueValues" };
          rule = {
            cfId: id,
            ranges: [univerRange(ref)],
            stopIfTrue: false,
            rule: { type: "highlightCell", ...condition, style },
          };
        } else {
          if ((op.operator === "between" || op.operator === "notBetween") && !op.formula2)
            throw new OpCompileError("区间验证需要 formula2");
          rule = {
            uid: id,
            ranges: [univerRange(ref)],
            type: op.type,
            operator: op.operator ?? "between",
            formula1: op.formula1,
            ...(op.formula2 ? { formula2: op.formula2 } : {}),
            allowBlank: op.allowBlank,
            showErrorMessage: true,
            errorStyle: "stop",
            showDropDown: true,
            error: op.error ?? "输入不满足数据验证规则",
          };
        }
        stored[sheet.id] = [...rules.filter((r) => (isCf ? r.cfId : r.uid) !== id), rule];
        setRulesResource(ctx.snapshot, resource, stored);
        commands.push({
          id: isCf ? "sheet.mutation.add-conditional-rule" : "data-validation.mutation.addRule",
          params: { unitId, subUnitId: sheet.id, rule },
        });
        ranges.push(ref);
        break;
      }
      case "cf.remove":
      case "dv.remove": {
        const sheet = resolveSheet(ctx, op.sheet);
        const isCf = op.op === "cf.remove";
        const name = isCf ? CF_RESOURCE : DV_RESOURCE;
        const stored = rulesResource(ctx.snapshot, name),
          rules = stored[sheet.id] ?? [];
        const rule = rules.find((r) => (isCf ? r.cfId : r.uid) === op.id);
        if (!rule) throw new OpCompileError("规则不存在");
        stored[sheet.id] = rules.filter((r) => (isCf ? r.cfId : r.uid) !== op.id);
        setRulesResource(ctx.snapshot, name, stored);
        commands.push({
          id: isCf
            ? "sheet.mutation.delete-conditional-rule"
            : "data-validation.mutation.removeRule",
          params: { unitId, subUnitId: sheet.id, ...(isCf ? { cfId: op.id } : { ruleId: op.id }) },
        });
        ranges.push({ sheetId: sheet.id, r0: 0, c0: 0, r1: MAX_R, c1: MAX_C });
        break;
      }
      case "chart.add":
      case "chart.update":
      case "chart.delete": {
        const sheet = resolveSheet(ctx, op.sheet);
        const objects = objectsOf(sheet.data);
        const id = op.op === "chart.add" ? (op.id ?? newId("chrt")) : op.id;
        const existing = objects.charts.find((c) => c.id === id);
        if (op.op === "chart.add" && existing) throw new OpCompileError("图表 ID 已存在");
        if (op.op !== "chart.add" && !existing) throw new OpCompileError("图表不存在");
        if (op.op === "chart.delete") objects.charts = objects.charts.filter((c) => c.id !== id);
        else {
          const { op: _op, sheet: _sheet, ...fields } = op;
          const chart = ChartObject.parse({ ...existing, ...fields, id });
          const range = parseRange(chart.range);
          if (range.sheet && range.sheet !== sheet.id && range.sheet !== sheet.data.name)
            throw new OpCompileError("图表数据必须属于目标工作表");
          if (range.endRow <= range.startRow || range.endCol <= range.startCol)
            throw new OpCompileError("图表区域需包含标题行、分类列和数据");
          chart.range = `${indexToCol(range.startCol)}${range.startRow}:${indexToCol(range.endCol)}${range.endRow}`;
          if (existing) objects.charts = objects.charts.map((c) => (c.id === id ? chart : c));
          else objects.charts.push(chart);
        }
        sheet.data.custom = { ...sheet.data.custom, excelmanusObjects: objects };
        commands.push({
          id: OBJECT_LAYER_MUTATION,
          params: { unitId, subUnitId: sheet.id, objects },
        });
        ranges.push({ sheetId: sheet.id, r0: 0, c0: 0, r1: MAX_R, c1: MAX_C });
        break;
      }
      case "axis.hide":
      case "axis.group": {
        const sheet = resolveSheet(ctx, op.sheet),
          rows = op.axis === "rows";
        const end = op.at + op.count - 2;
        if (end > (rows ? MAX_R : MAX_C)) throw new OpCompileError("行列区域越界");
        const range = {
          startRow: rows ? op.at - 1 : 0,
          endRow: rows ? end : MAX_R,
          startColumn: rows ? 0 : op.at - 1,
          endColumn: rows ? MAX_C : end,
        };
        if (op.op === "axis.hide")
          commands.push({
            id: `sheet.mutation.set-${rows ? "row" : "col"}-${op.hidden ? "hidden" : "visible"}`,
            params: { unitId, subUnitId: sheet.id, ranges: [range] },
          });
        else
          commands.push({
            id: AXIS_GROUP_MUTATION,
            params: {
              unitId,
              subUnitId: sheet.id,
              axis: op.axis,
              levels: Object.fromEntries(
                Array.from({ length: op.count }, (_, i) => [op.at - 1 + i, op.level]),
              ),
            },
          });
        ranges.push({
          sheetId: sheet.id,
          r0: range.startRow,
          r1: range.endRow,
          c0: range.startColumn,
          c1: range.endColumn,
        });
        break;
      }
      case "rows.height":
      case "cols.width": {
        const sheet = resolveSheet(ctx, op.sheet);
        const rows = op.op === "rows.height";
        const range = {
          startRow: rows ? op.at - 1 : 0,
          endRow: rows ? op.at + op.count - 2 : MAX_R,
          startColumn: rows ? 0 : op.at - 1,
          endColumn: rows ? MAX_C : op.at + op.count - 2,
        };
        if ((rows ? range.endRow : range.endColumn) > (rows ? MAX_R : MAX_C))
          throw new OpCompileError("尺寸区域越界");
        commands.push({
          id: rows
            ? "sheet.mutation.set-worksheet-row-height"
            : "sheet.mutation.set-worksheet-col-width",
          params: {
            unitId,
            subUnitId: sheet.id,
            ranges: [range],
            ...(rows ? { rowHeight: op.pixels } : { colWidth: op.pixels }),
          },
        });
        ranges.push({
          sheetId: sheet.id,
          r0: range.startRow,
          r1: range.endRow,
          c0: range.startColumn,
          c1: range.endColumn,
        });
        break;
      }
      case "sort": {
        const { sheet, ref } = regionOf(ctx, op.range);
        if (op.keys.some((key) => key.column < ref.c0 + 1 || key.column > ref.c1 + 1))
          throw new OpCompileError("排序键必须在目标区域内，列号从1开始");
        commands.push({
          id: "sheet.command.sort-range",
          params: {
            unitId,
            subUnitId: sheet.id,
            range: univerRange(ref),
            hasTitle: op.header,
            orderRules: op.keys.map((key) => ({ colIndex: key.column - 1, type: key.order })),
          },
        });
        ranges.push(ref);
        estCells += (ref.r1 - ref.r0 + 1) * (ref.c1 - ref.c0 + 1);
        needsSnapshot = true;
        break;
      }
      case "filter.set": {
        const { sheet, ref } = regionOf(ctx, op.range);
        if (
          ref.r1 <= ref.r0 ||
          (ref.r1 - ref.r0 + 1) * (ref.c1 - ref.c0 + 1) > 200000 ||
          op.columns.some((c) => c.column - 1 < ref.c0 || c.column - 1 > ref.c1)
        )
          throw new OpCompileError("筛选区域须含表头和明细，最多20万格，筛选列须在区域内");
        commands.push({
          id: FILTER_COMMAND,
          params: { ...op, unitId, subUnitId: sheet.id, range: univerRange(ref) },
        });
        ranges.push(ref);
        needsSnapshot = true;
        break;
      }
      case "hyperlink.set": {
        const { sheet, ref } = regionOf(ctx, op.range);
        if (ref.r0 !== ref.r1 || ref.c0 !== ref.c1)
          throw new OpCompileError("超链接一次指定一个单元格");
        if (ref.r1 >= sheet.data.rowCount) {
          sheet.data.rowCount = ref.r1 + 1;
          commands.push({
            id: "sheet.mutation.set-worksheet-row-count",
            params: { unitId, subUnitId: sheet.id, rowCount: sheet.data.rowCount },
          });
        }
        if (ref.c1 >= sheet.data.columnCount) {
          sheet.data.columnCount = ref.c1 + 1;
          commands.push({
            id: "sheet.mutation.set-worksheet-column-count",
            params: { unitId, subUnitId: sheet.id, columnCount: sheet.data.columnCount },
          });
        }
        commands.push({
          id: LINK_COMMAND,
          params: { ...op, unitId, subUnitId: sheet.id, row: ref.r0, col: ref.c0 },
        });
        ranges.push(ref);
        break;
      }
      case "cells.fill": {
        const { sheet, ref } = regionOf(ctx, op.range),
          source = regionOf(ctx, op.source);
        if (source.sheet.id !== sheet.id) throw new OpCompileError("填充源和目标须在同一工作表");
        if ((ref.r1 - ref.r0 + 1) * (ref.c1 - ref.c0 + 1) > 200000)
          throw new OpCompileError("填充最多20万格");
        if (ref.r1 >= sheet.data.rowCount) {
          sheet.data.rowCount = ref.r1 + 1;
          commands.push({
            id: "sheet.mutation.set-worksheet-row-count",
            params: { unitId, subUnitId: sheet.id, rowCount: sheet.data.rowCount },
          });
        }
        if (ref.c1 >= sheet.data.columnCount) {
          sheet.data.columnCount = ref.c1 + 1;
          commands.push({
            id: "sheet.mutation.set-worksheet-column-count",
            params: { unitId, subUnitId: sheet.id, columnCount: sheet.data.columnCount },
          });
        }
        commands.push({
          id: FILL_COMMAND,
          params: {
            unitId,
            subUnitId: sheet.id,
            sourceRange: univerRange(source.ref),
            targetRange: univerRange(ref),
            applyType: op.mode === "series" ? "SERIES" : "COPY",
          },
        });
        ranges.push(ref);
        needsSnapshot = true;
        break;
      }
      case "axis.size": {
        const sheet = resolveSheet(ctx, op.sheet);
        if (
          op.at + op.count - 2 > (op.axis === "rows" ? MAX_R : MAX_C) ||
          (op.mode !== "auto" && op.value === undefined)
        )
          throw new OpCompileError("尺寸参数无效");
        commands.push({ id: AXIS_SIZE_COMMAND, params: { ...op, unitId, subUnitId: sheet.id } });
        ranges.push({
          sheetId: sheet.id,
          r0: op.axis === "rows" ? op.at - 1 : 0,
          r1: op.axis === "rows" ? op.at + op.count - 2 : MAX_R,
          c0: op.axis === "cols" ? op.at - 1 : 0,
          c1: op.axis === "cols" ? op.at + op.count - 2 : MAX_C,
        });
        break;
      }
      case "find_replace": {
        const { sheet, ref } = regionOf(ctx, op.range);
        const size = (ref.r1 - ref.r0 + 1) * (ref.c1 - ref.c0 + 1);
        if (size > 200000) throw new OpCompileError("查找替换单次最多20万格");
        commands.push({
          id: FIND_REPLACE_COMMAND,
          params: { ...op, unitId, subUnitId: sheet.id, range: univerRange(ref) },
        });
        ranges.push(ref);
        estCells += size;
        break;
      }
      case "cells.set": {
        const { sheet, ref } = regionOf(ctx, op.range);
        // 只写 values 覆盖的矩形（以 range 左上角为锚点）；range 多出的部分不动（P1-34）
        const target = cellsSetTarget(sheet.id, ref, op.values);
        const value = Array.from({ length: target.r1 - target.r0 + 1 }, (_, i) =>
          Array.from({ length: target.c1 - target.c0 + 1 }, (_, j) =>
            cellData(op.values[i]?.[j] ?? null),
          ),
        );
        for (let i = 0; i < value.length; i++) {
          for (let j = 0; j < (value[i] as unknown[]).length; j++) {
            const cell = value[i]?.[j] as Record<string, unknown> | undefined;
            if (typeof cell?.f === "string") {
              formulas.push(
                `${sheet.data.name ?? sheet.id}!${indexToCol(target.c0 + j + 1)}${target.r0 + i + 1}`,
              );
            }
          }
        }
        if (target.r1 >= (sheet.data.rowCount ?? 1)) {
          sheet.data.rowCount = target.r1 + 1;
          commands.push({
            id: "sheet.mutation.set-worksheet-row-count",
            params: { unitId, subUnitId: sheet.id, rowCount: sheet.data.rowCount },
          });
        }
        if (target.c1 >= (sheet.data.columnCount ?? 1)) {
          sheet.data.columnCount = target.c1 + 1;
          commands.push({
            id: "sheet.mutation.set-worksheet-column-count",
            params: { unitId, subUnitId: sheet.id, columnCount: sheet.data.columnCount },
          });
        }
        commands.push({
          id: "sheet.command.set-range-values",
          params: { unitId, subUnitId: sheet.id, range: univerRange(target), value },
        });
        ranges.push(target);
        estCells += (target.r1 - target.r0 + 1) * (target.c1 - target.c0 + 1);
        break;
      }
      case "cells.clear": {
        const { sheet, ref } = regionOf(ctx, op.range);
        const id =
          op.what === "contents"
            ? "sheet.command.clear-selection-content"
            : op.what === "formats"
              ? "sheet.command.clear-selection-format"
              : "sheet.command.clear-selection-all";
        commands.push({ id, params: { unitId, subUnitId: sheet.id, ranges: [univerRange(ref)] } });
        ranges.push(ref);
        estCells += (ref.r1 - ref.r0 + 1) * (ref.c1 - ref.c0 + 1);
        break;
      }
      case "style.set": {
        const { sheet, ref } = regionOf(ctx, op.range);
        const styles: Array<{ type: string; value: unknown }> = [];
        if (op.bold !== undefined) styles.push({ type: "bl", value: op.bold ? 1 : 0 });
        if (op.italic !== undefined) styles.push({ type: "it", value: op.italic ? 1 : 0 });
        if (op.fontColor !== undefined) styles.push({ type: "cl", value: { rgb: op.fontColor } });
        if (op.fill !== undefined) styles.push({ type: "bg", value: { rgb: op.fill } });
        if (op.numFmt !== undefined) styles.push({ type: "n", value: { pattern: op.numFmt } });
        if (op.hAlign !== undefined) styles.push({ type: "ht", value: HALIGN[op.hAlign] });
        if (op.fontSize !== undefined) styles.push({ type: "fs", value: op.fontSize });
        if (op.indent !== undefined) styles.push({ type: "pd", value: { l: op.indent * 21 } });
        if (op.fontFamily !== undefined) styles.push({ type: "ff", value: op.fontFamily });
        if (op.vAlign !== undefined)
          styles.push({ type: "vt", value: { top: 1, center: 2, bottom: 3 }[op.vAlign] });
        if (op.borders !== undefined)
          styles.push({
            type: "bd",
            value: Object.fromEntries(
              Object.entries(op.borders).map(([key, value]) => [
                { top: "t", bottom: "b", left: "l", right: "r" }[key],
                value ? { s: BORDER_STYLES.indexOf(value.style), cl: { rgb: value.color } } : null,
              ]),
            ),
          });
        if (op.wrap !== undefined) styles.push({ type: "tb", value: op.wrap ? 3 : 2 });
        if (styles.length === 0) throw new OpCompileError("style.set 没有提供任何样式字段");
        for (const style of styles) {
          commands.push({
            id: "sheet.command.set-style",
            params: { unitId, subUnitId: sheet.id, range: univerRange(ref), style },
          });
        }
        ranges.push(ref);
        estCells += (ref.r1 - ref.r0 + 1) * (ref.c1 - ref.c0 + 1);
        break;
      }
      case "merge": {
        const { sheet, ref } = regionOf(ctx, op.range);
        commands.push({
          id: "sheet.command.add-worksheet-merge",
          params: {
            unitId,
            subUnitId: sheet.id,
            selections: [univerRange(ref)],
            defaultMerge: true,
          },
        });
        ranges.push(ref);
        break;
      }
      case "unmerge": {
        const { sheet, ref } = regionOf(ctx, op.range);
        commands.push({
          id: "sheet.command.remove-worksheet-merge",
          params: { unitId, subUnitId: sheet.id, ranges: [univerRange(ref)] },
        });
        ranges.push(ref);
        break;
      }
      case "rows.insert":
      case "rows.delete": {
        const sheet = resolveSheet(ctx, op.sheet);
        const index = op.at - 1;
        const lastCol = Math.max(0, (sheet.data.columnCount ?? 1) - 1);
        const range = {
          startRow: index,
          endRow: index + op.count - 1,
          startColumn: 0,
          endColumn: lastCol,
        };
        const rowCount = sheet.data.rowCount ?? 1;
        if (op.op === "rows.insert") {
          // Univer 以 startRow-1 为锚点（继承行高）：插在第 1 行时改用本行为锚点，
          // 插在现有行之后先扩行数，使锚点落在最后一行（P1-23）
          if (index > rowCount) {
            commands.push({
              id: "sheet.mutation.set-worksheet-row-count",
              params: { unitId, subUnitId: sheet.id, rowCount: index },
            });
          }
          commands.push({
            id: "sheet.command.insert-row-by-range",
            params: {
              unitId,
              subUnitId: sheet.id,
              range,
              ...(index === 0 ? { direction: Direction.UP } : {}),
            },
          });
          sheet.data.rowCount = Math.max(rowCount, index) + op.count;
        } else {
          commands.push({
            id: "sheet.command.remove-row-by-range",
            params: { unitId, subUnitId: sheet.id, range },
          });
          sheet.data.rowCount = Math.max(1, rowCount - op.count);
        }
        // 冲突写集只记插入/删除的条带；尾部位移由 structural 变换承担，
        // 否则之后任何 stale 写都会整表冲突，平移语义失效。
        ranges.push({
          sheetId: sheet.id,
          r0: index,
          c0: 0,
          r1: index + op.count - 1,
          c1: lastCol,
        });
        structural.push({
          sheetId: sheet.id,
          kind: op.op === "rows.insert" ? "insertRows" : "deleteRows",
          index,
          count: op.count,
        });
        estCells += op.count * (sheet.data.columnCount ?? 1);
        break;
      }
      case "cols.insert":
      case "cols.delete": {
        const sheet = resolveSheet(ctx, op.sheet);
        const index = op.at - 1;
        const lastRow = Math.max(0, (sheet.data.rowCount ?? 1) - 1);
        const range = {
          startRow: 0,
          endRow: lastRow,
          startColumn: index,
          endColumn: index + op.count - 1,
        };
        const columnCount = sheet.data.columnCount ?? 1;
        if (op.op === "cols.insert") {
          if (index > columnCount) {
            commands.push({
              id: "sheet.mutation.set-worksheet-column-count",
              params: { unitId, subUnitId: sheet.id, columnCount: index },
            });
          }
          commands.push({
            id: "sheet.command.insert-col-by-range",
            params: {
              unitId,
              subUnitId: sheet.id,
              range,
              ...(index === 0 ? { direction: Direction.LEFT } : {}),
            },
          });
          sheet.data.columnCount = Math.max(columnCount, index) + op.count;
        } else {
          commands.push({
            id: "sheet.command.remove-col-by-range",
            params: { unitId, subUnitId: sheet.id, range },
          });
          sheet.data.columnCount = Math.max(1, columnCount - op.count);
        }
        ranges.push({
          sheetId: sheet.id,
          r0: 0,
          c0: index,
          r1: lastRow,
          c1: index + op.count - 1,
        });
        structural.push({
          sheetId: sheet.id,
          kind: op.op === "cols.insert" ? "insertCols" : "deleteCols",
          index,
          count: op.count,
        });
        estCells += op.count * (sheet.data.rowCount ?? 1);
        break;
      }
      case "sheet.copy": {
        const source = resolveSheet(ctx, op.sheet);
        if (
          op.name.length > 31 ||
          /[[\]:*?/\\]/.test(op.name) ||
          Object.values(ctx.snapshot.sheets).some((s) => s.name === op.name)
        )
          throw new OpCompileError("工作表名称无效或重复");
        if (
          objectsOf(source.data).charts.length ||
          objectsOf(source.data).images.length ||
          [CF_RESOURCE, DV_RESOURCE, "SHEET_FILTER_PLUGIN"].some((name) => {
            const value: unknown = rulesResource(ctx.snapshot, name)[source.id];
            return Array.isArray(value)
              ? value.length > 0
              : !!value && typeof value === "object" && "ref" in value && !!value.ref;
          })
        )
          throw new OpCompileError("含对象或规则的工作表不能安全复制，请复制值和样式到新表");
        const id = newId("sheet"),
          index = op.index ?? ctx.snapshot.sheetOrder.length;
        if (index > ctx.snapshot.sheetOrder.length) throw new OpCompileError("复制索引越界");
        const added = { ...structuredClone(source.data), id, name: op.name, hidden: 0 };
        commands.push({
          id: COPY_SHEET_COMMAND,
          params: { unitId, subUnitId: source.id, id, name: op.name, index },
        });
        ctx.snapshot.sheets[id] = added;
        ctx.snapshot.sheetOrder.splice(index, 0, id);
        sheetNames.set(id, op.name);
        ranges.push({ sheetId: source.id, r0: 0, c0: 0, r1: MAX_R, c1: MAX_C });
        structural.push({ sheetId: id, kind: "insertSheet", index, count: 0 });
        needsSnapshot = true;
        break;
      }
      case "sheet.move": {
        const sheet = resolveSheet(ctx, op.sheet),
          fromOrder = ctx.snapshot.sheetOrder.indexOf(sheet.id);
        if (op.index >= ctx.snapshot.sheetOrder.length) throw new OpCompileError("移动索引越界");
        commands.push({
          id: "sheet.mutation.set-worksheet-order",
          params: { unitId, subUnitId: sheet.id, fromOrder, toOrder: op.index },
        });
        ctx.snapshot.sheetOrder.splice(fromOrder, 1);
        ctx.snapshot.sheetOrder.splice(op.index, 0, sheet.id);
        ranges.push({ sheetId: "*", r0: 0, c0: 0, r1: MAX_R, c1: MAX_C });
        needsSnapshot = true;
        break;
      }
      case "sheet.hide": {
        const sheet = resolveSheet(ctx, op.sheet);
        if (
          op.hidden &&
          !Object.entries(ctx.snapshot.sheets).some(([id, s]) => id !== sheet.id && !s.hidden)
        )
          throw new OpCompileError("至少保留一个可见工作表");
        commands.push({
          id: "sheet.mutation.set-worksheet-hidden",
          params: { unitId, subUnitId: sheet.id, hidden: op.hidden ? 1 : 0 },
        });
        sheet.data.hidden = op.hidden ? 1 : 0;
        ranges.push({ sheetId: sheet.id, r0: 0, c0: 0, r1: MAX_R, c1: MAX_C });
        needsSnapshot = true;
        break;
      }
      case "sheet.add": {
        if (
          !op.name ||
          op.name.length > 31 ||
          /[[\]:*?/\\]/.test(op.name) ||
          Object.values(ctx.snapshot.sheets).some((s) => s.name === op.name)
        )
          throw new OpCompileError("工作表名称无效或重复");
        const id = newId("sheet");
        const index = op.index ?? ctx.snapshot.sheetOrder?.length ?? 0;
        if (index > ctx.snapshot.sheetOrder.length) throw new OpCompileError("工作表插入索引越界");
        const added = { id, name: op.name, rowCount: 1000, columnCount: 26, cellData: {} };
        commands.push({
          id: "sheet.command.insert-sheet",
          params: {
            unitId,
            index,
            sheet: added,
          },
        });
        ctx.snapshot.sheets[id] = added;
        sheetNames.set(id, op.name);
        ctx.snapshot.sheetOrder.splice(index, 0, id);
        structural.push({ sheetId: id, kind: "insertSheet", index, count: 0 });
        break;
      }
      case "sheet.rename": {
        const sheet = resolveSheet(ctx, op.sheet);
        commands.push({
          id: "sheet.command.set-worksheet-name",
          params: { unitId, subUnitId: sheet.id, name: op.name },
        });
        if (
          !op.name ||
          op.name.length > 31 ||
          /[[\]:*?/\\]/.test(op.name) ||
          Object.values(ctx.snapshot.sheets).some((s) => s.id !== sheet.id && s.name === op.name)
        )
          throw new OpCompileError("工作表名称无效或重复");
        sheet.data.name = op.name;
        sheetNames.set(sheet.id, op.name);
        structural.push({ sheetId: sheet.id, kind: "renameSheet", index: 0, count: 0 });
        break;
      }
      case "sheet.delete": {
        const sheet = resolveSheet(ctx, op.sheet);
        if ((ctx.snapshot.sheetOrder ?? []).length <= 1) {
          throw new OpCompileError("不能删除最后一个工作表");
        }
        const index = (ctx.snapshot.sheetOrder ?? []).indexOf(sheet.id);
        commands.push({
          id: "sheet.command.remove-sheet",
          params: { unitId, subUnitId: sheet.id },
        });
        ranges.push({ sheetId: sheet.id, r0: 0, c0: 0, r1: MAX_R, c1: MAX_C });
        structural.push({
          sheetId: sheet.id,
          kind: "removeSheet",
          index: Math.max(0, index),
          count: 0,
        });
        needsSnapshot = true;
        delete ctx.snapshot.sheets[sheet.id];
        ctx.snapshot.sheetOrder.splice(index, 1);
        break;
      }
      case "freeze": {
        const sheet = resolveSheet(ctx, op.sheet);
        commands.push({
          id: "sheet.command.set-frozen",
          params: {
            unitId,
            subUnitId: sheet.id,
            startRow: op.rows,
            startColumn: op.cols,
            ySplit: op.rows,
            xSplit: op.cols,
          },
        });
        break;
      }
      case "recalculate":
        break;
    }
  }
  return { commands, ranges, structural, formulas, estCells, needsSnapshot, sheetNames };
}

export { rangeRefToA1 };

// ---------- stale 坐标平移（07 §3.3：baseRev 之后的结构操作要先作用到本次写入坐标） ----------

type SheetResolver = (nameOrId: string | undefined) => string | undefined;

/** 依次把结构操作应用到一个 RangeRef；任一返回 "deleted" 即整体删除。 */
function applyStructurals(ref: RangeRef, structurals: StructuralOp[]): RangeRef | "deleted" {
  let cur = ref;
  for (const s of structurals) {
    const t = transformRange(cur, s);
    if (t === "deleted") return "deleted";
    cur = t;
  }
  return cur;
}

/**
 * ChangeOp 的坐标字段经历史结构操作平移后重渲染。
 * - range 型 op（cells.clear、style.set、merge、unmerge）：变换 A1 区域；
 * - cells.set：写入矩形整体平移；内部被插入/删除 → "ambiguous"；
 * - rows/cols 型 op：变换 at 下标点；
 * - 目标表被 removeSheet → "deleted"；renameSheet 不改变坐标（sheet 解析走 id）。
 */
export function transformChangeOp(
  op: ChangeOp,
  structurals: StructuralOp[],
  sheetIdOf: SheetResolver,
): ChangeOp | "deleted" | "ambiguous" {
  switch (op.op) {
    case "cells.fill":
      return structurals.length ? "ambiguous" : op;
    case "cells.set": {
      // values 与单元格逐一对应：目标矩形内部被插入/删除行列时无法确定性平移（P0-08）
      const parsed = parseRange(op.range);
      const sheetId = sheetIdOf(parsed.sheet);
      if (sheetId === undefined) return "deleted";
      let cur = cellsSetTarget(
        sheetId,
        { sheetId, r0: parsed.startRow - 1, c0: parsed.startCol - 1, r1: 0, c1: 0 },
        op.values,
      );
      for (const s of structurals) {
        const t = transformRange(cur, s);
        if (t === "deleted") return "deleted";
        if (structuralTouchesInterior(cur, s)) return "ambiguous";
        cur = t;
      }
      const anchor = { ...cur, r1: cur.r0, c1: cur.c0 };
      return { ...op, range: rangeRefToA1(anchor, sheetId) };
    }
    case "filter.set":
    case "hyperlink.set":
    case "find_replace":
    case "cf.add":
    case "dv.add":
    case "sort":
    case "cells.clear":
    case "style.set":
    case "merge":
    case "unmerge": {
      const parsed = parseRange(op.range);
      const sheetId = sheetIdOf(parsed.sheet);
      if (sheetId === undefined) return "deleted";
      const ref: RangeRef = {
        sheetId,
        r0: parsed.startRow - 1,
        c0: parsed.startCol - 1,
        r1: parsed.endRow - 1,
        c1: parsed.endCol - 1,
      };
      const t = applyStructurals(ref, structurals);
      if (t === "deleted") return "deleted";
      return { ...op, range: rangeRefToA1(t, t.sheetId) };
    }
    case "axis.size":
    case "axis.hide":
    case "axis.group": {
      const sheetId = sheetIdOf(op.sheet);
      if (sheetId === undefined) return "deleted";
      const rows = op.axis === "rows";
      const ref = {
        sheetId,
        r0: rows ? op.at - 1 : 0,
        r1: rows ? op.at + op.count - 2 : MAX_R,
        c0: rows ? 0 : op.at - 1,
        c1: rows ? MAX_C : op.at + op.count - 2,
      };
      const t = applyStructurals(ref, structurals);
      if (t === "deleted") return "deleted";
      return {
        ...op,
        sheet: sheetId,
        at: (rows ? t.r0 : t.c0) + 1,
        count: rows ? t.r1 - t.r0 + 1 : t.c1 - t.c0 + 1,
      };
    }
    case "rows.height":
    case "rows.insert":
    case "rows.delete": {
      const sheetId = sheetIdOf(op.sheet);
      if (sheetId === undefined) return "deleted";
      const point: RangeRef = { sheetId, r0: op.at - 1, c0: 0, r1: op.at - 1, c1: 0 };
      const t = applyStructurals(point, structurals);
      if (t === "deleted") return "deleted";
      return { ...op, at: t.r0 + 1 };
    }
    case "cols.width":
    case "cols.insert":
    case "cols.delete": {
      const sheetId = sheetIdOf(op.sheet);
      if (sheetId === undefined) return "deleted";
      const point: RangeRef = { sheetId, r0: 0, c0: op.at - 1, r1: 0, c1: op.at - 1 };
      const t = applyStructurals(point, structurals);
      if (t === "deleted") return "deleted";
      return { ...op, at: t.c0 + 1 };
    }
    case "cf.remove":
    case "dv.remove":
    case "image.add":
    case "chart.add":
    case "chart.update":
    case "chart.delete":
    case "sheet.copy":
    case "sheet.move":
    case "sheet.hide":
    case "sheet.rename":
    case "sheet.delete":
    case "freeze": {
      const sheetId = sheetIdOf(op.sheet);
      if (sheetId === undefined) return "deleted";
      for (const s of structurals) {
        if (s.kind === "removeSheet" && s.sheetId === sheetId) return "deleted";
      }
      // sheet 引用改传 id，renameSheet 之后的旧表名仍能解析
      return { ...op, sheet: sheetId };
    }
    case "sheet.add":
    case "recalculate":
      return op;
  }
}

/**
 * ChangeOp 的坐标目标（op 自身坐标系）：rect = 写入矩形；rows/cols = 受影响的行/列段。
 * 不带行列坐标的 op 返回 undefined。用于按读集推定该 op 的坐标依据修订。
 */
export function changeOpTarget(
  op: ChangeOp,
  sheetIdOf: SheetResolver,
): { axis: "rect" | "rows" | "cols"; ref: RangeRef } | undefined {
  switch (op.op) {
    case "cells.fill":
    case "cells.set":
    case "filter.set":
    case "hyperlink.set":
    case "find_replace":
    case "cf.add":
    case "dv.add":
    case "sort":
    case "cells.clear":
    case "style.set":
    case "merge":
    case "unmerge": {
      const p = parseRange(op.range);
      const sheetId = sheetIdOf(p.sheet);
      if (sheetId === undefined) return undefined;
      const ref = {
        sheetId,
        r0: p.startRow - 1,
        c0: p.startCol - 1,
        r1: p.endRow - 1,
        c1: p.endCol - 1,
      };
      return {
        axis: "rect",
        ref: op.op === "cells.set" ? cellsSetTarget(sheetId, ref, op.values) : ref,
      };
    }
    case "axis.size":
    case "axis.hide":
    case "axis.group": {
      const sheetId = sheetIdOf(op.sheet);
      if (sheetId === undefined) return undefined;
      const a0 = op.at - 1,
        a1 = a0 + op.count - 1;
      return op.axis === "rows"
        ? { axis: "rows", ref: { sheetId, r0: a0, r1: a1, c0: 0, c1: MAX_C } }
        : { axis: "cols", ref: { sheetId, r0: 0, r1: MAX_R, c0: a0, c1: a1 } };
    }
    case "rows.height":
    case "rows.insert":
    case "rows.delete":
    case "cols.width":
    case "cols.insert":
    case "cols.delete": {
      const sheetId = sheetIdOf(op.sheet);
      if (sheetId === undefined) return undefined;
      const a0 = op.at - 1;
      const a1 = op.op.endsWith(".delete") ? a0 + op.count - 1 : a0;
      return op.op.startsWith("rows.")
        ? { axis: "rows", ref: { sheetId, r0: a0, r1: a1, c0: 0, c1: MAX_C } }
        : { axis: "cols", ref: { sheetId, r0: 0, r1: MAX_R, c0: a0, c1: a1 } };
    }
    default:
      return undefined;
  }
}

interface MutationParams {
  subUnitId?: string;
  range?: { startRow: number; endRow: number; startColumn: number; endColumn: number };
  ranges?: { startRow: number; endRow: number; startColumn: number; endColumn: number }[];
  cellValue?: Record<number, Record<number, unknown>>;
  [k: string]: unknown;
}

/** Univer IRange → RangeRef。 */
const iRangeToRef = (
  sheetId: string,
  r: { startRow: number; endRow: number; startColumn: number; endColumn: number },
): RangeRef => ({ sheetId, r0: r.startRow, c0: r.startColumn, r1: r.endRow, c1: r.endColumn });

const refToIRange = (r: RangeRef) => ({
  startRow: r.r0,
  startColumn: r.c0,
  endRow: r.r1,
  endColumn: r.c1,
});

function rekeyCellValue(
  cellValue: Record<number, Record<number, unknown>>,
  structurals: StructuralOp[],
): Record<number, Record<number, unknown>> | "deleted" {
  let cur = cellValue;
  for (const s of structurals) {
    const next: Record<number, Record<number, unknown>> = {};
    for (const [rs, cols] of Object.entries(cur)) {
      const row = Number(rs);
      const ref = applyStructurals({ sheetId: s.sheetId, r0: row, c0: 0, r1: row, c1: MAX_C }, [s]);
      if (ref === "deleted") continue; // 整行被删：丢弃该行的写入
      const newCols: Record<number, unknown> = {};
      for (const [cs, v] of Object.entries(cols)) {
        const col = Number(cs);
        const cref = applyStructurals({ sheetId: s.sheetId, r0: 0, c0: col, r1: 0, c1: col }, [s]);
        if (cref === "deleted") continue;
        newCols[cref.c0] = v;
      }
      if (Object.keys(newCols).length > 0) next[ref.r0] = newCols;
    }
    cur = next;
  }
  return cur;
}

/**
 * 用户来源 mutation 的坐标平移：认识 range/ranges/cellValue 形参数；
 * 其余带坐标语义的字段无法确定性平移时返回 "ambiguous"（调用方拒绝并提示重读）。
 */
export function transformMutation<M extends { id: string; params: unknown }>(
  m: M,
  structurals: StructuralOp[],
): M | "deleted" | "ambiguous" {
  const src = m.params as MutationParams;
  const sid = src.subUnitId;
  const rel = structurals.filter((s) => s.sheetId === sid || s.sheetId === "*");
  if (rel.length === 0) return m;
  if (sid !== undefined && rel.some((s) => s.kind === "removeSheet" && s.sheetId === sid)) {
    return "deleted";
  }
  const params: MutationParams = { ...src };
  if (params.range !== undefined) {
    if (sid === undefined) return "ambiguous";
    const t = applyStructurals(iRangeToRef(sid, params.range), rel);
    if (t === "deleted") return "deleted";
    params.range = refToIRange(t);
  }
  if (params.ranges !== undefined) {
    if (sid === undefined) return "ambiguous";
    const out: NonNullable<MutationParams["ranges"]> = [];
    for (const r of params.ranges) {
      const t = applyStructurals(iRangeToRef(sid, r), rel);
      if (t === "deleted") return "deleted";
      out.push(refToIRange(t));
    }
    params.ranges = out;
  }
  if (params.cellValue !== undefined) {
    if (sid === undefined) return "ambiguous";
    const t = rekeyCellValue(params.cellValue, rel);
    if (t === "deleted") return "deleted";
    params.cellValue = t;
  }
  return { ...m, params: params as M["params"] };
}
