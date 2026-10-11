// xlsx → IWorkbookData 只读导入（07 §3 快照定影、ADR 0003）。
// 自研解析：fflate 解 zip + fast-xml-parser 读 workbook/sharedStrings/styles/sheetData。
// 覆盖：单元格值与公式（s/n/b/str/e/inlineStr）、数字格式（样式表 numFmt）、
// 合并单元格、列宽行高、冻结窗格、隐藏表。不支持的部件只计数进 unsupported。

import { posix } from "node:path";
import type { ICellData, IWorkbookData, IWorksheetData } from "@univerjs/core";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { unzipSync } from "fflate";
import { importObjects } from "./objects.ts";
import { importRules } from "./rule-codec.ts";

export class XlsxImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XlsxImportError";
  }
}

export interface XlsxPreservation {
  parts: Record<string, Uint8Array>;
  sheetParts: Record<string, { path: string; rid: string; sheetId: string }>;
  stylesPart: string;
}

export interface ImportedWorkbook {
  preservation?: XlsxPreservation;
  csv?: { encoding: string; delimiter: string; newline: string; trailingNewline: boolean };
  snapshot: IWorkbookData;
  /** 不支持部件的计数（图表/透视表/图片/宏等），进 overview。 */
  unsupported: Record<string, number>;
  /** 每张表的单元格总数（非空），进 overview。 */
  cellCounts: Record<string, number>;
  formulaCounts: Record<string, number>;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseTagValue: false,
  isArray: (tag) =>
    [
      "c",
      "row",
      "si",
      "sheet",
      "mergeCell",
      "col",
      "r",
      "numFmt",
      "xf",
      "font",
      "fill",
      "border",
      "sheetView",
    ].includes(tag),
});

type Xml = Record<string, unknown>;

const asArr = <T>(v: T | T[] | undefined): T[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];
const attr = (node: Xml, name: string): string | undefined => {
  const v = node[`@_${name}`];
  return typeof v === "string" || typeof v === "number" ? String(v) : undefined;
};

// ---------- 列/单元格地址 ----------

function colLettersToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

/** "B3" → {col:2,row:3}（1-based）；非法返回 undefined。 */
function cellAddr(ref: string): { col: number; row: number } | undefined {
  const m = /^([A-Za-z]+)(\d+)$/.exec(ref.replace(/\$/g, ""));
  if (!m) return undefined;
  return { col: colLettersToIndex(m[1] as string), row: Number(m[2]) };
}

// ---------- sharedStrings ----------

function readSharedStrings(xml: Xml | undefined): string[] {
  const items = asArr<Xml>((xml?.sst as Xml | undefined)?.si as Xml[] | undefined);
  return items.map(readRichText);
}

function readRichText(node: Xml): string {
  const text = (v: unknown): string => {
    if (typeof v === "object" && v !== null) return String((v as Xml)["#text"] ?? "");
    return String(v ?? "");
  };
  if (node.t !== undefined) return text(node.t);
  return asArr<Xml>(node.r as Xml[] | undefined)
    .map((r) => text(r.t))
    .join("");
}

// ---------- styles（只取 numFmt 格式码 → Univer styles.n.pattern） ----------

import { importFilterLinks } from "./filter-links.ts";
import { shiftFormula } from "./formula-shift.ts";
import { BORDER_STYLES } from "./style-constants.ts";
import { resolveColor, themeColors } from "./theme.ts";

const BUILTIN_NUMFMT: Record<number, string> = {
  9: "0%",
  10: "0.00%",
  11: "0.00E+00",
  14: "m/d/yyyy",
  15: "d-mmm-yy",
  16: "d-mmm",
  17: "mmm-yy",
  18: "h:mm AM/PM",
  19: "h:mm:ss AM/PM",
  20: "h:mm",
  21: "h:mm:ss",
  22: "m/d/yyyy h:mm",
  37: "#,##0;(#,##0)",
  38: "#,##0;[Red](#,##0)",
  39: "#,##0.00;(#,##0.00)",
  40: "#,##0.00;[Red](#,##0.00)",
  44: '_-¥* #,##0.00_-;-¥* #,##0.00_-;_-¥* "-"??_-;_-@_-',
  45: "mm:ss",
  46: "[h]:mm:ss",
  47: "mmss.0",
  48: "##0.0E+0",
  49: "@",
};

