// A1 区域解析与运算（06 §4）：易错纯逻辑的单测。

import { describe, expect, test } from "vitest";
import {
  colToIndex,
  formatRange,
  indexToCol,
  intersection,
  intersects,
  parseRange,
  union,
} from "../src/index.ts";

describe("A1 解析", () => {
  test("单格 / 区域 / 工作表前缀", () => {
    expect(parseRange("B2")).toEqual({
      startCol: 2,
      startRow: 2,
      endCol: 2,
      endRow: 2,
    });
    expect(parseRange("Sheet1!A1:D20")).toEqual({
      sheet: "Sheet1",
      startCol: 1,
      startRow: 1,
      endCol: 4,
      endRow: 20,
    });
    expect(parseRange("'我的 表'!C3:D4")).toEqual({
      sheet: "我的 表",
      startCol: 3,
      startRow: 3,
      endCol: 4,
      endRow: 4,
    });
  });

  test("整列 / 整行 / 反向区间归一", () => {
    expect(parseRange("A:C")).toMatchObject({ startCol: 1, endCol: 3, startRow: 1 });
    expect(parseRange("3:7")).toMatchObject({ startRow: 3, endRow: 7, startCol: 1 });
    expect(parseRange("D20:A1")).toMatchObject({
      startCol: 1,
      startRow: 1,
      endCol: 4,
      endRow: 20,
    });
  });

  test("非法输入抛错", () => {
    expect(() => parseRange("")).toThrow();
    expect(() => parseRange("A0")).toThrow();
    expect(() => parseRange("XFE1")).toThrow();
    expect(() => parseRange("A1:")).toThrow();
  });

  test("列名转换", () => {
    expect(colToIndex("A")).toBe(1);
    expect(colToIndex("Z")).toBe(26);
    expect(colToIndex("AA")).toBe(27);
    expect(colToIndex("XFD")).toBe(16384);
    expect(indexToCol(1)).toBe("A");
    expect(indexToCol(27)).toBe("AA");
    expect(indexToCol(16384)).toBe("XFD");
  });
});

describe("区域运算", () => {
  test("intersects / intersection", () => {
    const a = parseRange("A1:C10");
    const b = parseRange("B5:D20");
    const c = parseRange("E1:F2");
    expect(intersects(a, b)).toBe(true);
    expect(intersects(a, c)).toBe(false);
    expect(intersection(a, b)).toMatchObject({
      startCol: 2,
      startRow: 5,
      endCol: 3,
      endRow: 10,
    });
    expect(intersection(a, c)).toBeNull();
  });

  test("不同工作表不相交", () => {
    const a = parseRange("S1!A1:B2");
    const b = parseRange("S2!A1:B2");
    expect(intersects(a, b)).toBe(false);
    expect(union(a, b)).toBeNull();
  });

  test("union 覆盖最小矩形；未指明工作表视为同表", () => {
    const u = union(parseRange("A1:B2"), parseRange("Sheet1!C3:D4"));
    expect(u).toMatchObject({
      startCol: 1,
      startRow: 1,
      endCol: 4,
      endRow: 4,
    });
    if (!u) throw new Error("union 返回 null");
    expect(formatRange(u)).toBe("Sheet1!A1:D4");
  });

  test("formatRange 往返", () => {
    expect(formatRange(parseRange("Sheet1!A1:D20"))).toBe("Sheet1!A1:D20");
    expect(formatRange(parseRange("B2"))).toBe("B2");
    expect(formatRange(parseRange("A:C"))).toBe("A:C");
  });
});
