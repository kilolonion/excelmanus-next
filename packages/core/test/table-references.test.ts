import { expect, test } from "vitest";
import { rewriteTableReferences, type TableReference } from "../src/table-references.ts";

const t: TableReference = {
  name: "Sales",
  sheet: "订单",
  range: { startRow: 0, endRow: 3, startColumn: 0, endColumn: 1 },
  columns: ["Item", "Amount"],
  showHeader: true,
  showFooter: true,
};
test("结构化引用改名不改字符串，转换保留范围语义", () => {
  expect(
    rewriteTableReferences(
      '=SUM(Sales[Amount])+IF(A1="Sales[Amount]",0,1)',
      t,
      { ...t, name: "Orders", columns: ["Item", "Value"] },
      1,
      false,
    ),
  ).toBe('=SUM(Orders[Value])+IF(A1="Sales[Amount]",0,1)');
  expect(rewriteTableReferences("=SUM(Sales[Amount])", t, null, 1, false)).toBe(
    "=SUM('订单'!$B$2:$B$3)",
  );
  expect(rewriteTableReferences("=[@Amount]*2", t, null, 2, true)).toBe("='订单'!$B$3*2");
  expect(rewriteTableReferences("=SUM(Sales[[#Totals],[Amount]])", t, null, 1, false)).toBe(
    "=SUM('订单'!$B$4)",
  );
});

test("整个表引用与列名交换同步改写", () => {
  expect(rewriteTableReferences("=SUM(Sales)", t, null, 0, false)).toBe("=SUM('订单'!$A$2:$B$3)");
  expect(
    rewriteTableReferences(
      "=Sales[Item]+Sales[Amount]",
      t,
      { ...t, columns: ["Amount", "Item"] },
      0,
      false,
    ),
  ).toBe("=Sales[Amount]+Sales[Item]");
});

test("当前行简写规范化为保留结构语义的带表名引用", async () => {
  const { normalizeTableCells } = await import("../src/table-references.ts");
  const cells = {
    1: { 1: { f: '=[@Amount]+IF(A1="[@Amount]",0,1)' } },
    2: { 1: { f: "=sales[@amount]" } },
  };
  normalizeTableCells(cells, "s", [{ ...t, sheetId: "s" }]);
  expect(cells[1][1].f).toBe('=Sales[[#This Row],[Amount]]+IF(A1="[@Amount]",0,1)');
  expect(cells[2][1].f).toBe("=Sales[[#This Row],[Amount]]");
});
