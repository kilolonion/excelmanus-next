import { normalizeTableCells } from "@excelmanus/core";
import { TableManager } from "@univerjs/sheets-table";
import { expect, test, vi } from "vitest";
import { normalizeEditorTableValues } from "../src/lib/workbook/table-values";

function fixture() {
  const manager = new TableManager({} as never, {} as never);
  manager.addTable(
    "book",
    "sheet",
    "Sales",
    {
      startRow: 0,
      endRow: 3,
      startColumn: 0,
      endColumn: 1,
    },
    ["Item", "Amount"],
    "sales",
    { showHeader: true, showFooter: true },
  );
  manager.addTable(
    "book",
    "other",
    "Costs",
    {
      startRow: 0,
      endRow: 3,
      startColumn: 0,
      endColumn: 0,
    },
    ["Expense"],
    "costs",
    { showHeader: false },
  );
  const sales = manager.getTableById("book", "sales");
  const costs = manager.getTableById("book", "costs");
  if (!sales || !costs) throw Error("table fixture missing");
  return { manager, sales, costs };
}
test("ordinary values and style-only edits do not prepare table definitions", () => {
  const { manager } = fixture();
  const list = vi.spyOn(manager, "getTableList");
  const cells = { 0: { 0: { v: 12 }, 1: { s: { bl: 1 } }, 2: null, 3: { f: null } } };
  const original = structuredClone(cells);
  normalizeEditorTableValues(cells, "sheet", "book", manager);
  expect(cells).toEqual(original);
  expect(list).not.toHaveBeenCalled();
  manager.dispose();
});
test("formula preparation reuses table list metadata without serializing table filters again", () => {
  const { manager, sales, costs } = fixture();
  const serializeSales = vi.spyOn(sales, "toJSON");
  const serializeCosts = vi.spyOn(costs, "toJSON");
  const filters = vi.spyOn(sales.getTableFilters(), "toJSON");
  const list = vi.spyOn(manager, "getTableList");
  const cells = {
    1: { 1: { f: "=[@amount]+sum(costs[expense])" } },
    9: { 0: { f: '=sum(sales[amount])+"sales[amount]"' } },
  };
  normalizeEditorTableValues(cells, "sheet", "book", manager);
  expect(cells[1][1].f).toBe("=Sales[[#This Row],[Amount]]+SUM(Costs[Expense])");
  expect(cells[9][0].f).toBe('=SUM(Sales[Amount])+"sales[amount]"');
  expect(list).toHaveBeenCalledTimes(1);
  expect(serializeSales).not.toHaveBeenCalled();
  expect(serializeCosts).not.toHaveBeenCalled();
  expect(filters).not.toHaveBeenCalled();
  manager.dispose();
});
test("latest table names and columns retain the previous normalization output", () => {
  const { manager, sales } = fixture();
  sales.setDisplayName("Orders");
  const column = sales.getTableColumnByIndex(1);
  if (!column) throw Error("column fixture missing");
  column.displayName = "Total";
  const cells = {
    1: { 1: { f: '=[@total]+sum(costs[expense])+"orders[total]"' } },
    9: {
      0: { f: "=sum(orders[total])" },
      1: { f: "=Unknown[missing]" },
      2: { f: "=Orders[[" },
      3: { v: 7 },
    },
  };
  const expected = structuredClone(cells);
  const tables = manager.getTableList("book").flatMap((info) => {
    const t = manager.getTableById("book", info.id)?.toJSON();
    return t
      ? [
          {
            name: t.name,
            sheet: "",
            sheetId: info.subUnitId,
            range: t.range,
            columns: t.columns.map((c) => c.displayName),
            showHeader: t.options.showHeader !== false,
            showFooter: !!t.options.showFooter,
          },
        ]
      : [];
  });
  normalizeTableCells(expected, "sheet", tables);
  normalizeEditorTableValues(cells, "sheet", "book", manager);
  expect(cells).toEqual(expected);
  expect(cells[1][1].f).toContain("Orders[[#This Row],[Total]]");
  expect(cells[9][0].f).toBe("=SUM(Orders[Total])");
  manager.dispose();
});
