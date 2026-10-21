import { expect, test } from "vitest";
import { importCsv } from "../src/csv.ts";
import { formulaGraph } from "../src/formula-graph.ts";

function fixture() {
  const snapshot = importCsv(new TextEncoder().encode("value\n1"), "probe.csv").snapshot;
  const sheetId = snapshot.sheetOrder[0]!;
  snapshot.sheets[sheetId] = {
    id: sheetId,
    name: "回归分析",
    rowCount: 100,
    columnCount: 20,
    cellData: {},
  };
  snapshot.sheets.data = {
    id: "data",
    name: "数据",
    rowCount: 3000,
    columnCount: 20,
    cellData: {},
  };
  snapshot.sheetOrder.push("data");
  return { snapshot, sheetId, target: { sheetId, r0: 27, r1: 27, c0: 4, c1: 4 } };
}

test("公式检查暴露实际引用值，保留引错 B23 的证据而不自动改成 C23", () => {
  const { snapshot, sheetId, target } = fixture();
  snapshot.sheets[sheetId]!.cellData = {
    22: { 1: { v: 7.172195488721792, f: "=SUMSQ(数据!E2:E21)" }, 2: { v: 18 } },
    27: {
      3: { v: 3.7535984492790884 },
      4: { f: "=TDIST(ABS(D28),B23,2)", v: 0.00713443876209952 },
    },
  };
  const before = JSON.stringify(snapshot);
  const graph = formulaGraph(snapshot, target, 1);
  expect(graph.precedents.items[0]).toMatchObject({
    cell: "'回归分析'!E28",
    formula: "=TDIST(ABS(D28),B23,2)",
    value: 0.00713443876209952,
    valueAvailable: true,
    references: [
      {
        text: "D28",
        totalCells: 1,
        truncated: false,
        cells: [{ cell: "'回归分析'!D28", value: 3.7535984492790884 }],
      },
      {
        text: "B23",
        totalCells: 1,
        truncated: false,
        cells: [
          { cell: "'回归分析'!B23", value: 7.172195488721792, formula: "=SUMSQ(数据!E2:E21)" },
        ],
      },
    ],
  });
  expect(JSON.stringify(snapshot)).toBe(before);
});

test("跨表区域返回逐格地址、空白和未计算状态", () => {
  const { snapshot, sheetId, target } = fixture();
  snapshot.sheets.data!.name = "收入 O'Brien";
  snapshot.sheets.data!.cellData = { 0: { 0: { v: 5 } }, 2: { 0: { f: "=1+1" } } };
  snapshot.sheets[sheetId]!.cellData = { 27: { 4: { f: "=SUM('收入 O''Brien'!$A$1:$A$3)" } } };
  const graph = formulaGraph(snapshot, target, 1);
  expect(graph.precedents.items[0]).toMatchObject({ value: null, valueAvailable: false });
  expect(graph.precedents.items[0]?.references[0]).toMatchObject({
    totalCells: 3,
    truncated: false,
    cells: [
      { cell: "'收入 O''Brien'!A1", value: 5, valueAvailable: true },
      { cell: "'收入 O''Brien'!A2", value: null, valueAvailable: true },
      { cell: "'收入 O''Brien'!A3", value: null, valueAvailable: false, formula: "=1+1" },
    ],
  });
});

test("引用值总预算有明确覆盖状态，不将大区域的部分值当完整结果", () => {
  const { snapshot, sheetId, target } = fixture();
  snapshot.sheets[sheetId]!.cellData = { 27: { 4: { f: "=SUM(数据!A1:A2001)+B1", v: 0 } } };
  const graph = formulaGraph(snapshot, target, 1);
  expect(graph).toMatchObject({
    valueCoverage: { limit: 2000, returnedCells: 2000, truncated: true },
  });
  expect(graph.precedents.items[0]?.references[0]).toMatchObject({
    totalCells: 2001,
    truncated: true,
  });
  expect(graph.precedents.items[0]?.references[0]).toHaveProperty("cells", expect.any(Array));
  expect(graph.precedents.items[0]?.references[1]).toMatchObject({
    totalCells: 1,
    truncated: true,
    cells: [],
  });
});

test("不把外部、结构化和三维引用冒充本工作簿单元格的值", () => {
  const { snapshot, sheetId, target } = fixture();
  snapshot.sheets.other = {
    id: "other",
    name: "其他",
    rowCount: 100,
    columnCount: 20,
    cellData: { 0: { 0: { v: 999 } } },
  };
  snapshot.sheets[sheetId]!.cellData = {
    1: { 1: { v: 7 } },
    27: { 4: { f: "=[book.xlsx]数据!A1+SUM(Table1[A1])+数据:其他!A1+B2" } },
  };
  const graph = formulaGraph(snapshot, target, 1);
  expect(graph.precedents.items[0]?.references).toHaveLength(1);
  expect(graph.precedents.items[0]?.references[0]).toMatchObject({
    text: "B2",
    cells: [{ value: 7 }],
  });
  expect(graph.precedents.items[0]?.unsupported.length).toBeGreaterThan(0);
});
