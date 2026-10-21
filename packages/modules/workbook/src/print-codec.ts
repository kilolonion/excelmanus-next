import { FileOperationError } from "@excelmanus/kernel";
import { type PrintSettings, printSettingsOf } from "@excelmanus/protocol";
import { SaxesParser } from "saxes";
import { escapeXml } from "./xml.ts";

export { type PrintSettings, printSettingsOf };
export const SPREADSHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

/** Exact source spans, with namespace and parent scope retained for surgical printing/name edits. */
export interface SpreadsheetXmlNode {
  name: string;
  local: string;
  uri: string;
  attributes: Record<string, string>;
  start: number;
  openEnd: number;
  closeStart: number;
  end: number;
  text: string;
  children: SpreadsheetXmlNode[];
}
export function spreadsheetXml(xml: string): SpreadsheetXmlNode {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new FileOperationError("INVALID_ARGUMENT", "XML 不允许 DTD 或实体声明");
  const stack: SpreadsheetXmlNode[] = [];
  const parser = new SaxesParser({ xmlns: true });
  let root: SpreadsheetXmlNode | undefined;
  let start = 0;
  let skipped = 0;
  parser.on("opentagstart", (tag) => {
    start = parser.position - tag.name.length - 2;
  });
  parser.on("opentag", (tag) => {
    // Cell payloads need validation, but never participate in print/name metadata.
    const parent = stack.at(-1);
    if (skipped || (parent?.uri === SPREADSHEET_NS && parent.local === "sheetData")) {
      skipped++;
      return;
    }
    const node: SpreadsheetXmlNode = {
      name: tag.name,
      local: tag.local,
      uri: tag.uri,
      attributes: Object.fromEntries(
        Object.values(tag.attributes)
          .filter((a) => a.uri !== "http://www.w3.org/2000/xmlns/")
          .map((a) => [a.name, a.value]),
      ),
      start,
      openEnd: parser.position,
      closeStart: parser.position,
      end: parser.position,
      text: "",
      children: [],
    };
    if (parent) parent.children.push(node);
    else root = node;
    stack.push(node);
  });
  const text = (value: string) => {
    const node = stack.at(-1);
    if (!skipped && node) node.text += value;
  };
  parser.on("text", text);
  parser.on("cdata", text);
  parser.on("closetag", (tag) => {
    if (skipped) {
      skipped--;
      return;
    }
    const node = stack.pop()!;
    node.end = parser.position;
    node.closeStart = tag.isSelfClosing ? node.openEnd : xml.lastIndexOf("</", parser.position - 1);
  });
  parser.write(xml).close();
  if (!root || root.uri !== SPREADSHEET_NS)
    throw new FileOperationError("INVALID_ARGUMENT", "不是受支持的 SpreadsheetML 命名空间");
  return root;
}
export const spreadsheetChildren = (node: SpreadsheetXmlNode, name: string) =>
  node.children.filter((child) => child.uri === SPREADSHEET_NS && child.local === name);
const child = (node: SpreadsheetXmlNode, name: string) => spreadsheetChildren(node, name)[0];
const qualified = (node: SpreadsheetXmlNode, name: string) =>
  node.name.includes(":") ? `${node.name.split(":")[0]}:${name}` : name;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const raw = (xml: string, node: SpreadsheetXmlNode) => xml.slice(node.start, node.end);
const headerNames = [
  "oddHeader",
  "oddFooter",
  "evenHeader",
  "evenFooter",
  "firstHeader",
  "firstFooter",
] as const;

export function importPrintSettings(xml: string, root = spreadsheetXml(xml)): PrintSettings {
  const result: PrintSettings = {};
  const unsupported: string[] = [];
  const single = (parent: SpreadsheetXmlNode, name: string) => {
    const nodes = spreadsheetChildren(parent, name);
    if (nodes.length > 1) unsupported.push(name);
    return nodes[0];
  };
  for (const name of ["pageSetup", "pageMargins", "printOptions"] as const) {
    const node = single(root, name);
    if (node) result[name] = node.attributes;
  }
  const sheetPr = single(root, "sheetPr");
  const pageSetUpPr = sheetPr && single(sheetPr, "pageSetUpPr");
  if (pageSetUpPr) result.pageSetUpPr = pageSetUpPr.attributes;
  const header = single(root, "headerFooter");
  if (header) {
    result.headerFooter = { attributes: header.attributes };
    for (const name of headerNames) {
      const nodes = spreadsheetChildren(header, name);
      const node = nodes[0];
      if (nodes.length > 1 || node?.children.length) unsupported.push(`headerFooter.${name}`);
      if (node) result.headerFooter[name] = node.text;
    }
  }
  for (const name of ["rowBreaks", "colBreaks"] as const) {
    const node = single(root, name);
    if (node) {
      const breaks = spreadsheetChildren(node, "brk");
      if (breaks.some((b) => b.children.length)) unsupported.push(name);
      result[name] = { attributes: node.attributes, breaks: breaks.map((b) => b.attributes) };
    }
  }
  if (unsupported.length) result.unsupported = unsupported;
  return result;
}

