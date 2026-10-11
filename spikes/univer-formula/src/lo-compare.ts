// A2-2a LibreOffice 三方对照：
//  exceljs 写 cases.xlsx（Data + Cases 两表，公式无缓存值）
//  → soffice --headless --convert-to fods（LO 载入时计算无缓存公式）
//  → 解析 fods 中 Cases 表每格 office:value/office:value-type
//  → 输出 期望/LO/Univer 三方表与分歧清单。

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import ExcelJS from "exceljs";

const casesJson = JSON.parse(readFileSync("cases.json", "utf8")) as {
  data: unknown[][];
  cases: Array<{ fn: string; formula: string; expect: Record<string, unknown> }>;
  errorCases: Array<{ id: string; formula: string; expect: Record<string, unknown> }>;
};

const OUT = "results/lo";

// OOXML 规则：Excel 2007 之后的函数在 xlsx 里必须带 `_xlfn.` 前缀，
// 动态数组函数带 `_xlfn._xlws.` 前缀；裸写名字会被 LO 读成 #NAME?（已实测）。
const XLFN = new Set(
  (
    "MAXIFS MINIFS AGGREGATE STDEV.S VAR.S IFS XOR SWITCH XLOOKUP XMATCH " +
    "CONCAT TEXTJOIN NUMBERVALUE DAYS IFNA ARABIC BASE DECIMAL " +
    "STDEV.P VAR.P PERCENTILE.INC RANK.EQ MODE.SNGL FORECAST.LINEAR " +
    "ISFORMULA SHEET SHEETS FORMULATEXT NETWORKDAYS.INTL"
  ).split(" "),
);
const XLWS = new Set("FILTER SORT UNIQUE SEQUENCE RANDARRAY".split(" "));

function toXlsxFormula(f: string): string {
  let out = f.replace(/^=/, "");
  for (const fn of XLFN)
    out = out.replace(new RegExp(`\\b${fn.replace(".", "\\.")}\\s*\\(`, "g"), `_xlfn.${fn}(`);
  for (const fn of XLWS)
    out = out.replace(new RegExp(`\\b${fn}\\s*\\(`, "g"), `_xlfn._xlws.${fn}(`);
  return out;
}

interface LoCell {
  vtype?: string;
  value?: unknown;
  display: string;
}

function parseFods(fods: string): LoCell[] {
  // 取 Cases 表的 A 列（含 number-columns-repeated 展开）
  const tbl = fods.match(/<table:table[^>]*table:name="Cases"[^>]*>([\s\S]*?)<\/table:table>/);
  if (!tbl) throw new Error("Cases table not found in fods");
  const body = tbl[1] ?? "";
  const colA: LoCell[] = [];
  const rowRe = /<table:table-row[^>]*>([\s\S]*?)<\/table:table-row>/g;
  const cellRe = /<table:table-cell([^>]*?)(?:\/>|>([\s\S]*?)<\/table:table-cell>)/g;
  const rowRepeatRe = /<table:table-row[^>]*table:number-rows-repeated="(\d+)"/;
  let m = rowRe.exec(body);
  while (m !== null) {
    const rowXml = m[0] ?? "";
    const rowBody = m[1] ?? "";
    const rowRep = Number(rowXml.match(rowRepeatRe)?.[1] ?? "1");
    // 取本行 A 列（第一个 cell 节点及其 repeat 覆盖列 0）
    cellRe.lastIndex = 0;
    let col = 0;
    let cellA: LoCell = { display: "" };
    let cm = cellRe.exec(rowBody);
    while (cm !== null) {
      if (col > 0) break;
      const attrs = cm[1] ?? "";
      const inner = cm[2] ?? "";
      const vt = attrs.match(/office:value-type="([^"]+)"/)?.[1];
      const vnum = attrs.match(/office:value="([^"]+)"/)?.[1];
      const vbool = attrs.match(/office:boolean-value="([^"]+)"/)?.[1];
      const vstr = attrs.match(/office:string-value="([^"]*)"/)?.[1];
      const disp = (inner.match(/<text:p[^>]*>([\s\S]*?)<\/text:p>/)?.[1] ?? "")
        .replace(/<[^>]+>/g, "")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
      const vdate = attrs.match(/office:date-value="([^"]+)"/)?.[1];
      const vtime = attrs.match(/office:time-value="([^"]+)"/)?.[1];
      let value: unknown;
      if (vt === "float" || vt === "currency" || vt === "percentage")
        value = vnum !== undefined ? Number(vnum) : undefined;
      else if (vt === "boolean") value = vbool === "true";
      else if (vt === "string") value = vstr ?? disp;
      else if (vt === "date") {
        // Excel 序列日：距 1899-12-30 的天数
        const d = vdate ? Date.parse(`${vdate.slice(0, 10)}T00:00:00Z`) : NaN;
        value = Number.isNaN(d) ? disp : d / 86400000 + 25569;
      } else if (vt === "time") {
        const mm = vtime?.match(/PT(\d+)H(\d+)M([\d.]+)S/);
        value = mm ? (Number(mm[1]) * 3600 + Number(mm[2]) * 60 + Number(mm[3])) / 86400 : disp;
      } else value = disp !== "" ? disp : undefined;
      cellA = { vtype: vt, value, display: disp };
      col += Number(attrs.match(/table:number-columns-repeated="(\d+)"/)?.[1] ?? "1");
      cm = cellRe.exec(rowBody);
    }
    for (let k = 0; k < rowRep; k++) colA.push(cellA);
    m = rowRe.exec(body);
  }
  return colA;
}

