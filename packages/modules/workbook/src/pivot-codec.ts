import { posix } from "node:path";
import { indexToCol, parseRange } from "@excelmanus/core";
import { FileOperationError } from "@excelmanus/kernel";
import { WorkbookObjects } from "@excelmanus/protocol";
import type { IWorkbookData, IWorksheetData } from "@univerjs/core";
import { SaxesParser } from "saxes";
import { bytesOf, textOf } from "./xml.ts";

const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE = "http://schemas.openxmlformats.org/package/2006/relationships";
const X14 = "http://schemas.microsoft.com/office/spreadsheetml/2009/9/main";
const MSREL = "http://schemas.microsoft.com/office/2007/relationships";
type Parts = Record<string, Uint8Array>;
type Mapping = Record<string, { path: string }>;
type Flag = null | "0" | "1" | "false" | "true";
interface Node {
  local: string;
  uri: string;
  start: number;
  openEnd: number;
  attributes: { name: string; local: string; uri: string; value: string }[];
  children: Node[];
}
const children = (node: Node | undefined, local: string, uri = MAIN) =>
  node?.children.filter((child) => child.local === local && child.uri === uri) ?? [];
const attr = (node: Node | undefined, local: string, uri = "") =>
  node?.attributes.find((a) => a.local === local && a.uri === uri)?.value;
const single = <T>(values: T[]): T | undefined => (values.length === 1 ? values[0] : undefined);
function unsupported(message: string): never {
  throw new FileOperationError("UNSUPPORTED_FEATURE", message);
}

