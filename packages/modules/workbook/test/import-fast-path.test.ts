import { XMLParser } from "fast-xml-parser";
import { expect, test, vi } from "vitest";
import { importObjects } from "../src/objects.ts";
import { bytesOf, elements } from "../src/xml.ts";

test("无目标标签时不扫描整张表，但保留精确 XML 词法结果", () => {
  const scan = vi.spyOn(String.prototype, "matchAll");
  try {
    expect(
      elements(
        "<worksheet><sheetData><row><c><v>1</v></c></row></sheetData></worksheet>",
        "drawing",
      ),
    ).toEqual([]);
    expect(scan).not.toHaveBeenCalled();
    const xml =
      '<root><!-- <drawing/> --><![CDATA[<drawing/>]]><drawings/><drawing\n r:id="a"/><p:drawing/></root>';
    expect(elements(xml, "drawing").map((e) => e.raw)).toEqual(['<drawing\n r:id="a"/>']);
    expect(elements(xml, "p:drawing").map((e) => e.raw)).toEqual(["<p:drawing/>"]);
  } finally {
    scan.mockRestore();
  }
});

test("无绘图引用的 worksheet 不再重复解析全部单元格", () => {
  const parse = vi.spyOn(XMLParser.prototype, "parse");
  try {
    const sheets = { s1: { id: "s1", name: "Data" } };
    importObjects(
      {
        "xl/worksheets/sheet1.xml": bytesOf(
          "<worksheet><sheetData><row><c><v>1</v></c></row></sheetData></worksheet>",
        ),
      },
      { s1: { path: "xl/worksheets/sheet1.xml" } },
      sheets,
    );
    expect(parse).not.toHaveBeenCalled();
    expect(sheets.s1).toEqual({ id: "s1", name: "Data" });
  } finally {
    parse.mockRestore();
  }
});

test.each([
  '<drawing\n r:id="r1"/>',
  '<p:drawing r:id="r1"></p:drawing>',
  '<图:drawing r:id="r1"/>',
  "<!-- <drawing/> --><![CDATA[<drawing/>]]>",
])("可能的绘图标签仍走原 XML 校验与解析：%s", (drawing) => {
  const parse = vi.spyOn(XMLParser.prototype, "parse");
  const xml = `<worksheet xmlns:p="urn:test" xmlns:图="urn:test" xmlns:r="urn:rel">${drawing}</worksheet>`;
  try {
    importObjects(
      { "xl/worksheets/sheet1.xml": bytesOf(xml) },
      { s1: { path: "xl/worksheets/sheet1.xml" } },
      { s1: { id: "s1", name: "Data" } },
    );
    expect(parse).toHaveBeenCalledWith(xml);
  } finally {
    parse.mockRestore();
  }
});