async function main() {
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  const wb = new ExcelJS.Workbook();
  const ds = wb.addWorksheet("Data");
  for (const row of casesJson.data) ds.addRow(row);
  const cs = wb.addWorksheet("Cases");
  const all = [
    ...casesJson.cases.map((c) => c.formula),
    ...casesJson.errorCases.map((c) => c.formula),
  ];
  all.forEach((f, i) => {
    cs.getCell(`A${i + 1}`).value = { formula: toXlsxFormula(f) } as never;
  });
  const xlsxPath = `${OUT}/cases.xlsx`;
  await wb.xlsx.writeFile(xlsxPath);

  const soffice = "/opt/homebrew/bin/soffice";
  let version = "";
  try {
    version = execFileSync(soffice, ["--version"], { encoding: "utf8" }).trim();
  } catch {
    version = "unknown";
  }
  console.log("soffice:", version);
  rmSync(`${OUT}/cases.fods`, { force: true });
  execFileSync(
    soffice,
    ["--headless", "--norestore", "--convert-to", "fods", "--outdir", OUT, xlsxPath],
    { encoding: "utf8", timeout: 120000 },
  );
  const fods = readFileSync(`${OUT}/cases.fods`, "utf8");
  const cells = parseFods(fods);
  console.log(`LO cells parsed: ${cells.length}`);

  const univer = JSON.parse(readFileSync("results/cases.json", "utf8")) as {
    p1: { results: Array<{ actual: unknown }> };
  };
  const expectToVal = (e: Record<string, unknown>) =>
    e.t === "num" || e.t === "str" || e.t === "bool" || e.t === "err"
      ? e.v
      : e.t === "numRange"
        ? `[${e.min},${e.max})`
        : e;
  const rows = casesJson.cases.map((c, i) => ({
    i,
    fn: c.fn,
    formula: c.formula,
    expect: expectToVal(c.expect),
    lo: cells[i] ?? null,
    univer: univer.p1.results[i]?.actual,
  }));
  const univerErrs = (univer as unknown as { p1: { errorCases: Array<{ actual: unknown }> } }).p1
    .errorCases;
  const errRows = casesJson.errorCases.map((c, i) => ({
    id: c.id,
    formula: c.formula,
    expect: expectToVal(c.expect),
    lo: cells[150 + i] ?? null,
    univer: univerErrs[i]?.actual,
  }));

  // ── 规范化比较 ──
  // err 期望同时比对 typed value 与 display 文本（LO 用自有错误文本如 Err:502）
  const cmp = (
    expect: unknown,
    actual: unknown,
    display: string | undefined,
    exp: Record<string, unknown>,
  ): "eq" | "boolnum" | "neq" => {
    if (exp.t === "numRange") {
      const ok =
        typeof actual === "number" &&
        actual >= Number(exp.min) &&
        actual < Number(exp.max) &&
        (!exp.int || Number.isInteger(actual));
      return ok ? "eq" : "neq";
    }
    if (exp.t === "err") {
      return actual === expect || display === expect ? "eq" : "neq";
    }
    if (expect === actual) return "eq";
    if (typeof expect === "number" && typeof actual === "number")
      return Math.abs(expect - actual) <= 1e-6 ? "eq" : "neq";
    if (expect === true && actual === 1) return "boolnum";
    if (expect === false && actual === 0) return "boolnum";
    return "neq";
  };

  const disagreeLo: unknown[] = [];
  const disagreeUniver: unknown[] = [];
  const boolnumRows: string[] = [];
  rows.forEach((r, i) => {
    const e = casesJson.cases[i]?.expect;
    if (e === undefined) return;
    const cLo = cmp(r.expect, r.lo?.value ?? r.lo?.display, r.lo?.display, e);
    const cU = cmp(r.expect, r.univer, undefined, e);
    if (cLo === "boolnum" || cU === "boolnum") boolnumRows.push(r.fn);
    if (cLo === "neq")
      disagreeLo.push({ i: r.i, fn: r.fn, expect: r.expect, lo: r.lo, univer: r.univer });
    if (cU === "neq")
      disagreeUniver.push({ i: r.i, fn: r.fn, expect: r.expect, univer: r.univer, lo: r.lo });
  });
  const errCmp = errRows.map((r) => ({
    ...r,
    loMatch: r.lo?.display === r.expect || r.lo?.value === r.expect,
    univerMatch: r.univer === r.expect,
  }));

  writeFileSync(
    `${OUT}/three-way.json`,
    JSON.stringify(
      {
        version,
        rows,
        errRows: errCmp,
        disagreeLo,
        disagreeUniver,
        boolnumRows,
      },
      null,
      2,
    ),
  );
  console.log(
    `期望≠LO: ${disagreeLo.length}；期望≠Univer: ${disagreeUniver.length}；bool↔1/0: ${boolnumRows.length}`,
  );
  // 打印摘要
  for (const r of rows.slice(0, 12))
    console.log(
      `${String(r.i).padStart(3)} ${r.fn.padEnd(14)} exp=${JSON.stringify(r.expect)} lo=${JSON.stringify(r.lo?.value)}/${r.lo?.display} univer=${JSON.stringify(r.univer)}`,
    );
  process.exit(0);
}

await main();