/** Namespace-aware metadata tree. Cell/cache payloads are validated but need not be retained. */
function parse(parts: Parts, part: string): Node | undefined {
  try {
    const xml = parts[part] && textOf(parts[part]);
    if (!xml || /<!DOCTYPE|<!ENTITY/i.test(xml)) return undefined;
    const parser = new SaxesParser({ xmlns: true });
    const stack: Node[] = [];
    let root: Node | undefined,
      start = 0,
      skipped = 0;
    parser.on("opentagstart", (tag) => {
      start = parser.position - tag.name.length - 2;
    });
    parser.on("opentag", (tag) => {
      const parent = stack.at(-1);
      if (
        skipped ||
        (parent?.uri === MAIN && ["sheetData", "cacheFields", "pivotFields"].includes(parent.local))
      ) {
        skipped++;
        return;
      }
      const node: Node = {
        local: tag.local,
        uri: tag.uri,
        start,
        openEnd: parser.position,
        attributes: Object.values(tag.attributes),
        children: [],
      };
      if (parent) parent.children.push(node);
      else root = node;
      stack.push(node);
    });
    parser.on("closetag", () => {
      if (skipped) skipped--;
      else stack.pop();
    });
    parser.write(xml).close();
    return root;
  } catch {
    return undefined;
  }
}
const rootOf = (parts: Parts, part: string, local: string, uri = MAIN) => {
  const node = parse(parts, part);
  return node?.local === local && node.uri === uri ? node : undefined;
};
interface Relationship {
  id: string;
  type: string;
  part?: string;
}
function relationships(parts: Parts, source: string): Relationship[] {
  const path = `${posix.dirname(source)}/_rels/${posix.basename(source)}.rels`;
  const result = children(
    rootOf(parts, path, "Relationships", PACKAGE),
    "Relationship",
    PACKAGE,
  ).map((n) => {
    const target = attr(n, "Target") ?? "";
    const path = posix.normalize(
      target.startsWith("/") ? target.slice(1) : posix.join(posix.dirname(source), target),
    );
    return {
      id: attr(n, "Id") ?? "",
      type: attr(n, "Type") ?? "",
      ...(target &&
      !/[:\\?#]/.test(target) &&
      (!attr(n, "TargetMode") || attr(n, "TargetMode") === "Internal") &&
      path.startsWith("xl/") &&
      parts[path]
        ? { part: path }
        : {}),
    };
  });
  return result.map((r) =>
    r.id && result.filter((other) => other.id === r.id).length === 1
      ? r
      : { id: r.id, type: r.type },
  );
}
const target = (rels: Relationship[], node: Node, type: string) => {
  const rel = single(rels.filter((r) => r.id === attr(node, "id", REL)));
  return rel?.type === type ? rel.part : undefined;
};
const extensionNodes = (node: Node | undefined, local: string) =>
  children(node, "extLst").flatMap((list) =>
    children(list, "ext").flatMap((ext) => children(ext, local, X14)),
  );
const booleanState = (raw: string | undefined, fallback: boolean) => ({
  raw: raw ?? null,
  effective:
    raw === undefined
      ? fallback
      : raw === "1" || raw === "true"
        ? true
        : raw === "0" || raw === "false"
          ? false
          : null,
  defaulted: raw === undefined,
});
const validFlag = (flag: unknown): flag is Flag =>
  flag === null || flag === "0" || flag === "1" || flag === "false" || flag === "true";
interface SheetEvidence {
  name: string;
  sheetId: string;
  part?: string;
}
export type SavedDisplayTotal =
  | { status: "unsupported"; label: "保存透视显示总计"; reason: string }
  | {
      status: "supported";
      label: "保存透视显示总计";
      cell: string;
      value: number;
      dataField: { name: string; field: number; subtotal: string };
      rowGrandIndex: number;
      columnGrandIndex: number;
    };

/** Read a saved numeric cell, not the live calculation engine or pivot cache records. */
function savedNumber(parts: Parts, part: string, ref: string): number | undefined {
  try {
    const xml = parts[part] && textOf(parts[part]);
    if (!xml || /<!DOCTYPE|<!ENTITY/i.test(xml)) return undefined;
    const parser = new SaxesParser({ xmlns: true });
    const stack: string[] = [];
    let count = 0,
      active = false,
      numeric = false,
      formula = false,
      values = 0,
      value = "";
    parser.on("opentag", (tag) => {
      stack.push(tag.uri === MAIN ? tag.local : "?");
      const path = stack.join("/");
      if (path === "worksheet/sheetData/row/c") {
        const attributes = Object.values(tag.attributes);
        const get = (name: string) => attributes.find((a) => a.local === name && !a.uri)?.value;
        active = get("r") === ref;
        if (active) {
          count++;
          numeric = get("t") === undefined || get("t") === "n";
        }
      } else if (active && path === "worksheet/sheetData/row/c/f") formula = true;
      else if (active && path === "worksheet/sheetData/row/c/v") values++;
    });
    parser.on("text", (text) => {
      if (active && stack.join("/") === "worksheet/sheetData/row/c/v") value += text;
    });
    parser.on("closetag", () => {
      if (stack.join("/") === "worksheet/sheetData/row/c") active = false;
      stack.pop();
    });
    parser.write(xml).close();
    if (
      count === 1 &&
      numeric &&
      !formula &&
      values === 1 &&
      /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?$/.test(value.trim()) &&
      Number.isFinite(Number(value))
    )
      return Number(value);
    return undefined;
  } catch {
    return undefined;
  }
}

/** Single row/column axis and one normal measure only. Unknown layouts are never guessed. */
function savedDisplayTotal(
  parts: Parts,
  root: Node | undefined,
  sheetPart?: string,
  cachePart?: string,
): SavedDisplayTotal {
  const no = (reason: string): SavedDisplayTotal => ({
    status: "unsupported",
    label: "保存透视显示总计",
    reason,
  });
  if (!root || !sheetPart || !cachePart) return no("透视表与工作表、缓存关系未唯一验证");
  const cache = rootOf(parts, cachePart, "pivotCacheDefinition");
  const source = single(children(cache, "cacheSource"));
  const worksheetSource = single(children(source, "worksheetSource"));
  const sourceRef = attr(worksheetSource, "ref");
  if (
    attr(source, "type") !== "worksheet" ||
    !sourceRef ||
    !/^\$?[A-Z]{1,3}\$?[1-9]\d*(?::\$?[A-Z]{1,3}\$?[1-9]\d*)?$/.test(sourceRef) ||
    !attr(worksheetSource, "sheet") ||
    attr(worksheetSource, "name") !== undefined ||
    attr(worksheetSource, "id", REL) !== undefined
  )
    return no("仅支持本地矩形工作表源的保存总计定位");
  const dataFields = single(children(root, "dataFields"));
  const measures = children(dataFields, "dataField");
  const measure = single(measures);
  const field = attr(measure, "fld"),
    name = attr(measure, "name");
  const subtotal = attr(measure, "subtotal") ?? "sum";
  if (
    !measure ||
    attr(dataFields, "count") !== "1" ||
    !field ||
    !/^\d+$/.test(field) ||
    !name ||
    ![
      "sum",
      "count",
      "average",
      "max",
      "min",
      "product",
      "countNums",
      "stdDev",
      "stdDevp",
      "var",
      "varp",
    ].includes(subtotal) ||
    ![undefined, "normal"].includes(attr(measure, "showDataAs"))
  )
    return no("仅支持一个已命名、常规聚合的度量；多度量或派生显示不推断");
  const unsigned = (node: Node | undefined, key: string) => {
    const raw = attr(node, key);
    return raw !== undefined && /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw))
      ? Number(raw)
      : undefined;
  };
  const axis = (kind: "row" | "col") => {
    const fields = single(children(root, `${kind}Fields`));
    const field = single(children(fields, "field"));
    const itemsRoot = single(children(root, `${kind}Items`));
    const items = children(itemsRoot, "i");
    const grands = items.flatMap((item, index) => (attr(item, "t") === "grand" ? [index] : []));
    const fieldIndex = unsigned(field, "x"),
      grand = single(grands);
    if (
      !field ||
      fieldIndex === undefined ||
      unsigned(fields, "count") !== 1 ||
      unsigned(itemsRoot, "count") !== items.length ||
      grand === undefined ||
      items.some(
        (item) =>
          ![undefined, "data", "grand"].includes(attr(item, "t")) ||
          ![undefined, "0"].includes(attr(item, "r")) ||
          ![undefined, "0"].includes(attr(item, "i")) ||
          children(item, "x").length !== 1,
      )
    )
      return undefined;
    return { count: items.length, grand, fieldIndex };
  };
  if (
    !booleanState(attr(root, "rowGrandTotals"), true).effective ||
    !booleanState(attr(root, "colGrandTotals"), true).effective
  )
    return no("行或列总计已关闭，不能将底右单元格认作总计");
  const rows = axis("row"),
    cols = axis("col"),
    location = single(children(root, "location"));
  const firstRow = unsigned(location, "firstDataRow"),
    firstCol = unsigned(location, "firstDataCol");
  const headerRow = unsigned(location, "firstHeaderRow");
  if (
    !rows ||
    !cols ||
    firstRow === undefined ||
    firstCol === undefined ||
    headerRow === undefined ||
    headerRow >= firstRow
  )
    return no("仅支持单层行列轴、唯一 grand 标记和明确 location 偏移；布局不支持或有歧义");
  try {
    const range = attr(location, "ref");
    if (!range || !/^\$?[A-Z]{1,3}\$?[1-9]\d*:\$?[A-Z]{1,3}\$?[1-9]\d*$/.test(range))
      return no("保存区域不是有限矩形");
    const r = parseRange(range.replaceAll("$", ""));
    const src = parseRange(sourceRef.replaceAll("$", ""));
    if (
      Number(field) >= src.endCol - src.startCol + 1 ||
      rows.fieldIndex >= src.endCol - src.startCol + 1 ||
      cols.fieldIndex >= src.endCol - src.startCol + 1 ||
      r.endRow - r.startRow + 1 !== firstRow + rows.count ||
      r.endCol - r.startCol + 1 !== firstCol + cols.count
    )
      return no("度量索引或行列 item 数量与保存区域尺寸不一致");
    // ISO 29500 location offsets are relative to ref's top-left; item order is display order.
    const cell = `${indexToCol(r.startCol + firstCol + cols.grand)}${r.startRow + firstRow + rows.grand}`;
    const value = savedNumber(parts, sheetPart, cell);
    if (value === undefined) return no("已定位的保存总计单元格缺失、重复或不是可验证的保存数值");
    return {
      status: "supported",
      label: "保存透视显示总计",
      cell,
      value,
      dataField: { name, field: Number(field), subtotal },
      rowGrandIndex: rows.grand,
      columnGrandIndex: cols.grand,
    };
  } catch {
    return no("保存区域或源区域无法解析，不推断总计");
  }
}