interface StylesOut {
  /** Univer styles 表：key = `s{cellXfs 下标}`。 */
  styles: Record<string, { n?: { pattern: string } } & Record<string, unknown>>;
  /** 单元格 s 属性（cellXfs 下标）→ Univer 样式 id；无格式则 undefined。 */
  xfToStyle: (xfIndex: number) => string | undefined;
}

function readStyles(xml: Xml | undefined, theme: Xml | undefined): StylesOut {
  const sheet = (xml?.styleSheet as Xml | undefined) ?? {};
  const numfmts = new Map<number, string>();
  for (const nf of asArr<Xml>((sheet.numFmts as Xml | undefined)?.numFmt as Xml[] | undefined)) {
    const id = Number(attr(nf, "numFmtId"));
    const code = attr(nf, "formatCode");
    if (Number.isInteger(id) && code !== undefined) numfmts.set(id, code);
  }
  const styles: StylesOut["styles"] = {};
  const xfStyle = new Map<number, string>();
  const fonts = asArr<Xml>((sheet.fonts as Xml | undefined)?.font as Xml[] | undefined);
  const borders = asArr<Xml>((sheet.borders as Xml | undefined)?.border as Xml[] | undefined);
  const fills = asArr<Xml>((sheet.fills as Xml | undefined)?.fill as Xml[] | undefined);
  const palette = themeColors(theme);
  const rgb = (node: unknown) => resolveColor(node, palette);
  const on = (node: unknown): boolean =>
    node !== undefined &&
    !(typeof node === "object" && node && ["0", "false"].includes(attr(node as Xml, "val") ?? ""));
  const xfs = asArr<Xml>((sheet.cellXfs as Xml | undefined)?.xf as Xml[] | undefined);
  xfs.forEach((xf, i) => {
    const numFmtId = Number(attr(xf, "numFmtId") ?? 0);
    const pattern = numfmts.get(numFmtId) ?? BUILTIN_NUMFMT[numFmtId];
    const key = `s${i}`;
    // 字体、纯色填充、对齐：映射为 Univer 样式，供工作台、截图与代理读取（07 §4.4）
    const style: Record<string, unknown> = pattern === undefined ? {} : { n: { pattern } };
    const font = fonts[Number(attr(xf, "fontId") ?? 0)];
    if (font) {
      if (on(font.b)) style.bl = 1;
      if (on(font.i)) style.it = 1;
      if (font.u !== undefined && attr((font.u as Xml) ?? {}, "val") !== "none")
        style.ul = { s: 1 };
      if (on(font.strike)) style.st = { s: 1 };
      const sz = Number(attr((font.sz as Xml | undefined) ?? {}, "val"));
      if (Number.isFinite(sz) && sz > 0) style.fs = sz;
      const ff = attr((font.name as Xml | undefined) ?? {}, "val");
      if (ff) style.ff = ff;
      const cl = rgb(font.color);
      if (cl) style.cl = cl;
    }
    const pf = fills[Number(attr(xf, "fillId") ?? 0)]?.patternFill as Xml | undefined;
    const bg = pf && attr(pf, "patternType") === "solid" ? rgb(pf.fgColor) : undefined;
    if (bg) style.bg = bg;
    const border = borders[Number(attr(xf, "borderId") ?? 0)];
    if (border) {
      const bd: Record<string, unknown> = {};
      for (const [side, key] of [
        ["top", "t"],
        ["bottom", "b"],
        ["left", "l"],
        ["right", "r"],
      ]) {
        const node = border[side!] as Xml | undefined;
        if (!node) continue;
        const styleName = attr(node, "style"),
          line = BORDER_STYLES.indexOf(styleName as (typeof BORDER_STYLES)[number]);
        if (line > 0) bd[key!] = { s: line, cl: rgb(node.color) ?? { rgb: "#000000" } };
      }
      if (Object.keys(bd).length) style.bd = bd;
    }
    const al = xf.alignment as Xml | undefined;
    if (al) {
      const ht = { left: 1, center: 2, right: 3 }[attr(al, "horizontal") ?? ""];
      if (ht) style.ht = ht;
      const vt = { top: 1, center: 2, bottom: 3 }[attr(al, "vertical") ?? ""];
      if (vt) style.vt = vt;
      if (Number(attr(al, "indent")) > 0) style.pd = { l: Number(attr(al, "indent")) * 21 };
      if (["1", "true"].includes(attr(al, "wrapText") ?? "")) style.tb = 3;
    }
    styles[key] = style as StylesOut["styles"][string];
    xfStyle.set(i, key);
  });
  return { styles, xfToStyle: (i) => xfStyle.get(i) };
}

