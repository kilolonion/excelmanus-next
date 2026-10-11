import { indexToCol, parseRange } from "@excelmanus/core";
import { FileOperationError } from "@excelmanus/kernel";
import type { ICellData, IWorkbookData, IWorksheetData } from "@univerjs/core";
import { rulesResource } from "./rule-codec.ts";
import {
  bytesOf,
  elements,
  escapeXml,
  replaceElement,
  setAttribute,
  textOf,
  xmlAttrs,
} from "./xml.ts";
export const FILTER_RESOURCE = "SHEET_FILTER_PLUGIN";
type Parts = Record<string, Uint8Array>;
type Mapping = Record<string, { path: string }>;
const relPath = (path: string) => path.replace(/\/([^/]+)$/, "/_rels/$1.rels");
const read = (parts: Parts, path: string) => (parts[path] ? textOf(parts[path]) : "");
const ranges = (ref: string) => {
  const p = parseRange(ref.replaceAll("$", ""));
  return {
    startRow: p.startRow - 1,
    endRow: p.endRow - 1,
    startColumn: p.startCol - 1,
    endColumn: p.endCol - 1,
  };
};
const a1 = (r: { startRow: number; endRow: number; startColumn: number; endColumn: number }) =>
  `${indexToCol(r.startColumn + 1)}${r.startRow + 1}:${indexToCol(r.endColumn + 1)}${r.endRow + 1}`;
