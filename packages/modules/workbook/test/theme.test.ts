import { unzipSync, zipSync } from "fflate";
import { expect, test } from "vitest";
import { minimalXlsx } from "../src/checkpoint.ts";
import { importCsv } from "../src/csv.ts";
import { resolveColor } from "../src/theme.ts";
import { importXlsx } from "../src/xlsx.ts";

test("原生主题色及 tint 读取为可渲染 RGB，未声明的索引颜色不伪造", () => {
  const original = minimalXlsx(importCsv(new TextEncoder().encode("标题\n值"), "a.csv").snapshot);
  const parts = unzipSync(original),
    enc = new TextEncoder(),
    dec = new TextDecoder();
  parts["xl/styles.xml"] = enc.encode(
    dec.decode(parts["xl/styles.xml"]).replace("</font>", '<color theme="4" tint="0.5"/></font>'),
  );
  parts["xl/worksheets/sheet1.xml"] = enc.encode(
    dec.decode(parts["xl/worksheets/sheet1.xml"]).replace('<c r="A1"', '<c s="0" r="A1"'),
  );
  parts["xl/theme/theme1.xml"] = enc.encode(
    '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:clrScheme name="test"><a:accent1><a:srgbClr val="FF0000"/></a:accent1></a:clrScheme></a:themeElements></a:theme>',
  );
  const imported = importXlsx(zipSync(parts), "theme.xlsx");
  expect(imported.snapshot.styles.s0?.cl).toEqual({ rgb: "#FF8080" });
  expect(resolveColor({ "@_indexed": "40" }, [])).toBeUndefined();
});

test("共享公式跟随单元格展开为真实公式且不改写字符串和绝对引用", () => {
  const parts = unzipSync(
    minimalXlsx(importCsv(new TextEncoder().encode("数,倍\n1,2\n2,4\n3,6"), "shared.csv").snapshot),
  );
  const enc = new TextEncoder(),
    dec = new TextDecoder();
  let xml = dec.decode(parts["xl/worksheets/sheet1.xml"]);
  xml = xml.replace(
    /<c r="B2"[^>]*>[\s\S]*?<\/c>/,
    '<c r="B2"><f t="shared" si="0" ref="B2:B4">A2*2+$C$1+IF("A1"="A1",0,0)</f><v>2</v></c>',
  );
  for (const r of [3, 4])
    xml = xml.replace(
      new RegExp(`<c r="B${r}"[^>]*>[\\s\\S]*?<\\/c>`),
      `<c r="B${r}"><f t="shared" si="0"/><v>${(r - 1) * 2}</v></c>`,
    );
  parts["xl/worksheets/sheet1.xml"] = enc.encode(xml);
  const snapshot = importXlsx(zipSync(parts), "shared.xlsx").snapshot;
  expect(snapshot.sheets[snapshot.sheetOrder[0]!]!.cellData?.[3]?.[1]?.f).toBe(
    '=A4*2+$C$1+IF("A1"="A1",0,0)',
  );
});
