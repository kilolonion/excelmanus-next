import { expect, test } from "vitest";
import { axisOutlineRanges, outlineSettings } from "../src/lib/workbook/outline-status";

test("outline status keeps group levels, hidden axes and summary collapsed flags independent", () => {
  expect(
    axisOutlineRanges(
      {
        1: { hd: 1, custom: { excelmanusOutlineLevel: 1 } },
        2: { hd: 1, custom: { excelmanusOutlineLevel: 2 } },
        3: { hd: 1, custom: { excelmanusOutlineLevel: 1 } },
        4: { custom: { excelmanusCollapsed: true } },
        5: { hd: 1 },
      },
      "cols",
    ),
  ).toEqual([
    { range: "B", level: 1, hidden: true, collapsed: false },
    { range: "C", level: 2, hidden: true, collapsed: false },
    { range: "D", level: 1, hidden: true, collapsed: false },
    { range: "E", level: 0, hidden: false, collapsed: true },
    { range: "F", level: 0, hidden: true, collapsed: false },
  ]);
});

test("only adjacent axes with the same three states are merged", () => {
  expect(
    axisOutlineRanges(
      {
        2: { hd: 1, custom: { excelmanusOutlineLevel: 1 } },
        3: { hd: 1, custom: { excelmanusOutlineLevel: 1 } },
        4: { hd: 0, custom: { excelmanusOutlineLevel: 1 } },
        5: { hd: 0, custom: { excelmanusOutlineLevel: 1, excelmanusCollapsed: true } },
        7: { hd: 0, custom: { excelmanusOutlineLevel: 1, excelmanusCollapsed: true } },
        8: { hd: 0, custom: { excelmanusOutlineLevel: 0, excelmanusCollapsed: false } },
        9: { h: 40 },
      },
      "rows",
    ),
  ).toEqual([
    { range: "3:4", level: 1, hidden: true, collapsed: false },
    { range: "5", level: 1, hidden: false, collapsed: false },
    { range: "6", level: 1, hidden: false, collapsed: true },
    { range: "8", level: 1, hidden: false, collapsed: true },
  ]);
  expect(axisOutlineRanges({ 25: { hd: 1 }, 26: { hd: 1 }, 27: { hd: 1 } }, "cols")).toEqual([
    { range: "Z:AB", level: 0, hidden: true, collapsed: false },
  ]);
});

test("outline settings distinguish file attributes from OOXML defaults without mutating them", () => {
  const raw = { summaryBelow: "0", summaryRight: "false", showOutlineSymbols: "1" };
  expect(outlineSettings(raw)).toEqual([
    { key: "summaryBelow", value: false, raw: "0" },
    { key: "summaryRight", value: false, raw: "false" },
    { key: "showOutlineSymbols", value: true, raw: "1" },
    { key: "applyStyles", value: false, raw: undefined },
  ]);
  expect(raw).toEqual({ summaryBelow: "0", summaryRight: "false", showOutlineSymbols: "1" });
  expect(outlineSettings(undefined).map((setting) => setting.value)).toEqual([
    true,
    true,
    true,
    false,
  ]);
});

test("outline settings match readback for on/off values and retain unknown explicit attributes", () => {
  expect(
    outlineSettings({
      summaryBelow: "OFF",
      summaryRight: "on",
      showOutlineSymbols: "unexpected",
    }),
  ).toEqual([
    { key: "summaryBelow", value: false, raw: "OFF" },
    { key: "summaryRight", value: true, raw: "on" },
    { key: "showOutlineSymbols", value: null, raw: "unexpected" },
    { key: "applyStyles", value: false, raw: undefined },
  ]);
});
