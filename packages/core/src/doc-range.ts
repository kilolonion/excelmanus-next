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
    case "insertRows":
      return transformInsert(range, op.index, op.count, "row");
    case "insertCols":
      return transformInsert(range, op.index, op.count, "col");
    case "deleteRows":
      return transformDelete(range, op.index, op.count, "row");
    case "deleteCols":
      return transformDelete(range, op.index, op.count, "col");
  }
}

// 整行/整列（该轴从 0 到上限）不随该轴的插入/删除变化；到上限的区域插入/删除后仍到上限，
// 被挤出上限之外的区域视为删除（P1-37）。
function transformInsert(
  range: RangeRef,
  index: number,
  count: number,
  axis: "row" | "col",
): RangeRef | "deleted" {
  const max = axis === "row" ? MAX_R : MAX_C;
  const s0 = axis === "row" ? range.r0 : range.c0;
  const s1 = axis === "row" ? range.r1 : range.c1;
  if ((s0 === 0 && s1 === max) || s1 < index) return range;
  const n0 = s0 >= index ? s0 + count : s0;
  if (n0 > max) return "deleted";
  const n1 = s1 === max ? max : Math.min(s1 + count, max);
  if (axis === "row") return { ...range, r0: n0, r1: n1 };
  return { ...range, c0: n0, c1: n1 };
}

function transformDelete(
  range: RangeRef,
  index: number,
  count: number,
  axis: "row" | "col",
): RangeRef | "deleted" {
  const max = axis === "row" ? MAX_R : MAX_C;
  const s0 = axis === "row" ? range.r0 : range.c0;
  const s1 = axis === "row" ? range.r1 : range.c1;
  if (s0 === 0 && s1 === max) return range;
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
  if (s1 === max) n1 = max;
  if (axis === "row") return { ...range, r0: n0, r1: n1 };
  return { ...range, c0: n0, c1: n1 };
}

/** 依次应用多条结构操作；任一步 "deleted" 即删除。 */
export function transformRangeAll(
  range: RangeRef,
  ops: readonly StructuralOp[],
): RangeRef | "deleted" {
  let cur = range;
  for (const op of ops) {
    const t = transformRange(cur, op);
    if (t === "deleted") return "deleted";
    cur = t;
  }
  return cur;
}

/**
 * 结构操作是否改动区域内部（区域不能整体平移）：删除与区域在该轴上重叠，
 * 或插入点严格落在区域内部。整行/整列区域只受删除影响。
 */
export function structuralTouchesInterior(range: RangeRef, op: StructuralOp): boolean {
  if (range.sheetId !== op.sheetId) return false;
  const rowAxis = op.kind === "insertRows" || op.kind === "deleteRows";
  if (!rowAxis && op.kind !== "insertCols" && op.kind !== "deleteCols") return false;
  const s0 = rowAxis ? range.r0 : range.c0;
  const s1 = rowAxis ? range.r1 : range.c1;
  const max = rowAxis ? MAX_R : MAX_C;
  if (op.kind === "deleteRows" || op.kind === "deleteCols")
    return s0 <= op.index + op.count - 1 && op.index <= s1;
  if (s0 === 0 && s1 === max) return false;
  return op.index > s0 && op.index <= s1;
}

/** a 是否完整包含 b（同表；"*" 通配）。 */
export function rangeContains(a: RangeRef, b: RangeRef): boolean {
  if (a.sheetId !== b.sheetId && a.sheetId !== "*") return false;
  return a.r0 <= b.r0 && a.c0 <= b.c0 && a.r1 >= b.r1 && a.c1 >= b.c1;
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
