import { readFileSync } from "node:fs";
import { unzipSync, zipSync } from "fflate";
import { expect, test } from "vitest";
import { exportXlsx } from "../src/checkpoint.ts";
import { namesOf, setNames } from "../src/defined-names.ts";
import { importXlsx } from "../src/xlsx.ts";
import { bytesOf, textOf } from "../src/xml.ts";

const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const source = () =>
  Buffer.from(
    readFileSync(new URL("./fixtures/printing.xlsx.base64", import.meta.url), "utf8"),
    "base64",
  );
const settings = (s: { custom?: unknown }) =>
  (s.custom as Record<string, unknown> | undefined)?.excelmanusPrintSettings as {
    pageSetup: Record<string, string>;
    pageSetUpPr: Record<string, string>;
    pageMargins: Record<string, string>;
    headerFooter: { attributes: Record<string, string>; oddHeader?: string; oddFooter?: string };
    rowBreaks: { attributes: Record<string, string>; breaks: Record<string, string>[] };
    colBreaks: { attributes: Record<string, string>; breaks: Record<string, string>[] };
  };

test("打印 fixture 读取原属性与动态页眉页脚，不填省略默认值", () => {
  const workbook = importXlsx(source(), "printing.xlsx");
  const print = settings(workbook.snapshot.sheets.s0!);
  expect(print).toMatchObject({
    pageSetup: { paperSize: "9", orientation: "landscape", fitToHeight: "0" },
    pageSetUpPr: { fitToPage: "1" },
    pageMargins: { left: "0.4", right: "0.4", top: "0.5", bottom: "0.5" },
    headerFooter: {
      oddHeader: "&LLayout QA&C&F&R&A",
      oddFooter: "&LInternal&CPage &P of &N&R2026",
    },
    rowBreaks: { breaks: [{ id: "12", max: "16383", man: "1" }] },
    colBreaks: { breaks: [{ id: "3", max: "1048575", man: "1" }] },
  });
  expect(print.pageSetup).not.toHaveProperty("fitToWidth");
});

test("仅打印 custom 改动导出最小差分：prefix、未知属性、foreign XML 与未请求字段原样保留", () => {
  const parts: Record<string, Uint8Array> = unzipSync(source());
  const path = "xl/worksheets/sheet1.xml";
  let xml = textOf(parts[path]!)
    .replace(`xmlns="${NS}"`, `xmlns:s="${NS}" xmlns:x="urn:foreign"`)
    .replace(/<(\/?)([A-Za-z][\w]*)(?=[\s/>])/g, "<$1s:$2")
    .replace("<s:pageSetup ", '<s:pageSetup x:vendor="keep" ')
    .replace("<s:headerFooter>", '<s:headerFooter differentOddEven="1" x:keep="yes">')
    .replace(
      "</s:headerFooter>",
      "<s:evenHeader>&amp;P even</s:evenHeader><x:oddHeader>foreign exact</x:oddHeader></s:headerFooter>",
    )
    .replace(
      "</s:worksheet>",
      '<x:pageSetup orientation="foreign"/><s:extLst><s:ext uri="test"><s:pageSetup orientation="nested"/></s:ext></s:extLst></s:worksheet>',
    );
  parts[path] = bytesOf(xml);
  const imported = importXlsx(zipSync(parts), "printing.xlsx");
  const next = structuredClone(imported.snapshot);
  const print = settings(next.sheets.s0!);
  expect(print?.pageSetup.orientation).toBe("landscape");
  print.pageSetup.orientation = "portrait";
  print.headerFooter.oddHeader = "&LLayout Round3&C&A&R&F";
  print.headerFooter.oddFooter = "&LPrivate&C&P / &N&R2026";
  print.rowBreaks.breaks = [{ id: "10", max: "16383", man: "1" }];
  print.colBreaks.breaks = [{ id: "4", max: "1048575", man: "1" }];
  const out = unzipSync(exportXlsx(imported, next));
  const actual = textOf(out[path]!);
  xml = xml
    .replace('orientation="landscape"', 'orientation="portrait"')
    .replace(
      "&amp;LLayout QA&amp;C&amp;F&amp;R&amp;A",
      "&amp;LLayout Round3&amp;C&amp;A&amp;R&amp;F",
    )
    .replace(
      "&amp;LInternal&amp;CPage &amp;P of &amp;N&amp;R2026",
      "&amp;LPrivate&amp;C&amp;P / &amp;N&amp;R2026",
    )
    .replace('id="12"', 'id="10"')
    .replace('id="3"', 'id="4"');
  expect(actual).toBe(xml);
  for (const [key, value] of Object.entries(parts))
    if (key !== path) expect(out[key]).toEqual(value);
  expect(
    settings(importXlsx(zipSync(out), "again.xlsx").snapshot.sheets.s0!).headerFooter.oddHeader,
  ).toBe(print.headerFooter.oddHeader);
});

