import { posix } from "node:path";
import { indexToCol, type RangeRef, type StructuralOp } from "@excelmanus/core";
import { FileOperationError } from "@excelmanus/kernel";
import type { ICellData, IWorkbookData, IWorksheetData } from "@univerjs/core";
import { zipSync } from "fflate";
import type { DocMutation } from "./engine.ts";
import { exportFilterLinks } from "./filter-links.ts";
import { exportImages, exportObjects, objectsOf } from "./objects.ts";
import type { ChangeOp } from "./ops.ts";
import { exportRules } from "./rule-codec.ts";
import { StyleWriter } from "./styles.ts";
import { type ImportedWorkbook, importXlsx, type XlsxPreservation } from "./xlsx.ts";
import {
  bytesOf,
  elements,
  escapeXml,
  replaceElement,
  setAttribute,
  textOf,
  xmlAttrs,
} from "./xml.ts";

const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const TYPE_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
const cellData = (
  s: Partial<IWorksheetData> | undefined,
): Record<number, Record<number, ICellData>> =>
  (s?.cellData as Record<number, Record<number, ICellData>>) ?? {};
const cellsEqual = (a: ICellData | undefined, b: ICellData | undefined): boolean =>
  JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
function unsupported(part: string): never {
  throw new FileOperationError("UNSUPPORTED_FEATURE", `无法保证保真写回，涉及部件：${part}`);
}
const removeAttribute = (tag: string, name: string): string =>
  tag.replace(new RegExp(`\\s${name}=(?:"[^"]*"|'[^']*')`), "");
/** "B3" / "$B$3" → 0 起算 {r,c}。 */
function cellAddr(ref: string): { r: number; c: number } | undefined {
  const m = /^\$?([A-Z]{1,3})\$?(\d+)$/.exec(ref);
  if (!m?.[1]) return undefined;
  let c = 0;
  for (const ch of m[1]) c = c * 26 + ch.charCodeAt(0) - 64;
  return { r: Number(m[2]) - 1, c: c - 1 };
}
const NON_CELL_IN_ROW = /<(?!\/)(?!c(?:\s|>|\/))/i;
const rowExtras = (inner: string): boolean =>
  NON_CELL_IN_ROW.test(inner.replace(/<c(?:\s|\/>)[\s\S]*?<\/c>|<c(?:\s[^>]*)?\/>/g, ""));
/** 整表按快照重写时，模型无法无损表达的单元格（错误值、日期、富文本）与行内扩展只能拒绝。 */
function assertRebuildable(xml: string, path: string): void {
  for (const row of elements(xml, "row"))
    if (rowExtras(row.inner)) unsupported(`${path}:row extension`);
  for (const c of elements(xml, "c")) {
    const t = xmlAttrs(c.open).t;
    if (t && !["n", "s", "str", "b", "inlineStr"].includes(t)) unsupported(`${path}:cell type`);
    if (c.inner.includes("<r>") || c.inner.includes("<is><r>")) unsupported(`${path}:rich text`);
  }
}

/** 自上次检查点以来已提交修订（及本次提交）的写集汇总：判定哪些表、哪些单元格被修改。 */
export interface SheetChanges {
  ranges: RangeRef[];
  /** 有行列插删/移动的表：坐标已平移，整表按快照重写。 */
  structural: Set<string>;
}
/**
 * 汇总已提交修订的写集。引擎来源修订不算作者修改，但仍要把它的区域交给导出器，
 * 这样异步重算能够只刷新对应公式单元格的 <v> 缓存；否则仅有引擎修订时会继续保留旧缓存。
 */
export function pendingChanges(
  records: Array<{
    writeSet: { ranges: RangeRef[]; structural: StructuralOp[] };
    sourceKind: string;
  }>,
): SheetChanges {
  const structural = new Set<string>();
  const ranges: RangeRef[] = [];
  for (const rec of records) {
    for (const s of rec.writeSet.structural)
      if (/^(?:insert|delete)(?:Rows|Cols)$|^moveRange$/.test(s.kind)) structural.add(s.sheetId);
    ranges.push(...rec.writeSet.ranges);
  }
  return { ranges, structural };
}

