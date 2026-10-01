import { FileOperationError } from "@excelmanus/kernel";
import type { ICellData, IStyleData, IWorkbookData } from "@univerjs/core";
import {
  bytesOf,
  elements,
  escapeXml,
  replaceElement,
  setAttribute,
  textOf,
  xmlAttrs,
} from "./xml.ts";

const MIN_STYLES =
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>';
const styleOf = (snapshot: IWorkbookData, cell: ICellData | undefined): IStyleData =>
  typeof cell?.s === "string" ? (snapshot.styles[cell.s] ?? {}) : (cell?.s ?? {});

export class StyleWriter {
  private xml: string;
  private readonly cache = new Map<string, number>();
  private changed = false;
  private readonly parts: Record<string, Uint8Array>;
  private readonly path: string;
  private readonly before: IWorkbookData;
  constructor(parts: Record<string, Uint8Array>, path: string, before: IWorkbookData) {
    this.parts = parts;
    this.path = path;
    this.before = before;
    this.xml = parts[path] ? textOf(parts[path]) : MIN_STYLES;
  }
  private append(group: string, tag: string, raw: string): number {
    const e = elements(this.xml, group)[0];
    const index = e ? elements(e.inner, tag).length : 0;
    const open = e
      ? setAttribute(e.open.replace(/\/>$/, ">"), "count", index + 1)
      : `<${group} count="1">`;
    this.xml = replaceElement(
      this.xml,
      group,
      `${open}${e?.inner ?? ""}${raw}</${group}>`,
      group === "numFmts" ? "fonts" : undefined,
    );
    this.changed = true;
    return index;
  }
  index(
    cell: ICellData,
    old: ICellData | undefined,
    after: IWorkbookData,
    rawStyle: number,
  ): number {
    const a = styleOf(after, cell);
    const b = styleOf(this.before, old);
    if (cell.s === null) return 0;
    if (
      typeof cell.s === "string" &&
      /^s\d+$/.test(cell.s) &&
      JSON.stringify(a) === JSON.stringify(this.before.styles[cell.s])
    )
      return Number(cell.s.slice(1));
    if (JSON.stringify(a) === JSON.stringify(b)) return rawStyle;
    // 清除格式：模型里已无任何样式 → 默认 xf 0（原 xf 中模型未建模的边框等一并清除）
    if (Object.keys(a).length === 0) return 0;
    const key = JSON.stringify([rawStyle, a, b]);
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const base =
      elements(elements(this.xml, "cellXfs")[0]?.inner ?? "", "xf")[rawStyle]?.raw ??
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>';
    let xf = base.replace(/\/>$/, "></xf>");
    let open = elements(xf, "xf")[0]?.open ?? "<xf>";
    const baseAttrs = xmlAttrs(open);
    if (cell.s === null) {
      open = '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0">';
      xf = `${open}</xf>`;
    }
    const fontChanged = ["bl", "it", "cl", "ff", "fs"].some(
      (k) => JSON.stringify(a[k as keyof IStyleData]) !== JSON.stringify(b[k as keyof IStyleData]),
    );
    if (fontChanged) {
      let font =
        elements(elements(this.xml, "fonts")[0]?.inner ?? "", "font")[Number(baseAttrs.fontId ?? 0)]
          ?.raw ?? "<font></font>";
      font = font.replace(/\/>$/, "></font>");
      for (const [key_, tag] of [
        ["bl", "b"],
        ["it", "i"],
        ["ff", "name"],
        ["fs", "sz"],
        ["cl", "color"],
      ] as const) {
        if (JSON.stringify(a[key_]) === JSON.stringify(b[key_])) continue;
        const val = a[key_];
        const raw =
          val == null
            ? ""
            : key_ === "cl"
              ? `<color rgb="${color(val)}"/>`
              : `<${tag} val="${escapeXml(val)}"/>`;
        font = replaceElement(font, tag, raw);
      }
      open = setAttribute(
        setAttribute(open, "fontId", this.append("fonts", "font", font)),
        "applyFont",
        "1",
      );
    }
    if (JSON.stringify(a.bg) !== JSON.stringify(b.bg)) {
      const fill = a.bg
        ? `<fill><patternFill patternType="solid"><fgColor rgb="${color(a.bg)}"/><bgColor indexed="64"/></patternFill></fill>`
        : '<fill><patternFill patternType="none"/></fill>';
      open = setAttribute(
        setAttribute(open, "fillId", this.append("fills", "fill", fill)),
        "applyFill",
        "1",
      );
    }
    if (JSON.stringify(a.n) !== JSON.stringify(b.n)) {
      let id = 0;
      if (a.n?.pattern) {
        const ids = elements(this.xml, "numFmt").map((e) => Number(xmlAttrs(e.open).numFmtId));
        id = Math.max(163, ...ids) + 1;
        this.append(
          "numFmts",
          "numFmt",
          `<numFmt numFmtId="${id}" formatCode="${escapeXml(a.n.pattern)}"/>`,
        );
      }
      open = setAttribute(setAttribute(open, "numFmtId", id), "applyNumberFormat", "1");
    }
    if (["ht", "vt", "tb"].some((k) => a[k as keyof IStyleData] !== b[k as keyof IStyleData])) {
      const existing = elements(xf, "alignment")[0]?.open ?? "<alignment/>";
      let align = existing;
      if (a.ht !== b.ht)
        align = setAttribute(
          align,
          "horizontal",
          ["general", "left", "center", "right"][Number(a.ht)] ?? "general",
        );
      if (a.vt !== b.vt)
        align = setAttribute(
          align,
          "vertical",
          ["bottom", "top", "center", "bottom"][Number(a.vt)] ?? "bottom",
        );
      if (a.tb !== b.tb) align = setAttribute(align, "wrapText", Number(a.tb) === 3 ? 1 : 0);
      xf = replaceElement(xf, "alignment", align);
      open = setAttribute(open, "applyAlignment", "1");
    }
    const supported = new Set(["bl", "it", "cl", "ff", "fs", "bg", "n", "ht", "vt", "tb"]);
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (
        !supported.has(k) &&
        JSON.stringify(a[k as keyof IStyleData]) !== JSON.stringify(b[k as keyof IStyleData])
      )
        throw new FileOperationError("UNSUPPORTED_FEATURE", `无法保真写回样式字段：${k}`);
    }
    xf = xf.replace(elements(xf, "xf")[0]?.open ?? "<xf>", open);
    const i = this.append("cellXfs", "xf", xf);
    this.cache.set(key, i);
    return i;
  }
  finish(): void {
    if (this.changed || !this.parts[this.path]) this.parts[this.path] = bytesOf(this.xml);
  }
}
function color(value: unknown): string {
  const c = (value as { rgb?: string })?.rgb;
  if (!c || !/^#?[\da-f]{6}([\da-f]{2})?$/i.test(c))
    throw new FileOperationError("UNSUPPORTED_FEATURE", "只支持 RGB 样式颜色");
  const rgb = c.replace(/^#/, "");
  return rgb.length === 6 ? `FF${rgb}` : rgb;
}
