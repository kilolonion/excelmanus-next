import { posix } from "node:path";
import { indexToCol, type RangeRef } from "@excelmanus/core";
import { FileOperationError } from "@excelmanus/kernel";
import type { ICellData, IWorkbookData, IWorksheetData } from "@univerjs/core";
import { zipSync } from "fflate";
import type { DocMutation } from "./engine.ts";
import type { ChangeOp } from "./ops.ts";
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
  if (imported.preservation && !imported.csv) {
    for (const ref of Object.values(imported.preservation.sheetParts)) {
      const raw = textOf(imported.preservation.parts[ref.path] as Uint8Array);
      for (const row of elements(raw, "row")) {
        const inner = row.inner.replace(/<c(?:\s|\/>)[\s\S]*?<\/c>|<c(?:\s|\/)>/g, "");
        if (/<(?!\/)(?!c(?:\s|>))/i.test(inner)) unsupported(`${ref.path}:row extension`);
      }
      for (const c of elements(raw, "c")) {
        const attrs = xmlAttrs(c.open);
        if (
          attrs.t &&
          attrs.t !== "n" &&
          attrs.t !== "s" &&
          attrs.t !== "str" &&
          attrs.t !== "b" &&
          attrs.t !== "inlineStr"
        )
          unsupported(`${ref.path}:cell type`);
        if (c.inner.includes("<r>") || c.inner.includes("<is><r>"))
          unsupported(`${ref.path}:rich text`);
      }
    }
  }
  if (!p) unsupported("缺少原始 OOXML 部件");
  if (Object.keys(p.parts).some((n) => /^_xmlsignatures\//i.test(n))) unsupported("_xmlsignatures");
  for (const [id, ref] of Object.entries(p.sheetParts)) {
    if (!ranges.some((r) => r.sheetId === id || r.sheetId === "*")) continue;
    const xml = textOf(p.parts[ref.path] as Uint8Array);
    if (!/<worksheet(?:\s|>)/.test(xml)) unsupported(ref.path);
    const structural = ops
      ? ops.some(
          (o) =>
            /^(rows|cols)\.|^sheet.delete$/.test(o.op) &&
            "sheet" in o &&
            (o.sheet === id || o.sheet === before.sheets[id]?.name),
        )
      : mutations.some((m) => /(?:insert|remove)-(?:row|col|sheet)|move-range/.test(m.id));
    if (structural) {
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
    // Shared/array formulas cannot be rewritten from the currently incomplete read model.
    if (/<f\b[^>]*\bt=["'](?:shared|array|dataTable)["']/.test(xml))
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
        !/^sheet\.mutation\.(?:set-range-values|set-worksheet-name|insert-sheet|remove-sheet|insert-row|remove-rows|insert-col|remove-col|add-worksheet-merge|remove-worksheet-merge|set-frozen|set-worksheet-row-count|set-worksheet-column-count)$/.test(
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
function renderCell(cell: ICellData, ref: string, style: number): string {
  const s = style ? ` s="${style}"` : "";
  if (cell.p && !cell.v) unsupported("单元格富文本编辑");
  const f = cell.f ? `<f>${escapeXml(cell.f.replace(/^=/, ""))}</f>` : "";
  if (cell.f) {
    // Do not publish stale imported caches for a newly authored formula. Excel recalculates on open.
    return `<c r="${ref}"${s}>${f}</c>`;
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

function renderSheet(
  xml: string,
  sheet: Partial<IWorksheetData>,
  old: Partial<IWorksheetData> | undefined,
  after: IWorkbookData,
  styles: StyleWriter,
): string {
  const resized =
    !!old && (sheet.rowCount !== old.rowCount || sheet.columnCount !== old.columnCount);
  const rawRows = new Map<number, string>();
  const rawCells = new Map<string, string>();
  const extraCells = new Map<number, Array<[string, string]>>();
  for (const row of elements(elements(xml, "sheetData")[0]?.inner ?? "", "row")) {
    rawRows.set(Number(xmlAttrs(row.open).r) - 1, row.open);
    for (const c of elements(row.inner, "c")) {
      const ref = xmlAttrs(c.open).r ?? "";
      rawCells.set(ref, c.raw);
      const n = Number(xmlAttrs(row.open).r) - 1;
      const extras = extraCells.get(n) ?? [];
      extras.push([ref, c.raw]);
      extraCells.set(n, extras);
    }
  }
  const data = cellData(sheet);
  const previous = cellData(old);
  const rowIndexes = new Set(
    [...Object.keys(data), ...Object.keys(sheet.rowData ?? {}), ...rawRows.keys()].map(Number),
  );
  let maxR = 1;
  let maxC = 1;
  const rows: string[] = [];
  for (const r of [...rowIndexes].sort((a, b) => a - b)) {
    const rendered: string[] = [];
    for (const c of Object.keys(data[r] ?? {})
      .map(Number)
      .sort((a, b) => a - b)) {
      const ref = `${indexToCol(c + 1)}${r + 1}`;
      const cell = data[r]?.[c];
      if (!cell) continue;
      const oldCell = previous[r]?.[c];
      const raw = rawCells.get(ref);
      const rawS = raw ? Number(xmlAttrs(elements(raw, "c")[0]?.open ?? "<c/>").s ?? 0) : 0;
      if (raw && !cellsEqual(cell, oldCell)) {
        const node = elements(raw, "c")[0];
        if (node && Object.keys(xmlAttrs(node.open)).some((a) => !["r", "s", "t"].includes(a)))
          unsupported(`${ref}:cell metadata`);
        if (node && /<(?:extLst|[A-Za-z_][\w.-]*:)/.test(node.inner))
          unsupported(`${ref}:cell extension`);
      }
      const styleIndex = styles.index(cell, oldCell, after, rawS);
      const sameContent = cell.v === oldCell?.v && cell.f === oldCell?.f && cell.t === oldCell?.t;
      const encoded =
        raw && cellsEqual(cell, oldCell)
          ? raw
          : raw && sameContent
            ? raw.replace(
                elements(raw, "c")[0]?.open ?? "<c>",
                setAttribute(elements(raw, "c")[0]?.open ?? "<c>", "s", styleIndex),
              )
            : renderCell(cell, ref, styleIndex);
      if (encoded) {
        rendered.push(encoded);
        maxR = Math.max(maxR, r + 1);
        maxC = Math.max(maxC, c + 1);
      }
    }
    // Preserve unsupported empty/style-only cells that were absent from the read model.
    for (const [ref, raw] of resized ? [] : (extraCells.get(r) ?? [])) {
      const m = /^([A-Z]+)(\d+)$/.exec(ref);
      if (Number(m?.[2]) !== r + 1 || !m?.[1]) continue;
      let col = 0;
      for (const ch of m[1]) col = col * 26 + ch.charCodeAt(0) - 64;
      if (previous[r]?.[col - 1] === undefined && data[r]?.[col - 1] === undefined)
        rendered.push(raw);
    }
    let open = rawRows.get(r)?.replace(/\/>$/, ">") ?? `<row r="${r + 1}">`;
    const rd = sheet.rowData?.[r];
    const oldRd = old?.rowData?.[r];
    if (resized || JSON.stringify(rd) !== JSON.stringify(oldRd)) {
      open = `<row r="${r + 1}"${rd?.h !== undefined ? ` ht="${rd.h}" customHeight="1"` : ""}${rd?.hd ? ' hidden="1"' : ""}>`;
    }
    if (rendered.length || rd || (!resized && rawRows.has(r)))
      rows.push(`${open}${rendered.join("")}</row>`);
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
  }
  if (JSON.stringify(sheet.freeze) !== JSON.stringify(old?.freeze)) {
    const f = sheet.freeze;
    const pane =
      f && (f.xSplit || f.ySplit)
        ? `<pane xSplit="${f.xSplit}" ySplit="${f.ySplit}" topLeftCell="${indexToCol(f.startColumn + 1)}${f.startRow + 1}" state="frozen"/>`
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
): Uint8Array {
  const p = imported.preservation;
  if (imported.preservation && !imported.csv) {
    for (const ref of Object.values(imported.preservation.sheetParts)) {
      const raw = textOf(imported.preservation.parts[ref.path] as Uint8Array);
      for (const row of elements(raw, "row")) {
        const inner = row.inner.replace(/<c(?:\s|\/>)[\s\S]*?<\/c>|<c(?:\s|\/)>/g, "");
        if (/<(?!\/)(?!c(?:\s|>))/i.test(inner)) unsupported(`${ref.path}:row extension`);
      }
      for (const c of elements(raw, "c")) {
        const attrs = xmlAttrs(c.open);
        if (
          attrs.t &&
          attrs.t !== "n" &&
          attrs.t !== "s" &&
          attrs.t !== "str" &&
          attrs.t !== "b" &&
          attrs.t !== "inlineStr"
        )
          unsupported(`${ref.path}:cell type`);
        if (c.inner.includes("<r>") || c.inner.includes("<is><r>"))
          unsupported(`${ref.path}:rich text`);
      }
    }
  }
  if (!p) return minimalXlsx(snapshot);
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
    sheetTags.push(tag);
    const modified =
      !old ||
      ["cellData", "rowData", "columnData", "mergeData", "freeze"].some(
        (k) =>
          JSON.stringify(sheet[k as keyof IWorksheetData] ?? {}) !==
          JSON.stringify(old[k as keyof IWorksheetData] ?? {}),
      );
    if (modified)
      parts[ref.path] = bytesOf(
        renderSheet(textOf(parts[ref.path] as Uint8Array), sheet, old, snapshot, styleWriter),
      );
  }
  for (const [id, ref] of Object.entries(mapping)) {
    if (snapshot.sheets[id]) continue;
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
    parts["xl/workbook.xml"] = bytesOf(wb);
    parts["xl/_rels/workbook.xml.rels"] = bytesOf(rels);
    parts["[Content_Types].xml"] = bytesOf(types);
  }
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
        const back = cellData(a)[Number(r)]?.[Number(c)];
        if (cell.f ? cell.f !== back?.f : cell.v != null && cell.v !== back?.v)
          throw new FileOperationError("INTERNAL", "单元格回读校验失败");
      }
  });
}
