import type { IWorksheetData } from "@univerjs/core";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { expect, test } from "vitest";
import { minimalXlsx } from "../src/checkpoint.ts";
import { importCsv } from "../src/csv.ts";
import { buildLayout } from "../src/render.ts";
import { importXlsx } from "../src/xlsx.ts";

test.each([
  [1, "0", "1234"],
  [2, "0.00", "1234.00"],
  [3, "#,##0", "1,234"],
  [4, "#,##0.00", "1,234.00"],
])("imports built-in number format %s without a custom numFmt entry", (id, pattern, text) => {
  const { snapshot } = importCsv(new TextEncoder().encode("1234\n"), "numbers.csv");
  const parts = unzipSync(minimalXlsx(snapshot));
  parts["xl/styles.xml"] = strToU8(
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="1"><xf numFmtId="${id}"/></cellXfs></styleSheet>`,
  );
  parts["xl/worksheets/sheet1.xml"] = strToU8(
    strFromU8(parts["xl/worksheets/sheet1.xml"]!)
      .replace('<c r="A1"', '<c s="0" r="A1"')
      .replace("<v>1234</v>", "<f>617*2</f><v>1234</v>"),
  );
  const imported = importXlsx(zipSync(parts), "numbers.xlsx").snapshot;
  const sheet = imported.sheets[imported.sheetOrder[0]!] as IWorksheetData;
  const cell = sheet.cellData![0]![0]!;
  const style = typeof cell.s === "string" ? imported.styles?.[cell.s] : cell.s;
  expect(style).toMatchObject({ n: { pattern } });
  expect(cell).toMatchObject({ v: 1234, f: "=617*2" });
  expect(buildLayout(imported, sheet, "A1:A1").layout.cells.some((c) => c.text === text)).toBe(true);
});