// ---------- worksheet ----------

interface ParsedCell {
  data: ICellData;
  isFormula: boolean;
}

function parseCell(node: Xml, sst: string[], xfToStyle: StylesOut["xfToStyle"]): ParsedCell | null {
  const t = attr(node, "t") ?? "n";
  const sAttr = attr(node, "s");
  const styleId = sAttr !== undefined ? xfToStyle(Number(sAttr)) : undefined;
  const cell: ICellData = {};
  if (styleId !== undefined) cell.s = styleId;

  const fNode = node.f as Xml | string | number | undefined;
  let isFormula = false;
  if (fNode !== undefined) {
    const fText =
      typeof fNode === "object" ? (fNode["#text"] as string | number | undefined) : fNode;
    const fType = typeof fNode === "object" ? attr(fNode as Xml, "t") : undefined;
    // 共享公式从属项在 parseWorksheet 的第二遍按主公式展开。
    if (fText !== undefined && String(fText) !== "") {
      cell.f = `=${String(fText)}`;
      isFormula = true;
    } else if (fType === "shared") {
      isFormula = true; // 计入公式数，但无 f 文本
    }
  }

  const vNode = node.v;
  const raw = vNode === undefined || vNode === null ? undefined : String(vNode);
  switch (t) {
    case "s": {
      const idx = Number(raw ?? -1);
      if (!Number.isInteger(idx) || sst[idx] === undefined) {
        throw new XlsxImportError("单元格引用了不存在的共享字符串");
      }
      cell.v = sst[idx];
      cell.t = 1; // CellValueType.STRING
      break;
    }
    case "str":
      cell.v = raw ?? "";
      cell.t = 1;
      break;
    case "inlineStr": {
      const is = node.is as Xml | undefined;
      cell.v = is ? readRichText(is) : "";
      cell.t = 1;
      break;
    }
    case "b":
      cell.v = raw === "1" || raw === "true";
      cell.t = 3; // CellValueType.BOOLEAN
      break;
    case "e":
      cell.v = raw ?? "#ERROR";
      cell.t = 1;
      break;
    case "d":
      cell.v = raw ?? "";
      cell.t = 1;
      break;
    default: {
      // n / 缺省
      const num = raw === undefined || raw === "" ? undefined : Number(raw);
      if (num !== undefined && Number.isFinite(num)) {
        cell.v = num;
        cell.t = 2; // NUMBER
      } else if (raw !== undefined && raw !== "") {
        cell.v = raw;
        cell.t = 2;
      }
      break;
    }
  }
  if (cell.v === undefined && cell.f === undefined && cell.s === undefined) return null;
  return { data: cell, isFormula };
}

interface ParsedSheet {
  data: Partial<IWorksheetData>;
  cellCount: number;
  formulaCount: number;
}

