import { describe, expect, test } from "vitest";
import {
  MAX_C,
  MAX_R,
  type RangeRef,
  type StructuralOp,
  structuralTouchesInterior,
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

  test("整行/整列与到上限的区域：插入/删除后不越界（P1-37）", () => {
    const insC: StructuralOp = { sheetId: S, kind: "insertCols", index: 0, count: 1 };
    const insR: StructuralOp = { sheetId: S, kind: "insertRows", index: 0, count: 1 };
    // 整行 1:1 插列后仍是整行；整列 B:B 插行后仍是整列
    expect(transformRange(r(0, 0, 0, MAX_C), insC)).toEqual(r(0, 0, 0, MAX_C));
    expect(transformRange(r(0, 1, MAX_R, 1), insR)).toEqual(r(0, 1, MAX_R, 1));
    // 整列 B:B 插列 → C:C；整行插行 → 下移一行
    expect(transformRange(r(0, 1, MAX_R, 1), insC)).toEqual(r(0, 2, MAX_R, 2));
    // 到上限的尾部区域保持到上限
    expect(transformRange(r(3, 0, MAX_R, 2), insR)).toEqual(r(4, 0, MAX_R, 2));
    // 被挤出上限 → deleted
    expect(transformRange(r(MAX_R, 0, MAX_R, 0), insR)).toBe("deleted");
    // 跨插入点的有界区域夹紧
    expect(transformRange(r(MAX_R - 1, 0, MAX_R - 1, 0), insR)).toEqual(r(MAX_R, 0, MAX_R, 0));
    const delR: StructuralOp = { sheetId: S, kind: "deleteRows", index: 2, count: 3 };
    expect(transformRange(r(0, 1, MAX_R, 1), delR)).toEqual(r(0, 1, MAX_R, 1));
    expect(transformRange(r(1, 0, MAX_R, 0), delR)).toEqual(r(1, 0, MAX_R, 0));
  });
  test("structuralTouchesInterior：内部插入/删除才算", () => {
    const region = r(2, 0, 8, 0);
    const at = (kind: StructuralOp["kind"], index: number, count = 1): StructuralOp => ({
      sheetId: S,
      kind,
      index,
      count,
    });
    expect(structuralTouchesInterior(region, at("insertRows", 2))).toBe(false);
    expect(structuralTouchesInterior(region, at("insertRows", 3))).toBe(true);
    expect(structuralTouchesInterior(region, at("insertRows", 9))).toBe(false);
    expect(structuralTouchesInterior(region, at("deleteRows", 0, 2))).toBe(false);
    expect(structuralTouchesInterior(region, at("deleteRows", 1, 2))).toBe(true);
    expect(structuralTouchesInterior(region, at("deleteCols", 1, 2))).toBe(false);
    expect(structuralTouchesInterior(r(0, 1, MAX_R, 1), at("insertRows", 5))).toBe(false);
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
