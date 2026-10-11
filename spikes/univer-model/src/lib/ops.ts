// T3/T4/T5 操作池：每个生成器产出一次"命令执行"，返回捕获到的 mutation 序列。

import { IUniverInstanceService } from "@univerjs/core";
import type { Prng } from "./prng.ts";
import type { Booted, CapturedMutation } from "./univer-node.ts";

export interface SheetShadow {
  id: string;
  name: string;
  rowCount: number;
  colCount: number;
}

export interface OpCtx {
  boot: Booted;
  unitId: string;
  prng: Prng;
  sheets: SheetShadow[];
  merges: Map<
    string,
    Array<{ startRow: number; startColumn: number; endRow: number; endColumn: number }>
  >;
  dvRules: Array<{ uid: string; sheetId: string; ranges: IRangeLite[] }>;
  cfRuleIds: string[];
  hiddenRows: Map<string, Set<number>>;
  hiddenCols: Map<string, Set<number>>;
  frozenSheets: Set<string>;
  filterSheets: Map<string, IRangeLite>;
  seqId: number;
  opIndex: number;
}

export interface OpResult {
  opType: string;
  commandId: string;
  ok: boolean;
  threw?: string;
  latencyMs: number;
  mutations: CapturedMutation[];
  mutationIds: string[];
  params: Record<string, unknown>;
  paramsSerializable: boolean;
}

interface IRangeLite {
  startRow: number;
  startColumn: number;
  endRow: number;
  endColumn: number;
}

const rnd = (ctx: OpCtx, lo: number, hi: number) => ctx.prng.range(lo, Math.max(lo, hi));

export function pickSheet(ctx: OpCtx): SheetShadow {
  return ctx.prng.pick(ctx.sheets);
}

interface InjectorLike {
  get(token: unknown): unknown;
}
interface WorksheetLike {
  getConfig(): { mergeData?: IRangeLite[] };
  getRowVisible?(row: number): boolean;
  getColVisible?(col: number): boolean;
}
interface WorkbookLike {
  getSheetBySheetId(id: string): WorksheetLike | undefined;
}
interface InstanceServiceLike {
  getUnit(unitId: string): WorkbookLike | undefined;
}

// 直接读真实 mergeData（行列增删会让 merge 自动平移，shadow 难以精确同步）
function realMerges(ctx: OpCtx, sheetId: string): IRangeLite[] {
  const svc = (ctx.boot.injector as InjectorLike).get(
    IUniverInstanceService,
  ) as InstanceServiceLike;
  const wb = svc.getUnit(ctx.unitId);
  return wb?.getSheetBySheetId(sheetId)?.getConfig().mergeData ?? [];
}

function realSheet(ctx: OpCtx, sheetId: string): WorksheetLike | undefined {
  const svc = (ctx.boot.injector as InjectorLike).get(
    IUniverInstanceService,
  ) as InstanceServiceLike;
  return svc.getUnit(ctx.unitId)?.getSheetBySheetId(sheetId);
}

// 真实隐藏行/列（spike 的 shadow 在 move/remove 后会漂移，直接问 Univer）
function realHiddenRows(ctx: OpCtx, sheet: SheetShadow): number[] {
  const ws = realSheet(ctx, sheet.id);
  const out: number[] = [];
  for (let r = 0; r < sheet.rowCount; r++) if (ws?.getRowVisible?.(r) === false) out.push(r);
  return out;
}
function realHiddenCols(ctx: OpCtx, sheet: SheetShadow): number[] {
  const ws = realSheet(ctx, sheet.id);
  const out: number[] = [];
  for (let c = 0; c < sheet.colCount; c++) if (ws?.getColVisible?.(c) === false) out.push(c);
  return out;
}

function randRange(ctx: OpCtx, sheet: SheetShadow, maxSpan = 20): IRangeLite {
  const r1 = rnd(ctx, 0, sheet.rowCount - 1);
  const c1 = rnd(ctx, 0, sheet.colCount - 1);
  const r2 = Math.min(sheet.rowCount - 1, r1 + rnd(ctx, 0, maxSpan - 1));
  const c2 = Math.min(
    sheet.colCount - 1,
    c1 + rnd(ctx, 0, Math.max(1, Math.floor(maxSpan / 2)) - 1),
  );
  return { startRow: r1, startColumn: c1, endRow: r2, endColumn: c2 };
}