export interface PivotTableMetadata {
  part: string;
  name: string;
  cacheId: string;
  range?: string;
  sheet?: string;
  sheetPart?: string;
  sheetId?: string;
  cachePart?: string;
  linked: boolean;
  reason?: string;
  savedDisplayTotal: SavedDisplayTotal;
}
export interface PivotCacheMetadata {
  cacheId: string;
  part: string;
  source: { type: string; sheet?: string; ref?: string; name?: string };
  refreshOnLoad: ReturnType<typeof booleanState>;
  enableRefresh: ReturnType<typeof booleanState>;
  editable: boolean;
  reason?: string;
  sourceSheetPart?: string;
  extensionCacheId?: string;
  pivots: string[];
  slicerCaches: string[];
  recordsPart?: string;
  recordCount?: string;
  recordsReason?: string;
}
export interface SlicerCacheMetadata {
  part: string;
  name: string;
  sourceName?: string;
  pivotCacheId?: string;
  cacheId?: string;
  pivotTables: { name: string; tabId: string; part?: string }[];
  linked: boolean;
  reason?: string;
}
export interface SlicerMetadata {
  part: string;
  name: string;
  cacheName: string;
  cachePart?: string;
  sheet?: string;
  linked: boolean;
  reason?: string;
  unknown?: true;
}
const unique = (items: (string | undefined)[]) => [
  ...new Set(items.filter((s): s is string => s !== undefined)),
];