function parseWorksheet(xml: Xml, sst: string[], xfToStyle: StylesOut["xfToStyle"]): ParsedSheet {
  const sheet = (xml.worksheet as Xml | undefined) ?? {};
  const cellData: Record<number, Record<number, ICellData>> = {};
  const rowData: Record<number, { h?: number; hd?: number; custom?: Record<string, unknown> }> = {};
  const columnData: Record<number, { w?: number; hd?: number; custom?: Record<string, unknown> }> =
    {};
  let cellCount = 0;
  let formulaCount = 0;
  let maxRow = 0;
  let maxCol = 0;

  // 冻结窗格：<pane ySplit= xSplit= topLeftCell state="frozen"/>
  let freeze = { xSplit: 0, ySplit: 0, startRow: 0, startColumn: 0 };
  const views = sheet.sheetViews as Xml | undefined;
  const pane = asArr<Xml>(views?.sheetView as Xml[] | undefined)[0]?.pane as Xml | undefined;
  if (pane !== undefined && attr(pane, "state") === "frozen") {
    const tl = cellAddr(attr(pane, "topLeftCell") ?? "A1");
    freeze = {
      xSplit: Number(attr(pane, "xSplit") ?? 0),
      ySplit: Number(attr(pane, "ySplit") ?? 0),
      startRow: (tl?.row ?? 1) - 1,
      startColumn: (tl?.col ?? 1) - 1,
    };
  }

  // 列宽/隐藏列
  const cols = sheet.cols as Xml | undefined;
  for (const col of asArr<Xml>(cols?.col as Xml[] | undefined)) {
    const min = Number(attr(col, "min") ?? 0) - 1;
    const max = Number(attr(col, "max") ?? 0) - 1;
    const w = attr(col, "width");
    const hidden = attr(col, "hidden") === "1" || attr(col, "hidden") === "true";
    for (let c = min; c <= max && c < 16384; c++) {
      columnData[c] = {
        ...(w !== undefined ? { w: Math.round(Number(w) * 7) } : {}),
        ...(hidden ? { hd: 1 } : {}),
        ...(Number(attr(col, "outlineLevel")) > 0
          ? { custom: { excelmanusOutlineLevel: Number(attr(col, "outlineLevel")) } }
          : {}),
      };
    }
  }

  const shared = new Map<string, { formula: string; row: number; col: number }>();
  for (const row of asArr<Xml>((sheet.sheetData as Xml | undefined)?.row as Xml[] | undefined))
    for (const cell of asArr<Xml>(row.c as Xml[] | undefined)) {
      const f = cell.f as Xml | undefined,
        ref = cellAddr(attr(cell, "r") ?? "");
      if (f && typeof f === "object" && attr(f, "t") === "shared" && f["#text"] && ref)
        shared.set(attr(f, "si") ?? "", {
          formula: `=${String(f["#text"])}`,
          row: ref.row,
          col: ref.col,
        });
    }
  for (const row of asArr<Xml>((sheet.sheetData as Xml | undefined)?.row as Xml[] | undefined)) {
    const r = Number(attr(row, "r")) - 1;
    if (!Number.isInteger(r) || r < 0) continue;
    const ht = attr(row, "ht");
    const hd = attr(row, "hidden");
    if (ht !== undefined || hd === "1" || hd === "true" || Number(attr(row, "outlineLevel")) > 0) {
      rowData[r] = {
        ...(ht !== undefined ? { h: Number(ht) } : {}),
        ...(hd === "1" || hd === "true" ? { hd: 1 } : {}),
        ...(Number(attr(row, "outlineLevel")) > 0
          ? { custom: { excelmanusOutlineLevel: Number(attr(row, "outlineLevel")) } }
          : {}),
      };
    }
    for (const c of asArr<Xml>(row.c as Xml[] | undefined)) {
      const ref = attr(c, "r");
      const addr = ref !== undefined ? cellAddr(ref) : undefined;
      if (!addr) continue;
      const parsed = parseCell(c, sst, xfToStyle);
      if (!parsed) continue;
      const formulaNode = c.f as Xml | undefined;
      if (
        !parsed.data.f &&
        formulaNode &&
        typeof formulaNode === "object" &&
        attr(formulaNode, "t") === "shared"
      ) {
        const master = shared.get(attr(formulaNode, "si") ?? "");
        if (master)
          parsed.data.f = shiftFormula(
            master.formula,
            addr.col - master.col,
            addr.row - master.row,
          );
        else throw new XlsxImportError("共享公式缺少主公式，不能安全读取");
      }
      const cellRow = cellData[addr.row - 1] ?? {};
      cellData[addr.row - 1] = cellRow;
      cellRow[addr.col - 1] = parsed.data;
      cellCount += 1;
      if (parsed.isFormula) formulaCount += 1;
      maxRow = Math.max(maxRow, addr.row);
      maxCol = Math.max(maxCol, addr.col);
    }
  }

  // dimension ref 优先（可能含样式空单元格范围）
  const dimRef = attr((sheet.dimension as Xml | undefined) ?? {}, "ref");
  const dimEnd = dimRef?.includes(":") === true ? cellAddr(dimRef.split(":")[1] ?? "") : undefined;
  const rowCount = Math.max(dimEnd?.row ?? 0, maxRow, 1);
  const columnCount = Math.max(dimEnd?.col ?? 0, maxCol, 1);

  const mergeData = asArr<Xml>(
    (sheet.mergeCells as Xml | undefined)?.mergeCell as Xml[] | undefined,
  )
    .map((m) => {
      const ref = attr(m, "ref") ?? "";
      const [a, b] = ref.split(":");
      const s = a !== undefined ? cellAddr(a) : undefined;
      const e = b !== undefined ? cellAddr(b) : s;
      if (!s || !e) return undefined;
      return {
        startRow: s.row - 1,
        startColumn: s.col - 1,
        endRow: e.row - 1,
        endColumn: e.col - 1,
      };
    })
    .filter((m): m is NonNullable<typeof m> => m !== undefined);

  return {
    data: {
      rowCount,
      columnCount,
      cellData: cellData as IWorksheetData["cellData"],
      ...(mergeData.length > 0 ? { mergeData } : {}),
      ...(Object.keys(rowData).length > 0 ? { rowData: rowData as IWorksheetData["rowData"] } : {}),
      ...(Object.keys(columnData).length > 0
        ? { columnData: columnData as IWorksheetData["columnData"] }
        : {}),
      freeze,
      showGridlines: 1,
    },
    cellCount,
    formulaCount,
  };
}