export interface XmlEdit {
  start: number;
  end: number;
  text: string;
}
export function editXml(xml: string, edits: XmlEdit[]): string {
  for (const edit of edits.sort((a, b) => b.start - a.start))
    xml = xml.slice(0, edit.start) + edit.text + xml.slice(edit.end);
  return xml;
}
/** Only attributes whose values changed are touched; original spelling/quotes survive otherwise. */
export function patchXmlAttributes(
  open: string,
  next: Record<string, string>,
  before: Record<string, string>,
): string {
  for (const key of new Set([...Object.keys(before), ...Object.keys(next)])) {
    if (next[key] === before[key]) continue;
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\s${escaped}\\s*=\\s*(?:"[^"]*"|'[^']*')`);
    const attr = next[key] === undefined ? "" : ` ${key}="${escapeXml(next[key])}"`;
    open = re.test(open)
      ? open.replace(re, () => attr)
      : open.replace(/\/?\s*>$/, (end) => attr + end);
  }
  return open;
}
const attrs = (value: Record<string, string>) =>
  Object.entries(value)
    .map(([key, value]) => ` ${key}="${escapeXml(value)}"`)
    .join("");
const sheetOrder = [
  "sheetPr",
  "dimension",
  "sheetViews",
  "sheetFormatPr",
  "cols",
  "sheetData",
  "sheetCalcPr",
  "sheetProtection",
  "protectedRanges",
  "scenarios",
  "autoFilter",
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
];
function insertChild(
  xml: string,
  parent: SpreadsheetXmlNode,
  name: string,
  value: string,
  order: readonly string[],
): string {
  const index = order.indexOf(name);
  const at =
    parent.children.find((node) => node.uri === SPREADSHEET_NS && order.indexOf(node.local) > index)
      ?.start ?? parent.closeStart;
  if (parent.openEnd === parent.end) {
    const open = xml.slice(parent.start, parent.openEnd).replace(/\/>$/, ">");
    return editXml(xml, [
      { start: parent.start, end: parent.end, text: `${open}${value}</${parent.name}>` },
    ]);
  }
  return editXml(xml, [{ start: at, end: at, text: value }]);
}
function patchAttributeNode(
  xml: string,
  parent: SpreadsheetXmlNode,
  name: string,
  next: Record<string, string> | undefined,
  before: Record<string, string> | undefined,
  order: readonly string[],
): string {
  const node = child(parent, name);
  if (node) {
    if (!next) return editXml(xml, [{ start: node.start, end: node.end, text: "" }]);
    return editXml(xml, [
      {
        start: node.start,
        end: node.openEnd,
        text: patchXmlAttributes(xml.slice(node.start, node.openEnd), next, before ?? {}),
      },
    ]);
  }
  return next
    ? insertChild(xml, parent, name, `<${qualified(parent, name)}${attrs(next)}/>`, order)
    : xml;
}
function patchHeader(
  xml: string,
  next: PrintSettings["headerFooter"],
  before: PrintSettings["headerFooter"],
): string {
  let root = spreadsheetXml(xml);
  let header = child(root, "headerFooter");
  if (!header) {
    if (!next) return xml;
    const name = qualified(root, "headerFooter");
    return insertChild(
      xml,
      root,
      "headerFooter",
      `<${name}${attrs(next.attributes)}>${headerNames
        .filter((key) => next[key] !== undefined)
        .map((key) => `<${qualified(root, key)}>${escapeXml(next[key])}</${qualified(root, key)}>`)
        .join("")}</${name}>`,
      sheetOrder,
    );
  }
  xml = editXml(xml, [
    {
      start: header.start,
      end: header.openEnd,
      text: patchXmlAttributes(
        xml.slice(header.start, header.openEnd),
        next?.attributes ?? {},
        before?.attributes ?? {},
      ),
    },
  ]);
  for (const name of headerNames) {
    if (next?.[name] === before?.[name]) continue;
    root = spreadsheetXml(xml);
    header = child(root, "headerFooter")!;
    const node = child(header, name);
    const value = next?.[name];
    if (node) {
      const replacement =
        value === undefined
          ? ""
          : `${xml.slice(node.start, node.openEnd).replace(/\/>$/, ">")}${escapeXml(value)}</${node.name}>`;
      xml = editXml(xml, [{ start: node.start, end: node.end, text: replacement }]);
    } else if (value !== undefined) {
      const qname = qualified(header, name);
      xml = insertChild(xml, header, name, `<${qname}>${escapeXml(value)}</${qname}>`, headerNames);
    }
  }
  return xml;
}
function patchBreaks(
  xml: string,
  name: "rowBreaks" | "colBreaks",
  next: PrintSettings["rowBreaks"],
  before: PrintSettings["rowBreaks"],
): string {
  const root = spreadsheetXml(xml);
  const node = child(root, name);
  if (!node) {
    if (!next) return xml;
    const qname = qualified(root, name);
    return insertChild(
      xml,
      root,
      name,
      `<${qname}${attrs(next.attributes)}>${next.breaks.map((value) => `<${qualified(root, "brk")}${attrs(value)}/>`).join("")}</${qname}>`,
      sheetOrder,
    );
  }
  if (!next) {
    // A clear removes managed breaks, not unrelated attributes/foreign children on their container.
    const remaining =
      node.children.some((n) => n.uri !== SPREADSHEET_NS || n.local !== "brk") ||
      Object.keys(node.attributes).some((key) => !["count", "manualBreakCount"].includes(key));
    if (!remaining) return editXml(xml, [{ start: node.start, end: node.end, text: "" }]);
    next = { attributes: { ...node.attributes, count: "0", manualBreakCount: "0" }, breaks: [] };
  }
  const edits: XmlEdit[] = [
    {
      start: node.start,
      end: node.openEnd,
      text: patchXmlAttributes(
        xml.slice(node.start, node.openEnd),
        next.attributes,
        before?.attributes ?? {},
      ),
    },
  ];
  const original = spreadsheetChildren(node, "brk");
  for (const [i, previous] of original.entries()) {
    const value = next.breaks[i];
    const matching = value && original.find((source) => source.attributes.id === value.id);
    const replacement = !value
      ? ""
      : matching
        ? raw(xml, matching).replace(
            xml.slice(matching.start, matching.openEnd),
            patchXmlAttributes(
              xml.slice(matching.start, matching.openEnd),
              value,
              matching.attributes,
            ),
          )
        : `<${qualified(node, "brk")}${attrs(value)}/>`;
    edits.push({ start: previous.start, end: previous.end, text: replacement });
  }
  const extra = next.breaks
    .slice(original.length)
    .map((value) => `<${qualified(node, "brk")}${attrs(value)}/>`)
    .join("");
  if (extra) {
    if (node.openEnd === node.end) {
      const open = patchXmlAttributes(
        xml.slice(node.start, node.openEnd),
        next.attributes,
        before?.attributes ?? {},
      ).replace(/\/>$/, ">");
      return editXml(xml, [
        { start: node.start, end: node.end, text: `${open}${extra}</${node.name}>` },
      ]);
    }
    edits.push({ start: node.closeStart, end: node.closeStart, text: extra });
  }
  return editXml(xml, edits);
}

