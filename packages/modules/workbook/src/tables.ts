import { posix } from "node:path";
import { indexToCol, parseRange } from "@excelmanus/core";
import { FileOperationError } from "@excelmanus/kernel";
import type { IWorkbookData } from "@univerjs/core";
import {
  type ITableJson,
  TableColumnDataTypeEnum,
  TableColumnFilterTypeEnum,
} from "@univerjs/sheets-table";
import { XMLParser } from "fast-xml-parser";
import {
  bytesOf,
  elements,
  escapeXml,
  replaceElement,
  setAttribute,
  textOf,
  xmlAttrs,
} from "./xml.ts";
export const TABLE_RESOURCE = "SHEET_TABLE_PLUGIN";
type Parts = Record<string, Uint8Array>;
type MapSheets = Record<string, { path: string }>;
export type TableResource = Record<
  string,
  { tables: ITableJson[]; tableFilteredOutRows?: number[] }
>;
export const tablesOf = (s: Pick<IWorkbookData, "resources">): TableResource => {
  const r = s.resources?.find((r) => r.name === TABLE_RESOURCE)?.data;
  return r ? JSON.parse(r) : {};
};
export function setTables(s: IWorkbookData, t: TableResource) {
  s.resources = [
    ...(s.resources ?? []).filter((r) => r.name !== TABLE_RESOURCE),
    { name: TABLE_RESOURCE, data: JSON.stringify(t) },
  ];
}
const read = (p: Parts, n: string) => (p[n] ? textOf(p[n]!) : "");
const relPath = (p: string) => `${posix.dirname(p)}/_rels/${posix.basename(p)}.rels`;
const styles = [
  "TableStyleMedium2",
  "TableStyleMedium4",
  "TableStyleMedium9",
  "TableStyleMedium3",
  "TableStyleMedium7",
  "TableStyleMedium6",
];
const parser = new XMLParser({ parseTagValue: false });
const text = (s: string) => String(parser.parse(`<v>${s}</v>`).v ?? "");
const ref = (t: ITableJson) =>
  `${indexToCol(t.range.startColumn + 1)}${t.range.startRow + 1}:${indexToCol(t.range.endColumn + 1)}${t.range.endRow + 1}`;
