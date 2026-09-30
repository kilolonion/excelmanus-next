// workbook_edit 的 ChangeOp 判别联合 → Univer 命令序列（07 §3.3 编译步）。
// 写集与结构操作直接从 op 推导（agent 来源，坐标用变换前的写入坐标）。

import {
  indexToCol,
  MAX_C,
  MAX_R,
  parseRange,
  type RangeRef,
  rangeRefToA1,
  type StructuralOp,
  transformRange,
} from "@excelmanus/core";
import type { IWorkbookData, IWorksheetData } from "@univerjs/core";
import { z } from "zod";

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
const styleSet = z.strictObject({
  op: z.literal("style.set"),
  range: z.string().min(1),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  fontColor: z.string().optional(),
  fill: z.string().optional(),
  numFmt: z.string().optional(),
  hAlign: z.enum(["left", "center", "right"]).optional(),
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

export const ChangeOp = z.discriminatedUnion("op", [
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
}

export class OpCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpCompileError";
  }
}

interface CompileCtx {
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

const HALIGN = { left: 1, center: 2, right: 3 } as const;

export function compileOps(ctx: CompileCtx, ops: ChangeOp[]): CompiledOps {
  const commands: CompiledCommand[] = [];
  const ranges: RangeRef[] = [];
  const structural: StructuralOp[] = [];
  const formulas: string[] = [];
  let estCells = 0;
  let needsSnapshot = false;
  const unitId = ctx.unitId;

  for (const op of ops) {
    switch (op.op) {
      case "cells.set": {
        const { sheet, ref } = regionOf(ctx, op.range);
        const rows = op.values.length;
        const cols = Math.max(...op.values.map((r) => r.length));
        const singleCell = ref.r0 === ref.r1 && ref.c0 === ref.c1 && !op.range.includes(":");
        const end = singleCell
          ? { r1: ref.r0 + rows - 1, c1: ref.c0 + cols - 1 }
          : { r1: Math.max(ref.r1, ref.r0 + rows - 1), c1: Math.max(ref.c1, ref.c0 + cols - 1) };
        const target: RangeRef = { sheetId: sheet.id, r0: ref.r0, c0: ref.c0, ...end };
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
        commands.push({
          id:
            op.op === "rows.insert"
              ? "sheet.command.insert-row-by-range"
              : "sheet.command.remove-row-by-range",
          params: { unitId, subUnitId: sheet.id, range },
        });
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
        commands.push({
          id:
            op.op === "cols.insert"
              ? "sheet.command.insert-col-by-range"
              : "sheet.command.remove-col-by-range",
          params: { unitId, subUnitId: sheet.id, range },
        });
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
      case "sheet.add": {
        const index = op.index ?? ctx.snapshot.sheetOrder?.length ?? 0;
        commands.push({
          id: "sheet.command.insert-sheet",
          params: {
            unitId,
            index,
            sheet: { name: op.name, rowCount: 1000, columnCount: 26 },
          },
        });
        structural.push({ sheetId: "*", kind: "insertSheet", index, count: 0 });
        break;
      }
      case "sheet.rename": {
        const sheet = resolveSheet(ctx, op.sheet);
        commands.push({
          id: "sheet.command.set-worksheet-name",
          params: { unitId, subUnitId: sheet.id, name: op.name },
        });
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
    }
  }
  return { commands, ranges, structural, formulas, estCells, needsSnapshot };
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
 * - range 型 op（cells.set/clear、style.set、merge、unmerge）：变换 A1 区域；
 * - rows/cols 型 op：变换 at 下标点；
 * - 目标表被 removeSheet → "deleted"；renameSheet 不改变坐标（sheet 解析走 id）。
 */
export function transformChangeOp(
  op: ChangeOp,
  structurals: StructuralOp[],
  sheetIdOf: SheetResolver,
): ChangeOp | "deleted" {
  switch (op.op) {
    case "cells.set":
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
    case "rows.insert":
    case "rows.delete": {
      const sheetId = sheetIdOf(op.sheet);
      if (sheetId === undefined) return "deleted";
      const point: RangeRef = { sheetId, r0: op.at - 1, c0: 0, r1: op.at - 1, c1: 0 };
      const t = applyStructurals(point, structurals);
      if (t === "deleted") return "deleted";
      return { ...op, at: t.r0 + 1 };
    }
    case "cols.insert":
    case "cols.delete": {
      const sheetId = sheetIdOf(op.sheet);
      if (sheetId === undefined) return "deleted";
      const point: RangeRef = { sheetId, r0: 0, c0: op.at - 1, r1: 0, c1: op.at - 1 };
      const t = applyStructurals(point, structurals);
      if (t === "deleted") return "deleted";
      return { ...op, at: t.c0 + 1 };
    }
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
      return op;
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
