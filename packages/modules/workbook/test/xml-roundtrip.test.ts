import { unzipSync, zipSync } from "fflate";
import { describe, expect, test } from "vitest";
import { assertWritable, exportXlsx, verifyXlsx } from "../src/checkpoint.ts";
import { importXlsx } from "../src/xlsx.ts";
import { bytesOf, elements, textOf, xmlAttrs } from "../src/xml.ts";

const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const P = "http://schemas.openxmlformats.org/package/2006/relationships";
function fixture(names = "<definedNames/>") {
  return zipSync({
    "[Content_Types].xml": bytesOf(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    ),
    "xl/workbook.xml": bytesOf(
      `<workbook xmlns="${NS}"><sheets><sheet xmlns:r="${R}" name="Sheet1" sheetId="1" r:id="rId1"/></sheets>${names}</workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": bytesOf(
      `<Relationships xmlns="${P}"><Relationship Id="rId1" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${R}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    ),
    "xl/sharedStrings.xml": bytesOf(
      `<sst xmlns="${NS}"><si><t>&#24352;&#19977; &#x4E59;</t></si></sst>`,
    ),
    "xl/worksheets/sheet1.xml": bytesOf(
      `<worksheet xmlns="${NS}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&#35746;&#21333; &amp; &amp;#65;</t></is></c><c r="B1" t="s"><v>0</v></c></row></sheetData></worksheet>`,
    ),
  });
}

describe("XLSX XML round trips from external producers", () => {
  test("decodes decimal and hex character references once in inline/shared strings", () => {
    const { snapshot } = importXlsx(fixture(), "external.xlsx");
    const sheet = snapshot.sheets[snapshot.sheetOrder[0]!];
    expect(sheet?.cellData?.[0]?.[0]?.v).toBe("订单 & &#65;");
    expect(sheet?.cellData?.[0]?.[1]?.v).toBe("张三 乙");
  });

  test("new worksheet relationship has an in-scope namespace when old declarations are local", () => {
    const imported = importXlsx(fixture(), "external.xlsx");
    const after = structuredClone(imported.snapshot);
    after.sheetOrder.push("new");
    after.sheets.new = { id: "new", name: "新增", rowCount: 10, columnCount: 10, cellData: {} };
    const out = exportXlsx(imported, after);
    const xml = textOf(unzipSync(out)["xl/workbook.xml"]!);
    const root = xmlAttrs(elements(xml, "workbook")[0]!.open);
    for (const sheet of elements(xml, "sheet")) {
      const attrs = xmlAttrs(sheet.open);
      expect(attrs["xmlns:r"] ?? root["xmlns:r"]).toBe(R);
    }
    expect(() => verifyXlsx(out, after)).not.toThrow();
  });

  test("verification rejects an unbound relationship prefix even if tolerant readback succeeds", () => {
    const valid = fixture();
    const expected = importXlsx(valid, "valid.xlsx").snapshot;
    const parts: Record<string, Uint8Array> = unzipSync(valid);
    parts["xl/workbook.xml"] = bytesOf(
      textOf(parts["xl/workbook.xml"]!).replace(` xmlns:r="${R}"`, ""),
    );
    expect(() => verifyXlsx(zipSync(parts), expected)).toThrow();
  });

  test("empty definedNames does not prohibit a structural edit or its undo", () => {
    const imported = importXlsx(fixture(), "empty-names.xlsx");
    const id = imported.snapshot.sheetOrder[0]!;
    expect(() =>
      assertWritable(
        imported,
        [{ sheetId: id, r0: 0, r1: 9, c0: 0, c1: 9 }],
        [{ op: "sheet.delete", sheet: id }],
        [],
        imported.snapshot,
      ),
    ).not.toThrow();
  });

  test("actual defined names still block unsupported structural edits", () => {
    const imported = importXlsx(
      fixture('<definedNames><definedName name="Keep">Sheet1!$A$1</definedName></definedNames>'),
      "names.xlsx",
    );
    const id = imported.snapshot.sheetOrder[0]!;
    expect(() =>
      assertWritable(
        imported,
        [{ sheetId: id, r0: 0, r1: 9, c0: 0, c1: 9 }],
        [{ op: "sheet.delete", sheet: id }],
        [],
        imported.snapshot,
      ),
    ).toThrow(/definedNames/);
  });
});