/** Read the preserved graph, never infer cache data from current worksheet values. */
export function pivotMetadata(parts: Parts) {
  const workbook = rootOf(parts, "xl/workbook.xml", "workbook");
  const workbookRels = relationships(parts, "xl/workbook.xml");
  const sheets: SheetEvidence[] = children(single(children(workbook, "sheets")), "sheet").map(
    (n) => ({
      name: attr(n, "name") ?? "",
      sheetId: attr(n, "sheetId") ?? "",
      part: target(workbookRels, n, `${REL}/worksheet`),
    }),
  );
  const registrations = children(single(children(workbook, "pivotCaches")), "pivotCache").map(
    (n) => ({
      cacheId: attr(n, "cacheId") ?? "",
      part: target(workbookRels, n, `${REL}/pivotCacheDefinition`),
    }),
  );
  const ownership = sheets.flatMap((s) =>
    s.part
      ? relationships(parts, s.part)
          .filter((r) => r.type === `${REL}/pivotTable`)
          .map((r) => ({ ...s, pivotPart: r.part }))
      : [],
  );
  const pivotPaths = unique([
    ...ownership.map((o) => o.pivotPart),
    ...Object.keys(parts).filter((p) => /^xl\/pivotTables\/[^/]+\.xml$/.test(p)),
  ]);
  const pivotTables: PivotTableMetadata[] = pivotPaths.map((part) => {
    const root = rootOf(parts, part, "pivotTableDefinition");
    const owner = single(ownership.filter((o) => o.pivotPart === part));
    const cacheId = attr(root, "cacheId") ?? "";
    const registration = single(registrations.filter((r) => r.cacheId === cacheId));
    const cacheRel = single(
      relationships(parts, part).filter((r) => r.type === `${REL}/pivotCacheDefinition`),
    );
    const linked = Boolean(
      root && owner?.part && registration?.part && cacheRel?.part === registration.part,
    );
    return {
      part,
      name: attr(root, "name") ?? "",
      cacheId,
      range: attr(single(children(root, "location")), "ref"),
      sheet: owner?.name,
      sheetPart: owner?.part,
      sheetId: owner?.sheetId,
      cachePart: cacheRel?.part,
      linked,
      savedDisplayTotal: savedDisplayTotal(
        parts,
        root,
        linked ? owner?.part : undefined,
        linked ? cacheRel?.part : undefined,
      ),
      ...(!linked ? { reason: "透视表的工作表或缓存关系缺失或不唯一" } : {}),
    };
  });
  const cachePaths = unique([
    ...registrations.map((r) => r.part),
    ...pivotTables.map((p) => p.cachePart),
    ...Object.keys(parts).filter(
      (p) => /^xl\/pivotCache\/[^/]+\.xml$/.test(p) && !/pivotCacheRecords/i.test(p),
    ),
  ]);
  const pivotCaches: PivotCacheMetadata[] = cachePaths.map((part) => {
    const root = rootOf(parts, part, "pivotCacheDefinition");
    const registration = single(registrations.filter((r) => r.part === part));
    const cacheId = registration?.cacheId ?? "";
    const cacheSource = single(children(root, "cacheSource"));
    const source = single(children(cacheSource, "worksheetSource"));
    const sheetName = attr(source, "sheet");
    const sheet = single(sheets.filter((s) => s.name === sheetName));
    const refreshOnLoad = booleanState(attr(root, "refreshOnLoad"), false);
    const enableRefresh = booleanState(attr(root, "enableRefresh"), true);
    const pivots = pivotTables.filter((p) => p.cacheId === cacheId || p.cachePart === part);
    const extensions = extensionNodes(root, "pivotCacheDefinition");
    const recordsPart = root
      ? target(relationships(parts, part), root, `${REL}/pivotCacheRecords`)
      : undefined;
    let reason: string | undefined;
    if (
      !root ||
      !registration ||
      !/^\d+$/.test(cacheId) ||
      registrations.filter((r) => r.cacheId === cacheId).length !== 1
    )
      reason = "透视缓存的根节点或工作簿关系缺失或不唯一";
    else if (
      !cacheSource ||
      attr(cacheSource, "type") !== "worksheet" ||
      !source ||
      attr(source, "name") !== undefined ||
      attr(source, "id", REL) !== undefined ||
      attr(cacheSource, "connectionId") !== undefined ||
      children(root, "cacheHierarchies").length
    )
      reason = "仅支持本地工作表的矩形区域缓存，不支持外部、OLAP 或命名来源";
    else if (
      !sheet?.part ||
      !rootOf(parts, sheet.part, "worksheet") ||
      sheets.filter((s) => s.part === sheet.part).length !== 1
    )
      reason = "缓存源工作表缺失或不唯一";
    else if (
      !validFlag(refreshOnLoad.raw) ||
      !validFlag(enableRefresh.raw) ||
      !enableRefresh.effective
    )
      reason = "缓存刷新已禁用或刷新属性无法识别";
    else if (!pivots.length || pivots.some((p) => !p.linked || p.cachePart !== part))
      reason = "缓存所连接的透视表关系无法唯一验证";
    else if (extensions.length > 1) reason = "缓存扩展标识不唯一";
    const ref = attr(source, "ref");
    try {
      if (!ref || !/^\$?[A-Z]{1,3}\$?[1-9]\d*(?::\$?[A-Z]{1,3}\$?[1-9]\d*)?$/.test(ref))
        throw new Error();
      parseRange(ref.replaceAll("$", ""));
    } catch {
      reason ??= "缓存源必须是有效的有限矩形单元格区域";
    }
    return {
      cacheId,
      part,
      source: {
        type: attr(cacheSource, "type") ?? "unknown",
        ...(sheetName === undefined ? {} : { sheet: sheetName }),
        ...(ref === undefined ? {} : { ref }),
        ...(attr(source, "name") === undefined ? {} : { name: attr(source, "name") }),
      },
      refreshOnLoad,
      enableRefresh,
      editable: !reason,
      ...(reason ? { reason } : {}),
      sourceSheetPart: sheet?.part,
      extensionCacheId: attr(single(extensions), "pivotCacheId"),
      pivots: pivots.map((p) => p.part),
      slicerCaches: [],
      recordsPart,
      recordCount: attr(root, "recordCount"),
      ...(!recordsPart && attr(root, "id", REL) !== undefined
        ? { recordsReason: "缓存记录关系缺失或不唯一" }
        : {}),
    };
  });
  const cacheLinks = extensionNodes(workbook, "slicerCaches")
    .flatMap((n) => children(n, "slicerCache", X14))
    .map((n) => target(workbookRels, n, `${MSREL}/slicerCache`));
  const slicerCachePaths = unique([
    ...cacheLinks,
    ...Object.keys(parts).filter((p) => /^xl\/slicerCaches\/[^/]+\.xml$/.test(p)),
  ]);
  const slicerCaches: SlicerCacheMetadata[] = slicerCachePaths.map((part) => {
    const root = rootOf(parts, part, "slicerCacheDefinition", X14);
    const pivotCacheId = attr(
      single(children(single(children(root, "data", X14)), "tabular", X14)),
      "pivotCacheId",
    );
    const cache =
      pivotCacheId === undefined
        ? undefined
        : single(pivotCaches.filter((c) => c.extensionCacheId === pivotCacheId));
    const refs = children(single(children(root, "pivotTables", X14)), "pivotTable", X14).map(
      (n) => {
        const name = attr(n, "name") ?? "",
          tabId = attr(n, "tabId") ?? "";
        const pivot = single(pivotTables.filter((p) => p.name === name && p.sheetId === tabId));
        return { name, tabId, part: pivot?.part };
      },
    );
    const linked = Boolean(
      root &&
        cacheLinks.filter((p) => p === part).length === 1 &&
        cache &&
        refs.length &&
        refs.every(
          (r) =>
            r.part &&
            cache.pivots.includes(r.part) &&
            pivotTables.find((p) => p.part === r.part)?.linked,
        ),
    );
    if (linked) cache!.slicerCaches.push(part);
    else
      for (const candidate of pivotCaches.filter((c) =>
        refs.some((r) => r.part && c.pivots.includes(r.part)),
      )) {
        candidate.editable = false;
        candidate.reason = "切片器缓存与透视缓存的扩展标识或关系无法唯一验证";
      }
    return {
      part,
      name: attr(root, "name") ?? "",
      sourceName: attr(root, "sourceName"),
      pivotCacheId,
      cacheId: cache?.cacheId,
      pivotTables: refs,
      linked,
      ...(!linked ? { reason: "切片器缓存的工作簿、透视表或 x14 缓存映射无法验证" } : {}),
    };
  });
  const slicerLinks = sheets.flatMap((sheet) => {
    if (!sheet.part) return [];
    const rels = relationships(parts, sheet.part);
    return extensionNodes(rootOf(parts, sheet.part, "worksheet"), "slicerList")
      .flatMap((n) => children(n, "slicer", X14))
      .map((n) => ({ sheet: sheet.name, part: target(rels, n, `${MSREL}/slicer`) }));
  });
  const slicerOwners = sheets.flatMap((sheet) =>
    sheet.part
      ? relationships(parts, sheet.part)
          .filter((r) => r.type === `${MSREL}/slicer`)
          .map((r) => ({ sheet: sheet.name, sheetPart: sheet.part, part: r.part }))
      : [],
  );
  const slicerPaths = unique([
    ...slicerLinks.map((s) => s.part),
    ...slicerOwners.map((s) => s.part),
    ...Object.keys(parts).filter((p) => /^xl\/slicers\/[^/]+\.xml$/.test(p)),
  ]);
  const slicers = slicerPaths.flatMap<SlicerMetadata>((part) => {
    const nodes = children(rootOf(parts, part, "slicers", X14), "slicer", X14);
    const owners = slicerOwners.filter((s) => s.part === part);
    if (!nodes.length) {
      // Invalid namespaces cannot prove a cache name. The actual worksheet relation still
      // proves which local pivot graph is affected, without blocking unrelated sheets.
      for (const cache of pivotCaches.filter((c) =>
        pivotTables.some(
          (p) =>
            c.pivots.includes(p.part) && owners.some((owner) => owner.sheetPart === p.sheetPart),
        ),
      )) {
        cache.editable = false;
        cache.reason = "关联工作表的切片器部件无法识别，不能验证缓存刷新影响";
      }
      return [
        {
          part,
          name: "",
          cacheName: "",
          sheet: single(owners)?.sheet,
          linked: false,
          unknown: true,
          reason: "切片器根节点或命名空间无法识别",
        },
      ];
    }
    return nodes.map((node) => {
      const cacheName = attr(node, "cache") ?? "";
      const cacheMatches = slicerCaches.filter((c) => c.name === cacheName);
      const cache = single(cacheMatches);
      const owner = single(slicerLinks.filter((s) => s.part === part));
      const linked = Boolean(
        owner && owners.length === 1 && owner.sheet === owners[0]?.sheet && cache?.linked,
      );
      const unresolvedRegisteredCache =
        !cacheMatches.length && slicerCaches.some((c) => !c.name && cacheLinks.includes(c.part));
      if (!linked)
        for (const affected of pivotCaches.filter(
          (c) =>
            cacheMatches.some(
              (match) => match.cacheId === c.cacheId || c.slicerCaches.includes(match.part),
            ) ||
            (unresolvedRegisteredCache &&
              pivotTables.some(
                (p) => c.pivots.includes(p.part) && owners.some((o) => o.sheetPart === p.sheetPart),
              )),
        )) {
          affected.editable = false;
          affected.reason = "关联切片器的工作表引用或缓存关系缺失或不唯一";
        }
      return {
        part,
        name: attr(node, "name") ?? "",
        cacheName,
        cachePart: cache?.part,
        sheet: owner?.sheet,
        linked,
        ...(!linked ? { reason: "切片器的工作表或缓存关系缺失或不唯一" } : {}),
      };
    });
  });
  return {
    pivotTables,
    pivotCaches,
    slicerCaches,
    slicers,
    pivotTableCount: pivotTables.length,
    cacheCount: pivotCaches.length,
    slicerCacheCount: slicerCaches.length,
    slicerCount: slicers.filter((s) => !s.unknown).length,
    unknownSlicerPartCount: slicers.filter((s) => s.unknown).length,
  };
}

