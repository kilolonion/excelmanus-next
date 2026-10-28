import { readFileSync } from "node:fs";
import { unzipSync, zipSync } from "fflate";
import { expect, test } from "vitest";
import { exportXlsx } from "../src/checkpoint.ts";
import { spreadsheetChildren, spreadsheetXml } from "../src/print-codec.ts";
import { importXlsx } from "../src/xlsx.ts";
import { bytesOf, elements, textOf, xmlAttrs } from "../src/xml.ts";

const source = () =>
  Buffer.from(
    readFileSync(new URL("./fixtures/grouping.xlsx.base64", import.meta.url), "utf8"),
    "base64",
  );
const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
function fixture(edit: (xml: string) => string) {
  const parts: Record<string, Uint8Array> = unzipSync(source());
  parts["xl/worksheets/sheet1.xml"] = bytesOf(edit(textOf(parts["xl/worksheets/sheet1.xml"]!)));
  return zipSync(parts);
}

test("collapsed-only summary axes and metadata-only extents are imported independently", () => {
  const input = fixture((xml) =>
    xml
      .replace("</cols>", '<col min="40" max="42" collapsed="true"/></cols>')
      .replace("</sheetData>", '<row r="50" collapsed="1"/></sheetData>'),
  );
  const sheet = importXlsx(input, "outline.xlsx").snapshot.sheets.s0!;
  expect(sheet.rowData?.[8]?.custom).toMatchObject({ excelmanusCollapsed: true });
  expect(sheet.rowData?.[8]?.hd).toBeUndefined();
  expect(sheet.columnData?.[4]?.custom).toMatchObject({ excelmanusCollapsed: true });
  expect(sheet.columnData?.[41]?.custom).toEqual({ excelmanusCollapsed: true });
  expect(sheet.rowData?.[49]?.custom).toEqual({ excelmanusCollapsed: true });
  expect(sheet.columnCount).toBe(42);
  expect(sheet.rowCount).toBe(50);
});

test("clearing collapsed preserves hidden, nested levels, unknown attrs and outline settings", () => {
  const input = fixture((xml) =>
    xml
      .replace("<outlinePr", '<outlinePr summaryBelow="0" summaryRight="false" vendor="keep"')
      .replace('<row r="9"', '<row r="9" hidden="1" vendor="row"')
      .replace('min="5" max="5"', 'min="5" max="5" vendor="column"'),
  );
  const imported = importXlsx(input, "outline.xlsx");
  const sheet = imported.snapshot.sheets.s0!;
  expect(sheet.custom?.excelmanusOutlineSettings).toEqual({
    summaryBelow: "0",
    summaryRight: "false",
    vendor: "keep",
  });
  const after = structuredClone(imported.snapshot);
  after.sheets.s0!.rowData![8]!.custom = {};
  after.sheets.s0!.columnData![4]!.custom = {};
  const out = exportXlsx(imported, after);
  const xml = textOf(unzipSync(out)["xl/worksheets/sheet1.xml"]!);
  const row = elements(xml, "row").find((node) => xmlAttrs(node.open).r === "9")!;
  expect(xmlAttrs(row.open)).toMatchObject({ hidden: "1", vendor: "row" });
  expect(xmlAttrs(row.open)).not.toHaveProperty("collapsed");
  const col = elements(xml, "col").find((node) => xmlAttrs(node.open).min === "5")!;
  expect(xmlAttrs(col.open).vendor).toBe("column");
  expect(xmlAttrs(col.open)).not.toHaveProperty("collapsed");
  expect(importXlsx(out, "out.xlsx").snapshot.sheets.s0?.rowData?.[3]).toEqual(sheet.rowData?.[3]);
  expect(elements(xml, "outlinePr")[0]?.raw).toBe(
    elements(textOf(unzipSync(input)["xl/worksheets/sheet1.xml"]!), "outlinePr")[0]?.raw,
  );
});

test("outline settings use direct SpreadsheetML parents and preserve foreign namespace lookalikes", () => {
  const input = fixture((xml) =>
    xml
      .replace('xmlns="' + NS + '"', 'xmlns:s="' + NS + '" xmlns:f="urn:foreign"')
      .replace(/<(\/?)([A-Za-z][\w]*)(?=[\s/>])/g, "<$1s:$2")
      .replace("<s:outlinePr", '<f:outlinePr summaryBelow="1"/><s:outlinePr summaryBelow="false"')
      .replace(
        "</s:sheetPr>",
        '<f:container><s:outlinePr summaryBelow="1"/></f:container></s:sheetPr>',
      ),
  );
  const imported = importXlsx(input, "prefixed.xlsx");
  expect(imported.snapshot.sheets.s0?.custom?.excelmanusOutlineSettings).toEqual({
    summaryBelow: "false",
  });
  const after = structuredClone(imported.snapshot);
  after.sheets.s0!.rowData![8]!.custom = {};
  const xml = textOf(unzipSync(exportXlsx(imported, after))["xl/worksheets/sheet1.xml"]!);
  const pr = spreadsheetChildren(spreadsheetXml(xml), "sheetPr")[0]!;
  expect(
    pr.children.find((node) => node.uri === "urn:foreign" && node.local === "outlinePr")
      ?.attributes,
  ).toEqual({ summaryBelow: "1" });
  expect(
    pr.children.find((node) => node.uri === "urn:foreign" && node.local === "container"),
  ).toBeDefined();
});

test("sheet format outline maxima follow the actual final axes without touching other attributes", () => {
  const imported = importXlsx(source(), "outline.xlsx");
  const after = structuredClone(imported.snapshot);
  for (const row of Object.values(after.sheets.s0!.rowData ?? {}))
    if (row.custom) delete row.custom.excelmanusOutlineLevel;
  const xml = textOf(unzipSync(exportXlsx(imported, after))["xl/worksheets/sheet1.xml"]!);
  expect(xmlAttrs(elements(xml, "sheetFormatPr")[0]!.open)).toEqual({
    defaultRowHeight: "15",
    outlineLevelCol: "2",
  });
});
