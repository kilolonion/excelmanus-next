import { posix } from "node:path";
import { SaxesParser } from "saxes";
import { textOf } from "./xml.ts";

const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE = "http://schemas.openxmlformats.org/package/2006/relationships";
type Parts = Record<string, Uint8Array>;
interface Node {
  local: string;
  uri: string;
  attributes: { local: string; uri: string; value: string }[];
  children: Node[];
  text: string;
}
const children = (n: Node | undefined, local: string, uri = MAIN) =>
  n?.children.filter((c) => c.local === local && c.uri === uri) ?? [];
const attr = (n: Node | undefined, local: string, uri = "") =>
  n?.attributes.find((a) => a.local === local && a.uri === uri)?.value;
const single = <T>(items: T[]) => (items.length === 1 ? items[0] : undefined);

/** Feature-local QName reader. It only consumes bytes already present in the ZIP. */
function root(parts: Parts, part: string, local: string, uri = MAIN): Node | undefined {
  try {
    const xml = parts[part] && textOf(parts[part]);
    if (!xml || /<!DOCTYPE|<!ENTITY/i.test(xml)) return undefined;
    const parser = new SaxesParser({ xmlns: true }),
      stack: Node[] = [];
    let result: Node | undefined;
    parser.on("opentag", (tag) => {
      const n: Node = {
        local: tag.local,
        uri: tag.uri,
        attributes: Object.values(tag.attributes),
        children: [],
        text: "",
      };
      const parent = stack.at(-1);
      if (parent) parent.children.push(n);
      else result = n;
      stack.push(n);
    });
    const text = (value: string) => {
      const n = stack.at(-1);
      if (n) n.text += value;
    };
    parser.on("text", text);
    parser.on("cdata", text);
    parser.on("closetag", () => {
      stack.pop();
    });
    parser.write(xml).close();
    return result?.local === local && result.uri === uri ? result : undefined;
  } catch {
    return undefined;
  }
}

interface Relationship {
  id: string;
  type: string;
  raw: string;
  mode: string;
  part?: string;
}
function relationships(parts: Parts, source: string): Relationship[] {
  const path = `${posix.dirname(source)}/_rels/${posix.basename(source)}.rels`;
  return children(root(parts, path, "Relationships", PACKAGE), "Relationship", PACKAGE).map((n) => {
    const raw = attr(n, "Target") ?? "",
      mode = attr(n, "TargetMode") ?? "Internal";
    // Only internal package paths are normalized. External target strings are never resolved.
    const part =
      mode === "Internal" && raw && !/[:\\?#]/.test(raw)
        ? posix.normalize(
            raw.startsWith("/") ? raw.slice(1) : posix.join(posix.dirname(source), raw),
          )
        : undefined;
    return {
      id: attr(n, "Id") ?? "",
      type: attr(n, "Type") ?? "",
      raw,
      mode,
      ...(part?.startsWith("xl/") && parts[part] ? { part } : {}),
    };
  });
}
function relation(rels: Relationship[], id: string | undefined, type: string) {
  const found = id ? single(rels.filter((r) => r.id === id)) : undefined;
  return found?.type === `${REL}/${type}` ? found : undefined;
}

/** Skip Excel string literals, not quoted sheet names or table brackets. No evaluation. */
export function externalFormulaIndexes(formula: string | undefined | null | void): number[] {
  const code = (formula ?? "").replace(/"(?:[^"]|"")*"/g, "");
  return [
    ...new Set(
      [...code.matchAll(/\[(\d+)\](?=[^[\]!+*/^&=<>(),;]*!|[\p{L}_\\])/gu)].map((m) =>
        Number(m[1]),
      ),
    ),
  ];
}
export function isExternalFormula(formula: string | undefined | null | void): boolean {
  if (!formula) return false;
  const code = formula.replace(/"(?:[^"]|"")*"/g, "");
  // Workbook-qualified sheet references and external defined names ([1]Rate).
  return (
    /\[[^[\]]+\][^[\]!+*/^&=<>(),;]*!/.test(code) ||
    /\[\d+\][\p{L}_\\]/u.test(code) ||
    /\|[^!]+!/.test(code.replace(/'(?:[^']|'')*'/g, "quoted"))
  );
}

interface SavedCache {
  source: "saved_external_link" | "saved_worksheet";
  type: string;
  rawValue?: string;
  present: boolean;
  reason?: string;
}
function savedCache(n: Node, source: SavedCache["source"]): SavedCache {
  const values = children(n, "v"),
    value = single(values);
  return {
    source,
    type: attr(n, "t") ?? "n",
    present: !!value,
    ...(value ? { rawValue: value.text } : {}),
    ...(values.length > 1 ? { reason: "多个保存值，无法确认唯一缓存。" } : {}),
  };
}
interface CacheCell {
  reason?: string;
  sheetId: string;
  sheet?: string;
  cell: string;
  type: string;
  rawValue?: string;
  present: boolean;
}
interface FormulaCache {
  association: "linked" | "unknown";
  reason?: string;
  sheet: string;
  sheetPart: string;
  cell: string;
  formula: string;
  linkIndexes: number[];
  cache: SavedCache;
}
interface Link {
  index: number;
  relationshipId?: string;
  part?: string;
  kind: "externalBook" | "ddeLink" | "oleLink" | "unknown";
  linked: boolean;
  reason?: string;
  target?: { raw: string; mode: string; relationshipId: string };
  sheetNames?: string[];
  cache?: {
    source: "saved_external_link";
    cells: CacheCell[];
    totalCells: number;
    returnedCells: number;
    truncated: boolean;
  };
}
function bounded<T>(items: T[]) {
  const result: T[] = [];
  let chars = 0;
  for (const item of items) {
    const size = JSON.stringify(item).length;
    if (result.length >= 2000 || chars + size > 16000) break;
    result.push(item);
    chars += size;
  }
  return { items: result, total: items.length, truncated: result.length !== items.length };
}

