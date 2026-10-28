import { arrayCache } from "@excelmanus/protocol";
import { expect, test } from "vitest";
import { materializeArrays } from "../src/array-formulas.ts";
import { minimalXlsx } from "../src/checkpoint.ts";
import { importCsv } from "../src/csv.ts";
import { bootUniver } from "../src/engine.ts";
import { engineArrayFormula, engineFormula, xlsxFormula } from "../src/formula-compat.ts";
import { buildLayout } from "../src/render.ts";
import { importXlsx } from "../src/xlsx.ts";

async function calculated() {
  const s = importCsv(
    new TextEncoder().encode("ID,Region,Amount\n001,East,10\n002,West,20\n003,East,30"),
    "source.csv",
  ).snapshot;
  const sid = s.sheetOrder[0]!;
  s.sheets[sid]!.rowCount = 30;
  s.sheets[sid]!.columnCount = 12;
  s.sheets[sid]!.cellData![0]![4] = { f: '=FILTER(A2:C4,B2:B4="East")' };
  s.sheets[sid]!.cellData![0]![8] = { f: "=UNIQUE(B2:B4)" };
  s.sheets[sid]!.cellData![0]![10] = { f: '=XLOOKUP("East",B2:B4,C2:C4)' };
  const b = bootUniver();
  try {
    const wb = b.univerAPI.createWorkbook(s);
    await b.waitCalc(4000, true);
    return { saved: wb.save(), sid };
  } finally {
    await b.dispose();
  }
}

test("modern function export uses interoperable OOXML names and reimports scalar formula", async () => {
  const { saved, sid } = await calculated();
  const imported = importXlsx(minimalXlsx(saved), "modern.xlsx");
  const xml = new TextDecoder().decode(imported.preservation!.parts["xl/worksheets/sheet1.xml"]);
  expect(xml).toContain("_xlfn._xlws.FILTER(");
  expect(xml).toContain("_xlfn.UNIQUE(");
  expect(xml).toContain("_xlfn.XLOOKUP(");
  expect(imported.snapshot.sheets[sid]!.cellData![0]![10]!.f).toBe('=XLOOKUP("East",B2:B4,C2:C4)');
});

test("reopened arrays retain cached results before recalculation without authored spill children", async () => {
  const { saved } = await calculated();
  const imported = importXlsx(minimalXlsx(saved), "modern.xlsx").snapshot;
  const sid = imported.sheetOrder[0]!;
  const cached = arrayCache(imported);
  expect(cached.cells[sid]?.[1]?.[5]?.v).toBe("East");
  expect(imported.sheets[sid]!.cellData?.[1]?.[5]?.v).toBeNull();
  expect(materializeArrays(imported).sheets[sid]!.cellData?.[1]?.[6]?.v).toBe(30);
  const b = bootUniver();
  try {
    const wb = b.univerAPI.createWorkbook(imported);
    expect(materializeArrays(wb.save()).sheets[sid]!.cellData?.[1]?.[6]?.v).toBe(30);
  } finally {
    await b.dispose();
  }
});

test("render shows dynamic spill values rather than anchor alone", async () => {
  const { saved, sid } = await calculated();
  const layout = buildLayout(saved, saved.sheets[sid] as never, "E1:G2").layout;
  expect(layout.cells.filter((c) => !c.header).map((c) => c.text)).toContain("30");
  expect(layout.cells.filter((c) => !c.header).map((c) => c.text)).toContain("East");
});

test("OOXML function mapping preserves literals and references, and is idempotent", () => {
  const f = `=IF(A1="FILTER( and ""UNIQUE(""",'XLOOKUP('!A1,SUM(Table1[FILTER(])+_xlfn.XLOOKUP(A1,A2:A3,B2:B3))`;
  expect(xlsxFormula(f)).toBe(f);
  expect(engineFormula(f)).toBe(f.replace("_xlfn.XLOOKUP(", "XLOOKUP("));
  const modern = '=FILTER(A1:A2,UNIQUE(A1:A2)="UNIQUE(")';
  expect(xlsxFormula(modern)).toBe('=_xlfn._xlws.FILTER(A1:A2,_xlfn.UNIQUE(A1:A2)="UNIQUE(")');
  expect(xlsxFormula(xlsxFormula(modern))).toBe(xlsxFormula(modern));
  expect(engineFormula(xlsxFormula(modern))).toBe(modern);
});

test("compatibility tokens do not rewrite Unicode function identifiers", () => {
  expect(xlsxFormula("=SUM(Table1[A']FILTER(])")).toBe("=SUM(Table1[A']FILTER(])");
  expect(engineArrayFormula("=SUM(Table1[A']_xlfn.XLOOKUP(])")).toBe(
    "=SUM(Table1[A']_xlfn.XLOOKUP(])",
  );
  expect(xlsxFormula("=\\FILTER(A1)")).toBe("=\\FILTER(A1)");
  expect(xlsxFormula("=中文FILTER(A1)+FILTER(A1:A2,A1:A2>0)")).toBe(
    "=中文FILTER(A1)+_xlfn._xlws.FILTER(A1:A2,A1:A2>0)",
  );
});

test("array import keeps prefix-looking string contents and normalizes other array functions", () => {
  const snap = importCsv(new TextEncoder().encode("1\n2"), "a.csv").snapshot;
  const sid = snap.sheetOrder[0]!;
  const formula = '=IF(A1=1,"_xlfn.XLOOKUP(",SEQUENCE(2))';
  expect(engineArrayFormula(formula.replace("SEQUENCE(", "_xlfn.SEQUENCE("))).toBe(formula);
  snap.sheets[sid]!.cellData![0]![1] = { f: formula, v: "_xlfn.XLOOKUP(" };
  snap.sheets[sid]!.custom = {
    excelmanusArrays: [
      {
        id: "literal",
        mode: "dynamic",
        formula,
        range: { startRow: 0, endRow: 0, startColumn: 1, endColumn: 1 },
      },
    ],
  };
  const imported = importXlsx(minimalXlsx(snap), "literal.xlsx").snapshot;
  const s = imported.sheets[imported.sheetOrder[0]!]!;
  expect(s.cellData![0]![1]!.f).toBe('=IF(A1=1,"_xlfn.XLOOKUP(",SEQUENCE(2))');
});
