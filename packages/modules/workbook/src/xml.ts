import { XMLParser } from "fast-xml-parser";
import { SaxesParser } from "saxes";

/** Namespace-aware XML validation, independent of the object importer. */
export function assertXmlDocument(xml: string): void {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("XML 不允许 DTD 或实体声明");
  new SaxesParser({ xmlns: true }).write(xml).close();
}

export const escapeXml = (s: unknown): string =>
  String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
export const textOf = (b: Uint8Array): string =>
  new TextDecoder("utf-8", { fatal: true }).decode(b);
export const bytesOf = (s: string): Uint8Array => new TextEncoder().encode(s);
export const xmlAttrs = (s: string): Record<string, string> => {
  const parsed = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    parseAttributeValue: false,
    htmlEntities: true,
  }).parse(s.replace(/\/?\s*>$/, "/>"));
  return Object.values(parsed)[0] as Record<string, string>;
};

interface Element {
  start: number;
  end: number;
  open: string;
  inner: string;
  raw: string;
}
/** Lex XML tokens, skipping comments and CDATA; retain exact byte-equivalent UTF-8 slices. */
export function elements(xml: string, name: string): Element[] {
  // Negative-only check: possible matches still go through the lexer (comments, CDATA, exact names).
  if (!xml.includes(`<${name}`)) return [];
  const tokens =
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/?[A-Za-z_][\w:.-]*(?:"[^"]*"|'[^']*'|[^'">])*?>/g;
  const out: Element[] = [];
  const stack: Array<{ start: number; open: string; innerStart: number }> = [];
  for (const m of xml.matchAll(tokens)) {
    const token = m[0];
    if (token.startsWith("<!") || token.startsWith("<?")) continue;
    const tag = /^<\/?([\w:.-]+)/.exec(token)?.[1];
    if (tag !== name) continue;
    const start = m.index;
    if (token.startsWith("</")) {
      const head = stack.pop();
      if (head)
        out.push({
          start: head.start,
          end: start + token.length,
          open: head.open,
          inner: xml.slice(head.innerStart, start),
          raw: xml.slice(head.start, start + token.length),
        });
    } else if (token.endsWith("/>"))
      out.push({ start, end: start + token.length, open: token, inner: "", raw: token });
    else stack.push({ start, open: token, innerStart: start + token.length });
  }
  return out.sort((a, b) => a.start - b.start);
}
export function replaceElement(
  xml: string,
  name: string,
  replacement: string,
  before?: string,
): string {
  const e = elements(xml, name)[0];
  if (e) return xml.slice(0, e.start) + replacement + xml.slice(e.end);
  const order: Record<string, string[]> = {
    drawing: [
      "legacyDrawing",
      "legacyDrawingHF",
      "drawingHF",
      "picture",
      "oleObjects",
      "controls",
      "webPublishItems",
      "tableParts",
      "extLst",
    ],
    autoFilter: [
      "sortState",
      "dataConsolidate",
      "customSheetViews",
      "mergeCells",
      "phoneticPr",
      "conditionalFormatting",
      "dataValidations",
      "hyperlinks",
      "printOptions",
      "pageMargins",
      "drawing",
      "extLst",
    ],
    hyperlinks: [
      "printOptions",
      "pageMargins",
      "pageSetup",
      "headerFooter",
      "drawing",
      "legacyDrawing",
      "tableParts",
      "extLst",
    ],
    dimension: ["sheetViews", "sheetFormatPr", "cols", "sheetData"],
    sheetViews: ["sheetFormatPr", "cols", "sheetData"],
    mergeCells: [
      "phoneticPr",
      "conditionalFormatting",
      "dataValidations",
      "hyperlinks",
      "printOptions",
      "pageMargins",
      "pageSetup",
      "headerFooter",
      "rowBreaks",
      "colBreaks",
      "customProperties",
      "cellWatches",
      "ignoredErrors",
      "smartTags",
      "drawing",
      "legacyDrawing",
      "legacyDrawingHF",
      "picture",
      "oleObjects",
      "controls",
      "webPublishItems",
      "tableParts",
      "extLst",
    ],
    pane: ["selection", "pivotSelection", "extLst"],
    numFmts: ["fonts", "fills", "borders", "cellStyleXfs", "cellXfs"],
    alignment: ["protection", "extLst"],
  };
  const candidates = (order[name] ?? (before ? [before] : [])).flatMap((n) =>
    elements(xml, n).map((e) => e.start),
  );
  const anchor = candidates.length ? Math.min(...candidates) : undefined;
  const end = anchor ?? xml.lastIndexOf("</");
  return xml.slice(0, end) + replacement + xml.slice(end);
}
export function setAttribute(tag: string, name: string, value: unknown): string {
  const re = new RegExp(`\\s${name}=(?:"[^"]*"|'[^']*')`);
  const a = ` ${name}="${escapeXml(value)}"`;
  return re.test(tag) ? tag.replace(re, a) : tag.replace(/\/?\s*>$/, (end) => a + end);
}
