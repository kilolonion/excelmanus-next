// 文档读/写集区域与结构操作坐标变换（03 §6.1、07 §3.3）。
// RangeRef 为 0 基闭区间；整行/整列用 r1/c1 = 最大坐标。

import { formatRange, MAX_COL, MAX_ROW } from "./a1.ts";

export interface RangeRef {
  sheetId: string;
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

export const MAX_R = MAX_ROW - 1;
export const MAX_C = MAX_COL - 1;

export type StructuralKind =
  | "insertRows"
  | "deleteRows"
  | "insertCols"
  | "deleteCols"
  | "removeSheet"
  | "insertSheet"
  | "renameSheet"
  | "moveRange";

export interface StructuralOp {
  sheetId: string;
  kind: StructuralKind;
  /** 行/列操作的起始下标（0 基）；其余类型为 0。 */
  index: number;
  /** 行/列操作的条数；其余类型为 0。 */
  count: number;
}

/** 区域是否相交（同表才相交；"*" 是推导不出表时的通配）。 */
export function rangeIntersects(a: RangeRef, b: RangeRef): boolean {
  if (a.sheetId !== b.sheetId && a.sheetId !== "*" && b.sheetId !== "*") return false;
  return a.r0 <= b.r1 && b.r0 <= a.r1 && a.c0 <= b.c1 && b.c0 <= a.c1;
}

/** 相交区域；不相交/不同表返回 null。 */
export function rangeIntersection(a: RangeRef, b: RangeRef): RangeRef | null {
  if (!rangeIntersects(a, b)) return null;
  return {
    sheetId: a.sheetId === "*" ? b.sheetId : a.sheetId,
    r0: Math.max(a.r0, b.r0),
    c0: Math.max(a.c0, b.c0),
    r1: Math.min(a.r1, b.r1),
    c1: Math.min(a.c1, b.c1),
  };
}

/**
 * 按一条结构操作变换区域坐标（03 §6.1）。
 * - 插入：起点 ≥ index 的整段平移；跨越插入点的区域随之下边界扩展。
 * - 删除：完全落在被删区 → "deleted"；部分重叠 → 收缩；整体在被删区之后 → 平移。
 * - removeSheet：该表所有区域 → "deleted"。
 * - insertSheet / renameSheet / moveRange 不改变坐标（moveRange 在 M2a 不生成）。
 */
export function transformRange(range: RangeRef, op: StructuralOp): RangeRef | "deleted" {
  if (range.sheetId !== op.sheetId) return range;
  switch (op.kind) {
    case "removeSheet":
      return "deleted";
    case "insertSheet":
    case "renameSheet":
    case "moveRange":
      return range;
    case "insertRows": {
      if (range.r0 >= op.index) {
        return { ...range, r0: range.r0 + op.count, r1: range.r1 + op.count };
      }
      if (range.r1 >= op.index) return { ...range, r1: range.r1 + op.count };
      return range;
    }
    case "insertCols": {
      if (range.c0 >= op.index) {
        return { ...range, c0: range.c0 + op.count, c1: range.c1 + op.count };
      }
      if (range.c1 >= op.index) return { ...range, c1: range.c1 + op.count };
      return range;
    }
    case "deleteRows":
      return transformDelete(range, op.index, op.count, "row");
    case "deleteCols":
      return transformDelete(range, op.index, op.count, "col");
  }
}

function transformDelete(
  range: RangeRef,
  index: number,
  count: number,
  axis: "row" | "col",
): RangeRef | "deleted" {
  const s0 = axis === "row" ? range.r0 : range.c0;
  const s1 = axis === "row" ? range.r1 : range.c1;
  const d0 = index;
  const d1 = index + count - 1;
  let n0: number;
  let n1: number;
  if (s1 < d0) {
    n0 = s0;
    n1 = s1;
  } else if (s0 > d1) {
    n0 = s0 - count;
    n1 = s1 - count;
  } else if (s0 >= d0 && s1 <= d1) {
    return "deleted";
  } else {
    // 部分重叠：幸存段 = [s0, d0) 原位 + (d1, s1] 上移 count
    n0 = s0 < d0 ? s0 : d0;
    n1 = s1 > d1 ? s1 - count : d0 - 1;
  }
  if (axis === "row") return { ...range, r0: n0, r1: n1 };
  return { ...range, c0: n0, c1: n1 };
}

/** 0 基 RangeRef → A1 记法（工作表名由调用方解析；不传则只输出区域）。 */
export function rangeRefToA1(ref: RangeRef, sheetName?: string): string {
  return formatRange({
    ...(sheetName !== undefined ? { sheet: sheetName } : {}),
    startRow: ref.r0 + 1,
    startCol: ref.c0 + 1,
    endRow: ref.r1 + 1,
    endCol: ref.c1 + 1,
  });
}

/** RangeRef 覆盖的单元格数（无界区域返回 Infinity）。 */
export function rangeArea(r: RangeRef): number {
  return (r.r1 - r.r0 + 1) * (r.c1 - r.c0 + 1);
}
