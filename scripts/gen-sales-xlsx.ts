// 生成仓库内样例 samples/sales.xlsx（确定性输出，不依赖 Excel）：
//   node scripts/gen-sales-xlsx.ts
// 单主表「销售」：地区/产品/日期/数量/单价/金额（F 列为 =D*E 公式列，含缓存值），
// 50 行数据；附带一个隐藏表「参数」；带冻结首行、列宽、合并标题行、数字格式。
// 另外生成 samples/catalog.csv（GBK 编码，供 CSV 导入测试）。

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { zipSync } from "fflate";
import { encode as gbkEncode } from "iconv-lite";

const REGIONS = ["华东", "华南", "华北", "西南"];
const PRODUCTS = ["笔记本", "显示器", "键盘", "鼠标", "平板"];
const PRICES: Record<string, number> = {
  笔记本: 6499,
  显示器: 1899,
  键盘: 249,
  鼠标: 129,
  平板: 2999,
};

// 确定性 PRNG
let seed = 20250901;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0xffffffff;
};

// Excel 1900 日期系统：serial = 距 1899-12-30 的天数
function dateSerial(y: number, m: number, d: number): number {
  return Math.floor((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
}

const ROWS: { region: string; product: string; serial: number; qty: number; price: number }[] = [];
for (let i = 0; i < 50; i++) {
  const region = REGIONS[i % REGIONS.length] as string;
  const product = PRODUCTS[Math.floor(rand() * PRODUCTS.length)] as string;
  const day = 6 + Math.floor(i / 4);
  const month = (i % 9) + 1;
  const serial = dateSerial(2025, month, Math.min(day + Math.floor(rand() * 3), 28));
  const qty = 1 + Math.floor(rand() * 40);
  ROWS.push({ region, product, serial, qty, price: PRICES[product] ?? 100 });
}

// sharedStrings：表头 + 全部字符串值
const sharedStrings: string[] = [];
const sstIndex = new Map<string, number>();
const si = (s: string): number => {
  const hit = sstIndex.get(s);
  if (hit !== undefined) return hit;
  sharedStrings.push(s);
  sstIndex.set(s, sharedStrings.length - 1);
  return sharedStrings.length - 1;
};
const HEADERS = ["地区", "产品", "日期", "数量", "单价", "金额"];
for (const h of HEADERS) si(h);
si("销售明细表");
for (const r of ROWS) {
  si(r.region);
  si(r.product);
}
si("说明");
si("汇率");
si("本样例由 scripts/gen-sales-xlsx.ts 生成，仅供测试使用。");

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// styles.xml：xf0 默认；xf1 标题粗体居中；xf2 日期 yyyy-mm-dd；xf3 金额 #,##0.00
const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="2">
    <numFmt numFmtId="164" formatCode="yyyy-mm-dd"/>
    <numFmt numFmtId="165" formatCode="#,##0.00"/>
  </numFmts>
  <fonts count="2"><font><sz val="11"/></font><font><b/><sz val="12"/></font></fonts>
  <fills count="1"><fill><patternFill/></fill></fills>
  <borders count="1"><border/></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="4">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
  </cellXfs>
</styleSheet>`;

function cellRef(col: number, row: number): string {
  let s = "";
  let c = col;
  while (c > 0) {
    s = String.fromCharCode(64 + (c % 26 || 26)) + s;
    c = Math.floor((c - 1) / 26);
  }
  return `${s}${row}`;
}

// 销售表 XML：行1 合并标题；行2 表头；行3-52 数据
function sheetXml(): string {
  const lines: string[] = [
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`,
    `<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>`,
    `<dimension ref="A1:F52"/>`,
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`,
    `<cols><col min="1" max="1" width="10" customWidth="1"/><col min="2" max="2" width="12" customWidth="1"/><col min="3" max="6" width="12" customWidth="1"/></cols>`,
    `<sheetData>`,
  ];
  // 标题行（合并 A1:F1）
  lines.push(
    `<row r="1" ht="24" customHeight="1"><c r="A1" s="1" t="s"><v>${si("销售明细表")}</v></c></row>`,
  );
  // 表头
  const headerCells = HEADERS.map(
    (h, i) => `<c r="${cellRef(i + 1, 2)}" s="1" t="s"><v>${si(h)}</v></c>`,
  ).join("");
  lines.push(`<row r="2">${headerCells}</row>`);
  ROWS.forEach((r, i) => {
    const row = i + 3;
    const amount = r.qty * r.price;
    lines.push(
      `<row r="${row}">` +
        `<c r="A${row}" t="s"><v>${si(r.region)}</v></c>` +
        `<c r="B${row}" t="s"><v>${si(r.product)}</v></c>` +
        `<c r="C${row}" s="2"><v>${r.serial}</v></c>` +
        `<c r="D${row}"><v>${r.qty}</v></c>` +
        `<c r="E${row}" s="3"><v>${r.price}</v></c>` +
        `<c r="F${row}" s="3"><f>D${row}*E${row}</f><v>${amount}</v></c>` +
        `</row>`,
    );
  });
  lines.push(`</sheetData>`);
  lines.push(`<mergeCells count="1"><mergeCell ref="A1:F1"/></mergeCells>`);
  lines.push(`</worksheet>`);
  return lines.join("\n");
}

const hiddenSheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:B2"/>
  <sheetData>
    <row r="1"><c r="A1" t="s"><v>${si("说明")}</v></c><c r="B1" t="s"><v>${si("汇率")}</v></c></row>
    <row r="2"><c r="A2" t="s"><v>${si("本样例由 scripts/gen-sales-xlsx.ts 生成，仅供测试使用。")}</v></c><c r="B2"><v>7.2</v></c></row>
  </sheetData>
</worksheet>`;

const sstXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">
${sharedStrings.map((s) => `  <si><t>${esc(s)}</t></si>`).join("\n")}
</sst>`;

const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="销售" sheetId="1" r:id="rId1"/>
    <sheet name="参数" sheetId="2" state="hidden" r:id="rId2"/>
  </sheets>
</workbook>`;

const files: Record<string, Uint8Array> = {
  "[Content_Types].xml":
    new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`),
  "_rels/.rels": new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`),
  "xl/workbook.xml": new TextEncoder().encode(workbookXml),
  "xl/_rels/workbook.xml.rels":
    new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
  <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`),
  "xl/worksheets/sheet1.xml": new TextEncoder().encode(sheetXml()),
  "xl/worksheets/sheet2.xml": new TextEncoder().encode(hiddenSheetXml),
  "xl/sharedStrings.xml": new TextEncoder().encode(sstXml),
  "xl/styles.xml": new TextEncoder().encode(stylesXml),
  "docProps/core.xml":
    new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"><dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">销售明细表</dc:title></cp:coreProperties>`),
};

const out = zipSync(files, { level: 6 });
const dir = join(process.cwd(), "samples");
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "sales.xlsx"), out);
console.log(`samples/sales.xlsx written (${out.length} bytes, ${ROWS.length} data rows)`);

// GBK CSV 样例（UTF-8 无 BOM 会被误判 → 显式 GBK 编码入盘）
const csvText = ["名称,类别,单价", ...PRODUCTS.map((p) => `${p},硬件,${PRICES[p]}`)].join("\r\n");
writeFileSync(join(dir, "catalog-gbk.csv"), gbkEncode(csvText, "gbk"));
console.log("samples/catalog-gbk.csv written");
