// Native DrawingML charts. Untouched package parts remain byte-identical.

import { createHash } from "node:crypto";
import { posix } from "node:path";
import { indexToCol, parseRange } from "@excelmanus/core";
import { FileOperationError } from "@excelmanus/kernel";
import { ChartObject, ImageObject, WorkbookObjects } from "@excelmanus/protocol";
import type { IWorkbookData, IWorksheetData } from "@univerjs/core";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { bytesOf, elements, escapeXml, textOf, xmlAttrs } from "./xml.ts";

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
function unsupported(message: string): never {
  throw new FileOperationError("UNSUPPORTED_FEATURE", message);
}
const read = (parts: Parts, path: string): string => (parts[path] ? textOf(parts[path]!) : "");
const xml = (value: string): Record<string, any> => {
  // bounded OOXML trees, untrusted objects never spread into executable configuration
  if (/<!DOCTYPE|<!ENTITY/i.test(value) || XMLValidator.validate(value) !== true) return {};
  return parser.parse(value) as Record<string, any>;
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
    const drawingId = xml(read(parts, entry.path)).worksheet?.drawing?.["@_id"];
    const drawingPart = drawingId ? target(parts, entry.path, String(drawingId)) : undefined;
    if (!drawingPart) continue;
    const drawing = xml(read(parts, drawingPart)).wsDr;
    const charts: ChartObject[] = [];
    const images: ImageObject[] = [];
    for (const anchor of [...list(drawing?.oneCellAnchor), ...list(drawing?.twoCellAnchor)]) {
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
            title: String(pic.nvPicPr?.cNvPr?.["@_descr"] ?? rawId),
            anchor: `${indexToCol(Number(anchor.from?.col ?? 0) + 1)}${Number(anchor.from?.row ?? 0) + 1}`,
            width: Math.max(
              1,
              Math.round(
                Number(anchor.ext?.["@_cx"] ?? pic.spPr?.xfrm?.ext?.["@_cx"] ?? 952500) / 9525,
              ),
            ),
            height: Math.max(
              1,
              Math.round(
                Number(anchor.ext?.["@_cy"] ?? pic.spPr?.xfrm?.ext?.["@_cy"] ?? 952500) / 9525,
              ),
            ),
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
    if (charts.length || images.length)
      sheet.custom = { ...sheet.custom, excelmanusObjects: { charts, images } };
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
    const oldImages = objectsOf(before.sheets[sid]).images;
    for (const image of objectsOf(sheet).images)
      if (!oldImages.some((i) => i.id === image.id))
        out.push(`新增图片「${image.title || image.id}」（${sheet.name}）`);
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
  for (const [sid, sheet] of Object.entries(snapshot.sheets)) {
    const images = objectsOf(sheet).images;
    const old = objectsOf(baseline.sheets[sid]).images;
    const sheetPart = mapping[sid]?.path;
    if (!sheetPart) continue;
    const key = createHash("sha256").update(sid).digest("hex").slice(0, 16);
    for (const image of images) {
      if (old.some((item) => JSON.stringify(item) === JSON.stringify(image))) continue;
      if (!image.data) continue; // imported bytes/anchors remain untouched
      const bytes = Buffer.from(image.data, "base64");
      if (bytes.length > 10_000_000 || sniffWorkbookImage(bytes) !== image.mediaType)
        unsupported("图片格式或大小不符合限制");
      const ext = image.mediaType === "image/jpeg" ? "jpg" : image.mediaType.split("/")[1];
      const mediaPart = `xl/media/image-em_${key}_${image.id}.${ext}`;
      parts[mediaPart] = bytes;
      const drawingId = xml(read(parts, sheetPart)).worksheet?.drawing?.["@_id"];
      const drawingPart =
        (drawingId ? target(parts, sheetPart, String(drawingId)) : undefined) ??
        `xl/drawings/drawing-${key}.xml`;
      let drawing =
        read(parts, drawingPart) || `<xdr:wsDr xmlns:xdr="${D}" xmlns:a="${A}" xmlns:r="${R}"/>`;
      if (drawing.includes(`name="${image.id}"`)) continue;
      const existingIds = [...drawing.matchAll(/<\w*:cNvPr\b[^>]*\bid="(\d+)"/g)].map((m) =>
        Number(m[1]),
      );
      const id = Math.max(0, ...existingIds) + 1;
      const anchor = parseRange(image.anchor),
        rid = `rId_${image.id}`;
      const body = `<xdr:oneCellAnchor><xdr:from><xdr:col>${anchor.startCol - 1}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${anchor.startRow - 1}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="${image.width * 9525}" cy="${image.height * 9525}"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${id}" name="${image.id}" descr="${escapeXml(image.title)}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${image.width * 9525}" cy="${image.height * 9525}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>`;
      drawing = append(drawing, "</xdr:wsDr>", body);
      parts[drawingPart] = bytesOf(drawing);
      relation(parts, drawingPart, rid, "image", mediaPart);
      if (!drawingId) {
        const id = `rId_em_${key}`;
        relation(parts, sheetPart, id, "drawing", drawingPart);
        let body = read(parts, sheetPart);
        if (!/xmlns:r=/.test(body))
          body = body.replace("<worksheet ", `<worksheet xmlns:r="${R}" `);
        parts[sheetPart] = bytesOf(append(body, "</worksheet>", `<drawing r:id="${id}"/>`));
      }
      contentType(parts, mediaPart, image.mediaType);
      contentType(parts, drawingPart, "application/vnd.openxmlformats-officedocument.drawing+xml");
    }
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
  const pivotTables = paths
    .filter((p) => /^xl\/pivotTables\/[^/]+\.xml$/.test(p))
    .map((part) => {
      const p = xml(read(parts, part)).pivotTableDefinition;
      return {
        part,
        name: p?.["@_name"],
        range: p?.location?.["@_ref"],
        cacheId: p?.["@_cacheId"],
      };
    });
  const comments = paths
    .filter((p) => /^xl\/comments[^/]*\.xml$/.test(p))
    .flatMap((part) =>
      list(xml(read(parts, part)).comments?.commentList?.comment).map((c) => ({
        part,
        ref: c?.["@_ref"],
        text:
          typeof c?.text?.t === "string"
            ? c.text.t
            : list(c?.text?.r)
                .map((r) => r?.t ?? "")
                .join(""),
      })),
    );
  return {
    tables,
    definedNames,
    pivotTables,
    comments,
    externalLinks: paths.filter((p) => /^xl\/externalLinks\/[^/]+\.xml$/.test(p)),
    hasMacros: paths.some((p) => /^xl\/vbaProject\.bin$/i.test(p)),
    preservedExtensions: paths.filter((p) =>
      /^xl\/(?:slicers|slicerCaches|timeline|activeX)\//.test(p),
    ),
  };
}
