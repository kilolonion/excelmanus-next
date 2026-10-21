import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync, zipSync } from "fflate";

const target = new URL("../fixtures/xlsx/m2b/", import.meta.url);
mkdirSync(target, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "xman-m2b-fixtures-"));
try {
  for (let n = 1; n <= 5; n++) {
    const rows = [
      ["名称", "数量", "金额"],
      ["中文样例", String(n), "12.5"],
      ["含,逗号", String(n + 1), "0"],
      ['含"引号', String(n + 2), "98"],
    ];
    const csv = rows
      .map((r) => r.map((s) => `"${s.replaceAll('"', '""')}"`).join(","))
      .join("\r\n");
    const source = join(tmp, `lo-${n}.csv`);
    writeFileSync(source, `\ufeff${csv}`);
    execFileSync(
      "soffice",
      [
        `-env:UserInstallation=file://${tmp}/profile`,
        "--headless",
        "--convert-to",
        "xlsx",
        "--outdir",
        target.pathname,
        source,
      ],
      { timeout: 30000 },
    );
  }
  const base = unzipSync(readFileSync(new URL("../samples/sales.xlsx", import.meta.url)));
  const set = (name: string, xml: string) => {
    base[name] = new TextEncoder().encode(xml);
  };
  const get = (name: string) => new TextDecoder().decode(base[name]);
  const rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  set(
    "xl/worksheets/sheet1.xml",
    get("xl/worksheets/sheet1.xml").replace(
      "</worksheet>",
      '<drawing r:id="rIdDrawing"/><extLst><ext uri="m2b-preservation"><custom xmlns="urn:m2b:test">保留原文</custom></ext></extLst></worksheet>',
    ),
  );
  set(
    "xl/worksheets/_rels/sheet1.xml.rels",
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdDrawing" Type="${rel}/drawing" Target="../drawings/drawing1.xml"/></Relationships>`,
  );
  set(
    "xl/drawings/drawing1.xml",
    `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><xdr:twoCellAnchor><xdr:from><xdr:col>7</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>12</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>12</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="样例图表"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="${rel}" r:id="rIdChart"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>`,
  );
  set(
    "xl/drawings/_rels/drawing1.xml.rels",
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdChart" Type="${rel}/chart" Target="../charts/chart1.xml"/></Relationships>`,
  );
  set(
    "xl/charts/chart1.xml",
    '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart><c:plotArea><c:layout/><c:pieChart><c:varyColors val="1"/><c:ser><c:idx val="0"/><c:order val="0"/><c:val><c:numLit><c:formatCode>General</c:formatCode><c:ptCount val="1"/><c:pt idx="0"><c:v>1</c:v></c:pt></c:numLit></c:val></c:ser></c:pieChart></c:plotArea><c:plotVisOnly val="1"/></c:chart></c:chartSpace>',
  );
  set("customXml/item1.xml", '<?xml version="1.0"?><custom xmlns="urn:m2b:test">字节保真</custom>');
  base["xl/vbaProject.bin"] = Buffer.from("M2b synthetic non-executable VBA preservation sentinel");
  set(
    "xl/_rels/workbook.xml.rels",
    get("xl/_rels/workbook.xml.rels").replace(
      "</Relationships>",
      '<Relationship Id="rIdVba" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="vbaProject.bin"/></Relationships>',
    ),
  );
  set(
    "[Content_Types].xml",
    get("[Content_Types].xml")
      .replace(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
        "application/vnd.ms-excel.sheet.macroEnabled.main+xml",
      )
      .replace(
        "</Types>",
        '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/><Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/><Override PartName="/xl/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>',
      ),
  );
  writeFileSync(new URL("preservation.xlsm", target), zipSync(base));
  process.stdout.write(
    "Generated 5 LibreOffice XLSX files and one synthetic OOXML XLSM preservation fixture.\n",
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