/** Saved metadata only: no filesystem/network APIs and no formula engine. */
export function externalLinkMetadata(parts: Parts) {
  const wb = root(parts, "xl/workbook.xml", "workbook"),
    rels = relationships(parts, "xl/workbook.xml");
  const references = children(single(children(wb, "externalReferences")), "externalReference");
  const links: Link[] = references.map((ref, i) => {
    const relationshipId = attr(ref, "id", REL),
      rel = relation(rels, relationshipId, "externalLink");
    const base: Link = { index: i + 1, relationshipId, kind: "unknown", linked: false };
    if (!rel?.part || references.filter((n) => attr(n, "id", REL) === relationshipId).length !== 1)
      return { ...base, reason: "外链关系缺失、重复或不是有效包内部件；仅保留，不推断目标。" };
    base.part = rel.part;
    const external = root(parts, rel.part, "externalLink");
    const kinds = ["externalBook", "ddeLink", "oleLink"] as const;
    const found = kinds.flatMap((kind) => children(external, kind).map((node) => ({ kind, node })));
    const content = single(found);
    if (!content) return { ...base, reason: "外链类型或命名空间未知/歧义；仅保留。" };
    base.kind = content.kind;
    if (content.kind !== "externalBook")
      return { ...base, reason: "DDE/OLE 外链仅保留，不解析、更新或执行。" };
    const targetId = attr(content.node, "id", REL);
    const target = relation(relationships(parts, rel.part), targetId, "externalLinkPath");
    if (!target || target.mode !== "External" || !target.raw)
      return { ...base, reason: "外部目标关系缺失、重复或类型不符；不推断目标。" };
    const names = children(single(children(content.node, "sheetNames")), "sheetName").map(
      (n) => attr(n, "val") ?? "",
    );
    const cells: CacheCell[] = [];
    for (const data of children(single(children(content.node, "sheetDataSet")), "sheetData")) {
      const sheetId = attr(data, "sheetId") ?? "",
        n = /^\d+$/.test(sheetId) ? Number(sheetId) : -1;
      for (const row of children(data, "row"))
        for (const cell of children(row, "cell")) {
          const cache = savedCache(cell, "saved_external_link");
          cells.push({
            sheetId,
            ...(names[n] !== undefined ? { sheet: names[n] } : {}),
            cell: attr(cell, "r") ?? "",
            type: cache.type,
            present: cache.present,
            ...(cache.present ? { rawValue: cache.rawValue } : {}),
            ...(cache.reason || names[n] === undefined
              ? {
                  reason: [
                    cache.reason,
                    names[n] === undefined ? "sheetId 无法映射到保存的工作表名称。" : undefined,
                  ]
                    .filter(Boolean)
                    .join(" "),
                }
              : {}),
          });
        }
    }
    const selected = bounded(cells);
    return {
      ...base,
      linked: true,
      target: { raw: target.raw, mode: target.mode, relationshipId: target.id },
      sheetNames: names,
      cache: {
        source: "saved_external_link",
        cells: selected.items,
        totalCells: selected.total,
        returnedCells: selected.items.length,
        truncated: selected.truncated,
      },
    };
  });
  const formulas: FormulaCache[] = [];
  let unresolvedSharedFormulaCells = 0;
  for (const sheet of children(single(children(wb, "sheets")), "sheet")) {
    const rel = relation(rels, attr(sheet, "id", REL), "worksheet");
    if (!rel?.part) continue;
    const worksheet = root(parts, rel.part, "worksheet");
    for (const row of children(single(children(worksheet, "sheetData")), "row"))
      for (const cell of children(row, "c")) {
        const f = single(children(cell, "f"));
        if (f && !f.text && attr(f, "t") === "shared") unresolvedSharedFormulaCells++;
        if (!f || !isExternalFormula(f.text)) continue;
        const linkIndexes = externalFormulaIndexes(f.text);
        const associated =
          linkIndexes.length > 0 &&
          linkIndexes.every((index) => links.some((link) => link.index === index && link.linked));
        formulas.push({
          association: associated ? "linked" : "unknown",
          ...(associated ? {} : { reason: "外部公式的保存关联无法唯一确认；不推断目标。" }),
          sheet: attr(sheet, "name") ?? "",
          sheetPart: rel.part,
          cell: attr(cell, "r") ?? "",
          formula: `=${f.text.replace(/^=/, "")}`,
          linkIndexes,
          cache: savedCache(cell, "saved_worksheet"),
        });
      }
  }
  const selected = bounded(formulas);
  return {
    source: "preserved_package" as const,
    updated: false,
    links,
    formulaCaches: selected.items,
    totalFormulaCells: selected.total,
    returnedFormulaCells: selected.items.length,
    truncated: selected.truncated,
    formulaCoverage: "explicit_formula_text_only",
    unresolvedSharedFormulaCells,
    limitations: [
      "仅报告包中保存缓存；未访问目标、未更新链接、未执行外部公式计算。",
      "公式缓存计数仅含保存了明确外部原式正文的单元格；不展开共享/数组跟随格，不据此声称全工作簿外链缓存已穷尽。",
    ],
  };
}