function rowSpanRange(sheet: SheetShadow, r1: number, r2: number): IRangeLite {
  return { startRow: r1, startColumn: 0, endRow: r2, endColumn: sheet.colCount - 1 };
}

function colSpanRange(sheet: SheetShadow, c1: number, c2: number): IRangeLite {
  return { startRow: 0, startColumn: c1, endRow: sheet.rowCount - 1, endColumn: c2 };
}

const mutationMark = 0;
export const mutationList: CapturedMutation[] = [];
export function attachRecorder(boot: Booted): void {
  boot.commandService.onCommandExecuted((info) => {
    if (info.type === 2) mutationList.push({ id: info.id, params: info.params });
  });
}

export async function exec(
  ctx: OpCtx,
  opType: string,
  commandId: string,
  params: Record<string, unknown>,
): Promise<OpResult> {
  const start = mutationList.length;
  let paramsSerializable = true;
  let clonedParams = params;
  try {
    clonedParams = JSON.parse(JSON.stringify(params));
  } catch {
    paramsSerializable = false;
  }
  const t0 = performance.now();
  let ok = false;
  let threw: string | undefined;
  try {
    ok = await ctx.boot.commandService.executeCommand(commandId, clonedParams);
  } catch (e) {
    threw = (e as Error).message ?? String(e);
  }
  const latencyMs = performance.now() - t0;
  const mutations = mutationList.slice(start);
  // mutation 也必须能 JSON 序列化
  for (const m of mutations) {
    try {
      JSON.stringify(m.params);
    } catch {
      paramsSerializable = false;
    }
  }
  return {
    opType,
    commandId,
    ok,
    threw,
    latencyMs,
    mutations,
    mutationIds: mutations.map((m) => m.id),
    params,
    paramsSerializable,
  };
}

export interface OpSpec {
  type: string;
  weight: number;
  run(ctx: OpCtx): Promise<OpResult>;
}

const numStr = (ctx: OpCtx) => `n${ctx.seqId}_${ctx.opIndex}_${rnd(ctx, 0, 9999)}`;

