import { expect, test } from "vitest";
import { parseZoomPercent } from "../src/lib/workbook/zoom";
test("zoom input accepts a complete percentage and rejects incomplete text", () => {
  expect(parseZoomPercent("80%")).toBe(80);
  expect(parseZoomPercent(" 125 ")).toBe(125);
  expect(parseZoomPercent("")).toBeNull();
  expect(parseZoomPercent("abc")).toBeNull();
  expect(parseZoomPercent("0")).toBe(10);
  expect(parseZoomPercent("800")).toBe(400);
});