test("清除单个打印字段不删除同块其他字段；新增节点遵守 worksheet 次序", () => {
  const parts: Record<string, Uint8Array> = unzipSync(source());
  const path = "xl/worksheets/sheet1.xml";
  parts[path] = bytesOf(textOf(parts[path]!).replace(/<headerFooter>[\s\S]*?<\/headerFooter>/, ""));
  const imported = importXlsx(zipSync(parts), "printing.xlsx");
  const next = structuredClone(imported.snapshot);
  const print = settings(next.sheets.s0!);
  expect(print).toBeDefined();
  delete print.pageSetup.orientation;
  print.headerFooter = { attributes: {}, oddFooter: "&P / &N" };
  const out = exportXlsx(imported, next);
  const xml = textOf(unzipSync(out)[path]!);
  expect(xml).not.toContain('orientation="landscape"');
  expect(xml).toContain('paperSize="9"');
  expect(xml.indexOf("<pageSetup")).toBeLessThan(xml.indexOf("<headerFooter"));
  expect(xml.indexOf("<headerFooter")).toBeLessThan(xml.indexOf("<rowBreaks"));
  expect(settings(importXlsx(out, "again.xlsx").snapshot.sheets.s0!).headerFooter.oddFooter).toBe(
    "&P / &N",
  );
});

test("打印内置名称只读真正的 workbook 子节点，修改保留作用域、未知属性及其他名称 XML", () => {
  const parts: Record<string, Uint8Array> = unzipSync(source());
  parts["xl/workbook.xml"] = bytesOf(
    textOf(parts["xl/workbook.xml"]!)
      .replace("<workbook ", '<workbook xmlns:s="' + NS + '" xmlns:x="urn:foreign" ')
      .replace(/<(\/?)(definedNames|definedName)(?=[\s/>])/g, "<$1s:$2")
      .replace('name="_xlnm.Print_Titles"', 'name="_xlnm.Print_Titles" x:vendor="keep"')
      .replace(
        "</s:definedNames>",
        '<x:definedName name="Fake">42</x:definedName></s:definedNames>',
      ),
  );
  const imported = importXlsx(zipSync(parts), "printing.xlsx");
  const next = structuredClone(imported.snapshot);
  const names = namesOf(next);
  expect(Object.values(names).map((n) => n.name)).toEqual([
    "_xlnm.Print_Area",
    "_xlnm.Print_Titles",
  ]);
  const title = Object.values(names).find((n) => n.name === "_xlnm.Print_Titles")!;
  title.formulaOrRefString = "'打印'!$1:$3";
  setNames(next, names);
  const actual = textOf(unzipSync(exportXlsx(imported, next))["xl/workbook.xml"]!);
  expect(actual).toBe(
    textOf(parts["xl/workbook.xml"]!).replace("打印!$1:$2", "&apos;打印&apos;!$1:$3"),
  );
});

test("替换手动分页按 id 保留自动分页属性，不向新分页迁移旧节点扩展", () => {
  const parts: Record<string, Uint8Array> = unzipSync(source());
  const path = "xl/worksheets/sheet1.xml";
  parts[path] = bytesOf(
    textOf(parts[path]!).replace(
      '<rowBreaks count="1" manualBreakCount="1"><brk id="12" max="16383" man="1"/></rowBreaks>',
      '<rowBreaks xmlns:x="urn:foreign" count="2" manualBreakCount="1"><brk id="12" max="16383" man="1" x:manual="old"/><brk id="15" min="3" max="8" x:auto="keep"/></rowBreaks>',
    ),
  );
  const imported = importXlsx(zipSync(parts), "printing.xlsx");
  const next = structuredClone(imported.snapshot);
  const print = settings(next.sheets.s0!);
  print.rowBreaks.breaks = [
    print.rowBreaks.breaks[1]!,
    { id: "10", min: "0", max: "16383", man: "1" },
  ];
  const actual = textOf(unzipSync(exportXlsx(imported, next))[path]!);
  expect(actual).toContain('<brk id="15" min="3" max="8" x:auto="keep"/>');
  expect(actual).toContain('<brk id="10" min="0" max="16383" man="1"/>');
  expect(actual).not.toContain('x:manual="old"');
  expect(
    settings(
      importXlsx(zipSync({ ...parts, [path]: bytesOf(actual) }), "again.xlsx").snapshot.sheets.s0!,
    ).rowBreaks.breaks[0],
  ).not.toHaveProperty("man");
});

test("无 calcPr 时新建打印名称仍位于 oleSize 和 extLst 前，未知后继原样保留", () => {
  const parts: Record<string, Uint8Array> = unzipSync(source());
  const path = "xl/workbook.xml";
  const original = textOf(parts[path]!)
    .replace(/<definedNames>[\s\S]*?<\/definedNames>/, "")
    .replace(/<calcPr\b[^>]*\/>/, "")
    .replace(
      "</workbook>",
      '<oleSize ref="A1:D2"/><extLst><ext uri="vendor"><x:keep xmlns:x="urn:vendor" attr = \'keep\' /></ext></extLst></workbook>',
    );
  parts[path] = bytesOf(original);
  const imported = importXlsx(zipSync(parts), "printing.xlsx");
  const next = structuredClone(imported.snapshot);
  setNames(next, {
    print: {
      id: "print",
      name: "_xlnm.Print_Area",
      localSheetId: "s0",
      formulaOrRefString: "打印!$A$1:$D$10",
    },
  });
  const actual = textOf(unzipSync(exportXlsx(imported, next))[path]!);
  const added =
    '<definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">打印!$A$1:$D$10</definedName></definedNames>';
  expect(actual).toBe(original.replace("<oleSize", `${added}<oleSize`));
});
