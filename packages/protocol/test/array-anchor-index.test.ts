import { expect, test, vi } from "vitest";
import { type ArrayFormula, effectiveArraysFromSheet } from "../src/array-formulas.ts";

const range = (row: number, col = 0) => ({
  startRow: row,
  endRow: row + 1,
  startColumn: col,
  endColumn: col,
});
const dynamic = (id: string, row: number): ArrayFormula => ({
  id,
  mode: "dynamic",
  formula: "=OLD()",
  range: range(row),
});

test("large spill lists do not scan all dynamic arrays for every anchor", () => {
  const arrays = Array.from({ length: 1000 }, (_, i) => dynamic(String(i), i * 2));
  const sheet = {
    custom: { excelmanusArrays: arrays },
    cellData: Object.fromEntries(
      arrays.map((a) => [a.range.startRow, { 0: { f: "=SEQUENCE(2)" } }]),
    ),
  };
  const ranges = Object.fromEntries(arrays.map((a) => [a.range.startRow, { 0: a.range }]));
  const original = Array.prototype.find;
  let comparisons = 0;
  const spy = vi.spyOn(Array.prototype, "find").mockImplementation(function (
    this: unknown[],
    predicate,
    thisArg,
  ) {
    return original.call(this, (value, index, list) => {
      comparisons++;
      return predicate.call(thisArg, value, index, list);
    });
  });
  try {
    const result = effectiveArraysFromSheet(sheet, ranges);
    expect(result).toHaveLength(1000);
    expect(result[999]).toMatchObject({ id: "999", formula: "=SEQUENCE(2)" });
    expect(comparisons).toBeLessThan(10000);
  } finally {
    spy.mockRestore();
  }
});

test("duplicate registered anchors retain first-match updates and original list order", () => {
  const arrays = [
    dynamic("first", 0),
    dynamic("second", 0),
    { ...dynamic("fixed", 4), mode: "fixed" as const },
  ];
  const sheet = { custom: { excelmanusArrays: arrays }, cellData: { 0: { 0: { f: "=NEW()" } } } };
  const result = effectiveArraysFromSheet(sheet, { 0: { 0: range(0) } });
  expect(result.map((a) => [a.id, a.formula])).toEqual([
    ["fixed", "=OLD()"],
    ["first", "=NEW()"],
    ["second", "=OLD()"],
  ]);
  expect(arrays[0]!.formula).toBe("=OLD()");
});

test("moved cached anchors preserve sequential matching rather than stale index entries", () => {
  const arrays = [dynamic("first", 0), dynamic("second", 2)];
  const sheet = {
    custom: { excelmanusArrays: arrays },
    cellData: { 0: { 0: { f: "=FIRST()" } }, 2: { 0: { f: "=SECOND()" } } },
  };
  const result = effectiveArraysFromSheet(sheet, { 0: { 0: range(2) }, 2: { 0: range(2) } });
  expect(result.map((a) => [a.id, a.formula, a.range.startRow])).toEqual([
    ["first", "=SECOND()", 2],
    ["second", "=OLD()", 2],
  ]);
});

test("unregistered spills are appended once and later matching preserves their generated ID", () => {
  const sheet = { cellData: { 0: { 0: { f: "=FIRST()" } }, 2: { 0: { f: "=SECOND()" } } } };
  const result = effectiveArraysFromSheet(sheet, { 0: { 0: range(2) }, 2: { 0: range(2) } });
  expect(result).toEqual([
    { id: "spill_0_0", mode: "dynamic", formula: "=SECOND()", range: range(2) },
  ]);
});