export const OPS: OpSpec[] = [
  {
    type: "set-value-number",
    weight: 10,
    run: (ctx) => {
      const s = pickSheet(ctx);
      const r = rnd(ctx, 0, s.rowCount - 1);
      const c = rnd(ctx, 0, s.colCount - 1);
      return exec(ctx, "set-value-number", "sheet.command.set-range-values", {
        unitId: ctx.unitId,
        subUnitId: s.id,
        range: { startRow: r, startColumn: c, endRow: r, endColumn: c },
        value: { v: rnd(ctx, -10_000, 10_000) + ctx.prng.next() },
      });
    },
  },
  {
    type: "set-value-string",
    weight: 8,
    run: (ctx) => {
      const s = pickSheet(ctx);
      const r = rnd(ctx, 0, s.rowCount - 1);
      const c = rnd(ctx, 0, s.colCount - 1);
      return exec(ctx, "set-value-string", "sheet.command.set-range-values", {
        unitId: ctx.unitId,
        subUnitId: s.id,
        range: { startRow: r, startColumn: c, endRow: r, endColumn: c },
        value: { v: `s_${numStr(ctx)}` },
      });
    },
  },
  {
    type: "set-value-boolean",
    weight: 4,
    run: (ctx) => {
      const s = pickSheet(ctx);
      const r = rnd(ctx, 0, s.rowCount - 1);
      const c = rnd(ctx, 0, s.colCount - 1);
      return exec(ctx, "set-value-boolean", "sheet.command.set-range-values", {
        unitId: ctx.unitId,
        subUnitId: s.id,
        range: { startRow: r, startColumn: c, endRow: r, endColumn: c },
        value: { v: ctx.prng.chance(0.5), t: 3 },
      });
    },
  },
  {
    type: "set-value-empty",
    weight: 4,
    run: (ctx) => {
      const s = pickSheet(ctx);
      const r = rnd(ctx, 0, s.rowCount - 1);
      const c = rnd(ctx, 0, s.colCount - 1);
      return exec(ctx, "set-value-empty", "sheet.command.set-range-values", {
        unitId: ctx.unitId,
        subUnitId: s.id,
        range: { startRow: r, startColumn: c, endRow: r, endColumn: c },
        value: { v: null },
      });
    },
  },
  {
    type: "set-formula",
    weight: 5,
    run: (ctx) => {
      const s = pickSheet(ctx);
      const r = rnd(ctx, 0, s.rowCount - 1);
      const c = rnd(ctx, 1, s.colCount - 1);
      const f = ctx.prng.chance(0.5)
        ? `=A${r + 1}+B${r + 1}`
        : `=SUM(A1:A${rnd(ctx, 2, Math.min(20, s.rowCount))})`;
      return exec(ctx, "set-formula", "sheet.command.set-range-values", {
        unitId: ctx.unitId,
        subUnitId: s.id,
        range: { startRow: r, startColumn: c, endRow: r, endColumn: c },
        value: { f },
      });
    },
  },
  {
    type: "set-style",
    weight: 7,
    run: (ctx) => {
      const s = pickSheet(ctx);
      const styles: Array<{ type: string; value: unknown }> = [
        { type: "bl", value: 1 },
        { type: "bg", value: { rgb: ctx.prng.pick(["#ff6600", "#00aa88", "#3366cc", "#e8e8e8"]) } },
        { type: "n", value: { pattern: ctx.prng.pick(["0.00", "0.0%", "yyyy-mm-dd", "#,##0"]) } },
        { type: "fs", value: rnd(ctx, 8, 36) },
      ];
      return exec(ctx, "set-style", "sheet.command.set-style", {
        unitId: ctx.unitId,
        subUnitId: s.id,
        range: randRange(ctx, s, 6),
        style: ctx.prng.pick(styles),
      });
    },
  },
  {
    type: "merge",
    weight: 4,
    run: async (ctx) => {
      const s = pickSheet(ctx);
      const r = randRange(ctx, s, 5);
      const res = await exec(ctx, "merge", "sheet.command.add-worksheet-merge", {
        unitId: ctx.unitId,
        subUnitId: s.id,
        selections: [r],
        defaultMerge: true, // 无头无 confirm-service：始终保留左上角值
      });
      if (res.ok) {
        const list = ctx.merges.get(s.id) ?? [];
        list.push(r);
        ctx.merges.set(s.id, list);
      }
      return res;
    },
  },
  {
    type: "unmerge",
    weight: 4,
    run: (ctx) => {
      const candidates = ctx.sheets.filter((s) => realMerges(ctx, s.id).length > 0);
      if (candidates.length === 0) {
        return Promise.resolve({
          opType: "unmerge",
          commandId: "-",
          ok: true,
          latencyMs: 0,
          mutations: [],
          mutationIds: [],
          params: {},
          paramsSerializable: true,
        } as OpResult);
      }
      const s = ctx.prng.pick(candidates);
      const range = ctx.prng.pick(realMerges(ctx, s.id));
      return exec(ctx, "unmerge", "sheet.command.remove-worksheet-merge", {
        unitId: ctx.unitId,
        subUnitId: s.id,
        ranges: [range],
      });
    },
  },
  {
    type: "insert-rows",
    weight: 5,
    run: async (ctx) => {
      const s = pickSheet(ctx);
      const at = rnd(ctx, 0, s.rowCount - 1);
      const n = rnd(ctx, 1, 5);
      const res = await exec(ctx, "insert-rows", "sheet.command.insert-row-by-range", {
        unitId: ctx.unitId,
        subUnitId: s.id,
        range: rowSpanRange(s, at, Math.min(s.rowCount - 1, at + n - 1)),
      });
      if (res.ok) {
        s.rowCount += n;
        for (const set of ctx.hiddenRows.values()) {
          const next = new Set<number>();
          for (const r of set) next.add(r >= at ? r + n : r);
          set.clear();
          for (const r of next) set.add(r);
        }
        const merged = ctx.merges.get(s.id);
        if (merged) {
          for (const m of merged) {
            if (m.startRow >= at) m.startRow += n;
            if (m.endRow >= at) m.endRow += n;
          }
        }
      }
      return res;
    },
  },
  {
    type: "remove-rows",
    weight: 5,
    run: async (ctx) => {
      const s = pickSheet(ctx);
      if (s.rowCount < 10) {
        return {
          opType: "remove-rows",
          commandId: "-",
          ok: true,
          latencyMs: 0,
          mutations: [],
          mutationIds: [],
          params: {},
          paramsSerializable: true,
        } as OpResult;
      }
      const at = rnd(ctx, 0, s.rowCount - 3);
      const n = rnd(ctx, 1, Math.min(5, s.rowCount - at - 1));
      const res = await exec(ctx, "remove-rows", "sheet.command.remove-row-by-range", {
        unitId: ctx.unitId,
        subUnitId: s.id,
        range: rowSpanRange(s, at, at + n - 1),
      });
      if (res.ok) {
        s.rowCount -= n;
        const merged = ctx.merges.get(s.id);
        if (merged)
          ctx.merges.set(
            s.id,
            merged.filter((m) => m.endRow < at || m.startRow > at + n - 1),
          );
      }
      return res;
    },
  },
  {
    type: "insert-cols",
    weight: 4,
    run: async (ctx) => {
      const s = pickSheet(ctx);
      const at = rnd(ctx, 0, s.colCount - 1);
      const n = rnd(ctx, 1, 3);
      const res = await exec(ctx, "insert-cols", "sheet.command.insert-col-by-range", {
        unitId: ctx.unitId,
        subUnitId: s.id,
        range: colSpanRange(s, at, Math.min(s.colCount - 1, at + n - 1)),
      });
      if (res.ok) s.colCount += n;
      return res;
    },
  },
  {
    type: "remove-cols",
    weight: 4,
    run: async (ctx) => {
      const s = pickSheet(ctx);
      if (s.colCount < 8) {
        return {
          opType: "remove-cols",
          commandId: "-",
          ok: true,
          latencyMs: 0,
          mutations: [],
          mutationIds: [],
          params: {},
          paramsSerializable: true,
        } as OpResult;
      }
      const at = rnd(ctx, 0, s.colCount - 3);
      const n = rnd(ctx, 1, Math.min(3, s.colCount - at - 1));
      const res = await exec(ctx, "remove-cols", "sheet.command.remove-col-by-range", {
        unitId: ctx.unitId,
        subUnitId: s.id,
        range: colSpanRange(s, at, at + n - 1),
      });
      if (res.ok) s.colCount -= n;
      return res;
    },
  },
  {
    type: "insert-sheet",
    weight: 3,
    run: async (ctx) => {
      const res = await exec(ctx, "insert-sheet", "sheet.command.insert-sheet", {
        unitId: ctx.unitId,
        index: rnd(ctx, 0, ctx.sheets.length),
        sheet: { name: `X${numStr(ctx)}`, rowCount: 60, columnCount: 12 },
      });
      if (res.ok) {
        // 新 sheet id 从 mutation params 回读
        const m = res.mutations.find((x) => x.id === "sheet.mutation.insert-sheet");
        const sheetId = (m?.params as { sheet?: { id?: string } })?.sheet?.id;
        ctx.sheets.push({
          id: sheetId ?? `unknown_${ctx.sheets.length}`,
          name: `X`,
          rowCount: 60,
          colCount: 12,
        });
      }
      return res;
    },
  },
  {
    type: "remove-sheet",
    weight: 2,
    run: async (ctx) => {
      if (ctx.sheets.length <= 1) {
        return {
          opType: "remove-sheet",
          commandId: "-",
          ok: true,
          latencyMs: 0,
          mutations: [],
          mutationIds: [],
          params: {},
          paramsSerializable: true,
        } as OpResult;
      }
      const s = ctx.prng.pick(ctx.sheets);
      const res = await exec(ctx, "remove-sheet", "sheet.command.remove-sheet", {
        unitId: ctx.unitId,
        subUnitId: s.id,
      });
      if (res.ok) {
        ctx.sheets = ctx.sheets.filter((x) => x.id !== s.id);
        ctx.merges.delete(s.id);
        ctx.hiddenRows.delete(s.id);
        ctx.hiddenCols.delete(s.id);
        ctx.frozenSheets.delete(s.id);
        ctx.filterSheets.delete(s.id);
      }
      return res;
    },
  },
  {
    type: "rename-sheet",
    weight: 3,
    run: (ctx) => {
      const s = pickSheet(ctx);
      const name = `R_${numStr(ctx)}`;
      return exec(ctx, "rename-sheet", "sheet.command.set-worksheet-name", {
        unitId: ctx.unitId,
        subUnitId: s.id,
        name,
      }).then((res) => {
        if (res.ok) s.name = name;
        return res;
      });
    },
  },
  {
    type: "move-sheet",
    weight: 3,
    run: async (ctx) => {
      const s = pickSheet(ctx);
      const order = rnd(ctx, 0, ctx.sheets.length - 1);
      const res = await exec(ctx, "move-sheet", "sheet.command.set-worksheet-order", {
        unitId: ctx.unitId,
        subUnitId: s.id,
        order,
      });
      if (res.ok) {
        const idx = ctx.sheets.indexOf(s);
        ctx.sheets.splice(idx, 1);
        ctx.sheets.splice(order, 0, s);
      }
      return res;
    },
  },
  {
    type: "copy-sheet",
    weight: 2,
    run: async (ctx) => {
      const s = pickSheet(ctx);
      const res = await exec(ctx, "copy-sheet", "sheet.command.copy-sheet", {
        unitId: ctx.unitId,
        subUnitId: s.id,
      });
      if (res.ok) {
        const m = res.mutations.find((x) => x.id === "sheet.mutation.insert-sheet");
        const sheetId = (m?.params as { sheet?: { id?: string } })?.sheet?.id;
        ctx.sheets.push({
          id: sheetId ?? `copy_${ctx.sheets.length}`,
          name: "copy",
          rowCount: s.rowCount,
          colCount: s.colCount,
        });
      }
      return res;
    },
  },
  {
    type: "set-row-height",
    weight: 4,
    run: (ctx) => {
      const s = pickSheet(ctx);
      return exec(ctx, "set-row-height", "sheet.command.set-row-height", {
        unitId: ctx.unitId,
        subUnitId: s.id,
        ranges: [randRange(ctx, s, 8)],
        value: rnd(ctx, 15, 60),
      });
    },
  },
  {
    type: "set-col-width",
    weight: 4,
    run: (ctx) => {
      const s = pickSheet(ctx);
      return exec(ctx, "set-col-width", "sheet.command.set-worksheet-col-width", {
        unitId: ctx.unitId,
        subUnitId: s.id,
        ranges: [randRange(ctx, s, 8)],
        value: rnd(ctx, 40, 240),
      });
    },
  },
  {
    type: "hide-rows",
    weight: 3,
    run: async (ctx) => {
      const s = pickSheet(ctx);
      const range = randRange(ctx, s, 6);
      const res = await exec(ctx, "hide-rows", "sheet.command.set-rows-hidden", {
        unitId: ctx.unitId,
        subUnitId: s.id,
        ranges: [range],
      });
      if (res.ok) {
        const set = ctx.hiddenRows.get(s.id) ?? new Set<number>();
        for (let r = range.startRow; r <= range.endRow; r++) set.add(r);
        ctx.hiddenRows.set(s.id, set);
      }
      return res;
    },
  },
  {
    type: "show-rows",
    weight: 3,
    run: async (ctx) => {
      const s = pickSheet(ctx);
      const hidden = realHiddenRows(ctx, s);
      if (hidden.length === 0) {
        return {
          opType: "show-rows",
          commandId: "-",
          ok: true,
          latencyMs: 0,
          mutations: [],
          mutationIds: [],
          params: {},
          paramsSerializable: true,
        } as OpResult;
      }
      const rows = hidden.slice(0, 4);
      const ranges = rows.map((r) => ({
        startRow: r,
        startColumn: 0,
        endRow: r,
        endColumn: s.colCount - 1,
      }));
      const res = await exec(ctx, "show-rows", "sheet.command.set-specific-rows-visible", {
        unitId: ctx.unitId,
        subUnitId: s.id,
        ranges,
      });
      if (res.ok) {
        const set = ctx.hiddenRows.get(s.id) ?? new Set<number>();
        for (const r of rows) set.delete(r);
        ctx.hiddenRows.set(s.id, set);
      }
      return res;
    },
  },
  {
    type: "hide-cols",
    weight: 3,
    run: async (ctx) => {
      const s = pickSheet(ctx);
      const range = randRange(ctx, s, 4);
      const res = await exec(ctx, "hide-cols", "sheet.command.set-col-hidden", {
        unitId: ctx.unitId,
        subUnitId: s.id,
        ranges: [range],
      });
      if (res.ok) {
        const set = ctx.hiddenCols.get(s.id) ?? new Set<number>();
        for (let c = range.startColumn; c <= range.endColumn; c++) set.add(c);
        ctx.hiddenCols.set(s.id, set);
      }
      return res;
    },
  },
  {
    type: "show-cols",
    weight: 3,
    run: async (ctx) => {
      const s = pickSheet(ctx);
      const hidden = realHiddenCols(ctx, s);
      if (hidden.length === 0) {
        return {
          opType: "show-cols",
          commandId: "-",
          ok: true,
          latencyMs: 0,
          mutations: [],
          mutationIds: [],
          params: {},
          paramsSerializable: true,
        } as OpResult;
      }
      const cols = hidden.slice(0, 4);
      const ranges = cols.map((c) => ({
        startRow: 0,
        startColumn: c,
        endRow: s.rowCount - 1,
        endColumn: c,
      }));
      const res = await exec(ctx, "show-cols", "sheet.command.set-col-visible-on-cols", {
        unitId: ctx.unitId,
        subUnitId: s.id,
        ranges,
      });
      if (res.ok) {
        const set = ctx.hiddenCols.get(s.id) ?? new Set<number>();
        for (const c of cols) set.delete(c);
        ctx.hiddenCols.set(s.id, set);
      }
      return res;
    },
  },
  {
    type: "set-frozen",
    weight: 2,
    run: async (ctx) => {
      const s = pickSheet(ctx);
      const res = await exec(ctx, "set-frozen", "sheet.command.set-frozen", {
        unitId: ctx.unitId,
        subUnitId: s.id,
        startRow: rnd(ctx, 0, 4),
        startColumn: rnd(ctx, 0, 3),
        ySplit: rnd(ctx, 0, 2),
        xSplit: rnd(ctx, 0, 2),
      });
      if (res.ok) ctx.frozenSheets.add(s.id);
      return res;
    },
  },
  {
    type: "cancel-frozen",
    weight: 2,
    run: async (ctx) => {
      const candidates = ctx.sheets.filter((s) => ctx.frozenSheets.has(s.id));
      const s = candidates[0] ?? pickSheet(ctx);
      const res = await exec(ctx, "cancel-frozen", "sheet.command.cancel-frozen", {
        unitId: ctx.unitId,
        subUnitId: s.id,
      });
      if (res.ok) ctx.frozenSheets.delete(s.id);
      return res;
    },
  },
  {
    type: "clear-content",
    weight: 4,
    run: (ctx) => {
      const s = pickSheet(ctx);
      return exec(ctx, "clear-content", "sheet.command.clear-selection-content", {
        unitId: ctx.unitId,
        subUnitId: s.id,
        ranges: [randRange(ctx, s, 8)],
      });
    },
  },
  {
    type: "clear-format",
    weight: 3,
    run: (ctx) => {
      const s = pickSheet(ctx);
      return exec(ctx, "clear-format", "sheet.command.clear-selection-format", {
        unitId: ctx.unitId,
        subUnitId: s.id,
        ranges: [randRange(ctx, s, 8)],
      });
    },
  },
  {
    type: "clear-all",
    weight: 3,
    run: (ctx) => {
      const s = pickSheet(ctx);
      return exec(ctx, "clear-all", "sheet.command.clear-selection-all", {
        unitId: ctx.unitId,
        subUnitId: s.id,
        ranges: [randRange(ctx, s, 6)],
      });
    },
  },
  {
    type: "move-range",
    weight: 4,
    run: (ctx) => {
      const s = pickSheet(ctx);
      const from = randRange(ctx, s, 4);
      let dr = rnd(ctx, -10, 10);
      const dc = rnd(ctx, -3, 3);
      if (dr === 0 && dc === 0) dr = 5;
      const h = from.endRow - from.startRow;
      const w = from.endColumn - from.startColumn;
      const to = {
        startRow: Math.max(0, Math.min(s.rowCount - 1 - h, from.startRow + dr)),
        startColumn: Math.max(0, Math.min(s.colCount - 1 - w, from.startColumn + dc)),
        endRow: 0,
        endColumn: 0,
      };
      to.endRow = to.startRow + h;
      to.endColumn = to.startColumn + w;
      return exec(ctx, "move-range", "sheet.command.move-range", {
        fromRange: from,
        toRange: to,
        fromUnitId: ctx.unitId,
        fromSubUnitId: s.id,
        toUnitId: ctx.unitId,
        toSubUnitId: s.id,
      });
    },
  },
  {
    type: "move-rows",
    weight: 3,
    run: (ctx) => {
      const s = pickSheet(ctx);
      const r1 = rnd(ctx, 0, s.rowCount - 2);
      const r2 = rnd(ctx, 0, s.rowCount - 2);
      const sel = { ...rowSpanRange(s, r1, r1), unitId: ctx.unitId, subUnitId: s.id, rangeType: 1 };
      return exec(ctx, "move-rows", "sheet.command.move-rows", {
        unitId: ctx.unitId,
        subUnitId: s.id,
        range: sel,
        fromRange: rowSpanRange(s, r1, r1),
        toRange: rowSpanRange(s, r2, r2),
      });
    },
  },
  {
    type: "move-cols",
    weight: 3,
    run: (ctx) => {
      const s = pickSheet(ctx);
      const c1 = rnd(ctx, 0, s.colCount - 2);
      const c2 = rnd(ctx, 0, s.colCount - 2);
      const sel = { ...colSpanRange(s, c1, c1), unitId: ctx.unitId, subUnitId: s.id, rangeType: 2 };
      return exec(ctx, "move-cols", "sheet.command.move-cols", {
        unitId: ctx.unitId,
        subUnitId: s.id,
        range: sel,
        fromRange: colSpanRange(s, c1, c1),
        toRange: colSpanRange(s, c2, c2),
      });
    },
  },
  {
    type: "autofill",
    weight: 3,
    run: (ctx) => {
      const s = pickSheet(ctx);
      const r = rnd(ctx, 0, s.rowCount - 3);
      const c = rnd(ctx, 0, s.colCount - 1);
      const target = {
        startRow: r,
        startColumn: c,
        endRow: Math.min(s.rowCount - 1, r + rnd(ctx, 1, 6)),
        endColumn: c,
      };
      return exec(ctx, "autofill", "sheet.command.auto-fill", {
        unitId: ctx.unitId,
        subUnitId: s.id,
        sourceRange: { startRow: r, startColumn: c, endRow: r, endColumn: c },
        targetRange: target,
        applyType: ctx.prng.pick(["COPY", "SERIES"]),
      });
    },
  },
  {
    type: "sort-range",
    weight: 3,
    run: (ctx) => {
      const s = pickSheet(ctx);
      return exec(ctx, "sort-range", "sheet.command.sort-range", {
        unitId: ctx.unitId,
        subUnitId: s.id,
        range: randRange(ctx, s, 15),
        orderRules: [{ colIndex: 0, type: ctx.prng.pick(["asc", "desc"]) }],
        hasTitle: false,
      });
    },
  },
  {
    type: "set-filter",
    weight: 3,
    run: async (ctx) => {
      const s = pickSheet(ctx);
      const range = randRange(ctx, s, 30);
      const res = await exec(ctx, "set-filter", "sheet.command.set-filter-range", {
        unitId: ctx.unitId,
        subUnitId: s.id,
        range,
      });
      if (res.ok) ctx.filterSheets.set(s.id, range);
      return res;
    },
  },
  {
    type: "set-filter-criteria",
    weight: 3,
    run: (ctx) => {
      const candidates = ctx.sheets.filter((s) => ctx.filterSheets.has(s.id));
      if (candidates.length === 0) {
        return Promise.resolve({
          opType: "set-filter-criteria",
          commandId: "-",
          ok: true,
          latencyMs: 0,
          mutations: [],
          mutationIds: [],
          params: {},
          paramsSerializable: true,
        } as OpResult);
      }
      const s = ctx.prng.pick(candidates);
      const fr = ctx.filterSheets.get(s.id) as IRangeLite;
      const col = rnd(ctx, fr.startColumn, fr.endColumn);
      return exec(ctx, "set-filter-criteria", "sheet.command.set-filter-criteria", {
        unitId: ctx.unitId,
        subUnitId: s.id,
        col,
        criteria: { colId: col, filters: { filters: [`txt_${ctx.prng.int(0, 50)}`] } },
      });
    },
  },
  {
    type: "remove-filter",
    weight: 2,
    run: async (ctx) => {
      const candidates = ctx.sheets.filter((s) => ctx.filterSheets.has(s.id));
      if (candidates.length === 0) {
        return {
          opType: "remove-filter",
          commandId: "-",
          ok: true,
          latencyMs: 0,
          mutations: [],
          mutationIds: [],
          params: {},
          paramsSerializable: true,
        } as OpResult;
      }
      const s = ctx.prng.pick(candidates);
      const res = await exec(ctx, "remove-filter", "sheet.command.remove-sheet-filter", {
        unitId: ctx.unitId,
        subUnitId: s.id,
      });
      if (res.ok) ctx.filterSheets.delete(s.id);
      return res;
    },
  },
  {
    type: "add-cf",
    weight: 3,
    run: async (ctx) => {
      const s = pickSheet(ctx);
      const rid = `cf_${numStr(ctx)}`;
      const res = await exec(ctx, "add-cf", "sheet.command.add-conditional-rule", {
        unitId: ctx.unitId,
        subUnitId: s.id,
        rule: {
          rid,
          ranges: [randRange(ctx, s, 15)],
          cfId: "",
          stopIfTrue: false,
          rule: {
            type: "cellIs",
            operator: ctx.prng.pick(["greaterThan", "lessThan", "equal"]),
            formula: [String(rnd(ctx, 0, 500))],
            style: { bg: { rgb: ctx.prng.pick(["#ffcccc", "#ccffcc", "#ccccff"]) } },
          },
        },
      });
      if (res.ok) ctx.cfRuleIds.push(rid);
      return res;
    },
  },
  {
    type: "delete-cf",
    weight: 2,
    run: async (ctx) => {
      const s = pickSheet(ctx);
      const res = await exec(ctx, "delete-cf", "sheet.command.delete-conditional-rule", {
        unitId: ctx.unitId,
        subUnitId: s.id,
        cfId: ctx.cfRuleIds[0] ?? "nonexistent",
      });
      if (res.ok) ctx.cfRuleIds.shift();
      return res;
    },
  },
  {
    type: "add-dv",
    weight: 3,
    run: async (ctx) => {
      const s = pickSheet(ctx);
      const rid = `dv_${numStr(ctx)}`;
      const ranges = [randRange(ctx, s, 10)];
      const res = await exec(ctx, "add-dv", "sheet.command.addDataValidation", {
        unitId: ctx.unitId,
        subUnitId: s.id,
        rule: {
          uid: rid,
          type: ctx.prng.pick(["whole", "list", "decimal"]),
          operator: "between",
          formula1: "1",
          formula2: "100",
          ranges,
          ...(ctx.prng.chance(0.3)
            ? { formula1: undefined, formula2: undefined, list: ["a", "b", "c"] }
            : {}),
        },
      });
      if (res.ok) ctx.dvRules.push({ uid: rid, sheetId: s.id, ranges });
      return res;
    },
  },
  {
    type: "clear-dv",
    weight: 2,
    run: (ctx) => {
      const rule = ctx.dvRules[0];
      if (!rule || !ctx.sheets.some((s) => s.id === rule.sheetId)) {
        return Promise.resolve({
          opType: "clear-dv",
          commandId: "-",
          ok: true,
          latencyMs: 0,
          mutations: [],
          mutationIds: [],
          params: {},
          paramsSerializable: true,
        } as OpResult);
      }
      return exec(ctx, "clear-dv", "sheets.command.clear-range-data-validation", {
        unitId: ctx.unitId,
        subUnitId: rule.sheetId,
        ranges: rule.ranges,
      }).then((res) => {
        if (res.ok) ctx.dvRules.shift();
        return res;
      });
    },
  },
  {
    type: "copy-down",
    weight: 2,
    run: (ctx) => {
      const s = pickSheet(ctx);
      const r = rnd(ctx, 0, s.rowCount - 2);
      return exec(ctx, "copy-down", "sheet.command.copy-down", {
        unitId: ctx.unitId,
        subUnitId: s.id,
        ranges: [
          {
            startRow: r,
            startColumn: 0,
            endRow: Math.min(s.rowCount - 1, r + 3),
            endColumn: Math.min(5, s.colCount - 1),
          },
        ],
      });
    },
  },
];

const totalWeight = OPS.reduce((a, o) => a + o.weight, 0);

export function pickOp(prng: Prng): OpSpec {
  let roll = prng.next() * totalWeight;
  for (const op of OPS) {
    roll -= op.weight;
    if (roll <= 0) return op;
  }
  return OPS[OPS.length - 1] as OpSpec;
}

export { mutationMark };