/** Apply only the explicit model delta; all unrepresented XML remains byte-for-byte unchanged. */
export function patchPrintSettings(
  xml: string,
  next: PrintSettings,
  before: PrintSettings,
): string {
  for (const name of ["pageSetup", "pageMargins", "printOptions"] as const) {
    if (!same(next[name], before[name]))
      xml = patchAttributeNode(
        xml,
        spreadsheetXml(xml),
        name,
        next[name],
        before[name],
        sheetOrder,
      );
  }
  if (!same(next.pageSetUpPr, before.pageSetUpPr)) {
    let root = spreadsheetXml(xml);
    if (!child(root, "sheetPr") && next.pageSetUpPr) {
      xml = insertChild(xml, root, "sheetPr", `<${qualified(root, "sheetPr")}/>`, sheetOrder);
      root = spreadsheetXml(xml);
    }
    const pr = child(root, "sheetPr");
    if (pr)
      xml = patchAttributeNode(xml, pr, "pageSetUpPr", next.pageSetUpPr, before.pageSetUpPr, [
        "tabColor",
        "outlinePr",
        "pageSetUpPr",
        "extLst",
      ]);
  }
  if (!same(next.headerFooter, before.headerFooter))
    xml = patchHeader(xml, next.headerFooter, before.headerFooter);
  for (const name of ["rowBreaks", "colBreaks"] as const)
    if (!same(next[name], before[name])) xml = patchBreaks(xml, name, next[name], before[name]);
  return xml;
}
