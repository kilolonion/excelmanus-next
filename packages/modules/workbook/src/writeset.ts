// 写集推导（07 §3.3）：mutation(id+params) → 受影响区域 RangeRef[] 与结构操作。
// 移植自 spikes/univer-model writeset.ts：缺省维度 = 全维（尾部区间），
// 推导不出的表用 sheetId "*"（与任何表都判相交，保守）。

import { MAX_C, MAX_R, type RangeRef, type StructuralOp } from "@excelmanus/core";
import type { DocMutation } from "./engine.ts";

type P = Record<string, unknown>;
const numKeys = (o: unknown): number[] =>
  o && typeof o === "object"
    ? Object.keys(o as P)
        .map(Number)
        .filter((n) => Number.isFinite(n))
    : [];

interface R {
  startRow: number;
  startColumn: number;
  endRow: number;
  endColumn: number;
}
const asRanges = (v: unknown): R[] => (Array.isArray(v) ? (v as R[]) : v ? [v as R] : []);

export interface DerivedWriteSet {
  ranges: RangeRef[];
  structural: StructuralOp[];
}

const fromRanges = (sheetId: string, ranges: R[]): RangeRef[] =>
  ranges.map((r) => ({
    sheetId,
    r0: r.startRow,
    c0: r.startColumn,
    r1: r.endRow,
    c1: r.endColumn,
  }));

/** ObjectMatrix {row:{col:cell}} → 最小包围矩形；空矩阵 = 整表。 */
const matrixRegion = (sheetId: string, matrix: unknown): RangeRef[] => {
  const rows = numKeys(matrix);
  if (rows.length === 0) return [{ sheetId, r0: 0, c0: 0, r1: MAX_R, c1: MAX_C }];
  const m = matrix as Record<string, Record<string, unknown>>;
  let r0 = Infinity;
  let r1 = -Infinity;
  let c0 = Infinity;
  let c1 = -Infinity;
  for (const r of rows) {
    r0 = Math.min(r0, r);
    r1 = Math.max(r1, r);
    for (const c of numKeys(m[String(r)])) {
      c0 = Math.min(c0, c);
      c1 = Math.max(c1, c);
    }
  }
  return [{ sheetId, r0, c0, r1, c1 }];
};

/** 行/列插删写集 = [index, 表尾) × 全维（坐标空间整体平移，影响所有下游区域）。 */
const rowTail = (sheetId: string, fromRow: number): RangeRef => ({
  sheetId,
  r0: fromRow,
  c0: 0,
  r1: MAX_R,
  c1: MAX_C,
});
const colTail = (sheetId: string, fromCol: number): RangeRef => ({
  sheetId,
  r0: 0,
  c0: fromCol,
  r1: MAX_R,
  c1: MAX_C,
});
const wholeSheet = (sheetId: string): RangeRef => ({
  sheetId,
  r0: 0,
  c0: 0,
  r1: MAX_R,
  c1: MAX_C,
});

