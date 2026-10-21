// Native DrawingML charts. Untouched package parts remain byte-identical.

import { createHash } from "node:crypto";
import { posix } from "node:path";
import { indexToCol, parseRange } from "@excelmanus/core";
import { FileOperationError } from "@excelmanus/kernel";
import { ChartObject, ImageObject, type ShapeObject, WorkbookObjects } from "@excelmanus/protocol";
import type { IWorkbookData, IWorksheetData } from "@univerjs/core";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import {
  appendDrawing, drawingAnchors, drawingCatalogue, drawingGeometry, drawingNode, drawingTheme, findDrawingAnchor,
  importShape, newDrawingAnchor, nextDrawingId, patchDrawingGeometry, patchShape, shapeContent,
} from "./drawing-codec.ts";
import { externalLinkMetadata } from "./external-links.ts";
import { pivotMetadata } from "./pivot-codec.ts";
import { bytesOf, elements, escapeXml, replaceElement, textOf, xmlAttrs } from "./xml.ts";

const C = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const D = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const P = "http://schemas.openxmlformats.org/package/2006/relationships";
type Parts = Record<string, Uint8Array>;
type SheetParts = Record<string, { path: string }>;
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: false,
});
const noteParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: false,
});
function unsupported(message: string): never {
  throw new FileOperationError("UNSUPPORTED_FEATURE", message);
}
const read = (parts: Parts, path: string): string => (parts[path] ? textOf(parts[path]!) : "");
const xml = (value: string, preserveNoteWhitespace = false): Record<string, any> => {
  // bounded OOXML trees, untrusted objects never spread into executable configuration
  if (/<!DOCTYPE|<!ENTITY/i.test(value) || XMLValidator.validate(value) !== true) return {};
  return (preserveNoteWhitespace ? noteParser : parser).parse(value) as Record<string, any>;
};
const list = <T>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];
const relPath = (part: string) => `${posix.dirname(part)}/_rels/${posix.basename(part)}.rels`;
function target(parts: Parts, part: string, id: string): string | undefined {
  for (const rel of list(xml(read(parts, relPath(part))).Relationships?.Relationship)) {
    if (rel?.["@_Id"] !== id || rel["@_TargetMode"] === "External") continue;
    const raw = String(rel["@_Target"] ?? "");
    if (/[:\\?#]/.test(raw)) return undefined;
    const path = posix.normalize(
      raw.startsWith("/") ? raw.slice(1) : posix.join(posix.dirname(part), raw),
    );
    if (!path.startsWith("xl/")) return undefined;
    return path;
  }
  return undefined;
}
export function objectsOf(sheet: Partial<IWorksheetData> | undefined): WorkbookObjects {
  const parsed = WorkbookObjects.safeParse(sheet?.custom?.excelmanusObjects);
  return parsed.success ? parsed.data : { charts: [], images: [] };
}

/** Bounded, read-only evidence from the saved chart parts, not inferred live cell values. */
export function chartCacheMetadata(parts: Parts) {
  const paths = Object.keys(parts).filter((p) => /^xl\/charts\/[^/]+\.xml$/.test(p));
  return {
    truncated: paths.length > 20,
    charts: paths.slice(0, 20).map((part) => {
      const body = read(parts, part);
      const prefixes = new Set(
        [...body.matchAll(/<([A-Za-z_][\w.-]*:)?ser\b/g)].map((m) => m[1] ?? ""),
      );
      const nodes = [...prefixes].flatMap((prefix) => elements(body, prefix + "ser"));
      const reference = (node: any) => {
        const ref = node?.strRef ?? node?.numRef;
        if (!ref) return undefined;
        const cache = ref.strCache ?? ref.numCache;
        const points = list(cache?.pt);
        return {
          formula: ref.f,
          pointCount: Number(cache?.ptCount?.["@_val"] ?? 0),
          hasCache: Boolean(cache),
          truncated: points.length > 20,
          points: points
            .slice(0, 20)
            .map((p) => ({ index: Number(p?.["@_idx"]), value: p?.v ?? "" })),
        };
      };
      return {
        part,
        truncated: nodes.length > 8,
        series: nodes.slice(0, 8).map((node) => {
          const s = xml(node.raw).ser;
          return {
            label: reference(s?.tx),
            categories: reference(s?.cat ?? s?.xVal),
            values: reference(s?.val ?? s?.yVal),
          };
        }),
      };
    }),
  };
}

function chartXml(chart: ChartObject, sheet: Partial<IWorksheetData>): string {
  const ref = parseRange(chart.range);
  const count = ref.endRow - ref.startRow;
  const seriesCount = ref.endCol - ref.startCol;
  if (count < 1 || count > 10000 || seriesCount < 1 || seriesCount > 32)
    unsupported("图表范围必须包含表头、1–10000行明细和1–32个数值系列");
  const name = `'${String(sheet.name).replaceAll("'", "''")}'`;
  const abs = (c: number, r: number) => `$${indexToCol(c)}$${r}`;
  const formula = (c: number, first = ref.startRow + 1, last = ref.endRow) =>
    `${name}!${abs(c, first)}:${abs(c, last)}`;
  const v = (r: number, c: number) => sheet.cellData?.[r - 1]?.[c - 1]?.v;
  if (chart.type === "scatter") {
    let numeric = 0;
    for (let row = ref.startRow + 1; row <= ref.endRow; row++) {
      const value = v(row, ref.startCol);
      if (typeof value === "number" && Number.isFinite(value)) numeric++;
      else if (value !== null && value !== undefined && value !== "")
        unsupported("散点图 X 轴必须为数值，文本分类请使用折线图");
    }
    if (!numeric) unsupported("散点图 X 轴没有有效数值");
  }
  const cache = (c: number, numeric: boolean) =>
    `<c:ptCount val="${count}"/>` +
    Array.from({ length: count }, (_, i) => {
      const value = v(ref.startRow + 1 + i, c);
      if (numeric && (typeof value !== "number" || !Number.isFinite(value))) return "";
      return `<c:pt idx="${i}"><c:v>${escapeXml(String(value ?? ""))}</c:v></c:pt>`;
    }).join("");
  const series = (col: number, index: number) => {
    const label = `<c:tx><c:strRef><c:f>${escapeXml(`${name}!${abs(col, ref.startRow)}`)}</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${escapeXml(String(v(ref.startRow, col) ?? `系列${index + 1}`))}</c:v></c:pt></c:strCache></c:strRef></c:tx>`;
    const xy = chart.type === "scatter";
    const category = xy
      ? `<c:xVal><c:numRef><c:f>${escapeXml(formula(ref.startCol))}</c:f><c:numCache>${cache(ref.startCol, true)}</c:numCache></c:numRef></c:xVal>`
      : `<c:cat><c:strRef><c:f>${escapeXml(formula(ref.startCol))}</c:f><c:strCache>${cache(ref.startCol, false)}</c:strCache></c:strRef></c:cat>`;
    const val = xy ? "yVal" : "val";
    return `<c:ser><c:idx val="${index}"/><c:order val="${index}"/>${label}${category}<c:${val}><c:numRef><c:f>${escapeXml(formula(col))}</c:f><c:numCache><c:formatCode>General</c:formatCode>${cache(col, true)}</c:numCache></c:numRef></c:${val}></c:ser>`;
  };
  const all = Array.from({ length: seriesCount }, (_, i) => series(ref.startCol + 1 + i, i));
  const axesIds = '<c:axId val="100"/><c:axId val="200"/>';
  let plots: string;
  switch (chart.type) {
    case "column":
    case "bar":
      plots = `<c:barChart><c:barDir val="${chart.type === "bar" ? "bar" : "col"}"/><c:grouping val="clustered"/>${all.join("")}${axesIds}</c:barChart>`;
      break;
    case "line":
      plots = `<c:lineChart><c:grouping val="standard"/>${all.join("")}${axesIds}</c:lineChart>`;
      break;
    case "area":
      plots = `<c:areaChart><c:grouping val="standard"/>${all.join("")}${axesIds}</c:areaChart>`;
      break;
    case "scatter":
      plots = `<c:scatterChart><c:scatterStyle val="lineMarker"/>${all.join("")}${axesIds}</c:scatterChart>`;
      break;
    case "pie":
    case "doughnut":
      if (seriesCount !== 1) unsupported("饼图和圆环图只接受一个数值系列");
      plots = `<c:${chart.type}Chart><c:varyColors val="1"/>${all.join("")}${chart.type === "doughnut" ? '<c:holeSize val="50"/>' : ""}</c:${chart.type}Chart>`;
      break;
    case "combo":
      if (seriesCount < 2) unsupported("组合图至少需要两个数值系列，最后一个为折线");
      plots = `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>${all.slice(0, -1).join("")}${axesIds}</c:barChart><c:lineChart><c:grouping val="standard"/>${all.at(-1)}${axesIds}</c:lineChart>`;
      break;
  }
  const xType = chart.type === "scatter" ? "valAx" : "catAx";
  const axes =
    chart.type === "pie" || chart.type === "doughnut"
      ? ""
      : `<c:${xType}><c:axId val="100"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="${chart.type === "bar" ? "l" : "b"}"/><c:crossAx val="200"/><c:crosses val="autoZero"/>${xType === "catAx" ? '<c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/>' : ""}</c:${xType}><c:valAx><c:axId val="200"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="${chart.type === "bar" ? "b" : "l"}"/><c:majorGridlines/><c:numFmt formatCode="General" sourceLinked="1"/><c:crossAx val="100"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:chartSpace xmlns:c="${C}" xmlns:a="${A}" xmlns:r="${R}"><c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${escapeXml(chart.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/><c:plotArea><c:layout/>${plots}${axes}</c:plotArea><c:legend><c:legendPos val="r"/><c:overlay val="0"/></c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`;
}
function append(xmlText: string, closing: string, fragment: string): string {
  if (xmlText.includes(closing)) return xmlText.replace(closing, fragment + closing);
  return xmlText.replace(/\/>\s*$/, `>${fragment}${closing}`);
}
function relation(
  parts: Parts,
  source: string,
  id: string,
  type: string,
  destination: string,
): void {
  const path = relPath(source);
  let body = read(parts, path) || `<Relationships xmlns="${P}"/>`;
  if (elements(body, "Relationship").some((e) => xmlAttrs(e.open).Id === id)) return;
  body = append(
    body,
    "</Relationships>",
    `<Relationship Id="${id}" Type="${R}/${type}" Target="${escapeXml(posix.relative(posix.dirname(source), destination))}"/>`,
  );
  parts[path] = bytesOf(body);
}
function contentType(parts: Parts, path: string, type: string): void {
  const body = read(parts, "[Content_Types].xml");
  if (elements(body, "Override").some((e) => xmlAttrs(e.open).PartName === `/${path}`)) return;
  parts["[Content_Types].xml"] = bytesOf(
    append(body, "</Types>", `<Override PartName="/${path}" ContentType="${type}"/>`),
  );
}
function removeAnchor(body: string, id: string): string {
  return body.replace(
    /<(?:xdr:)?(?:oneCellAnchor|twoCellAnchor|absoluteAnchor)\b[\s\S]*?<\/(?:xdr:)?(?:oneCellAnchor|twoCellAnchor|absoluteAnchor)>/g,
    (block) => (block.includes(`name="${id}"`) ? "" : block),
  );
}
/** Refresh only caches whose exact source cells changed; retain foreign references and styling. */
function refreshImportedCaches(
  source: string,
  sheet: Partial<IWorksheetData>,
  before: Partial<IWorksheetData> | undefined,
): string {
  const prefixes = new Set(
    [...source.matchAll(/<([A-Za-z_][\w.-]*:)?(?:numRef|strRef)\b/g)].map((m) => m[1] ?? ""),
  );
  let output = source;
  for (const prefix of prefixes)
    for (const kind of ["numRef", "strRef"] as const) {
      for (const node of elements(source, prefix + kind)) {
        const formula = xml(node.raw)[kind]?.f;
        if (typeof formula !== "string") continue;
        try {
          const start = formula.lastIndexOf("!") + 1;
          const range = parseRange(
            formula.slice(0, start) + formula.slice(start).replaceAll("$", ""),
          );
          if (range.sheet && range.sheet !== sheet.name) continue;
          const rows = range.endRow - range.startRow + 1,
            cols = range.endCol - range.startCol + 1;
          if ((rows !== 1 && cols !== 1) || rows * cols > 10000) continue;
          const values = (s: Partial<IWorksheetData> | undefined) =>
            Array.from(
              { length: rows * cols },
              (_, i) =>
                s?.cellData?.[range.startRow - 1 + Math.floor(i / cols)]?.[
                  range.startCol - 1 + (i % cols)
                ]?.v ?? null,
            );
          const current = values(sheet);
          if (JSON.stringify(current) === JSON.stringify(values(before))) continue;
          const tag = prefix + (kind === "numRef" ? "numCache" : "strCache");
          const cache = elements(node.inner, tag)[0];
          if (!cache) continue;
          // Extensions are opaque and must survive, including any nested point-like tags.
          const extension = elements(cache.inner, prefix + "extLst")[0];
          let head = extension ? cache.inner.slice(0, extension.start) : cache.inner;
          const tail = extension ? cache.inner.slice(extension.start) : "";
          for (const old of [
            ...elements(head, prefix + "ptCount"),
            ...elements(head, prefix + "pt"),
          ])
            head = head.replace(old.raw, "");
          const points = current
            .map((v, i) =>
              kind === "numRef" && (typeof v !== "number" || !Number.isFinite(v))
                ? ""
                : `<${prefix}pt idx="${i}"><${prefix}v>${escapeXml(v ?? "")}</${prefix}v></${prefix}pt>`,
            )
            .join("");
          const refreshed = `${cache.open.replace(/\/>$/, ">")}${head}<${prefix}ptCount val="${current.length}"/>${points}${tail}</${tag}>`;
          output = output.replace(node.raw, node.raw.replace(cache.raw, refreshed));
        } catch {
          // Non-rectangular, external or named references remain byte-preserved.
        }
      }
    }
  return output;
}

/** Call after cell serialization and workbook relationship updates. */
export function exportObjects(
  parts: Parts,
  mapping: SheetParts,
  snapshot: IWorkbookData,
  baseline: IWorkbookData,
): void {
  for (const [sid, sheet] of Object.entries(snapshot.sheets)) {
    const sheetKey = createHash("sha256").update(sid).digest("hex").slice(0, 16);
    const objects = objectsOf(sheet);
    const previous = objectsOf(baseline.sheets[sid]);
    if (!objects.charts.length && !previous.charts.length) continue;
    const sheetPart = mapping[sid]?.path;
    if (!sheetPart) unsupported("图表工作表缺少 OOXML 部件");
    for (const old of previous.charts) {
      if (objects.charts.some((c) => c.id === old.id)) continue;
      const drawingId = xml(read(parts, sheetPart)).worksheet?.drawing?.["@_id"];
      const part =
        old.drawingPart ?? (drawingId ? target(parts, sheetPart, String(drawingId)) : undefined);
      if (part) {
        const source = read(parts, part),
          updated = removeAnchor(source, old.id);
        if (source === updated) unsupported("该导入图表的锚点标识不能安全匹配，未删除任何内容");
        parts[part] = bytesOf(updated);
      }
      const oldPart = old.chartPart ?? `xl/charts/chart-em_${sheetKey}_${old.id}.xml`;
      if (oldPart.includes("/chart-em_") && part) {
        const relsPath = relPath(part);
        let rels = read(parts, relsPath);
        for (const rel of elements(rels, "Relationship")) {
          const attrs = xmlAttrs(rel.open);
          if (
            attrs.Id &&
            target(parts, part, attrs.Id) === oldPart &&
            !read(parts, part).includes(`r:id="${attrs.Id}"`)
          )
            rels = rels.replace(rel.raw, "");
        }
        parts[relsPath] = bytesOf(rels);
        delete parts[oldPart];
        let types = read(parts, "[Content_Types].xml");
        for (const tag of elements(types, "Override"))
          if (xmlAttrs(tag.open).PartName === `/${oldPart}`) types = types.replace(tag.raw, "");
        parts["[Content_Types].xml"] = bytesOf(types);
      }
    }
    for (const chart of objects.charts) {
      const old = previous.charts.find((c) => c.id === chart.id);
      if (
        old?.chartPart &&
        !old.chartPart.includes("/chart-em_") &&
        JSON.stringify(chart) === JSON.stringify(old)
      ) {
        const original = read(parts, old.chartPart);
        const refreshed = refreshImportedCaches(original, sheet, baseline.sheets[sid]);
        if (refreshed !== original) parts[old.chartPart] = bytesOf(refreshed);
        continue;
      }
      if (old && JSON.stringify(chart) === JSON.stringify(old)) {
        const source = parseRange(chart.range);
        if (source.endRow - source.startRow > 10000 || source.endCol - source.startCol > 32)
          unsupported("图表数据范围过大");
        const values = (s: Partial<IWorksheetData> | undefined) =>
          JSON.stringify(
            Array.from({ length: source.endRow - source.startRow + 1 }, (_, r) =>
              Array.from(
                { length: source.endCol - source.startCol + 1 },
                (_, c) =>
                  s?.cellData?.[source.startRow + r - 1]?.[source.startCol + c - 1]?.v ?? null,
              ),
            ),
          );
        if (values(sheet) === values(baseline.sheets[sid])) continue;
      }
      // Even unchanged charts refresh numeric caches when source cells change.
      const chartPart = chart.chartPart ?? `xl/charts/chart-em_${sheetKey}_${chart.id}.xml`;
      const existingDrawing = xml(read(parts, sheetPart)).worksheet?.drawing?.["@_id"];
      const drawingPart =
        chart.drawingPart ??
        (existingDrawing ? target(parts, sheetPart, String(existingDrawing)) : undefined) ??
        `xl/drawings/drawing-${sheetKey}.xml`;
      if (old && old.chartPart && !old.chartPart.includes("/chart-em_")) {
        if (JSON.stringify(chart) === JSON.stringify(old)) continue;
        if (
          chart.type !== old.type ||
          chart.anchor !== old.anchor ||
          chart.width !== old.width ||
          chart.height !== old.height
        )
          unsupported("导入图表仅支持修改标题和数据范围；锚点、类型和尺寸保留");
        const original = read(parts, chartPart),
          generated = chartXml(chart, sheet);
        const oldSeries = elements(original, "c:ser"),
          newSeries = elements(generated, "c:ser");
        if (!oldSeries.length || oldSeries.length !== newSeries.length)
          unsupported("导入图表更新需保持系列数量和标准 c: 命名空间");
        let patched = original;
        for (let i = 0; i < oldSeries.length; i++) {
          const oldSer = oldSeries[i]!,
            newSer = newSeries[i]!;
          let value = oldSer.raw;
          for (const tag of ["c:tx", "c:cat", "c:val", "c:xVal", "c:yVal"]) {
            const oldNode = elements(value, tag)[0],
              newNode = elements(newSer.raw, tag)[0];
            if (oldNode && newNode) value = value.replace(oldNode.raw, newNode.raw);
            else if (Boolean(oldNode) !== Boolean(newNode))
              unsupported("导入图表系列结构不支持无损修改");
          }
          patched = patched.replace(oldSer.raw, value);
        }
        if (chart.title !== old.title) {
          const title = elements(patched, "c:title")[0],
            replacement = elements(generated, "c:title")[0];
          if (!title || !replacement) unsupported("导入图表标题结构暂不支持");
          patched = patched.replace(title.raw, replacement.raw);
        }
        parts[chartPart] = bytesOf(patched);
        continue;
      }
      parts[chartPart] = bytesOf(chartXml(chart, sheet));
      let drawing =
        read(parts, drawingPart) || `<xdr:wsDr xmlns:xdr="${D}" xmlns:a="${A}" xmlns:r="${R}"/>`;
      const drawingBefore = drawing;
      const oldAnchor = drawing
        .match(
          /<(?:xdr:)?(?:oneCellAnchor|twoCellAnchor|absoluteAnchor)\b[\s\S]*?<\/(?:xdr:)?(?:oneCellAnchor|twoCellAnchor|absoluteAnchor)>/g,
        )
        ?.find((block) => block.includes(`name="${chart.id}"`));
      drawing = removeAnchor(drawing, chart.id);
      const anchor = parseRange(chart.anchor);
      const rid = `rId_${chart.id}`;
      const existingIds = [...drawing.matchAll(/<\w*:cNvPr\b[^>]*\bid="(\d+)"/g)].map((m) =>
        Number(m[1]),
      );
      const objectId =
        Number(oldAnchor?.match(/<\w*:cNvPr\b[^>]*\bid="(\d+)"/)?.[1]) ||
        Math.max(0, ...existingIds) + 1;
      const block = `<xdr:oneCellAnchor><xdr:from><xdr:col>${anchor.startCol - 1}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${anchor.startRow - 1}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="${chart.width * 9525}" cy="${chart.height * 9525}"/><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${objectId}" name="${chart.id}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="${C}"><c:chart xmlns:c="${C}" xmlns:r="${R}" r:id="${rid}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:oneCellAnchor>`;
      parts[drawingPart] = bytesOf(
        oldAnchor ? drawingBefore.replace(oldAnchor, block) : append(drawing, "</xdr:wsDr>", block),
      );
      relation(parts, drawingPart, rid, "chart", chartPart);
      if (!existingDrawing) {
        const drawId = `rId_em_${sid}`;
        relation(parts, sheetPart, drawId, "drawing", drawingPart);
        let sheetXml = read(parts, sheetPart);
        if (!/xmlns:r=/.test(sheetXml))
          sheetXml = sheetXml.replace("<worksheet ", `<worksheet xmlns:r="${R}" `);
        parts[sheetPart] = bytesOf(append(sheetXml, "</worksheet>", `<drawing r:id="${drawId}"/>`));
      }
      contentType(
        parts,
        chartPart,
        "application/vnd.openxmlformats-officedocument.drawingml.chart+xml",
      );
      contentType(parts, drawingPart, "application/vnd.openxmlformats-officedocument.drawing+xml");
    }
  }
}

export function importObjects(
  parts: Parts,
  mapping: SheetParts,
  sheets: Record<string, Partial<IWorksheetData>>,
): void {
  for (const [sid, entry] of Object.entries(mapping)) {
    const sheet = sheets[sid];
    if (!sheet) continue;
    const sheetXml = read(parts, entry.path);
    // Worksheets have already been validated by the importer. Avoid parsing all cells again
    // when no drawing is possible; prefixed names and false positives retain the original parser.
    if (!/<(?:[^<>\s/:]+:)?drawing(?=[\s/>])/.test(sheetXml)) continue;
    const drawingId = xml(sheetXml).worksheet?.drawing?.["@_id"];
    const drawingPart = drawingId ? target(parts, entry.path, String(drawingId)) : undefined;
    if (!drawingPart) continue;
    const charts: ChartObject[] = [];
    const images: ImageObject[] = [];
    const shapes: ShapeObject[] = [];
    const theme = drawingTheme(read(parts, "xl/theme/theme1.xml"));
    for (const node of drawingAnchors(read(parts, drawingPart))) {
      if (node.namespaceReason) continue;
      const anchor = drawingNode(node.raw);
      if (!anchor.from) continue;
      if (anchor?.sp) {
        const shape = importShape(anchor, theme);
        if (shape) shapes.push(shape);
        continue;
      }
      const pic = anchor?.pic;
      if (pic) {
        const rid = pic.blipFill?.blip?.["@_embed"];
        const mediaPart = rid ? target(parts, drawingPart, String(rid)) : undefined;
        const bytes = mediaPart ? parts[mediaPart] : undefined;
        const mediaType = bytes ? sniffWorkbookImage(bytes) : undefined;
        if (mediaPart && mediaType) {
          const rawId = String(pic.nvPicPr?.cNvPr?.["@_name"] ?? "");
          const parsed = ImageObject.safeParse({
            id: /^[A-Za-z0-9_-]{1,100}$/.test(rawId) ? rawId : `image_${images.length}`,
            drawingObjectId: String(pic.nvPicPr?.cNvPr?.["@_id"] ?? ""),
            title: String(pic.nvPicPr?.cNvPr?.["@_descr"] ?? rawId),
            ...drawingGeometry(anchor, pic),
            mediaPart,
            mediaType,
          });
          if (parsed.success) images.push(parsed.data);
        }
        continue;
      }
      const frame = anchor?.graphicFrame;
      const rid = frame?.graphic?.graphicData?.chart?.["@_id"];
      const chartPart = rid ? target(parts, drawingPart, String(rid)) : undefined;
      if (!chartPart) continue;
      const chart = xml(read(parts, chartPart)).chartSpace?.chart;
      const plot = chart?.plotArea;
      if (!plot) continue;
      const type =
        plot.barChart && plot.lineChart
          ? "combo"
          : plot.barChart
            ? plot.barChart.barDir?.["@_val"] === "bar"
              ? "bar"
              : "column"
            : plot.lineChart
              ? "line"
              : plot.pieChart
                ? "pie"
                : plot.doughnutChart
                  ? "doughnut"
                  : plot.scatterChart
                    ? "scatter"
                    : plot.areaChart
                      ? "area"
                      : undefined;
      if (!type) continue;
      const series = [
        ...list(plot.barChart?.ser),
        ...list(plot.lineChart?.ser),
        ...list(plot.pieChart?.ser),
        ...list(plot.doughnutChart?.ser),
        ...list(plot.scatterChart?.ser),
        ...list(plot.areaChart?.ser),
      ];
      const first = series[0];
      const last = series.at(-1);
      const cat = first?.cat?.strRef?.f ?? first?.cat?.numRef?.f ?? first?.xVal?.numRef?.f;
      const val = last?.val?.numRef?.f ?? last?.yVal?.numRef?.f;
      if (typeof cat !== "string" || typeof val !== "string") continue;
      try {
        const a = parseRange(cat.replaceAll("$", "")),
          b = parseRange(val.replaceAll("$", ""));
        if (
          a.startRow !== b.startRow ||
          a.endRow !== b.endRow ||
          a.startRow < 2 ||
          (a.sheet && a.sheet !== sheet.name) ||
          (b.sheet && b.sheet !== sheet.name)
        )
          continue;
        const rawId = String(frame?.nvGraphicFramePr?.cNvPr?.["@_name"] ?? "");
        const id = /^[A-Za-z0-9_-]{1,100}$/.test(rawId) ? rawId : `imported_${charts.length}`;
        const title =
          chart?.title?.tx?.rich?.p?.r?.t ?? chart?.title?.tx?.strRef?.strCache?.pt?.v ?? "";
        const parsed = ChartObject.safeParse({
          id,
          type,
          title: String(title),
          range: `${indexToCol(a.startCol)}${a.startRow - 1}:${indexToCol(b.endCol)}${b.endRow}`,
          anchor: `${indexToCol(Number(anchor.from?.col ?? 0) + 1)}${Number(anchor.from?.row ?? 0) + 1}`,
          width: Math.round(Number(anchor.ext?.["@_cx"] ?? 6096000) / 9525),
          height: Math.round(Number(anchor.ext?.["@_cy"] ?? 3429000) / 9525),
          chartPart,
          drawingPart,
        });
        if (parsed.success) charts.push(parsed.data);
      } catch {
        /* Unsupported references stay preserved and read-only. */
      }
    }
    if (charts.length || images.length || shapes.length)
      sheet.custom = { ...sheet.custom, excelmanusObjects: { charts, images, ...(shapes.length ? { shapes } : {}) } };
  }
}

/** Object changes are derived from snapshots, never from an agent's narration. */
export function describeObjectChanges(before: IWorkbookData, after: IWorkbookData): string[] {
  const out: string[] = [];
  const survivingBefore = before.sheetOrder.filter((id) => after.sheets[id]);
  const survivingAfter = after.sheetOrder.filter((id) => before.sheets[id]);
  if (JSON.stringify(survivingBefore) !== JSON.stringify(survivingAfter))
    out.push("调整工作表顺序");
  for (const [sid, sheet] of Object.entries(after.sheets)) {
    const a = objectsOf(before.sheets[sid]).charts,
      b = objectsOf(sheet).charts;
    for (const chart of b) {
      const old = a.find((c) => c.id === chart.id);
      if (!old) out.push(`新增图表「${chart.title}」（${sheet.name}）`);
      else if (JSON.stringify(old) !== JSON.stringify(chart))
        out.push(`更新图表「${chart.title}」（${sheet.name}）`);
    }
    for (const chart of a)
      if (!b.some((c) => c.id === chart.id))
        out.push(`删除图表「${chart.title}」（${sheet.name}）`);
    if (Number(before.sheets[sid]?.hidden ?? 0) !== Number(sheet.hidden ?? 0))
      out.push(`${sheet.hidden ? "隐藏" : "显示"}工作表「${sheet.name}」`);
    if (
      JSON.stringify(objectsOf(before.sheets[sid]).pivotRefreshOnLoad ?? {}) !==
      JSON.stringify(objectsOf(sheet).pivotRefreshOnLoad ?? {})
    )
      out.push(
        `更新透视缓存打开时刷新标记（${sheet.name}）；共享该缓存的所有透视表受影响，未立即刷新`,
      );
    const oldThreads = objectsOf(before.sheets[sid]).threadedComments ?? [];
    for (const comment of objectsOf(sheet).threadedComments ?? []) {
      const old = oldThreads.find(c => c.id === comment.id);
      if (!old) out.push(`${comment.parentId ? "回复" : "新增"}线程批注（${sheet.name}!${comment.ref}）`);
      else if (old.done !== comment.done) out.push(`${comment.done ? "解决" : "重新打开"}线程批注（${sheet.name}!${comment.ref}）`);
    }
    for (const comment of oldThreads)
      if (!(objectsOf(sheet).threadedComments ?? []).some(c => c.id === comment.id))
        out.push(`撤回线程批注（${sheet.name}!${comment.ref}）`);
    const oldNotes = objectsOf(before.sheets[sid]).notes ?? [], notes = objectsOf(sheet).notes ?? [];
    for (const note of notes) {
      const previous = oldNotes.find((item) => item.ref === note.ref);
      if (JSON.stringify(previous) !== JSON.stringify(note))
        out.push(`${previous ? "修改" : "新增"}批注（${sheet.name}!${note.ref}）`);
    }
    for (const note of oldNotes)
      if (!notes.some((item) => item.ref === note.ref)) out.push(`删除批注（${sheet.name}!${note.ref}）`);
    const oldImages = objectsOf(before.sheets[sid]).images;
    for (const image of objectsOf(sheet).images) {
      const previous = oldImages.find((i) => i.id === image.id);
      if (!previous)
        out.push(`新增图片「${image.title || image.id}」（${sheet.name}）`);
      else if (JSON.stringify(previous) !== JSON.stringify(image))
        out.push(`更新图片「${image.title || image.id}」（${sheet.name}）`);
    }
    for (const image of oldImages)
      if (!objectsOf(sheet).images.some((item) => item.id === image.id))
        out.push(`删除图片「${image.title || image.id}」（${sheet.name}）`);
    const oldShapes = objectsOf(before.sheets[sid]).shapes ?? [];
    const shapes = objectsOf(sheet).shapes ?? [];
    for (const shape of shapes) {
      const previous = oldShapes.find((item) => item.id === shape.id);
      if (!previous) out.push(`新增形状「${shape.title || shape.id}」（${sheet.name}）`);
      else if (JSON.stringify(previous) !== JSON.stringify(shape))
        out.push(`更新形状「${shape.title || shape.id}」（${sheet.name}）`);
    }
    for (const shape of oldShapes)
      if (!shapes.some((item) => item.id === shape.id))
        out.push(`删除形状「${shape.title || shape.id}」（${sheet.name}）`);
    for (const [key, label] of [
      ["rowData", "行高/行属性"],
      ["columnData", "列宽/列属性"],
    ] as const)
      if (JSON.stringify(before.sheets[sid]?.[key] ?? {}) !== JSON.stringify(sheet[key] ?? {}))
        out.push(`调整${label}（${sheet.name}）`);
  }
  return out;
}

export function sniffWorkbookImage(bytes: Uint8Array): ImageObject["mediaType"] | undefined {
  if (
    bytes.length >= 8 &&
    Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return "image/jpeg";
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(Buffer.from(bytes.subarray(0, 6)).toString("ascii")))
    return "image/gif";
  return undefined;
}
export function exportImages(
  parts: Parts,
  mapping: SheetParts,
  snapshot: IWorkbookData,
  baseline: IWorkbookData,
): void {
  exportDrawingObjects(parts, mapping, snapshot, baseline, "image");
}
export function exportShapes(
  parts: Parts,
  mapping: SheetParts,
  snapshot: IWorkbookData,
  baseline: IWorkbookData,
): void {
  exportDrawingObjects(parts, mapping, snapshot, baseline, "shape");
}
function exportDrawingObjects(
  parts: Parts,
  mapping: SheetParts,
  snapshot: IWorkbookData,
  baseline: IWorkbookData,
  kind: "image" | "shape",
): void {
  const select = (sheet: Partial<IWorksheetData> | undefined): (ImageObject | ShapeObject)[] =>
    kind === "image" ? objectsOf(sheet).images : objectsOf(sheet).shapes ?? [];
  for (const [sid, sheet] of Object.entries(snapshot.sheets)) {
    const current = select(sheet), previous = select(baseline.sheets[sid]);
    if (JSON.stringify(current) === JSON.stringify(previous)) continue;
    const sheetPart = mapping[sid]?.path;
    if (!sheetPart) continue;
    const key = createHash("sha256").update(sid).digest("hex").slice(0, 16);
    const drawingId = xml(read(parts, sheetPart)).worksheet?.drawing?.["@_id"];
    const drawingPart = (drawingId ? target(parts, sheetPart, String(drawingId)) : undefined)
      ?? `xl/drawings/drawing-${key}.xml`;
    let drawing = read(parts, drawingPart) || `<xdr:wsDr xmlns:xdr="${D}" xmlns:a="${A}" xmlns:r="${R}"/>`;
    const marker = (id: string) => `em-${kind}-${createHash("sha256").update(id).digest("hex")}`;
    for (const object of previous.filter((item) => !current.some((next) => next.id === item.id))) {
      const node = findDrawingAnchor(drawing, object, kind);
      if (!node) unsupported(`无法定位原始${kind === "image" ? "图片" : "形状"}，未删除任何内容`);
      drawing = drawing.replace(node.raw, `<!--${marker(object.id)}:${Buffer.from(node.raw).toString("base64")}-->`);
    }
    for (const object of current) {
      const old = previous.find((item) => item.id === object.id);
      if (JSON.stringify(object) === JSON.stringify(old)) continue;
      if (!old) drawing = drawing.replace(
        new RegExp(`<!--${marker(object.id)}:([A-Za-z0-9+/=]+)-->`),
        (_all, encoded: string) => Buffer.from(encoded, "base64").toString("utf8"),
      );
      const node = findDrawingAnchor(drawing, object, kind);
      if (node) {
        if (!old) continue; // A deleted object was restored verbatim by revision undo.
        let patched = node.raw;
        if (["anchor", "width", "height", "offsetX", "offsetY"].some((field) =>
          object[field as keyof typeof object] !== old[field as keyof typeof old]))
          patched = patchDrawingGeometry(patched, object, sheet);
        if (kind === "shape") patched = patchShape(patched, object as ShapeObject, old as ShapeObject);
        drawing = drawing.replace(node.raw, patched);
        continue;
      }
      if (old) unsupported("无法定位原始绘图对象，未进行重建");
      let content: string;
      if (kind === "image") {
        const image = object as ImageObject;
        if (!image.data) unsupported("新增图片缺少内容，不能从未知部件重建");
        const bytes = Buffer.from(image.data, "base64");
        if (bytes.length > 10_000_000 || sniffWorkbookImage(bytes) !== image.mediaType)
          unsupported("图片格式或大小不符合限制");
        const ext = image.mediaType === "image/jpeg" ? "jpg" : image.mediaType.split("/")[1];
        const mediaPart = `xl/media/image-em_${key}_${image.id}.${ext}`;
        const rid = `rId_${image.id}`;
        parts[mediaPart] = bytes;
        relation(parts, drawingPart, rid, "image", mediaPart);
        contentType(parts, mediaPart, image.mediaType);
        content = `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${nextDrawingId(drawing)}" name="${image.id}" descr="${escapeXml(image.title)}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${image.width * 9525}" cy="${image.height * 9525}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>`;
      } else content = shapeContent(object as ShapeObject, nextDrawingId(drawing));
      drawing = appendDrawing(drawing, patchDrawingGeometry(newDrawingAnchor(object, content), object, sheet));
    }
    parts[drawingPart] = bytesOf(drawing);
    if (!drawingId) {
      const id = `rId_em_${key}`;
      relation(parts, sheetPart, id, "drawing", drawingPart);
      const body = read(parts, sheetPart);
      parts[sheetPart] = bytesOf(replaceElement(body, "drawing", `<drawing xmlns:r="${R}" r:id="${id}"/>`));
    }
    contentType(parts, drawingPart, "application/vnd.openxmlformats-officedocument.drawing+xml");
  }
}

/** Read-only catalogue for preserved OOXML features not represented as editable engine objects. */
export function preservedMetadata(parts: Parts) {
  const paths = Object.keys(parts);
  const tables = paths
    .filter((p) => /^xl\/tables\/[^/]+\.xml$/.test(p))
    .map((part) => {
      const t = xml(read(parts, part)).table;
      return {
        part,
        name: t?.["@_displayName"] ?? t?.["@_name"],
        range: t?.["@_ref"],
        columns: list(t?.tableColumns?.tableColumn).map((c) => c?.["@_name"]),
      };
    });
  const definedNames = list(
    xml(read(parts, "xl/workbook.xml")).workbook?.definedNames?.definedName,
  ).map((n) => ({
    name: n?.["@_name"],
    formula: n?.["#text"] ?? "",
    localSheetId: n?.["@_localSheetId"],
  }));
  const pivots = pivotMetadata(parts);
  const comments = paths
    .filter((p) => /^xl\/comments[^/]*\.xml$/.test(p))
    .flatMap((part) =>
      list(xml(read(parts, part), true).comments?.commentList?.comment).map((c) => ({
        part,
        ref: c?.["@_ref"],
        text: typeof c?.text?.t === "string"
          ? c.text.t
          : String(c?.text?.t?.["#text"] ?? list(c?.text?.r)
              .map((r) => r?.t?.["#text"] ?? r?.t ?? "")
              .join("")),
      })),
    );
  return {
    tables,
    definedNames,
    ...pivots,
    comments,
    drawings: paths
      .filter((part) => /^xl\/drawings\/[^/]+\.xml$/.test(part))
      .map((part) => ({
        part,
        objects: drawingCatalogue(read(parts, part), drawingTheme(read(parts, "xl/theme/theme1.xml"))),
      })),
    externalLinks: paths.filter((p) => /^xl\/externalLinks\/[^/]+\.xml$/.test(p)),
    externalLinkDetails: externalLinkMetadata(parts),
    hasMacros: paths.some((p) => /^xl\/vbaProject\.bin$/i.test(p)),
    preservedExtensions: paths.filter((p) =>
      /^xl\/(?:slicers|slicerCaches|timeline|activeX)\//.test(p),
    ),
  };
}

export function imagePreviewBytes(image: ImageObject, parts: Parts): Uint8Array {
  const bytes = image.data ? Buffer.from(image.data, "base64") : image.mediaPart ? parts[image.mediaPart] : undefined;
  if (!bytes || sniffWorkbookImage(bytes) !== image.mediaType) throw new FileOperationError("INVALID_ARGUMENT", "图片内容不存在或格式不支持");
  return bytes;
}

/** Classic Excel notes. Threaded comments remain preserved, not converted. */
export function importNotes(parts: Parts, mapping: SheetParts, sheets: IWorkbookData["sheets"]): void {
  for (const [sid, entry] of Object.entries(mapping)) {
    const sheet = sheets[sid];
    if (!sheet) continue;
    const rel = list(xml(read(parts, relPath(entry.path))).Relationships?.Relationship)
      .find((item) => String(item?.["@_Type"]).endsWith("/comments"));
    const part = rel ? target(parts, entry.path, String(rel["@_Id"])) : undefined;
    if (!part) continue;
    const body = xml(read(parts, part), true).comments;
    const authors = list(body?.authors?.author).map((a) => String(a?.["#text"] ?? a));
    const notes = list(body?.commentList?.comment).map((c) => ({
      ref: String(c["@_ref"]),
      text: typeof c.text?.t === "string" ? c.text.t : String(c.text?.t?.["#text"] ?? list(c.text?.r).map((r) => r.t?.["#text"] ?? r.t ?? "").join("")),
      author: authors[Number(c["@_authorId"])] ?? "",
    }));
    if (notes.length) sheet.custom = { ...sheet.custom, excelmanusObjects: { ...objectsOf(sheet), notes } };
  }
}

export function exportNotes(parts: Parts, mapping: SheetParts, snapshot: IWorkbookData, baseline: IWorkbookData): void {
  for (const [sid, sheet] of Object.entries(snapshot.sheets)) {
    const notes = objectsOf(sheet).notes ?? [], old = objectsOf(baseline.sheets[sid]).notes ?? [];
    if (JSON.stringify(notes) === JSON.stringify(old)) continue;
    const sheetPart = mapping[sid]?.path;
    if (!sheetPart) continue;
    const relations = list(xml(read(parts, relPath(sheetPart))).Relationships?.Relationship);
    const existing = relations.find((r) => String(r["@_Type"]).endsWith("/comments"));
    const key = createHash("sha256").update(sid).digest("hex").slice(0, 16);
    const part = existing ? target(parts, sheetPart, String(existing["@_Id"])) : `xl/comments-em-${key}.xml`;
    if (!part) unsupported("无法定位批注部件");
    let body = read(parts, part) || '<comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><authors></authors><commentList></commentList></comments>';
    const authors = list(xml(body, true).comments?.authors?.author).map((a) => String(a?.["#text"] ?? a));
    for (const note of old) if (!notes.some((n) => n.ref === note.ref)) {
      const node = elements(body, "comment").find((n) => xmlAttrs(n.open).ref === note.ref);
      if (node) body = body.replace(node.raw, "");
    }
    for (const note of notes) {
      if (JSON.stringify(old.find((n) => n.ref === note.ref)) === JSON.stringify(note)) continue;
      let authorId = authors.indexOf(note.author);
      if (authorId < 0) {
        authorId = authors.length; authors.push(note.author);
        body = append(body, "</authors>", `<author>${escapeXml(note.author)}</author>`);
      }
      const node = elements(body, "comment").find((n) => xmlAttrs(n.open).ref === note.ref);
      const next = `<comment ref="${note.ref}" authorId="${authorId}"><text><t xml:space="preserve">${escapeXml(note.text)}</t></text></comment>`;
      if (node) body = body.replace(node.raw, next); else body = append(body, "</commentList>", next);
    }
    parts[part] = bytesOf(body);
    relation(parts, sheetPart, existing?.["@_Id"] ?? `rId_notes_${key}`, "comments", part);
    contentType(parts, part, "application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml");
    // Note shapes are separate from charts/images. Preserve unrelated VML controls verbatim.
    const legacy = xml(read(parts, sheetPart)).worksheet?.legacyDrawing?.["@_id"];
    const vmlPart = legacy ? target(parts, sheetPart, String(legacy)) : `xl/drawings/notes-${key}.vml`;
    if (!vmlPart) unsupported("无法定位批注形状");
    let vml = read(parts, vmlPart) || '<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe"><v:stroke joinstyle="miter"/><v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype></xml>';
    const shapes = () => elements(vml, "v:shape");
    const shapeRef = (raw: string) => {
      const d = xml(raw).shape?.ClientData;
      return d?.["@_ObjectType"] === "Note" ? `${indexToCol(Number(d.Column) + 1)}${Number(d.Row) + 1}` : undefined;
    };
    for (const shape of shapes()) {
      const ref = shapeRef(shape.raw);
      if (ref && old.some((n) => n.ref === ref) && !notes.some((n) => n.ref === ref)) vml = vml.replace(shape.raw, "");
    }
    let nextId = Math.max(1024, ...[...vml.matchAll(/id="_x0000_s(\d+)"/g)].map((m) => Number(m[1])));
    for (const note of notes) {
      if (shapes().some((s) => shapeRef(s.raw) === note.ref)) continue;
      const r = parseRange(note.ref), row = r.startRow - 1, col = r.startCol - 1;
      vml = append(vml, "</xml>", `<v:shape id="_x0000_s${++nextId}" type="#_x0000_t202" style="position:absolute;width:144pt;height:72pt;visibility:hidden" fillcolor="#ffffe1" o:insetmode="auto"><v:fill color2="#ffffe1"/><v:shadow on="t" color="black" obscured="t"/><v:path o:connecttype="none"/><v:textbox style="mso-direction-alt:auto"><div style="text-align:left"/></v:textbox><x:ClientData ObjectType="Note"><x:MoveWithCells/><x:SizeWithCells/><x:Anchor>${col + 1}, 15, ${row}, 2, ${col + 3}, 15, ${row + 4}, 2</x:Anchor><x:AutoFill>False</x:AutoFill><x:Row>${row}</x:Row><x:Column>${col}</x:Column></x:ClientData></v:shape>`);
    }
    parts[vmlPart] = bytesOf(vml);
    contentType(parts, vmlPart, "application/vnd.openxmlformats-officedocument.vmlDrawing");
    if (!legacy) {
      const rid = `rId_notes_vml_${key}`;
      relation(parts, sheetPart, rid, "vmlDrawing", vmlPart);
      let sheetXml = read(parts, sheetPart);
      if (!/xmlns:r=/.test(sheetXml)) sheetXml = sheetXml.replace("<worksheet ", `<worksheet xmlns:r="${R}" `);
      parts[sheetPart] = bytesOf(append(sheetXml, "</worksheet>", `<legacyDrawing r:id="${rid}"/>`));
    }
  }
}