function sourceSheet(
  cache: PivotCacheMetadata,
  mapping: Mapping,
  sheets: IWorkbookData["sheets"],
): string | undefined {
  const matches = Object.entries(mapping).filter(([, m]) => m.path === cache.sourceSheetPart);
  const entry = single(matches);
  if (!entry) return undefined;
  const [id] = entry,
    sheet = sheets[id];
  if (
    !sheet ||
    sheet.id !== id ||
    sheet.name !== cache.source.sheet ||
    Object.values(sheets).filter((s) => s.name === sheet.name).length !== 1
  )
    return undefined;
  return id;
}
export function importPivotRefresh(
  parts: Parts,
  mapping: Mapping,
  sheets: IWorkbookData["sheets"],
): void {
  for (const cache of pivotMetadata(parts).pivotCaches) {
    if (!cache.editable || !validFlag(cache.refreshOnLoad.raw)) continue;
    const id = sourceSheet(cache, mapping, sheets);
    if (!id) continue;
    const sheet = sheets[id]!;
    const parsed = WorkbookObjects.safeParse(sheet.custom?.excelmanusObjects);
    const objects = parsed.success ? parsed.data : { charts: [], images: [] };
    sheet.custom = {
      ...sheet.custom,
      excelmanusObjects: {
        ...objects,
        pivotRefreshOnLoad: {
          ...(objects as { pivotRefreshOnLoad?: Record<string, Flag> }).pivotRefreshOnLoad,
          [cache.cacheId]: cache.refreshOnLoad.raw,
        },
      },
    };
  }
}
function flags(sheet: Partial<IWorksheetData> | undefined): Record<string, Flag> {
  const objects = sheet?.custom?.excelmanusObjects as { pivotRefreshOnLoad?: unknown } | undefined;
  const value = objects?.pivotRefreshOnLoad;
  if (value === undefined) return {};
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.values(value).some((v) => !validFlag(v))
  )
    unsupported("透视缓存刷新标记格式无效");
  return value as Record<string, Flag>;
}
export function resolvePivotRefreshTarget(
  parts: Parts,
  mapping: Mapping,
  snapshot: IWorkbookData,
  sheetId: string,
  cacheId: string,
): PivotCacheMetadata {
  const cache = single(pivotMetadata(parts).pivotCaches.filter((c) => c.cacheId === cacheId));
  if (!cache?.editable) unsupported(cache?.reason ?? "找不到唯一可修改的已有透视缓存");
  if (sourceSheet(cache, mapping, snapshot.sheets) !== sheetId)
    unsupported("透视缓存必须在其原始源工作表上标记刷新，不能重命名或复制来源");
  if (!Object.hasOwn(flags(snapshot.sheets[sheetId]), cacheId))
    unsupported("源工作表缺少可信的已有透视缓存刷新标记");
  return cache;
}

