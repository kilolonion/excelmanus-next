import { describe, expect, test } from "vitest";
import {
  MAX_C,
  MAX_R,
  type RangeRef,
  type StructuralOp,
  transformRange,
} from "../src/doc-range.ts";

const S = "s1";
const r = (r0: number, c0: number, r1: number, c1: number, sheetId = S): RangeRef => ({
  sheetId,
  r0,
  c0,
  r1,
  c1,
});

describe("transformRange", () => {
  test("插入行：起点 ≥ index 的区间整体平移", () => {
    const op: StructuralOp = { sheetId: S, kind: "insertRows", index: 5, count: 3 };
    expect(transformRange(r(5, 0, 8, 2), op)).toEqual(r(8, 0, 11, 2));
    expect(transformRange(r(10, 0, 12, 2), op)).toEqual(r(13, 0, 15, 2));
  });

  test("插入行：插入点之前的区间不动；跨插入点的区间下界扩展", () => {
    const op: StructuralOp = { sheetId: S, kind: "insertRows", index: 5, count: 2 };
    expect(transformRange(r(0, 0, 4, 2), op)).toEqual(r(0, 0, 4, 2));
    expect(transformRange(r(2, 0, 8, 2), op)).toEqual(r(2, 0, 10, 2));
  });

  test("插入列同理", () => {
    const op: StructuralOp = { sheetId: S, kind: "insertCols", index: 2, count: 1 };
    expect(transformRange(r(0, 2, 5, 6), op)).toEqual(r(0, 3, 5, 7));
    expect(transformRange(r(0, 0, 5, 4), op)).toEqual(r(0, 0, 5, 5));
  });

  test("删除行：完全覆盖 → deleted；之后 → 平移", () => {
    const op: StructuralOp = { sheetId: S, kind: "deleteRows", index: 5, count: 3 };
    expect(transformRange(r(5, 0, 7, 2), op)).toBe("deleted");
    expect(transformRange(r(6, 0, 6, 2), op)).toBe("deleted");
    expect(transformRange(r(10, 0, 12, 2), op)).toEqual(r(7, 0, 9, 2));
  });

  test("删除行：部分重叠收缩", () => {
    const op: StructuralOp = { sheetId: S, kind: "deleteRows", index: 5, count: 3 };
    // [3,6] 删 [5,7] → 幸存 [3,4]
    expect(transformRange(r(3, 0, 6, 2), op)).toEqual(r(3, 0, 4, 2));
    // [6,10] 删 [5,7] → 幸存 [8,10]→[5,7]
    expect(transformRange(r(6, 0, 10, 2), op)).toEqual(r(5, 0, 7, 2));
    // [3,10] 删 [5,7] → [3,7]
    expect(transformRange(r(3, 0, 10, 2), op)).toEqual(r(3, 0, 7, 2));
    // [5,10] → [5,7]
    expect(transformRange(r(5, 0, 10, 2), op)).toEqual(r(5, 0, 7, 2));
  });

  test("删除列同理", () => {
    const op: StructuralOp = { sheetId: S, kind: "deleteCols", index: 1, count: 2 };
    expect(transformRange(r(0, 1, 4, 2), op)).toBe("deleted");
    expect(transformRange(r(0, 0, 4, 5), op)).toEqual(r(0, 0, 4, 3));
  });

  test("removeSheet：该表所有区域 deleted；其他表不受影响", () => {
    const op: StructuralOp = { sheetId: S, kind: "removeSheet", index: 0, count: 0 };
    expect(transformRange(r(0, 0, MAX_R, MAX_C), op)).toBe("deleted");
    expect(transformRange(r(0, 0, 1, 1, "other"), op)).toEqual(r(0, 0, 1, 1, "other"));
  });

  test("renameSheet/insertSheet 不改坐标", () => {
    const region = r(1, 1, 2, 2);
    expect(transformRange(region, { sheetId: S, kind: "renameSheet", index: 0, count: 0 })).toEqual(
      region,
    );
    expect(transformRange(region, { sheetId: S, kind: "insertSheet", index: 0, count: 0 })).toEqual(
      region,
    );
  });
});
