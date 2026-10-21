import type { IWorksheetData } from "@univerjs/core";
import { expect, test } from "vitest";
import { importCsv } from "../src/csv.ts";
import { buildLayout, displayText } from "../src/render.ts";

test.each([
  [1234.5, "¥#,##0.00;(¥#,##0.00)", "¥1,234.50"],
  [-56.7, "¥#,##0.00;(¥#,##0.00)", "(¥56.70)"],
  [0, "¥#,##0.00;(¥#,##0.00)", "¥0.00"],
  [1234.5, '"¥"#,##0.00;("¥"#,##0.00)', "¥1,234.50"],
  [-56.7, '"¥"#,##0.00;("¥"#,##0.00)', "(¥56.70)"],
  [7, "00000", "00007"],
  [0.125, "0.0%", "12.5%"],
  [0, '0.00;(0.00);"—"', "—"],
  [1500000, '0.0,,"M"', "1.5M"],
  [45351, "yyyy-mm-dd", "2024-02-29"],
  [0.5, "hh:mm", "12:00"],
])("renders %s using Excel pattern %s", (value, pattern, expected) => {
  expect(displayText(value, pattern)).toBe(expected);
});
test("formatted layout preserves numeric values", () => {
  const { snapshot } = importCsv(new TextEncoder().encode("n\n7\n"), "a.csv");
  const sheet = snapshot.sheets[snapshot.sheetOrder[0]!] as IWorksheetData;
  sheet.cellData![1]![0]!.s = { n: { pattern: "00000" } };
  const result = buildLayout(snapshot, sheet, "A1:A2");
  expect(result.layout.cells.some((c) => c.text === "00007")).toBe(true);
  expect(sheet.cellData![1]![0]!.v).toBe(7);
});
test("unsupported format reports a limitation instead of breaking the screenshot", () => {
  const { snapshot } = importCsv(new TextEncoder().encode("n\n7\n"), "a.csv");
  const sheet = snapshot.sheets[snapshot.sheetOrder[0]!] as IWorksheetData;
  sheet.cellData![1]![0]!.s = { n: { pattern: "[broken" } };
  const result = buildLayout(snapshot, sheet, "A1:A2");
  expect(result.layout.cells.some((c) => c.text === "7")).toBe(true);
  expect(result.limitations.join(" ")).toContain("数字格式无法解析");
});

test.each([
  [-2500.5, '#,##0.00;[Red](#,##0.00);"-"', "#ff0000"],
  [12, "[Blue][>=10]0;[Red][<0]0;0", "#0000ff"],
  [0, "[Blue][>=10]0;[Red][<0]0;0", "#123456"],
  [7, "[Color10]0", "#008000"],
  [7, '"[Red]"0', "#123456"],
])("renders number-format color for %s / %s", (value, pattern, color) => {
  const { snapshot } = importCsv(new TextEncoder().encode("n\n7\n"), "a.csv");
  const sheet = snapshot.sheets[snapshot.sheetOrder[0]!] as IWorksheetData;
  const cell = sheet.cellData![1]![0]!;
  cell.v = value;
  cell.s = { n: { pattern }, cl: { rgb: "#123456" } };
  const result = buildLayout(snapshot, sheet, "A2:A2");
  expect(result.layout.cells.find((c) => c.text === displayText(value, pattern))?.color).toBe(
    color,
  );
  expect(cell.v).toBe(value);
  expect(cell.s.cl?.rgb).toBe("#123456");
});