export function importFilterLinks(
  parts: Parts,
  mapping: Mapping,
  sheets: Record<string, Partial<IWorksheetData>>,
): { name: string; data: string } {
  const filters: Record<string, unknown> = {};
  for (const [sid, { path }] of Object.entries(mapping)) {
    const sheet = sheets[sid];
    if (!sheet) continue;
    const xml = read(parts, path);
    const filter = elements(xml, "autoFilter")[0];
    if (filter) {
      const ref = xmlAttrs(filter.open).ref;
      if (
        ref &&
        !/<(?:customFilters|dynamicFilter|colorFilter|iconFilter|top10|dateGroupItem|extLst)\b/.test(
          filter.inner,
        )
      ) {
        const range = ranges(ref),
          columns = elements(filter.inner, "filterColumn").map((column) => {
            const f = elements(column.inner, "filters")[0];
            return {
              colId: range.startColumn + Number(xmlAttrs(column.open).colId),
              filters: {
                ...(f && xmlAttrs(f.open).blank === "1" ? { blank: true } : {}),
                filters: elements(f?.inner ?? "", "filter").map((e) => xmlAttrs(e.open).val ?? ""),
              },
            };
          });
        const cachedFilteredOut: number[] = [];
        if ((range.endRow - range.startRow) * Math.max(1, columns.length) <= 200000) {
          for (let row = range.startRow + 1; row <= range.endRow; row++)
            if (
              columns.some((c) => {
                const value = sheet.cellData?.[row]?.[c.colId]?.v;
                return value === null || value === undefined || value === ""
                  ? !c.filters.blank
                  : !c.filters.filters.includes(String(value));
              })
            ) {
              cachedFilteredOut.push(row);
              if (sheet.rowData?.[row]?.hd) delete sheet.rowData[row]!.hd;
            }
          filters[sid] = { ref: range, filterColumns: columns, cachedFilteredOut };
        }
      }
    }
    const relationships = new Map(
      elements(read(parts, relPath(path)), "Relationship").map((e) => {
        const a = xmlAttrs(e.open);
        return [a.Id, a];
      }),
    );
    for (const link of elements(xml, "hyperlink")) {
      const a = xmlAttrs(link.open),
        target = relationships.get(a["r:id"] ?? "");
      const url = a.location ? `#${a.location}` : target?.Target;
      if (!url || !a.ref || !/^(?:https?:\/\/|mailto:|#)/i.test(url)) continue;
      const r = ranges(a.ref);
      if (r.startRow !== r.endRow || r.startColumn !== r.endColumn) continue;
      sheet.cellData ??= {};
      const row = sheet.cellData[r.startRow] ?? {},
        cell = row[r.startColumn] ?? {};
      cell.custom = { ...cell.custom, excelmanusHyperlink: { url } };
      row[r.startColumn] = cell;
      sheet.cellData[r.startRow] = row;
    }
  }
  return { name: FILTER_RESOURCE, data: JSON.stringify(filters) };
}
function linksOf(sheet: Partial<IWorksheetData> | undefined) {
  const links = new Map<string, string>();
  for (const [r, cells] of Object.entries(sheet?.cellData ?? {}))
    for (const [c, raw] of Object.entries(cells ?? {})) {
      const cell = raw as ICellData;
      const link = cell?.custom?.excelmanusHyperlink as { url?: unknown } | undefined;
      if (typeof link?.url === "string")
        links.set(`${indexToCol(Number(c) + 1)}${Number(r) + 1}`, link.url);
    }
  return links;
}
export function exportFilterLinks(
  parts: Parts,
  mapping: Mapping,
  snapshot: IWorkbookData,
  baseline: IWorkbookData,
) {
  const filters = rulesResource(snapshot, FILTER_RESOURCE) as Record<string, any>,
    oldFilters = rulesResource(baseline, FILTER_RESOURCE) as Record<string, any>;
  for (const [sid, sheet] of Object.entries(snapshot.sheets)) {
    const path = mapping[sid]?.path;
    if (!path) continue;
    let body = read(parts, path);
    const filter = filters[sid],
      old = oldFilters[sid];
    if (JSON.stringify(filter) !== JSON.stringify(old)) {
      let block = "";
      if (filter) {
        const columns = (filter.filterColumns ?? [])
          .map((column: any) => {
            if (column.customFilters || column.colorFilters)
              throw new FileOperationError("UNSUPPORTED_FEATURE", "当前筛选写回支持枚举值和空白项");
            return `<filterColumn colId="${column.colId - filter.ref.startColumn}"><filters${column.filters?.blank ? ' blank="1"' : ""}>${(column.filters?.filters ?? []).map((v: string) => `<filter val="${escapeXml(v)}"/>`).join("")}</filters></filterColumn>`;
          })
          .join("");
        block = `<autoFilter ref="${a1(filter.ref)}">${columns}</autoFilter>`;
      }
      body = replaceElement(body, "autoFilter", block);
      const hidden = new Set<number>(filter?.cachedFilteredOut ?? []),
        oldHidden = new Set<number>(old?.cachedFilteredOut ?? []);
      let data = elements(body, "sheetData")[0]?.inner ?? "";
      for (const row of new Set([...hidden, ...oldHidden])) {
        const previous = elements(data, "row").find((e) => Number(xmlAttrs(e.open).r) === row + 1);
        const hide = hidden.has(row) || !!sheet.rowData?.[row]?.hd;
        if (previous) {
          let open = previous.open;
          open = hide
            ? setAttribute(open, "hidden", "1")
            : open.replace(/\s+hidden=(?:"[^"]*"|'[^']*')/, "");
          data = data.replace(previous.raw, previous.raw.replace(previous.open, open));
        } else if (hide) {
          const next = elements(data, "row").find((e) => Number(xmlAttrs(e.open).r) > row + 1),
            at = next?.start ?? data.length;
          data = data.slice(0, at) + `<row r="${row + 1}" hidden="1"/>` + data.slice(at);
        }
      }

      body = replaceElement(body, "sheetData", `<sheetData>${data}</sheetData>`);
    }
    const links = linksOf(sheet),
      previous = linksOf(baseline.sheets[sid]);
    if (JSON.stringify([...links]) !== JSON.stringify([...previous])) {
      let block = elements(body, "hyperlinks")[0]?.inner ?? "",
        rels =
          read(parts, relPath(path)) ||
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
      for (const ref of new Set([...links.keys(), ...previous.keys()])) {
        const url = links.get(ref);
        if (url === previous.get(ref)) continue;
        for (const item of elements(block, "hyperlink"))
          if (xmlAttrs(item.open).ref === ref) block = block.replace(item.raw, "");
        if (!url) continue;
        if (!/^(?:https?:\/\/|mailto:|#)/i.test(url))
          throw new FileOperationError("UNSUPPORTED_FEATURE", "超链接协议不受支持");
        if (url.startsWith("#"))
          block += `<hyperlink ref="${ref}" location="${escapeXml(url.slice(1))}"/>`;
        else {
          let n = 1;
          while (
            elements(rels, "Relationship").some((e) => xmlAttrs(e.open).Id === `rId_em_link_${n}`)
          )
            n++;
          const rid = `rId_em_link_${n}`;
          const relation = `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escapeXml(url)}" TargetMode="External"/>`;
          if (rels.trimEnd().endsWith("/>"))
            rels = rels.replace(/\/>\s*$/, `>${relation}</Relationships>`);
          else rels = rels.replace("</Relationships>", `${relation}</Relationships>`);
          block += `<hyperlink ref="${ref}" r:id="${rid}"/>`;
        }
      }
      if (!/xmlns:r=/.test(body))
        body = body.replace(
          "<worksheet ",
          '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ',
        );
      body = replaceElement(body, "hyperlinks", block ? `<hyperlinks>${block}</hyperlinks>` : "");
      parts[relPath(path)] = bytesOf(rels);
    }
    parts[path] = bytesOf(body);
  }
}
