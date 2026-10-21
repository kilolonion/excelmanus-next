import { expect, test, vi } from "vitest";
import { createRangeValueSearch, readRangeDataColumns } from "../src/lib/workbook/range-data";

const range = { startRow: 2, endRow: 9999, startColumn: 3, endColumn: 4 };
test("sorting prepares only header values rather than the whole selection", () => {
  const read = vi.fn(() => [
    ["Name", "Amount"],
    ["apple", 20],
  ]);
  const columns = readRangeDataColumns("sort", range, read);
  expect(read).toHaveBeenCalledWith({ ...range, endRow: range.startRow });
  expect(columns).toEqual([
    { index: 3, label: "第 4 列 · Name", values: [] },
    { index: 4, label: "第 5 列 · Amount", values: [] },
  ]);
});
test("filter preparation does not clone the complete body row array for each column", () => {
  const values = [
    ["Name", "Amount"],
    ["apple", 20],
    ["apple", 10],
    [null, 20],
  ];
  const slice = vi.spyOn(values, "slice");
  const read = vi.fn(() => values);
  const criteria = vi.fn((column: number) =>
    column === 3 ? { filters: ["apple"], blank: true } : undefined,
  );
  const columns = readRangeDataColumns("filter", range, read, criteria);
  expect(read).toHaveBeenCalledWith(range);
  expect(columns).toEqual([
    { index: 3, label: "第 4 列 · Name", values: ["apple", ""], selected: ["apple", ""] },
    { index: 4, label: "第 5 列 · Amount", values: ["20", "10"] },
  ]);
  expect(slice).not.toHaveBeenCalled();
});
test("missing labels and booleans retain their existing display text", () => {
  expect(
    readRangeDataColumns("filter", range, () => [
      [undefined, ""],
      [true, false],
      [false, null],
    ]),
  ).toEqual([
    { index: 3, label: "第 4 列 · （无表头）", values: ["true", "false"] },
    { index: 4, label: "第 5 列 · ", values: ["false", ""] },
  ]);
});
test("typing a narrower filter query does not normalize every value again", () => {
  const values = Array.from({ length: 1000 }, (_, i) => `VALUE ${i}`);
  const search = createRangeValueSearch(values);
  const original = String.prototype.toLowerCase;
  let normalized = 0;
  const spy = vi.spyOn(String.prototype, "toLowerCase").mockImplementation(function (this: string) {
    if (String(this).startsWith("VALUE")) normalized++;
    return original.call(this);
  });
  try {
    expect(search("")).toBe(values);
    expect(normalized).toBe(0);
    search("value");
    expect(search("value 99")).toEqual(values.filter((v) => v.startsWith("VALUE 99")));
    expect(normalized).toBe(1000);
  } finally {
    spy.mockRestore();
  }
});
test("filter searches preserve literal spaces, order, and all results beyond the visible 200", () => {
  const values = [
    "",
    "ABC",
    "abc def",
    "中文",
    "İX",
    ...Array.from({ length: 300 }, (_, i) => `row ${i}`),
  ];
  const search = createRangeValueSearch(values);
  for (const query of ["row", "row 2", "row", "abc", "ABC D", "", " ", "中文", "i̇"])
    expect(search(query)).toEqual(
      query ? values.filter((v) => v.toLowerCase().includes(query.toLowerCase())) : values,
    );
  expect(search("row")).toHaveLength(300);
});
