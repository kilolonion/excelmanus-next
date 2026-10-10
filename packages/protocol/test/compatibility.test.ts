import { expect, test } from "vitest";
import { protocolCompatible, protocolVersion, SheetObjectsMutation } from "../src/index.ts";

test("对象层协议要求匹配版本，原始对象 mutation 的 images 字段兼容缺省", () => {
  expect(protocolVersion).toBe(2);
  expect(protocolCompatible(2)).toBe(true);
  expect(protocolCompatible(1)).toBe(false);
  expect(protocolCompatible(3)).toBe(false);
  expect(
    SheetObjectsMutation.parse({ unitId: "w", subUnitId: "s", objects: { charts: [] } }).objects
      .images,
  ).toEqual([]);
});
