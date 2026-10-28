import { indexToCol, parseRange } from "@excelmanus/core";
import { FileOperationError } from "@excelmanus/kernel";
import { ShapeObject } from "@excelmanus/protocol";
import type { IWorksheetData } from "@univerjs/core";
import { XMLParser } from "fast-xml-parser";
import { SaxesParser } from "saxes";
import { elements, escapeXml, setAttribute } from "./xml.ts";

export const DRAWING_NS = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing";
export const ART_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
export const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const EMU = 9525;
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: false,
  ignoreDeclaration: true,
});
export const drawingNode = (body: string): any => Object.values(parser.parse(body))[0];
const list = <T>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

/** Locate exact original slices without assuming a particular DrawingML prefix. */
export function drawingElements(body: string, local: string) {
  const names = new Set(
    [...body.matchAll(new RegExp(`<((?:[\\w.-]+:)?${local})(?=[\\s/>])`, "g"))].map(
      (match) => match[1]!,
    ),
  );
  return [...names].flatMap((name) => elements(body, name)).sort((a, b) => a.start - b.start);
}
/** Namespace scope is checked on the complete document before any local-name parsing or patching. */
export function drawingAnchors(body: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(body))
    throw new FileOperationError("UNSUPPORTED_FEATURE", "绘图 XML 不允许 DTD 或实体声明");
  const out: Array<{ raw: string; namespaceReason?: string }> = [];
  const sax = new SaxesParser({ xmlns: true });
  const stack: string[] = [];
  let opening = 0;
  let anchor: { start: number; namespaceReason?: string } | undefined;
  const artNames = new Set([
    "xfrm",
    "off",
    "prstGeom",
    "avLst",
    "gd",
    "solidFill",
    "srgbClr",
    "schemeClr",
    "sysClr",
    "ln",
    "bodyPr",
    "lstStyle",
    "p",
    "r",
    "rPr",
    "t",
    "blip",
  ]);
  const drawingNames = new Set([
    "oneCellAnchor",
    "twoCellAnchor",
    "absoluteAnchor",
    "from",
    "to",
    "col",
    "row",
    "colOff",
    "rowOff",
    "pic",
    "nvPicPr",
    "cNvPr",
    "cNvPicPr",
    "blipFill",
    "spPr",
    "sp",
    "nvSpPr",
    "cNvSpPr",
    "txBody",
    "grpSp",
    "cxnSp",
    "clientData",
  ]);
  sax.on("opentagstart", (tag) => {
    opening = sax.position - tag.name.length - 2;
  });
  sax.on("opentag", (tag) => {
    if (!stack.length && (tag.local !== "wsDr" || tag.uri !== DRAWING_NS))
      throw new FileOperationError("UNSUPPORTED_FEATURE", "绘图根节点命名空间不受支持");
    if (
      stack.length === 1 &&
      ["oneCellAnchor", "twoCellAnchor", "absoluteAnchor"].includes(tag.local)
    )
      anchor = { start: opening };
    const parent = stack.at(-1);
    const placement: Record<string, string[]> = {
      from: ["oneCellAnchor", "twoCellAnchor"],
      to: ["twoCellAnchor"],
      sp: ["oneCellAnchor", "twoCellAnchor", "absoluteAnchor", "grpSp"],
      pic: ["oneCellAnchor", "twoCellAnchor", "absoluteAnchor", "grpSp"],
      spPr: ["sp", "pic", "cxnSp"],
      xfrm: ["spPr", "graphicFrame", "grpSpPr"],
      cNvPr: ["nvSpPr", "nvPicPr", "nvCxnSpPr", "nvGrpSpPr", "nvGraphicFramePr"],
    };
    if (
      anchor &&
      ((drawingNames.has(tag.local) && tag.uri !== DRAWING_NS) ||
        (artNames.has(tag.local) &&
          tag.uri !== ART_NS &&
          !(tag.local === "xfrm" && tag.uri === DRAWING_NS)) ||
        (tag.local === "ext" && parent === "xfrm" && tag.uri !== ART_NS) ||
        (tag.local === "ext" &&
          ["oneCellAnchor", "absoluteAnchor"].includes(parent ?? "") &&
          tag.uri !== DRAWING_NS) ||
        (tag.local === "xfrm" && tag.uri !== (parent === "graphicFrame" ? DRAWING_NS : ART_NS)) ||
        (placement[tag.local] && !placement[tag.local]!.includes(parent ?? "")) ||
        (tag.local === "blip" &&
          Object.values(tag.attributes).some(
            (attribute) => attribute.local === "embed" && attribute.uri !== REL_NS,
          )))
    )
      anchor.namespaceReason = "含不支持的节点位置或命名空间，绘图只保留，暂不可编辑";
    stack.push(tag.local);
  });
  sax.on("closetag", () => {
    if (stack.length === 2 && anchor) {
      out.push({
        raw: body.slice(anchor.start, sax.position),
        namespaceReason: anchor.namespaceReason,
      });
      anchor = undefined;
    }
    stack.pop();
  });
  sax.write(body).close();
  return out;
}
export const objectProperties = (anchor: any, kind: "image" | "shape") =>
  kind === "image" ? anchor?.pic?.nvPicPr?.cNvPr : anchor?.sp?.nvSpPr?.cNvPr;