export function assertWritable(
  imported: ImportedWorkbook,
  ranges: RangeRef[],
  ops: ChangeOp[] | undefined,
  mutations: DocMutation[],
  before: IWorkbookData,
): void {
  if (imported.csv) {
    if (
      ops
        ? ops.some(
            (o) =>
              ![
                "cells.set",
                "cells.clear",
                "rows.insert",
                "rows.delete",
                "cols.insert",
                "cols.delete",
              ].includes(o.op) ||
              (o.op === "cells.clear" && o.what !== "contents"),
          )
        : mutations.some((m) => m.id !== "sheet.mutation.set-range-values")
    )
      unsupported("CSV 不支持格式、工作表或对象操作；请另存为 xlsx");
    return;
  }
  const p = imported.preservation;
  if (!p) unsupported("缺少原始 OOXML 部件");
  if (Object.keys(p.parts).some((n) => /^_xmlsignatures\//i.test(n))) unsupported("_xmlsignatures");
  for (const [id, ref] of Object.entries(p.sheetParts)) {
    if (!ranges.some((r) => r.sheetId === id || r.sheetId === "*")) continue;
    const xml = textOf(p.parts[ref.path] as Uint8Array);
    if (!/<worksheet(?:\s|>)/.test(xml)) unsupported(ref.path);
    if (
      ops?.some(
        (o) => o.op === "sheet.copy" && (o.sheet === id || o.sheet === before.sheets[id]?.name),
      )
    ) {
      assertRebuildable(xml, ref.path);
      if (
        /<(?:drawing|legacyDrawing|tableParts|conditionalFormatting|dataValidations|extLst|autoFilter|hyperlinks|oleObjects)\b/.test(
          xml,
        )
      )
        unsupported("含复杂对象的工作表不能保真复制");
    }
    const structural = ops
      ? ops.some(
          (o) =>
            /^(rows|cols)\.(insert|delete)$|^sheet.delete$/.test(o.op) &&
            "sheet" in o &&
            (o.sheet === id || o.sheet === before.sheets[id]?.name),
        )
      : mutations.some((m) => /(?:insert|remove)-(?:row|col|sheet)|move-range/.test(m.id));
    if (
      structural &&
      (objectsOf(before.sheets[id]).charts.length || objectsOf(before.sheets[id]).images.length)
    )
      unsupported("图表锚点和引用不能在本次结构操作中确定性平移，请先移除图表或另存副本");
    if (structural) {
      // 结构操作会整表按快照重写单元格：模型无法表达的单元格类型与行内扩展只能拒绝
      assertRebuildable(xml, ref.path);
      for (const row of elements(xml, "row"))
        if (
          Object.keys(xmlAttrs(row.open)).some(
            (key) => !["r", "ht", "hidden", "customHeight", "spans"].includes(key),
          )
        )
          unsupported(`${ref.path}:row metadata`);
      for (const col of elements(xml, "col"))
        if (
          Object.keys(xmlAttrs(col.open)).some(
            (key) => !["min", "max", "width", "customWidth", "hidden"].includes(key),
          )
        )
          unsupported(`${ref.path}:column metadata`);
    }
    if (
      (ops?.some((o) => o.op === "merge") ||
        mutations.some((m) => m.id.includes("add-worksheet-merge"))) &&
      /<tableParts\b/.test(xml)
    )
      unsupported(`${ref.path}:tableParts`);
    const related = `${posix.dirname(ref.path)}/_rels/${posix.basename(ref.path)}.rels`;
    if (
      structural &&
      (/<(?:drawing|legacyDrawing|tableParts|pivotTable|conditionalFormatting|dataValidations|extLst|autoFilter|hyperlinks)\b/.test(
        xml,
      ) ||
        p.parts[related])
    )
      unsupported(ref.path);
    if (
      structural &&
      /<(?:definedNames|externalReferences)\b/.test(
        textOf(p.parts["xl/workbook.xml"] as Uint8Array),
      )
    )
      unsupported("xl/workbook.xml:definedNames/externalReferences");
    if (
      structural &&
      Object.keys(p.parts).some((n) => /^xl\/(?:charts|pivot|tables|drawings)\//.test(n))
    )
      unsupported("xl/charts,pivot,tables,drawings（尚无引用平移支持）");
    // 共享/数组公式在结构平移时无法从读模型重建；非结构写入由 renderSheet 逐格判定
    if (structural && /<f\b[^>]*\bt=["'](?:shared|array|dataTable)["']/.test(xml))
      unsupported(`${ref.path}:shared/array/dataTable formula`);
    if (structural && /<(?:sheetPr|sheetFormatPr)\b[^>]*(?:outline|summary)/.test(xml))
      unsupported(`${ref.path}:outline`);
  }
  const renames = [
    ...(ops?.filter((o) => o.op === "sheet.rename") ?? []),
    ...mutations.filter((m) => m.id === "sheet.mutation.set-worksheet-name"),
  ];
  if (
    renames.length &&
    Object.keys(p.parts).some((n) => /^xl\/(?:charts|pivot|tables|externalLinks)\//.test(n))
  )
    unsupported("工作表重命名涉及对象引用");
  if (renames.length && /<definedNames\b/.test(textOf(p.parts["xl/workbook.xml"] as Uint8Array)))
    unsupported("xl/workbook.xml:definedNames");
  if (
    mutations.some(
      (m) =>
        !/^sheet\.mutation\.(?:set-range-values|set-worksheet-name|set-worksheet-hidden|set-worksheet-order|insert-sheet|remove-sheet|insert-row|remove-rows|insert-col|remove-col|add-worksheet-merge|remove-worksheet-merge|set-frozen|set-worksheet-row-count|set-worksheet-column-count|set-worksheet-row-height|set-worksheet-row-is-auto-height|set-worksheet-row-auto-height|set-row-hidden|set-row-visible|set-worksheet-col-width|set-col-hidden|set-col-visible)$/.test(
          m.id,
        ),
    )
  )
    unsupported("尚未支持写回的 mutation");
}

function rangeRef(s: {
  startRow: number;
  endRow: number;
  startColumn: number;
  endColumn: number;
}): string {
  return `${indexToCol(s.startColumn + 1)}${s.startRow + 1}:${indexToCol(s.endColumn + 1)}${s.endRow + 1}`;
}
const ERROR_VALUE = /^#(?:NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|SPILL!|CALC!|GETTING_DATA)$/;
function renderCell(
  cell: ICellData,
  ref: string,
  style: number,
  oldCell: ICellData | undefined,
): string {
  const s = style ? ` s="${style}"` : "";
  if (cell.p && !cell.v) unsupported("单元格富文本编辑");
  const f = cell.f ? `<f>${escapeXml(cell.f.replace(/^=/, ""))}</f>` : "";
  if (cell.f) {
    // 引擎计算值作为缓存；公式刚改而值未变，说明引擎尚未重算，不发布旧值（打开时全量重算兜底）
    const v = cell.v;
    const stale = cell.f !== oldCell?.f && v === oldCell?.v;
    if (stale || v == null || v === "") return `<c r="${ref}"${s}>${f}</c>`;
    if (typeof v === "boolean") return `<c r="${ref}"${s} t="b">${f}<v>${v ? 1 : 0}</v></c>`;
    if (typeof v === "number")
      return Number.isFinite(v)
        ? `<c r="${ref}"${s}>${f}<v>${v}</v></c>`
        : `<c r="${ref}"${s}>${f}</c>`;
    const text = String(v);
    if ([...text].some((ch) => ch.charCodeAt(0) < 32 && ![9, 10, 13].includes(ch.charCodeAt(0))))
      return `<c r="${ref}"${s}>${f}</c>`;
    return `<c r="${ref}"${s} t="${ERROR_VALUE.test(text) ? "e" : "str"}">${f}<v>${escapeXml(text)}</v></c>`;
  }
  if (cell.v == null) return style ? `<c r="${ref}"${s}/>` : "";
  if (typeof cell.v === "string") {
    if ([...cell.v].some((ch) => ch.charCodeAt(0) < 32 && ![9, 10, 13].includes(ch.charCodeAt(0))))
      unsupported("XML 不支持的控制字符");
    return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escapeXml(cell.v)}</t></is></c>`;
  }
  if (typeof cell.v === "boolean") return `<c r="${ref}"${s} t="b"><v>${cell.v ? 1 : 0}</v></c>`;
  if (!Number.isFinite(cell.v)) unsupported("非有限数字");
  return `<c r="${ref}"${s}><v>${cell.v}</v></c>`;
}

/**
 * 未被写入的公式格：引擎重算出新值时只替换 <v> 缓存（及值类型 t），<f> 与其他属性原样保留；
 * 值无法无损表示或未重算时保留原字节。
 */
function refreshCache(
  raw: string,
  cell: ICellData | undefined,
  old: ICellData | undefined,
): string {
  if (!cell?.f || cell.f !== old?.f || cell.v === old?.v || cell.v == null || cell.v === "")
    return raw;
  const node = elements(raw, "c")[0];
  if (!node || node.open.endsWith("/>")) return raw;
  const v = cell.v;
  let t: string | undefined;
  let text: string;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return raw;
    text = String(v);
  } else if (typeof v === "boolean") {
    t = "b";
    text = v ? "1" : "0";
  } else {
    text = String(v);
    if ([...text].some((ch) => ch.charCodeAt(0) < 32 && ![9, 10, 13].includes(ch.charCodeAt(0))))
      return raw;
    t = ERROR_VALUE.test(text) ? "e" : "str";
  }
  const open = t ? setAttribute(node.open, "t", t) : removeAttribute(node.open, "t");
  const cached = elements(node.inner, "v")[0];
  const inner = cached
    ? `${node.inner.slice(0, cached.start)}<v>${escapeXml(text)}</v>${node.inner.slice(cached.end)}`
    : `${node.inner}<v>${escapeXml(text)}</v>`;
  return `${open}${inner}</c>`;
}

interface RenderState {
  /** 写出了新的/改动的公式。 */
  formulaWritten: boolean;
  /** 原始公式格被改写为非公式（calcChain 失效）。 */
  formulaSetChanged: boolean;
}
interface RenderOptions {
  /** 该格是否出现在已提交修订的写集中；未出现的格逐字节保留原 XML。 */
  touched: (r: number, c: number) => boolean;
  /** 有行列插删：原始行/格坐标失效，整表按快照重建。 */
  structural: boolean;
  state: RenderState;
}
type Box = { r0: number; c0: number; r1: number; c1: number };
function boxOf(ref: string): Box | undefined {
  const [a, b = a] = ref.split(":");
  const s = cellAddr(a ?? "");
  const e = cellAddr(b ?? "");
  return s && e ? { r0: s.r, c0: s.c, r1: e.r, c1: e.c } : undefined;
}
type RawRow = { open: string; inner: string; raw: string };
interface ParsedSheet {
  rows: Map<number, RawRow>;
  cells: Map<number, Map<number, string>>;
  sharedMasters: Set<string>;
  arrays: Box[];
}
function parseSheet(xml: string): ParsedSheet {
  const rows = new Map<number, RawRow>();
  const cells = new Map<number, Map<number, string>>();
  const sharedMasters = new Set<string>();
  const arrays: Box[] = [];
  for (const row of elements(elements(xml, "sheetData")[0]?.inner ?? "", "row")) {
    const r = Number(xmlAttrs(row.open).r) - 1;
    if (!Number.isInteger(r) || r < 0) unsupported("省略行号的 <row>");
    rows.set(r, row);
    const inRow = new Map<number, string>();
    for (const c of elements(row.inner, "c")) {
      const at = cellAddr(xmlAttrs(c.open).r ?? "");
      if (!at || at.r !== r) unsupported(`省略或错位的单元格地址（第 ${r + 1} 行）`);
      inRow.set(at.c, c.raw);
      const f = elements(c.inner, "f")[0];
      const fa = f ? xmlAttrs(f.open) : {};
      if (fa.t === "shared" && fa.ref) sharedMasters.add(`${at.r}:${at.c}`);
      if ((fa.t === "array" || fa.t === "dataTable") && fa.ref) {
        const box = boxOf(fa.ref);
        if (box) arrays.push(box);
      }
    }
    cells.set(r, inRow);
  }
  return { rows, cells, sharedMasters, arrays };
}
/**
 * 写集中的一个格如何写回：keep = 原字节，restyle = 只改 s（并刷新缓存），encode = 按模型重写。
 * 无法保真改写（格元数据/扩展、共享公式主格、数组公式区域）时拒绝；提交时与检查点共用此判定。
 */
function rewriteKind(
  p: ParsedSheet,
  r: number,
  c: number,
  raw: string | undefined,
  cell: ICellData | undefined,
  oldCell: ICellData | undefined,
  structural: boolean,
): "keep" | "restyle" | "encode" {
  const ref = `${indexToCol(c + 1)}${r + 1}`;
  if (raw !== undefined && !cell && !oldCell) return "keep"; // 模型未建模的空/样式格
  if (raw !== undefined && cell && cellsEqual(cell, oldCell)) return "keep";
  const node = raw !== undefined ? elements(raw, "c")[0] : undefined;
  const sameContent =
    !!cell &&
    (cell.f
      ? cell.f === oldCell?.f
      : !oldCell?.f && cell.v === oldCell?.v && cell.t === oldCell?.t);
  if (node && sameContent) return "restyle";
  if (node && !structural) {
    if (cell && Object.keys(xmlAttrs(node.open)).some((a) => !["r", "s", "t"].includes(a)))
      unsupported(`${ref}:cell metadata`);
    if (cell && /<(?:extLst|[A-Za-z_][\w.-]*:)/.test(node.inner))
      unsupported(`${ref}:cell extension`);
    if (p.sharedMasters.has(`${r}:${c}`)) unsupported(`${ref}:共享公式主单元格`);
  }
  if (p.arrays.some((b) => r >= b.r0 && r <= b.r1 && c >= b.c0 && c <= b.c1))
    unsupported(`${ref}:数组公式区域`);
  return "encode";
}
const parsedParts = new WeakMap<Uint8Array, ParsedSheet>();
/**
 * 提交时的轻量保真检查（不做整本导出预检的大工作簿用）：只判定本次写集命中的格与所在行，
 * 与检查点 renderSheet 同一规则，保证"做不到就在写入时拒绝"，而不是提交成功后检查点永久失败。
 * 结构操作表不在此检查（提交前 assertWritable 已按整表重建规则检查）。
 */
export function assertCellsWritable(
  imported: ImportedWorkbook,
  after: IWorkbookData,
  baseline: IWorkbookData,
  ranges: RangeRef[],
  structural: Set<string>,
): void {
  const p = imported.preservation;
  if (!p) return;
  for (const [id, ref] of Object.entries(p.sheetParts)) {
    const mine = ranges.filter((x) => x.sheetId === id || x.sheetId === "*");
    if (!mine.length || structural.has(id) || !after.sheets[id] || !baseline.sheets[id]) continue;
    const bytes = p.parts[ref.path] as Uint8Array;
    let parsed = parsedParts.get(bytes);
    if (!parsed) {
      parsed = parseSheet(textOf(bytes));
      parsedParts.set(bytes, parsed);
    }
    const data = cellData(after.sheets[id]);
    const prev = cellData(baseline.sheets[id]);
    const hit = (r: number, c: number) =>
      mine.some((x) => r >= x.r0 && r <= x.r1 && c >= x.c0 && c <= x.c1);
    const check = (r: number, c: number) => {
      const kind = rewriteKind(
        parsed,
        r,
        c,
        parsed.cells.get(r)?.get(c),
        data[r]?.[c],
        prev[r]?.[c],
        false,
      );
      const row = parsed.rows.get(r);
      if (kind !== "keep" && row && rowExtras(row.inner))
        unsupported(`第 ${r + 1} 行:row extension`);
    };
    for (const [r, inRow] of parsed.cells) for (const c of inRow.keys()) if (hit(r, c)) check(r, c);
    // 模型中的新格（原文件无此格）：数组公式区域与行扩展
    for (const x of mine)
      for (const rk of Object.keys(data)) {
        const r = Number(rk);
        if (r < x.r0 || r > x.r1) continue;
        for (const ck of Object.keys(data[r] ?? {})) {
          const c = Number(ck);
          if (c >= x.c0 && c <= x.c1 && !parsed.cells.get(r)?.has(c)) check(r, c);
        }
      }
  }
}
type RowMeta = { h?: number; hd?: number; custom?: Record<string, unknown> } & Record<
  string,
  unknown
>;
/** 行属性是否变化；ia/ah 是排版缓存，不写回；无法写回的行字段变化则拒绝。 */
function rowChanged(rd: RowMeta | undefined, old: RowMeta | undefined, where: string): boolean {
  let changed = false;
  for (const k of new Set([...Object.keys(rd ?? {}), ...Object.keys(old ?? {})])) {
    if (k === "ia" || k === "ah") continue;
    if (k === "hd") changed ||= Boolean(rd?.hd) !== Boolean(old?.hd);
    else if (k === "h") changed ||= rd?.h !== old?.h;
    else if (k === "custom") {
      const { excelmanusOutlineLevel: a, ...restA } = rd?.custom ?? {};
      const { excelmanusOutlineLevel: b, ...restB } = old?.custom ?? {};
      if (JSON.stringify(restA) !== JSON.stringify(restB)) unsupported(`${where}:行自定义元数据`);
      changed ||= Number(a ?? 0) !== Number(b ?? 0);
    } else if (JSON.stringify(rd?.[k]) !== JSON.stringify(old?.[k]))
      unsupported(`${where}:行属性 ${k}`);
  }
  return changed;
}

function renderSheet(
  xml: string,
  sheet: Partial<IWorksheetData>,
  old: Partial<IWorksheetData> | undefined,
  after: IWorkbookData,
  styles: StyleWriter,
  opts: RenderOptions,
): string {
  const { structural, state } = opts;
  const touched = structural ? () => true : opts.touched;
  const parsed = parseSheet(xml);
  const { rows: rawRows, cells: rawCells } = parsed;
  if (structural) assertRebuildable(xml, "worksheet");
  const data = cellData(sheet);
  const previous = cellData(old);
  /** 改写一个出现在写集中的格；返回空串 = 不输出。 */
  const encode = (r: number, c: number, raw: string | undefined): string => {
    const ref = `${indexToCol(c + 1)}${r + 1}`;
    const cell = data[r]?.[c];
    // 结构操作后原始 XML 与基线快照的坐标都已失效，按新单元格重建
    const oldCell = structural ? undefined : previous[r]?.[c];
    const kind = rewriteKind(parsed, r, c, raw, cell, oldCell, structural);
    if (kind === "keep") return raw as string;
    const node = raw !== undefined ? elements(raw, "c")[0] : undefined;
    const rawS = node ? Number(xmlAttrs(node.open).s ?? 0) : 0;
    const styleIndex = cell ? styles.index(cell, oldCell, after, rawS) : 0;
    if (kind === "restyle" && raw !== undefined && node)
      return refreshCache(
        raw.replace(node.open, setAttribute(node.open, "s", styleIndex)),
        cell,
        oldCell,
      );
    // 原格带公式（含模型中无 f 的共享公式跟随格）被改成非公式：calcChain 会指向非公式格
    if (node && !cell?.f && elements(node.inner, "f").length) state.formulaSetChanged = true;
    if (!cell) return "";
    if (cell.f) state.formulaWritten = true;
    return renderCell(cell, ref, styleIndex, oldCell);
  };
  const rowIndexes = new Set([
    ...Object.keys(data).map(Number),
    ...Object.keys(sheet.rowData ?? {}).map(Number),
    ...(structural ? [] : rawRows.keys()),
  ]);
  let maxR = 1;
  let maxC = 1;
  const rows: string[] = [];
  for (const r of [...rowIndexes].sort((a, b) => a - b)) {
    const rawRow = structural ? undefined : rawRows.get(r);
    const raws = (structural ? undefined : rawCells.get(r)) ?? new Map<number, string>();
    const cols = new Set([
      ...Object.keys(data[r] ?? {}).map(Number),
      ...(structural ? [] : raws.keys()),
    ]);
    const rendered: string[] = [];
    let changed = false;
    let lo = Number.POSITIVE_INFINITY;
    let hi = -1;
    for (const c of [...cols].sort((a, b) => a - b)) {
      const raw = raws.get(c);
      const encoded =
        raw !== undefined && !touched(r, c)
          ? refreshCache(raw, data[r]?.[c], previous[r]?.[c])
          : encode(r, c, raw);
      if (encoded !== raw || structural) changed = true;
      if (!encoded) continue;
      rendered.push(encoded);
      lo = Math.min(lo, c + 1);
      hi = Math.max(hi, c + 1);
    }
    if (hi > 0) {
      maxR = Math.max(maxR, r + 1);
      maxC = Math.max(maxC, hi);
    }
    const rd = sheet.rowData?.[r] as RowMeta | undefined;
    const oldRd = old?.rowData?.[r] as RowMeta | undefined;
    if (rawRow) {
      const rdChanged = rowChanged(rd, oldRd, `第 ${r + 1} 行`);
      if (!changed && !rdChanged) {
        rows.push(rawRow.raw);
        continue;
      }
      if (rowExtras(rawRow.inner)) unsupported(`第 ${r + 1} 行:row extension`);
      // 保留原行开标签（样式、分组、spans 等），只覆盖改动过的行高与隐藏
      let open = rawRow.open.replace(/\s*\/>$/, ">");
      if (rd?.h !== oldRd?.h)
        open =
          rd?.h !== undefined
            ? setAttribute(setAttribute(open, "ht", rd.h), "customHeight", "1")
            : removeAttribute(removeAttribute(open, "ht"), "customHeight");
      if (Boolean(rd?.hd) !== Boolean(oldRd?.hd))
        open = rd?.hd ? setAttribute(open, "hidden", "1") : removeAttribute(open, "hidden");
      if (
        Number(rd?.custom?.excelmanusOutlineLevel ?? 0) !==
        Number(oldRd?.custom?.excelmanusOutlineLevel ?? 0)
      )
        open = rd?.custom?.excelmanusOutlineLevel
          ? setAttribute(open, "outlineLevel", Number(rd.custom.excelmanusOutlineLevel))
          : removeAttribute(open, "outlineLevel");
      const spans = /^(\d+):(\d+)$/.exec(xmlAttrs(open).spans ?? "");
      if (spans && hi > 0 && (lo < Number(spans[1]) || hi > Number(spans[2])))
        open = removeAttribute(open, "spans");
      rows.push(`${open}${rendered.join("")}</row>`);
      continue;
    }
    const open = `<row r="${r + 1}"${rd?.h !== undefined ? ` ht="${rd.h}" customHeight="1"` : ""}${rd?.hd ? ' hidden="1"' : ""}${rd?.custom?.excelmanusOutlineLevel ? ` outlineLevel="${Number(rd.custom.excelmanusOutlineLevel)}"` : ""}>`;
    if (rendered.length || rd) rows.push(`${open}${rendered.join("")}</row>`);
  }
  xml = replaceElement(xml, "sheetData", `<sheetData>${rows.join("")}</sheetData>`);
  xml = replaceElement(
    xml,
    "dimension",
    `<dimension ref="A1:${indexToCol(maxC)}${maxR}"/>`,
    "sheetViews",
  );
  if (JSON.stringify(sheet.mergeData ?? []) !== JSON.stringify(old?.mergeData ?? [])) {
    const merges = sheet.mergeData ?? [];
    xml = replaceElement(
      xml,
      "mergeCells",
      merges.length
        ? `<mergeCells count="${merges.length}">${merges.map((m) => `<mergeCell ref="${rangeRef(m)}"/>`).join("")}</mergeCells>`
        : "",
      "conditionalFormatting",
    );
  }
  if (JSON.stringify(sheet.columnData ?? {}) !== JSON.stringify(old?.columnData ?? {})) {
    if (structural) {
      xml = replaceElement(
        xml,
        "cols",
        `<cols>${Object.entries(sheet.columnData ?? {})
          .map(
            ([c, d]) =>
              `<col min="${Number(c) + 1}" max="${Number(c) + 1}"${d.w !== undefined ? ` width="${d.w / 7}" customWidth="1"` : ""}${d.hd ? ' hidden="1"' : ""}/>`,
          )
          .join("")}</cols>`,
        "sheetData",
      );
    } else xml = renderCols(xml, sheet, old);
  }
  if (JSON.stringify(sheet.freeze) !== JSON.stringify(old?.freeze)) {
    const f = sheet.freeze;
    const pane =
      f && (f.xSplit || f.ySplit)
        ? `<pane xSplit="${f.xSplit}" ySplit="${f.ySplit}" topLeftCell="${indexToCol(Math.max(f.startColumn, f.xSplit, 0) + 1)}${Math.max(f.startRow, f.ySplit, 0) + 1}" state="frozen"/>`
        : "";
    const views = elements(xml, "sheetViews")[0];
    const view = elements(views?.inner ?? "", "sheetView")[0];
    const v = view
      ? replaceElement(view.raw.replace(/\/>$/, "></sheetView>"), "pane", pane)
      : `<sheetView workbookViewId="0">${pane}</sheetView>`;
    xml = replaceElement(
      xml,
      "sheetViews",
      views && view ? views.raw.replace(view.raw, v) : `<sheetViews>${v}</sheetViews>`,
      "sheetData",
    );
  }
  return xml;
}

/** 列宽/隐藏写回：按列展开原 <col> 属性（样式、分组等），只覆盖改动的列，再合并相邻同属性列。 */
function renderCols(
  xml: string,
  sheet: Partial<IWorksheetData>,
  old: Partial<IWorksheetData> | undefined,
): string {
  const per = new Map<number, Record<string, string>>();
  for (const e of elements(elements(xml, "cols")[0]?.inner ?? "", "col")) {
    const { min, max, ...attrs } = xmlAttrs(e.open);
    for (let c = Number(min) - 1; c <= Number(max) - 1 && c < 16384; c++) per.set(c, { ...attrs });
  }
  type ColMeta = { w?: number; hd?: number; custom?: Record<string, unknown> } & Record<
    string,
    unknown
  >;
  const now = (sheet.columnData ?? {}) as Record<number, ColMeta>;
  const before = (old?.columnData ?? {}) as Record<number, ColMeta>;
  for (const key of new Set([...Object.keys(now), ...Object.keys(before)])) {
    const c = Number(key);
    const d = now[c];
    const o = before[c];
    if (JSON.stringify(d ?? {}) === JSON.stringify(o ?? {})) continue;
    for (const k of new Set([...Object.keys(d ?? {}), ...Object.keys(o ?? {})]))
      if (
        k !== "w" &&
        k !== "hd" &&
        k !== "custom" &&
        JSON.stringify(d?.[k]) !== JSON.stringify(o?.[k])
      )
        unsupported(`第 ${c + 1} 列:列属性 ${k}`);
    const { excelmanusOutlineLevel: level, ...rest } = d?.custom ?? {};
    const { excelmanusOutlineLevel: oldLevel, ...oldRest } = o?.custom ?? {};
    if (JSON.stringify(rest) !== JSON.stringify(oldRest))
      unsupported(`第 ${c + 1} 列:自定义元数据`);
    const a = { ...(per.get(c) ?? {}) };
    if (Number(level ?? 0) !== Number(oldLevel ?? 0)) {
      if (level) a.outlineLevel = String(level);
      else delete a.outlineLevel;
    }
    if (d?.w !== o?.w) {
      if (d?.w !== undefined) {
        a.width = String(d.w / 7);
        a.customWidth = "1";
      } else {
        delete a.width;
        delete a.customWidth;
      }
    }
    if (Boolean(d?.hd) !== Boolean(o?.hd)) {
      if (d?.hd) a.hidden = "1";
      else delete a.hidden;
    }
    per.set(c, a);
  }
  const out: string[] = [];
  const sorted = [...per.entries()]
    .filter(([, a]) => Object.keys(a).length)
    .sort(([a], [b]) => a - b);
  for (let i = 0; i < sorted.length; ) {
    const [start, attrs] = sorted[i] as [number, Record<string, string>];
    const key = JSON.stringify(attrs);
    let end = start;
    while (sorted[i + 1]?.[0] === end + 1 && JSON.stringify(sorted[i + 1]?.[1]) === key) {
      end += 1;
      i += 1;
    }
    i += 1;
    out.push(
      `<col min="${start + 1}" max="${end + 1}"${Object.entries(attrs)
        .map(([k, v]) => ` ${k}="${escapeXml(v)}"`)
        .join("")}/>`,
    );
  }
  return replaceElement(xml, "cols", out.length ? `<cols>${out.join("")}</cols>` : "", "sheetData");
}

/** 表顺序变化时重映射定义名 localSheetId 与 workbookView 的 activeTab/firstSheet；无法映射则拒绝。 */
export function remapSheetIndexes(wb: string, before: string[], after: string[]): string {
  const map = (i: number): number => (Number.isInteger(i) ? after.indexOf(before[i] ?? "") : -1);
  const edits: Array<{ start: number; open: string; next: string }> = [];
  for (const d of elements(wb, "definedName")) {
    const local = xmlAttrs(d.open).localSheetId;
    if (local === undefined) continue;
    const next = map(Number(local));
    if (next < 0) unsupported("xl/workbook.xml:definedName 的 localSheetId 指向被删除的工作表");
    if (next !== Number(local))
      edits.push({
        start: d.start,
        open: d.open,
        next: setAttribute(d.open, "localSheetId", next),
      });
  }
  for (const v of elements(wb, "workbookView")) {
    let open = v.open;
    for (const key of ["activeTab", "firstSheet"]) {
      const cur = xmlAttrs(open)[key];
      if (cur === undefined) continue;
      const next = Math.max(0, map(Number(cur)));
      if (next !== Number(cur)) open = setAttribute(open, key, next);
    }
    if (open !== v.open) edits.push({ start: v.start, open: v.open, next: open });
  }
  for (const e of edits.sort((a, b) => b.start - a.start))
    wb = wb.slice(0, e.start) + e.next + wb.slice(e.start + e.open.length);
  return wb;
}

const emptySheet = () =>
  `<worksheet xmlns="${NS}" xmlns:r="${REL_NS}"><dimension ref="A1"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetData/></worksheet>`;
export function minimalXlsx(snapshot: IWorkbookData): Uint8Array {
  const parts: Record<string, Uint8Array> = {
    "[Content_Types].xml": bytesOf(
      `<Types xmlns="${TYPE_NS}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`,
    ),
    "_rels/.rels": bytesOf(
      `<Relationships xmlns="${PKG_NS}"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    "xl/workbook.xml": bytesOf(`<workbook xmlns="${NS}" xmlns:r="${REL_NS}"><sheets/></workbook>`),
    "xl/_rels/workbook.xml.rels": bytesOf(`<Relationships xmlns="${PKG_NS}"/>`),
  };
  const p: XlsxPreservation = { parts, sheetParts: {}, stylesPart: "xl/styles.xml" };
  const empty = { ...snapshot, sheets: {}, sheetOrder: [], styles: {} };
  return exportXlsx(
    { snapshot: empty, preservation: p, unsupported: {}, cellCounts: {}, formulaCounts: {} },
    snapshot,
    empty,
  );
}

export function exportXlsx(
  imported: ImportedWorkbook,
  snapshot: IWorkbookData,
  baseline = imported.snapshot,
  /** 已提交修订写集；缺省时按快照差异判定（无写集来源的调用方，如新建文件）。 */
  changes?: SheetChanges,
): Uint8Array {
  const p = imported.preservation;
  if (!p) return minimalXlsx(snapshot);
  const state: RenderState = { formulaWritten: false, formulaSetChanged: false };
  const formulaCells = (s: Partial<IWorksheetData> | undefined): string =>
    JSON.stringify(
      Object.entries(cellData(s)).flatMap(([r, row]) =>
        Object.entries(row ?? {})
          .filter(([, cell]) => cell?.f)
          .map(([c]) => `${r}:${c}`),
      ),
    );
  let formulaSetChanged = false;
  const parts = { ...p.parts };
  const hadStylesPart = Boolean(p.parts[p.stylesPart]);
  const styleWriter = new StyleWriter(parts, p.stylesPart, baseline);
  const mapping = structuredClone(p.sheetParts);
  let wb = textOf(parts["xl/workbook.xml"] as Uint8Array);
  let rels = textOf(parts["xl/_rels/workbook.xml.rels"] as Uint8Array);
  let types = textOf(parts["[Content_Types].xml"] as Uint8Array);
  let structureChanged =
    JSON.stringify(snapshot.sheetOrder) !== JSON.stringify(baseline.sheetOrder);
  const existingTags = new Map(
    elements(elements(wb, "sheets")[0]?.inner ?? "", "sheet").map((e) => [
      xmlAttrs(e.open)["r:id"],
      e.open,
    ]),
  );
  const sheetTags: string[] = [];
  for (const id of snapshot.sheetOrder) {
    const sheet = snapshot.sheets[id];
    if (!sheet) unsupported("缺少工作表快照");
    const old = baseline.sheets[id];
    let ref = mapping[id];
    if (!ref) {
      let n = 1;
      while (parts[`xl/worksheets/sheet${n}.xml`]) n++;
      let r = 1;
      while (elements(rels, "Relationship").some((e) => xmlAttrs(e.open).Id === `rId${r}`)) r++;
      ref = {
        path: `xl/worksheets/sheet${n}.xml`,
        rid: `rId${r}`,
        sheetId: String(Math.max(0, ...Object.values(mapping).map((s) => Number(s.sheetId))) + 1),
      };
      mapping[id] = ref;
      parts[ref.path] = bytesOf(emptySheet());
      rels = rels.replace(
        "</Relationships>",
        `<Relationship Id="${ref.rid}" Type="${REL_NS}/worksheet" Target="${ref.path.slice(3)}"/></Relationships>`,
      );
      if (rels.endsWith("/>"))
        rels = rels.replace(
          /\/>$/,
          `><Relationship Id="${ref.rid}" Type="${REL_NS}/worksheet" Target="${ref.path.slice(3)}"/></Relationships>`,
        );
      types = types.replace(
        "</Types>",
        `<Override PartName="/${ref.path}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
      );
      structureChanged = true;
    }
    let tag =
      existingTags.get(ref.rid) ??
      `<sheet name="${escapeXml(sheet.name)}" sheetId="${ref.sheetId}" r:id="${ref.rid}"/>`;
    if (old?.name !== sheet.name) {
      tag = setAttribute(tag, "name", sheet.name);
      structureChanged = true;
    }
    if (Number(old?.hidden ?? 0) !== Number(sheet.hidden ?? 0)) {
      tag = sheet.hidden
        ? setAttribute(tag, "state", Number(sheet.hidden) === 2 ? "veryHidden" : "hidden")
        : removeAttribute(tag, "state");
      structureChanged = true;
    }
    sheetTags.push(tag);
    // 引擎重算会改写公式格的 v：单元格是否修改以写集为准，不用快照差异
    const ranges = changes?.ranges.filter((r) => r.sheetId === id || r.sheetId === "*");
    const layoutChanged = ["rowData", "columnData", "mergeData", "freeze"].some(
      (k) =>
        JSON.stringify(sheet[k as keyof IWorksheetData] ?? {}) !==
        JSON.stringify(old?.[k as keyof IWorksheetData] ?? {}),
    );
    const modified =
      !old ||
      layoutChanged ||
      (changes
        ? (ranges?.length ?? 0) > 0 || changes.structural.has(id)
        : JSON.stringify(sheet.cellData ?? {}) !== JSON.stringify(old.cellData ?? {}));
    if (modified) {
      parts[ref.path] = bytesOf(
        renderSheet(textOf(parts[ref.path] as Uint8Array), sheet, old, snapshot, styleWriter, {
          touched: ranges
            ? (r, c) => ranges.some((x) => r >= x.r0 && r <= x.r1 && c >= x.c0 && c <= x.c1)
            : () => true,
          // 无写集（以外部包为底）：按坐标逐格对比写回，原行开标签与未变格保留，不整表重建
          structural: changes?.structural.has(id) ?? false,
          state,
        }),
      );
      if (formulaCells(sheet) !== formulaCells(old)) formulaSetChanged = true;
    }
  }
  for (const [id, ref] of Object.entries(mapping)) {
    if (snapshot.sheets[id]) continue;
    if (formulaCells(baseline.sheets[id]) !== "[]") formulaSetChanged = true;
    const removedName = baseline.sheets[id]?.name;
    if (removedName && elements(wb, "definedName").some((d) => d.inner.includes(removedName)))
      unsupported("xl/workbook.xml:definedNames 引用了被删除的工作表");
    delete parts[ref.path];
    rels = elements(rels, "Relationship").reduce(
      (s, e) => (xmlAttrs(e.open).Id === ref.rid ? s.replace(e.raw, "") : s),
      rels,
    );
    types = elements(types, "Override").reduce(
      (s, e) => (xmlAttrs(e.open).PartName === `/${ref.path}` ? s.replace(e.raw, "") : s),
      types,
    );
    structureChanged = true;
  }
  styleWriter.finish();
  if (!hadStylesPart) {
    rels = rels.replace(
      "</Relationships>",
      `<Relationship Id="emStyles" Type="${REL_NS}/styles" Target="styles.xml"/></Relationships>`,
    );
    types = types.replace(
      "</Types>",
      `<Override PartName="/${p.stylesPart}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    );
    parts["xl/_rels/workbook.xml.rels"] = bytesOf(rels);
    parts["[Content_Types].xml"] = bytesOf(types);
  }
  if (structureChanged) {
    wb = replaceElement(wb, "sheets", `<sheets>${sheetTags.join("")}</sheets>`);
    wb = remapSheetIndexes(wb, baseline.sheetOrder, snapshot.sheetOrder);
  }
  // 公式格集合变化：calcChain 失效，删除（Excel 打开时重建）
  const calcChain = elements(rels, "Relationship").find((e) =>
    /\/calcChain$/.test(xmlAttrs(e.open).Type ?? ""),
  );
  if ((formulaSetChanged || state.formulaSetChanged) && calcChain) {
    const target = xmlAttrs(calcChain.open).Target ?? "calcChain.xml";
    const part = posix.normalize(target.startsWith("/") ? target.slice(1) : `xl/${target}`);
    delete parts[part];
    rels = rels.replace(calcChain.raw, "");
    types = elements(types, "Override").reduce(
      (s, e) => (xmlAttrs(e.open).PartName === `/${part}` ? s.replace(e.raw, "") : s),
      types,
    );
    structureChanged = true;
  }
  // 新写/改写了公式：缓存可能缺失或引擎不支持该函数，要求打开时全量重算（07 §12）
  if (state.formulaWritten) {
    const calcPr = elements(wb, "calcPr")[0];
    if (calcPr) wb = wb.replace(calcPr.open, setAttribute(calcPr.open, "fullCalcOnLoad", "1"));
    else {
      const after = [
        "oleSize",
        "customWorkbookViews",
        "pivotCaches",
        "smartTagPr",
        "smartTagTypes",
        "webPublishing",
        "fileRecoveryPr",
        "webPublishObjects",
        "extLst",
      ].flatMap((n) => elements(wb, n).map((e) => e.start));
      const at = after.length ? Math.min(...after) : wb.lastIndexOf("</");
      wb = `${wb.slice(0, at)}<calcPr fullCalcOnLoad="1"/>${wb.slice(at)}`;
    }
    structureChanged = true;
  }
  if (structureChanged) {
    parts["xl/workbook.xml"] = bytesOf(wb);
    parts["xl/_rels/workbook.xml.rels"] = bytesOf(rels);
    parts["[Content_Types].xml"] = bytesOf(types);
  }
  exportRules(parts, mapping, snapshot, baseline, p.stylesPart);
  exportFilterLinks(parts, mapping, snapshot, baseline);
  exportObjects(parts, mapping, snapshot, baseline);
  exportImages(parts, mapping, snapshot, baseline);
  const bytes = zipSync(parts);
  verifyXlsx(bytes, snapshot);
  return bytes;
}

export function verifyXlsx(bytes: Uint8Array, expected: IWorkbookData): void {
  const actual = importXlsx(bytes, "verify.xlsx").snapshot;
  if (actual.sheetOrder.length !== expected.sheetOrder.length)
    throw new FileOperationError("INTERNAL", "工作表数量回读不一致");
  expected.sheetOrder.forEach((id, i) => {
    const s = expected.sheets[id];
    const a = actual.sheets[actual.sheetOrder[i] ?? ""];
    if (!s || !a || s.name !== a.name) throw new FileOperationError("INTERNAL", "工作表回读不一致");
    let count = 0;
    for (const [r, row] of Object.entries(cellData(s)))
      for (const [c, cell] of Object.entries(row ?? {})) {
        if (count++ > 200_000) break;
        if (cell == null) continue;
        const back = cellData(a)[Number(r)]?.[Number(c)];
        if (cell.f ? cell.f !== back?.f : cell.v != null && cell.v !== back?.v)
          throw new FileOperationError("INTERNAL", "单元格回读校验失败");
      }
  });
}