// ---------- 入口 ----------

const UNSUPPORTED_PARTS: [RegExp, string][] = [
  [/^xl\/charts\//, "charts"],
  [/^xl\/pivot/, "pivotTables"],
  [/^xl\/drawings\/(?!_rels)/, "drawings"],
  [/^xl\/media\//, "images"],
  [/^xl\/vbaProject\.bin$/i, "macros"],
  [/^xl\/externalLinks\//, "externalLinks"],
  [/^xl\/comments/, "comments"],
  [/^xl\/ctrlProps\//, "activeX"],
];

export function importXlsx(bytes: Uint8Array, name: string): ImportedWorkbook {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new XlsxImportError("不是有效的 xlsx（zip 解包失败）");
  }
  const readXmlDirect = (p: string, required = false): Xml | undefined => {
    const raw = files[p];
    if (!raw) {
      if (required) throw new XlsxImportError("缺少工作簿引用的 XML 部件");
      return undefined;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    if (/<!DOCTYPE|<!ENTITY/i.test(text))
      throw new XlsxImportError("工作簿 XML 不允许 DTD 或实体声明");
    if (XMLValidator.validate(text) !== true) {
      throw new XlsxImportError("工作簿 XML 部件格式损坏");
    }
    try {
      return parser.parse(text) as Xml;
    } catch {
      throw new XlsxImportError("工作簿 XML 部件无法解析");
    }
  };

  const wbXml = readXmlDirect("xl/workbook.xml");
  if (!wbXml) throw new XlsxImportError("缺少 xl/workbook.xml");
  const relsXml = readXmlDirect("xl/_rels/workbook.xml.rels", true);
  const relTargets = new Map<string, string>();
  const relTypes = new Map<string, string>();
  for (const rel of asArr<Xml>(
    (relsXml?.Relationships as Xml | undefined)?.Relationship as Xml[] | undefined,
  )) {
    const id = attr(rel, "Id");
    const target = attr(rel, "Target");
    if (!id || !target || attr(rel, "TargetMode") === "External") continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || /[\\?#]/.test(target)) {
      throw new XlsxImportError("工作簿部件关系路径不合法");
    }
    const part = posix.normalize(target.startsWith("/") ? target.slice(1) : `xl/${target}`);
    if (part === ".." || part.startsWith("../")) {
      throw new XlsxImportError("工作簿部件关系越出包边界");
    }
    relTargets.set(id, part);
    const type = attr(rel, "Type")?.split("/").pop();
    if (type) relTypes.set(type, part);
  }

  const sstPart = relTypes.get("sharedStrings");
  const stylesPart = relTypes.get("styles");
  const sst = readSharedStrings(readXmlDirect(sstPart ?? "xl/sharedStrings.xml", !!sstPart));
  const styles = readStyles(
    readXmlDirect(stylesPart ?? "xl/styles.xml", !!stylesPart),
    readXmlDirect(relTypes.get("theme") ?? "xl/theme/theme1.xml"),
  );

  const sheetsArr = asArr<Xml>(
    ((wbXml.workbook as Xml | undefined)?.sheets as Xml | undefined)?.sheet as Xml[] | undefined,
  );
  if (sheetsArr.length === 0) throw new XlsxImportError("workbook 中没有工作表");

  const sheetParts: XlsxPreservation["sheetParts"] = {};
  const sheets: Record<string, Partial<IWorksheetData>> = {};
  const sheetOrder: string[] = [];
  const cellCounts: Record<string, number> = {};
  const formulaCounts: Record<string, number> = {};
  sheetsArr.forEach((s, i) => {
    const rid = attr(s, "id") ?? attr(s, "r:id");
    const target = rid !== undefined ? relTargets.get(rid) : undefined;
    const sheetId = `s${i}`;
    sheetOrder.push(sheetId);
    const sheetName = attr(s, "name") ?? `Sheet${i + 1}`;
    const state = attr(s, "state");
    const hidden = state === "hidden" ? 1 : state === "veryHidden" ? 2 : 0;
    if (!target) throw new XlsxImportError("工作表缺少有效的内部部件关系");
    sheetParts[sheetId] = {
      path: target,
      rid: rid as string,
      sheetId: attr(s, "sheetId") ?? String(i + 1),
    };
    const sheetXml = readXmlDirect(target, true);
    if (!sheetXml?.worksheet) throw new XlsxImportError("不支持的工作表部件或部件格式损坏");
    const parsed = parseWorksheet(sheetXml, sst, styles.xfToStyle);
    cellCounts[sheetName] = parsed.cellCount;
    formulaCounts[sheetName] = parsed.formulaCount;
    sheets[sheetId] = {
      id: sheetId,
      name: sheetName,
      ...parsed.data,
      ...(hidden !== 0 ? { hidden } : {}),
    };
  });

  const unsupported: Record<string, number> = {};
  for (const name_ of Object.keys(files)) {
    for (const [re, key] of UNSUPPORTED_PARTS) {
      if (re.test(name_)) unsupported[key] = (unsupported[key] ?? 0) + 1;
    }
  }

  importObjects(files, sheetParts, sheets);
  return {
    preservation: { parts: files, sheetParts, stylesPart: stylesPart ?? "xl/styles.xml" },
    snapshot: {
      id: `wbk_${name.replace(/\W+/g, "_")}`,
      name,
      appVersion: "1.0.2",
      locale: "zh-CN" as never,
      styles: styles.styles as never,
      resources: [
        ...(importRules(files, sheetParts, stylesPart ?? "xl/styles.xml") ?? []),
        importFilterLinks(files, sheetParts, sheets),
      ],
      sheetOrder,
      sheets,
    },
    unsupported,
    cellCounts,
    formulaCounts,
  };
}