/** 单条 mutation → 写集（区域 + 结构操作）。 */
export function deriveWriteSet(m: DocMutation): DerivedWriteSet {
  const q = (m.params ?? {}) as P;
  const sub = String(q.subUnitId ?? "") || "*";
  switch (m.id) {
    case "sheet.mutation.set-range-values":
      return { ranges: matrixRegion(sub, q.cellValue), structural: [] };
    case "sheet.mutation.insert-row": {
      const r = (q.range ?? {}) as R;
      return {
        ranges: [rowTail(sub, r.startRow ?? 0)],
        structural: [
          {
            sheetId: sub,
            kind: "insertRows",
            index: r.startRow ?? 0,
            count: Math.max(1, (r.endRow ?? 0) - (r.startRow ?? 0) + 1),
          },
        ],
      };
    }
    case "sheet.mutation.remove-rows": {
      const r = (q.range ?? {}) as R;
      return {
        ranges: [rowTail(sub, r.startRow ?? 0)],
        structural: [
          {
            sheetId: sub,
            kind: "deleteRows",
            index: r.startRow ?? 0,
            count: Math.max(1, (r.endRow ?? 0) - (r.startRow ?? 0) + 1),
          },
        ],
      };
    }
    case "sheet.mutation.insert-col": {
      const r = (q.range ?? {}) as R;
      return {
        ranges: [colTail(sub, r.startColumn ?? 0)],
        structural: [
          {
            sheetId: sub,
            kind: "insertCols",
            index: r.startColumn ?? 0,
            count: Math.max(1, (r.endColumn ?? 0) - (r.startColumn ?? 0) + 1),
          },
        ],
      };
    }
    case "sheet.mutation.remove-col": {
      const r = (q.range ?? {}) as R;
      return {
        ranges: [colTail(sub, r.startColumn ?? 0)],
        structural: [
          {
            sheetId: sub,
            kind: "deleteCols",
            index: r.startColumn ?? 0,
            count: Math.max(1, (r.endColumn ?? 0) - (r.startColumn ?? 0) + 1),
          },
        ],
      };
    }
    case "sheet.mutation.move-rows": {
      const s = (q.sourceRange ?? {}) as R;
      const t = (q.targetRange ?? {}) as R;
      const index = Math.min(s.startRow ?? 0, t.startRow ?? 0);
      const end = Math.max(s.endRow ?? 0, t.endRow ?? 0);
      return {
        ranges: [{ sheetId: sub, r0: index, c0: 0, r1: end, c1: MAX_C }],
        structural: [{ sheetId: sub, kind: "moveRange", index, count: end - index + 1 }],
      };
    }
    case "sheet.mutation.move-columns": {
      const s = (q.sourceRange ?? {}) as R;
      const t = (q.targetRange ?? {}) as R;
      const index = Math.min(s.startColumn ?? 0, t.startColumn ?? 0);
      const end = Math.max(s.endColumn ?? 0, t.endColumn ?? 0);
      return {
        ranges: [{ sheetId: sub, r0: 0, c0: index, r1: MAX_R, c1: end }],
        structural: [{ sheetId: sub, kind: "moveRange", index, count: end - index + 1 }],
      };
    }
    case "sheet.mutation.move-range": {
      const from = ((q.from ?? {}) as P).subUnitId as string | undefined;
      const to = ((q.to ?? {}) as P).subUnitId as string | undefined;
      return {
        ranges: [
          ...fromRanges(from || sub, asRanges(q.fromRange)),
          ...fromRanges(to || sub, asRanges(q.toRange)),
        ],
        structural: [{ sheetId: sub, kind: "moveRange", index: 0, count: 0 }],
      };
    }
    case "sheet.mutation.reorder-range":
      return { ranges: fromRanges(sub, asRanges(q.range)), structural: [] };
    case "sheet.mutation.set-worksheet-row-height":
    case "sheet.mutation.set-worksheet-row-is-auto-height":
    case "sheet.mutation.set-row-hidden":
    case "sheet.mutation.set-row-visible":
    case "sheet.mutation.set-worksheet-col-width":
    case "sheet.mutation.set-col-hidden":
    case "sheet.mutation.set-col-visible":
      return { ranges: fromRanges(sub, asRanges(q.ranges)), structural: [] };
    case "sheet.mutation.set-frozen":
      return { ranges: [], structural: [] };
    case "sheet.mutation.add-worksheet-merge":
    case "sheet.mutation.remove-worksheet-merge":
      return { ranges: fromRanges(sub, asRanges(q.ranges)), structural: [] };
    case "sheet.mutation.set-worksheet-name":
      return {
        ranges: [],
        structural: [{ sheetId: sub, kind: "renameSheet", index: 0, count: 0 }],
      };
    case "sheet.mutation.set-worksheet-order":
      return { ranges: [], structural: [] };
    case "sheet.mutation.insert-sheet": {
      const sheet = (q.sheet ?? {}) as P;
      const sid = String(sheet.id ?? "*");
      return {
        ranges: [wholeSheet(sid)],
        structural: [{ sheetId: sid, kind: "insertSheet", index: 0, count: 0 }],
      };
    }
    case "sheet.mutation.remove-sheet":
      return {
        ranges: [wholeSheet(sub)],
        structural: [{ sheetId: sub, kind: "removeSheet", index: 0, count: 0 }],
      };
    case "sheet.mutation.set-filter-range":
    case "sheet.mutation.remove-filter":
      return { ranges: fromRanges(sub, asRanges(q.range)), structural: [] };
    case "sheet.mutation.set-filter-criteria":
    case "sheet.mutation.mark-dirty-filter-change":
      return { ranges: [wholeSheet(sub)], structural: [] };
    case "sheet.mutation.re-calc-filter":
      return { ranges: [wholeSheet(sub === "" ? "*" : sub)], structural: [] };
    case "sheet.mutation.add-conditional-rule":
    case "sheet.mutation.delete-conditional-rule":
    case "sheet.mutation.set-conditional-rule":
    case "sheet.mutation.move-conditional-rule":
      return { ranges: [wholeSheet(sub)], structural: [] };
    case "data-validation.mutation.addRule":
    case "data-validation.mutation.updateRule":
    case "data-validation.mutation.removeRule":
      return { ranges: [wholeSheet(sub)], structural: [] };
    case "formula.mutation.set-formula-data": {
      const ranges: RangeRef[] = [];
      const fd = (q.formulaData ?? {}) as P;
      for (const sheetMap of Object.values(fd)) {
        for (const [sid, rows] of Object.entries(sheetMap as P)) {
          ranges.push(...matrixRegion(sid, rows));
        }
      }
      return { ranges, structural: [] };
    }
    case "formula.mutation.set-array-formula-data": {
      const ranges: RangeRef[] = [];
      for (const key of ["arrayFormulaRange", "arrayFormulaCellData"] as const) {
        const afd = (q[key] ?? {}) as P;
        for (const perUnit of Object.values(afd)) {
          for (const [sid, v] of Object.entries(perUnit as P)) {
            ranges.push(...matrixRegion(sid, v));
          }
        }
      }
      return { ranges, structural: [] };
    }
    case "formula.mutation.set-trigger-formula-calculation-start": {
      const ranges: RangeRef[] = [];
      for (const d of (q.dirtyRanges as Array<P>) ?? []) {
        const sid = String(d.sheetId ?? sub);
        ranges.push(...fromRanges(sid, asRanges(d.range)));
      }
      return { ranges, structural: [] };
    }
    default:
      // 公式计算结果通知/未登记的 id：保守整表
      return { ranges: [wholeSheet(sub === "" ? "*" : sub)], structural: [] };
  }
}

export function deriveWriteSetAll(mutations: DocMutation[]): DerivedWriteSet {
  const ranges: RangeRef[] = [];
  const structural: StructuralOp[] = [];
  for (const m of mutations) {
    const d = deriveWriteSet(m);
    ranges.push(...d.ranges);
    structural.push(...d.structural);
  }
  return { ranges, structural };
}