export function drawingObjectId(name: unknown, id: unknown, kind: string) {
  const raw = String(name ?? "");
  return /^[A-Za-z0-9_-]{1,100}$/.test(raw)
    ? raw
    : `${kind}_${String(id ?? "").replace(/\W/g, "_") || "unknown"}`;
}
export function findDrawingAnchor(
  body: string,
  object: { id: string; drawingObjectId?: string },
  kind: "image" | "shape",
) {
  return drawingAnchors(body).find((node) => {
    if (node.namespaceReason) return false;
    const props = objectProperties(drawingNode(node.raw), kind);
    return (
      props &&
      (object.drawingObjectId
        ? String(props["@_id"]) === object.drawingObjectId
        : props["@_name"] === object.id)
    );
  });
}
export function appendDrawing(body: string, fragment: string) {
  const root = drawingElements(body, "wsDr")[0];
  if (!root) throw new FileOperationError("UNSUPPORTED_FEATURE", "无法定位原始绘图根节点");
  if (root.open.endsWith("/>")) {
    const name = /^<([\w:.-]+)/.exec(root.open)![1];
    return body.replace(root.raw, `${root.open.slice(0, -2)}>${fragment}</${name}>`);
  }
  const end = root.end - root.raw.match(/<\/[\w:.-]+\s*>$/)![0].length;
  return body.slice(0, end) + fragment + body.slice(end);
}
export function nextDrawingId(body: string) {
  return (
    Math.max(
      0,
      ...drawingElements(body, "cNvPr").map((node) => Number(drawingNode(node.raw)?.["@_id"]) || 0),
    ) + 1
  );
}
export function drawingGeometry(anchor: any, object: any) {
  const extent = anchor.ext ?? object?.spPr?.xfrm?.ext;
  return {
    anchor: `${indexToCol(Number(anchor.from?.col ?? 0) + 1)}${Number(anchor.from?.row ?? 0) + 1}`,
    offsetX: Number(anchor.from?.colOff ?? 0) / EMU,
    offsetY: Number(anchor.from?.rowOff ?? 0) / EMU,
    width: Math.max(1, Math.round(Number(extent?.["@_cx"] ?? EMU * 100) / EMU)),
    height: Math.max(1, Math.round(Number(extent?.["@_cy"] ?? EMU * 100) / EMU)),
  };
}
type Geometry = {
  anchor: string;
  width: number;
  height: number;
  offsetX?: number;
  offsetY?: number;
};
function axisSize(sheet: Partial<IWorksheetData>, axis: "col" | "row", index: number) {
  const data = axis === "col" ? sheet.columnData?.[index] : sheet.rowData?.[index];
  if (data?.hd) return 0;
  return axis === "col"
    ? ((data as { w?: number } | undefined)?.w ?? sheet.defaultColumnWidth ?? 64)
    : ((data as { h?: number } | undefined)?.h ?? sheet.defaultRowHeight ?? 20);
}
function axisPosition(sheet: Partial<IWorksheetData>, axis: "col" | "row", index: number) {
  const fallback =
    axis === "col" ? (sheet.defaultColumnWidth ?? 64) : (sheet.defaultRowHeight ?? 20);
  const data = axis === "col" ? sheet.columnData : sheet.rowData;
  let total = index * fallback;
  for (const key of Object.keys(data ?? {})) {
    const i = Number(key);
    if (i < index) total += axisSize(sheet, axis, i) - fallback;
  }
  return total;
}
function endMarker(
  sheet: Partial<IWorksheetData>,
  axis: "col" | "row",
  start: number,
  size: number,
) {
  let index = start,
    offset = size;
  const limit = axis === "col" ? 16383 : 1048575;
  while (index < limit) {
    const cell = axisSize(sheet, axis, index);
    if (offset < cell) break;
    offset -= cell;
    index++;
  }
  return { index, offset: Math.round(offset * EMU) };
}
function setNodeText(body: string, name: string, value: number) {
  const node = drawingElements(body, name)[0];
  if (!node) throw new FileOperationError("UNSUPPORTED_FEATURE", `绘图缺少 ${name}，无法保真修改`);
  return body.replace(node.raw, node.raw.replace(node.inner, String(value)));
}
function patchAttributes(body: string, name: string, attrs: Record<string, number | string>) {
  const node = drawingElements(body, name)[0];
  if (!node) throw new FileOperationError("UNSUPPORTED_FEATURE", `绘图缺少 ${name}，无法保真修改`);
  let open = node.open;
  for (const [key, value] of Object.entries(attrs)) open = setAttribute(open, key, value);
  return body.replace(node.open, open);
}
/** Patch geometry only: preserve anchor mode, shape body and every unrelated XML byte. */
export function patchDrawingGeometry(
  body: string,
  object: Geometry,
  sheet: Partial<IWorksheetData>,
) {
  const anchor = parseRange(object.anchor),
    col = anchor.startCol - 1,
    row = anchor.startRow - 1;
  const x = object.offsetX ?? 0,
    y = object.offsetY ?? 0;
  const from = drawingElements(body, "from")[0];
  if (!from) throw new FileOperationError("UNSUPPORTED_FEATURE", "绝对锚点暂不支持修改");
  let marker = from.raw;
  for (const [key, value] of Object.entries({
    col,
    row,
    colOff: Math.round(x * EMU),
    rowOff: Math.round(y * EMU),
  }))
    marker = setNodeText(marker, key, value);
  body = body.replace(from.raw, marker);
  const to = drawingElements(body, "to")[0];
  if (to) {
    const right = endMarker(sheet, "col", col, x + object.width);
    const bottom = endMarker(sheet, "row", row, y + object.height);
    marker = to.raw;
    for (const [key, value] of Object.entries({
      col: right.index,
      row: bottom.index,
      colOff: right.offset,
      rowOff: bottom.offset,
    }))
      marker = setNodeText(marker, key, value);
    body = body.replace(to.raw, marker);
  } else body = patchAttributes(body, "ext", { cx: object.width * EMU, cy: object.height * EMU });
  const transform = drawingElements(body, "xfrm")[0];
  if (transform) {
    let patched = patchAttributes(transform.raw, "ext", {
      cx: object.width * EMU,
      cy: object.height * EMU,
    });
    patched = patchAttributes(patched, "off", {
      x: Math.round((axisPosition(sheet, "col", col) + x) * EMU),
      y: Math.round((axisPosition(sheet, "row", row) + y) * EMU),
    });
    body = body.replace(transform.raw, patched);
  }
  return body;
}
export function newDrawingAnchor(object: Geometry, content: string) {
  const anchor = parseRange(object.anchor);
  return `<xdr:oneCellAnchor xmlns:xdr="${DRAWING_NS}" xmlns:a="${ART_NS}" xmlns:r="${REL_NS}"><xdr:from><xdr:col>${anchor.startCol - 1}</xdr:col><xdr:colOff>${Math.round((object.offsetX ?? 0) * EMU)}</xdr:colOff><xdr:row>${anchor.startRow - 1}</xdr:row><xdr:rowOff>${Math.round((object.offsetY ?? 0) * EMU)}</xdr:rowOff></xdr:from><xdr:ext cx="${object.width * EMU}" cy="${object.height * EMU}"/>${content}<xdr:clientData/></xdr:oneCellAnchor>`;
}
export function shapeUnsupportedReason(anchor: any): string | undefined {
  const shape = anchor.sp;
  if (!shape) return anchor.grpSp ? "组合形状只保留，暂不可编辑" : "此绘图类型只保留，暂不可编辑";
  if (!anchor.from) return "绝对锚点形状只保留，暂不可编辑";
  const unsupportedAppearance = (value: any): boolean => {
    if (!value || typeof value !== "object") return false;
    return Object.entries(value).some(([key, child]: [string, any]) => {
      if (
        [
          "gradFill",
          "blipFill",
          "pattFill",
          "grpFill",
          "effectLst",
          "effectDag",
          "scene3d",
          "sp3d",
        ].includes(key)
      )
        return true;
      if (key === "solidFill" && !child?.srgbClr && !child?.schemeClr && !child?.sysClr)
        return true;
      if (
        ["srgbClr", "schemeClr", "sysClr"].includes(key) &&
        Object.keys(child ?? {}).some(
          (transform) => !transform.startsWith("@_") && !["shade", "tint"].includes(transform),
        )
      )
        return true;
      return unsupportedAppearance(child);
    });
  };
  if (
    unsupportedAppearance(shape) ||
    Number(shape.style?.effectRef?.["@_idx"] ?? 0) > 0 ||
    (!shape.spPr?.solidFill &&
      shape.spPr?.noFill === undefined &&
      Number(shape.style?.fillRef?.["@_idx"] ?? 0) > 0) ||
    (!shape.spPr?.ln && Number(shape.style?.lnRef?.["@_idx"] ?? 0) > 0)
  )
    return "复杂填充、透明度或效果只保留，暂不可编辑";
  if (!["rect", "ellipse", "rightArrow"].includes(shape.spPr?.prstGeom?.["@_prst"]))
    return "仅支持矩形、椭圆和右箭头；此形状只保留";
  const xfrm = shape.spPr?.xfrm;
  if (
    Number(xfrm?.["@_rot"] ?? 0) ||
    ["1", "true"].includes(String(xfrm?.["@_flipH"])) ||
    ["1", "true"].includes(String(xfrm?.["@_flipV"]))
  )
    return "旋转或翻转形状只保留，暂不可编辑";
  if (shape.spPr?.custGeom || list(shape.spPr?.prstGeom?.avLst?.gd).length)
    return "自定义形状几何只保留，暂不可编辑";
  if (
    list(shape.txBody?.p).length > 1 ||
    list(shape.txBody?.p?.r).length > 1 ||
    shape.txBody?.p?.fld
  )
    return "复杂文字排版只保留，暂不可编辑";
  return undefined;
}
function color(fill: any, theme: Record<string, string>) {
  const node = fill?.srgbClr ?? fill?.schemeClr ?? fill?.sysClr;
  if (!node) return undefined;
  let hex =
    fill.srgbClr?.["@_val"] ?? theme[fill.schemeClr?.["@_val"]] ?? fill.sysClr?.["@_lastClr"];
  if (!/^[\da-f]{6}$/i.test(String(hex))) return undefined;
  const shade = Number(node.shade?.["@_val"] ?? 100000) / 100000;
  const tint = Number(node.tint?.["@_val"] ?? 0) / 100000;
  hex = [0, 2, 4]
    .map((i) =>
      Math.round(
        Math.min(
          255,
          Math.max(0, Number.parseInt(hex.slice(i, i + 2), 16) * shade * (1 - tint) + 255 * tint),
        ),
      )
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")
    .toUpperCase();
  return `#${hex}`;
}
export function drawingTheme(themeXml: string): Record<string, string> {
  const scheme = themeXml ? drawingNode(themeXml)?.themeElements?.clrScheme : {};
  return Object.fromEntries(
    Object.entries(scheme ?? {}).flatMap(([name, value]: [string, any]) => {
      const hex = value?.srgbClr?.["@_val"] ?? value?.sysClr?.["@_lastClr"];
      return hex ? [[name, String(hex)]] : [];
    }),
  );
}
export function importShape(anchor: any, theme: Record<string, string>): ShapeObject | undefined {
  if (shapeUnsupportedReason(anchor)) return undefined;
  const shape = anchor.sp,
    props = shape.nvSpPr?.cNvPr;
  const run = shape.txBody?.p?.r;
  const text = run?.t ?? shape.txBody?.p?.fld?.t ?? "";
  const result = ShapeObject.safeParse({
    id: drawingObjectId(props?.["@_name"], props?.["@_id"], "shape"),
    drawingObjectId: String(props?.["@_id"] ?? ""),
    title: String(props?.["@_descr"] ?? props?.["@_name"] ?? ""),
    text: String(text?.["#text"] ?? text),
    type: shape.spPr.prstGeom["@_prst"],
    ...drawingGeometry(anchor, shape),
    fill: color(shape.spPr.solidFill, theme),
    stroke: color(shape.spPr.ln?.solidFill, theme),
    textColor:
      color(
        run?.rPr?.solidFill ?? shape.txBody?.p?.pPr?.defRPr?.solidFill ?? shape.style?.fontRef,
        theme,
      ) ?? "#000000",
  });
  return result.success ? result.data : undefined;
}
const solid = (prefix: string, value: string) =>
  `<${prefix}solidFill><${prefix}srgbClr val="${value.slice(1)}"/></${prefix}solidFill>`;
export function patchShape(body: string, shape: ShapeObject, old: ShapeObject) {
  const reason = shapeUnsupportedReason(drawingNode(body));
  if (reason) throw new FileOperationError("UNSUPPORTED_FEATURE", reason);
  if (
    ["title", "text", "type", "fill", "stroke", "textColor"].some(
      (field) => shape[field as keyof ShapeObject] !== old[field as keyof ShapeObject],
    )
  )
    throw new FileOperationError(
      "UNSUPPORTED_FEATURE",
      "已有形状仅支持移动和缩放；文字、类型和样式保留",
    );
  return body;
}
export function shapeContent(shape: ShapeObject, id: number) {
  const fill = shape.fill ? solid("a:", shape.fill) : "<a:noFill/>";
  const stroke = shape.stroke ? solid("a:", shape.stroke) : "<a:noFill/>";
  return `<xdr:sp><xdr:nvSpPr><xdr:cNvPr id="${id}" name="${shape.id}" descr="${escapeXml(shape.title)}"/><xdr:cNvSpPr/></xdr:nvSpPr><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${shape.width * EMU}" cy="${shape.height * EMU}"/></a:xfrm><a:prstGeom prst="${shape.type}"><a:avLst/></a:prstGeom>${fill}<a:ln>${stroke}</a:ln></xdr:spPr><xdr:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr>${solid("a:", shape.textColor ?? "#000000")}</a:rPr><a:t>${escapeXml(shape.text)}</a:t></a:r></a:p></xdr:txBody></xdr:sp>`;
}
export function drawingCatalogue(body: string, theme: Record<string, string>) {
  return drawingAnchors(body).flatMap((node) => {
    const anchor = drawingNode(node.raw);
    const kind = anchor.pic
      ? "image"
      : anchor.sp || anchor.grpSp || anchor.cxnSp
        ? "shape"
        : "chart";
    const props =
      anchor.pic?.nvPicPr?.cNvPr ??
      anchor.sp?.nvSpPr?.cNvPr ??
      anchor.grpSp?.nvGrpSpPr?.cNvPr ??
      anchor.cxnSp?.nvCxnSpPr?.cNvPr ??
      anchor.graphicFrame?.nvGraphicFramePr?.cNvPr;
    if (!props) return [];
    let reason =
      node.namespaceReason ?? (kind === "shape" ? shapeUnsupportedReason(anchor) : undefined);
    const editable =
      !reason &&
      (kind === "shape"
        ? Boolean(importShape(anchor, theme))
        : kind === "image" && Boolean(anchor.from));
    if (!editable && !reason)
      reason =
        kind === "chart"
          ? "图表可编辑能力请查看 charts 清单；本目录仅列出原始绘图"
          : "超出当前可编辑对象范围，原样保留";
    return [
      {
        id: drawingObjectId(props["@_name"], props["@_id"], kind),
        name: String(props["@_name"] ?? ""),
        drawingObjectId: String(props["@_id"] ?? ""),
        kind,
        type: anchor.sp?.spPr?.prstGeom?.["@_prst"],
        editable,
        ...(reason ? { reason } : {}),
        ...(kind === "shape" && !reason
          ? {
              previewLimitations: ["文字字体、排版位置和边线宽度仅作近似预览；原始 XML 保留"],
            }
          : {}),
      },
    ];
  });
}
