import { expect, test } from "vitest";
import {
  ARRAY_CACHE_RESOURCE,
  effectiveArrays,
  effectiveArraysFromSheet,
} from "../src/array-formulas.ts";

test("live-sheet array reads match saved-resource reads and do not share mutable ranges", () => {
  const fixed = {
    id: "fixed",
    mode: "fixed",
    formula: "=A1",
    range: { startRow: 4, endRow: 4, startColumn: 0, endColumn: 0 },
  };
  const dynamic = {
    id: "dynamic",
    mode: "dynamic",
    formula: "=OLD()",
    range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 },
  };
  const sheet = {
    custom: { excelmanusArrays: [fixed, dynamic] },
    cellData: { 0: { 0: { f: "=SEQUENCE(3,2)" } }, 2: { 3: { f: "=SEQUENCE(2)" } } },
  };
  const ranges = {
    0: { 0: { startRow: 0, endRow: 2, startColumn: 0, endColumn: 1 } },
    2: { 3: { startRow: 2, endRow: 3, startColumn: 3, endColumn: 3 } },
  };
  const saved = {
    sheets: { s: sheet },
    resources: [
      { name: ARRAY_CACHE_RESOURCE, data: JSON.stringify({ ranges: { s: ranges }, cells: {} }) },
    ],
  };
  const live = effectiveArraysFromSheet(sheet, ranges);
  expect(live).toEqual(effectiveArrays(saved, "s"));
  expect(live).toMatchObject([
    { id: "fixed", mode: "fixed", formula: "=A1" },
    { id: "dynamic", mode: "dynamic", formula: "=SEQUENCE(3,2)", range: ranges[0][0] },
    { id: "spill_2_3", mode: "dynamic", formula: "=SEQUENCE(2)", range: ranges[2][3] },
  ]);
  live[1]!.range.endRow = 99;
  expect(ranges[0][0].endRow).toBe(2);
  expect(dynamic.range.endRow).toBe(0);
});

test("removed spill formulas and absent worksheets remain empty", () => {
  const ranges = { 0: { 0: { startRow: 0, endRow: 2, startColumn: 0, endColumn: 1 } } };
  expect(effectiveArraysFromSheet({ cellData: {} }, ranges)).toEqual([]);
  expect(effectiveArraysFromSheet(undefined, ranges)).toEqual([]);
});
