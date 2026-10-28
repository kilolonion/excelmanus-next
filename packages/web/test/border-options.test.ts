import { expect, test } from "vitest";
import { borderValue } from "../src/lib/workbook/border-options.ts";

test("边框使用所选线型及自定义颜色，清除边框不依赖颜色输入", () => {
  expect(borderValue("outside", 9, " 12abef ")).toEqual({
    type: "outside",
    style: 9,
    color: "#12ABEF",
  });
  expect(borderValue("bottom", 7, "#123")).toEqual({ type: "bottom", style: 7, color: "#112233" });
  expect(borderValue("all", 1, "red")).toBeNull();
  expect(borderValue("none", 1, "bad")).toEqual({ type: "none", style: 1, color: "#000000" });
});