/** Pure all-or-nothing plan; only the cacheDefinition root's unqualified flag may change. */
export function planPivotRefreshPatches(
  parts: Parts,
  mapping: Mapping,
  snapshot: IWorkbookData,
  baseline: IWorkbookData,
): { part: string; bytes: Uint8Array }[] {
  const requested: { id: string; cacheId: string; value: Flag }[] = [];
  for (const id of new Set([...Object.keys(snapshot.sheets), ...Object.keys(baseline.sheets)])) {
    const next = flags(snapshot.sheets[id]),
      before = flags(baseline.sheets[id]);
    for (const cacheId of new Set([...Object.keys(next), ...Object.keys(before)])) {
      if (
        Object.hasOwn(next, cacheId) &&
        Object.hasOwn(before, cacheId) &&
        next[cacheId] === before[cacheId]
      )
        continue;
      if (!Object.hasOwn(next, cacheId) || !Object.hasOwn(before, cacheId))
        unsupported("不能新增、移动或删除已有透视缓存的刷新标记");
      requested.push({ id, cacheId, value: next[cacheId]! });
    }
  }
  if (!requested.length) return [];
  const catalogue = pivotMetadata(parts);
  const changes = requested.map(({ id, cacheId, value }) => {
    const cache = single(catalogue.pivotCaches.filter((c) => c.cacheId === cacheId));
    if (!cache?.editable) unsupported(cache?.reason ?? "不能修改未知或不唯一的透视缓存");
    if (
      sourceSheet(cache, mapping, snapshot.sheets) !== id ||
      sourceSheet(cache, mapping, baseline.sheets) !== id
    )
      unsupported("透视缓存来源工作表的身份或名称已改变");
    return { cache, value };
  });
  return changes.map(({ cache, value }) => {
    const xml = textOf(parts[cache.part]!);
    const node = rootOf(parts, cache.part, "pivotCacheDefinition")!;
    const open = xml.slice(node.start, node.openEnd);
    const token = [...open.matchAll(/(\s+)([A-Za-z_][\w:.-]*)(\s*=\s*)(["'])([\s\S]*?)\4/g)].find(
      (m) => m[2] === "refreshOnLoad",
    );
    let patched: string;
    if (token) {
      const replacement =
        value === null ? "" : `${token[1]}${token[2]}${token[3]}${token[4]}${value}${token[4]}`;
      patched =
        open.slice(0, token.index) + replacement + open.slice(token.index + token[0].length);
    } else if (value === null) patched = open;
    else patched = open.replace(/\/?\s*>$/, (end) => ` refreshOnLoad="${value}"${end}`);
    return {
      part: cache.part,
      bytes: bytesOf(xml.slice(0, node.start) + patched + xml.slice(node.openEnd)),
    };
  });
}