function fail(s: string): never {
  throw new FileOperationError("UNSUPPORTED_FEATURE", s);
}
function tableParts(parts: Parts, sheet: string) {
  const rels = elements(read(parts, relPath(sheet)), "Relationship");
  return elements(read(parts, sheet), "tablePart").flatMap((e) => {
    const rid = xmlAttrs(e.open)["r:id"],
      r = rels.find((r) => xmlAttrs(r.open).Id === rid);
    if (!r) return [];
    const a = xmlAttrs(r.open);
    if (a.TargetMode === "External") return [];
    const path = posix.normalize(
      a.Target!.startsWith("/") ? a.Target!.slice(1) : posix.join(posix.dirname(sheet), a.Target!),
    );
    return path.startsWith("xl/tables/") ? [{ path, rid: rid! }] : [];
  });
}
export function importTables(parts: Parts, mapping: MapSheets) {
  const all: TableResource = {};
  for (const [sid, sheet] of Object.entries(mapping))
    for (const { path } of tableParts(parts, sheet.path)) {
      const xml = read(parts, path),
        node = elements(xml, "table")[0];
      if (!node) continue;
      const a = xmlAttrs(node.open);
      if (
        elements(xml, "extLst").length ||
        elements(xml, "sortState").length ||
        (a.tableType && a.tableType !== "worksheet")
      )
        continue;
      // Unknown filtering and extension parts stay in the original package.
      if (
        elements(xml, "filterColumn").some((e) =>
          /<(?:customFilters|dynamicFilter|top10|colorFilter|iconFilter)/.test(e.inner),
        )
      )
        continue;
      const r = parseRange(a.ref!),
        style = xmlAttrs(elements(xml, "tableStyleInfo")[0]?.open ?? "<tableStyleInfo/>").name;
      const columns = elements(xml, "tableColumn").map((e, i) => {
        const c = xmlAttrs(e.open),
          f = elements(e.inner, "calculatedColumnFormula")[0],
          tot = elements(e.inner, "totalsRowFormula")[0];
        return {
          id: c.id ?? String(i + 1),
          displayName: c.name!,
          dataType: TableColumnDataTypeEnum.None,
          formula: f ? `=${text(f.inner)}` : "",
          ...(f && xmlAttrs(f.open).array === "1" ? { formulaIsArray: true } : {}),
          ...(c.totalsRowLabel ? { totalsRowLabel: c.totalsRowLabel } : {}),
          ...(c.totalsRowFunction ? { totalsRowFunction: c.totalsRowFunction } : {}),
          ...(tot ? { totalsRowFormula: `=${text(tot.inner)}` } : {}),
          meta: {},
          style: {},
        };
      });
      const filters: ITableJson["filters"] = { tableColumnFilterList: [] };
      for (const f of elements(xml, "filterColumn")) {
        const fa = xmlAttrs(f.open),
          fs = elements(f.inner, "filters")[0];
        if (fs) {
          const values = elements(fs.inner, "filter").map((x) => xmlAttrs(x.open).val!);
          if (xmlAttrs(fs.open).blank === "1") values.push("");
          filters.tableColumnFilterList![Number(fa.colId)] = {
            filterType: "manual" as never,
            values,
          };
        }
      }
      const t: ITableJson = {
        id: `table_${a.id}`,
        name: a.displayName ?? a.name!,
        range: {
          startRow: r.startRow - 1,
          endRow: r.endRow - 1,
          startColumn: r.startCol - 1,
          endColumn: r.endCol - 1,
        },
        columns,
        options: {
          showHeader: a.headerRowCount !== "0",
          showFooter: a.totalsRowCount === "1",
          showAutoFilter: elements(xml, "autoFilter").length > 0,
          tableStyleId: `table-default-${Math.max(0, styles.indexOf(style ?? ""))}`,
        },
        filters,
        meta: {},
      };
      all[sid] ??= { tables: [] };
      all[sid].tables.push(t);
    }
  return { name: TABLE_RESOURCE, data: JSON.stringify(all) };
}
function tableXml(t: ITableJson, id: number, old = "", previous?: ITableJson) {
  const oldRoot = elements(old, "table")[0];
  const a = oldRoot
    ? xmlAttrs(oldRoot.open)
    : { xmlns: "http://schemas.openxmlformats.org/spreadsheetml/2006/main" };
  Object.assign(a, {
    id: String(id),
    name: t.name,
    displayName: t.name,
    ref: ref(t),
    headerRowCount: t.options.showHeader === false ? "0" : "1",
    totalsRowCount: t.options.showFooter ? "1" : "0",
    totalsRowShown: t.options.showFooter ? "1" : "0",
  });
  const oldCols = elements(old, "tableColumn");
  const columns = t.columns
    .map((c, i) => {
      const oc = oldCols.find((x) => xmlAttrs(x.open).id === c.id),
        attrs = oc ? xmlAttrs(oc.open) : {};
      Object.assign(attrs, { id: String(i + 1), name: c.displayName });
      for (const k of ["totalsRowLabel", "totalsRowFunction"] as const) {
        if (c[k]) attrs[k] = c[k]!;
        else delete attrs[k];
      }
      let inner = oc?.inner ?? "";
      for (const tag of ["calculatedColumnFormula", "totalsRowFormula"])
        inner = elements(inner, tag).reduce((s, e) => s.replace(e.raw, ""), inner);
      if (c.formula)
        inner += `<calculatedColumnFormula${c.formulaIsArray ? ' array="1"' : ""}>${escapeXml(c.formula.replace(/^=/, ""))}</calculatedColumnFormula>`;
      if (c.totalsRowFormula)
        inner += `<totalsRowFormula>${escapeXml(c.totalsRowFormula.replace(/^=/, ""))}</totalsRowFormula>`;
      return `<tableColumn${Object.entries(attrs)
        .map(([k, v]) => ` ${k}="${escapeXml(v)}"`)
        .join("")}>${inner}</tableColumn>`;
    })
    .join("");
  let filter = "";
  for (const [i, f] of (t.filters.tableColumnFilterList ?? []).entries()) {
    if (!f) continue;
    if (f.filterType !== TableColumnFilterTypeEnum.manual) fail("当前表格筛选仅支持值列表写回");
    filter += `<filterColumn colId="${i}"><filters${f.values.includes("") ? ' blank="1"' : ""}>${f.values
      .filter((v) => v !== "")
      .map((v) => `<filter val="${escapeXml(v)}"/>`)
      .join("")}</filters></filterColumn>`;
  }
  const range = { ...t.range, endRow: t.range.endRow - (t.options.showFooter ? 1 : 0) };
  let inner = oldRoot?.inner ?? "";
  for (const tag of ["autoFilter", "tableColumns", "tableStyleInfo", "sortState"])
    inner = elements(inner, tag).reduce((s, e) => s.replace(e.raw, ""), inner);
  const style = styles[Number(t.options.tableStyleId?.replace("table-default-", ""))];
  if (!style) fail("暂不支持写回该自定义表格样式");
  const oldStyle = elements(old, "tableStyleInfo")[0]?.raw;
  const styleNode =
    oldStyle && previous?.options.tableStyleId === t.options.tableStyleId
      ? oldStyle
      : `<tableStyleInfo name="${style}" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/>`;
  return `<table${Object.entries(a)
    .map(([k, v]) => ` ${k}="${escapeXml(v)}"`)
    .join(
      "",
    )}>${t.options.showAutoFilter !== false ? `<autoFilter ref="${ref({ ...t, range })}">${filter}</autoFilter>` : ""}<tableColumns count="${t.columns.length}">${columns}</tableColumns>${styleNode}${inner}</table>`;
}
function comparable(t: ITableJson | undefined): string {
  if (!t) return "";
  return JSON.stringify({
    name: t.name,
    range: t.range,
    options: {
      showHeader: t.options.showHeader !== false,
      showFooter: !!t.options.showFooter,
      showAutoFilter: t.options.showAutoFilter !== false,
      tableStyleId: t.options.tableStyleId ?? "table-default-0",
    },
    columns: t.columns.map((c) => ({
      name: c.displayName,
      formula: c.formula || "",
      array: !!c.formulaIsArray,
      label: c.totalsRowLabel || "",
      function: c.totalsRowFunction || "",
      totals: c.totalsRowFormula || "",
    })),
    filters: (t.filters?.tableColumnFilterList ?? []).map((f) => f ?? null),
  });
}
export function exportTables(
  parts: Parts,
  mapping: MapSheets,
  snapshot: IWorkbookData,
  baseline: IWorkbookData,
) {
  const next = tablesOf(snapshot),
    before = tablesOf(baseline);
  if (JSON.stringify(next) === JSON.stringify(before)) return;
  const allNames = new Set<string>();
  let maxId = Math.max(
    0,
    ...Object.keys(parts)
      .filter((p) => /^xl\/tables\/.*\.xml$/.test(p))
      .map(
        (p) => Number(xmlAttrs(elements(read(parts, p), "table")[0]?.open ?? "<table/>").id) || 0,
      ),
  );
  for (const [sid, sheet] of Object.entries(mapping)) {
    const prev = before[sid]?.tables ?? [],
      current = next[sid]?.tables ?? [];
    const links = tableParts(parts, sheet.path),
      oldMap = new Map(
        prev.map((t) => [
          t.id,
          links.find(
            (l) =>
              xmlAttrs(elements(read(parts, l.path), "table")[0]?.open ?? "<table/>")
                .displayName === t.name,
          ),
        ]),
      );
    let sx = read(parts, sheet.path),
      rels =
        read(parts, relPath(sheet.path)) ||
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
      types = read(parts, "[Content_Types].xml");
    for (const t of prev)
      if (!current.some((n) => n.id === t.id)) {
        const l = oldMap.get(t.id);
        if (!l) continue;
        delete parts[l.path];
        for (const e of elements(rels, "Relationship"))
          if (xmlAttrs(e.open).Id === l.rid) rels = rels.replace(e.raw, "");
        for (const e of elements(sx, "tablePart"))
          if (xmlAttrs(e.open)["r:id"] === l.rid) sx = sx.replace(e.raw, "");
        for (const e of elements(types, "Override"))
          if (xmlAttrs(e.open).PartName === `/${l.path}`) types = types.replace(e.raw, "");
      }
    for (const t of current) {
      const name = t.name.toLowerCase();
      if (allNames.has(name)) fail("表名称不能重复");
      allNames.add(name);
      const old = prev.find((p) => p.id === t.id),
        l = oldMap.get(t.id);
      if (comparable(old) === comparable(t) && l) continue;
      if (
        !/^[\p{L}_][\p{L}\p{N}_.]*$/u.test(t.name) ||
        t.name.length > 255 ||
        /^[A-Z]{1,3}\d+$/i.test(t.name)
      )
        fail("表名称无效");
      if (
        t.columns.length !== t.range.endColumn - t.range.startColumn + 1 ||
        new Set(t.columns.map((c) => c.displayName.toLowerCase())).size !== t.columns.length ||
        t.columns.some((c) => !c.displayName)
      )
        fail("表列名称或数量无效");
      if (
        t.range.startRow < 0 ||
        t.range.startColumn < 0 ||
        t.range.endRow <
          t.range.startRow +
            (t.options.showHeader === false ? 0 : 1) +
            (t.options.showFooter ? 1 : 0) ||
        t.range.endRow >= 1048576 ||
        t.range.endColumn >= 16384
      )
        fail("表范围无效");
      if (
        current.some(
          (other) =>
            other.id !== t.id &&
            other.range.startRow <= t.range.endRow &&
            other.range.endRow >= t.range.startRow &&
            other.range.startColumn <= t.range.endColumn &&
            other.range.endColumn >= t.range.startColumn,
        )
      )
        fail("表范围不能重叠");
      const id = l ? Number(xmlAttrs(elements(read(parts, l.path), "table")[0]!.open).id) : ++maxId,
        path = l?.path ?? `xl/tables/table${id}.xml`,
        rid = l?.rid ?? `rId_em_table_${id}`;
      parts[path] = bytesOf(tableXml(t, id, l ? read(parts, path) : "", old));
      if (!l) {
        const node = `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="${posix.relative(posix.dirname(sheet.path), path)}"/>`;
        rels = rels.replace(/\/>$/, `>${node}</Relationships>`);
        if (!rels.includes(node))
          rels = rels.replace("</Relationships>", node + "</Relationships>");
        const block = elements(sx, "tableParts")[0];
        sx = replaceElement(
          sx,
          "tableParts",
          `<tableParts count="${(block ? elements(block.inner, "tablePart").length : 0) + 1}">${block?.inner ?? ""}<tablePart r:id="${rid}"/></tableParts>`,
        );
        types = types.replace(
          "</Types>",
          `<Override PartName="/${path}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/></Types>`,
        );
      }
    }
    const block = elements(sx, "tableParts")[0];
    if (block) {
      const count = elements(block.inner, "tablePart").length;
      sx = sx.replace(
        block.raw,
        count
          ? block.raw.replace(block.open, setAttribute(block.open, "count", String(count)))
          : "",
      );
    }
    if (/<tablePart\b/.test(sx) && !sx.includes("xmlns:r="))
      sx = sx.replace(
        "<worksheet ",
        '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ',
      );
    parts[sheet.path] = bytesOf(sx);
    parts[relPath(sheet.path)] = bytesOf(rels);
    parts["[Content_Types].xml"] = bytesOf(types);
  }
}
