import { expect, test } from "vitest";
import { rangeDataCommands } from "../src/lib/workbook/range-actions";

const target = {
  unitId: "book",
  subUnitId: "sheet",
  range: { startRow: 2, endRow: 5, startColumn: 2, endColumn: 4 },
};
test("sort uses the whole selected range, absolute column and explicit header", () => {
  expect(
    rangeDataCommands(target, { kind: "sort", column: 3, order: "desc", header: true })[0],
  ).toEqual({
    id: "sheet.command.sort-range",
    params: { ...target, hasTitle: true, orderRules: [{ colIndex: 3, type: "desc" }] },
  });
});
test("filter creates a range only when needed and preserves blank selection", () => {
  const action = { kind: "filter" as const, column: 3, values: ["", "2"] };
  const commands = rangeDataCommands(target, action);
  expect(commands.map((x) => x.id)).toEqual([
    "sheet.command.set-filter-range",
    "sheet.command.set-filter-criteria",
  ]);
  expect(commands[1]?.params).toMatchObject({
    col: 3,
    criteria: { colId: 1, filters: { filters: ["2"], blank: true } },
  });
  expect(rangeDataCommands({ ...target, hasFilter: true }, action)).toHaveLength(1);
  expect(() => rangeDataCommands(target, { ...action, values: [] })).toThrow("至少");
});
