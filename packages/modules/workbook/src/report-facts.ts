import { createHash } from "node:crypto";
import { posix } from "node:path";
import { assertSortableRange, formatRange } from "@excelmanus/core";
import type { IWorksheetData } from "@univerjs/core";
import { SaxesParser } from "saxes";
import type { pivotMetadata, SavedDisplayTotal } from "./pivot-codec.ts";
import { readWorkbookManifest } from "./workbook-manifest.ts";
import { textOf } from "./xml.ts";

/** A conservative saved-sheet comparison, not an arbitrary package selector or dependency graph. */
export function savedSheetFingerprint(
  parts: Record<string, Uint8Array> | undefined,
  sheet: string,
) {
  if (!parts?.["xl/workbook.xml"] || !parts["xl/_rels/workbook.xml.rels"]) return;
  try {
    const sheets = readWorkbookManifest(textOf(parts["xl/workbook.xml"])).sheets;
    if (sheets.filter((entry) => entry.name === sheet).length !== 1) return;
    const relationships = new Map<string, string>();
    const parser = new SaxesParser({ xmlns: true });
    const namespace = "http://schemas.openxmlformats.org/package/2006/relationships";
    let depth = 0;
    parser.on("doctype", () => {
      throw new Error("DTD is unsupported");
    });
    parser.on("opentag", (tag) => {
      const attr = (name: string) =>
        Object.values(tag.attributes).find((a) => a.local === name && a.uri === "")?.value;
      if (depth === 0 && (tag.local !== "Relationships" || tag.uri !== namespace))
        throw new Error("Unknown relationships namespace");
      if (
        depth === 1 &&
        tag.local === "Relationship" &&
        tag.uri === namespace &&
        attr("Type") ===
          "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"
      ) {
        const id = attr("Id"),
          raw = attr("Target");
        if (
          !id ||
          !raw ||
          relationships.has(id) ||
          attr("TargetMode") === "External" ||
          /[:\\?#]/.test(raw)
        )
          throw new Error("Ambiguous worksheet relationship");
        const path = posix.normalize(raw.startsWith("/") ? raw.slice(1) : `xl/${raw}`);
        if (path === ".." || path.startsWith("../") || !parts[path])
          throw new Error("Missing worksheet part");
        relationships.set(id, path);
      }
      depth++;
    });
    parser.on("closetag", () => {
      depth--;
    });
    parser.write(textOf(parts["xl/_rels/workbook.xml.rels"])).close();
    const worksheets = new Set<string>();
    let worksheetPart: string | undefined;
    for (const entry of sheets) {
      const part = entry.rid ? relationships.get(entry.rid) : undefined;
      if (!part || worksheets.has(part)) return;
      worksheets.add(part);
      if (entry.name === sheet) worksheetPart = part;
    }
    const worksheet = worksheetPart ? parts[worksheetPart] : undefined;
    if (!worksheetPart || !worksheet) return;
    const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
    return {
      worksheetPart,
      worksheetSha256: hash(worksheet),
      supportingPartsSha256: hash(
        JSON.stringify(
          Object.entries(parts)
            .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
            .filter(([path]) => !worksheets.has(path))
            .map(([path, bytes]) => [path, hash(bytes)]),
        ),
      ),
    };
  } catch {
    return;
  }
}

/** A finite, host-built projection. It is not a selector into arbitrary preserved XML. */
export function pivotReportFacts(
  sheets: Record<string, IWorksheetData>,
  graph: ReturnType<typeof pivotMetadata>,
  checkpoint: { rev: number; currentRev: number; isCurrent: boolean },
) {
  return {
    version: 1,
    sheets: Object.values(sheets).map(({ id, name }) => ({ id, name })),
    pivots: graph.pivotTables.map((pivot) => {
      const cache = graph.pivotCaches.find(
        (cache) => cache.part === pivot.cachePart && cache.cacheId === pivot.cacheId,
      );
      const slicerCaches = graph.slicerCaches.filter(
        (slicer) =>
          slicer.linked &&
          slicer.cacheId === cache?.cacheId &&
          slicer.pivotTables.some((table) => table.part === pivot.part),
      );
      const savedDisplayTotal: SavedDisplayTotal = checkpoint.isCurrent
        ? pivot.savedDisplayTotal
        : {
            status: "unsupported",
            label: "保存透视显示总计",
            reason: "当前修订与已确认保存文件不一致，保真包当前性未验证，不能认证当前保存总计。",
          };
      return {
        part: pivot.part,
        name: pivot.name,
        sheet: pivot.sheet,
        sheetId: Object.values(sheets).find((sheet) => sheet.name === pivot.sheet)?.id,
        range: pivot.range,
        cacheId: pivot.cacheId,
        cachePart: pivot.cachePart,
        linked: pivot.linked && Boolean(cache),
        source: cache?.source ?? { type: "unknown" },
        refreshOnLoad: cache?.refreshOnLoad ?? { raw: null, effective: null, defaulted: false },
        enableRefresh: cache?.enableRefresh ?? { raw: null, effective: null, defaulted: false },
        recordCount: cache?.recordCount ?? null,
        slicerCaches: slicerCaches.map(({ part, name }) => ({ part, name })),
        slicers: graph.slicers
          .filter(
            (slicer) =>
              slicer.linked && slicerCaches.some((cache) => cache.part === slicer.cachePart),
          )
          .map(({ part, name }) => ({ part, name })),
        checkpoint,
        savedDisplayTotal,
        refreshExecuted: false,
        cacheRecordsAggregated: false,
      };
    }),
    capabilities: { refresh: false, cacheRecordsAggregation: false, slicerInteraction: false },
  };
}

export function sortPreflight(
  sheet: IWorksheetData,
  target: { startRow: number; endRow: number; startColumn: number; endColumn: number },
  hasHeader: boolean,
) {
  const data = { ...target, startRow: target.startRow + (hasHeader ? 1 : 0) };
  const merges = sheet.mergeData ?? [];
  const address = (r: typeof target) =>
    formatRange({
      sheet: sheet.name,
      startRow: r.startRow + 1,
      endRow: r.endRow + 1,
      startCol: r.startColumn + 1,
      endCol: r.endColumn + 1,
    });
  let status: "blocked" | "safe" = "safe";
  let reason =
    "排序数据区域与合并单元格无交集；仅通过合并几何预检，未执行排序，也未验证排序键、公式或其他限制。";
  try {
    assertSortableRange(data, merges);
  } catch (error) {
    status = "blocked";
    reason = `${(error as Error).message}；这是只读预检阻断，未执行排序。`;
  }
  return {
    sheet: sheet.name,
    targetRange: address(target),
    dataRange: data.startRow > data.endRow ? null : address(data),
    hasHeader,
    status,
    execution: "not_executed",
    reason,
    merges: merges.map((merge) => {
      // Use the execution guard itself to identify intersection, not a second safety rule.
      let relation: "crosses_boundary" | "inside_data" | "outside_data" = "outside_data";
      try {
        assertSortableRange(data, [merge]);
      } catch {
        relation =
          merge.startRow >= data.startRow &&
          merge.endRow <= data.endRow &&
          merge.startColumn >= data.startColumn &&
          merge.endColumn <= data.endColumn
            ? "inside_data"
            : "crosses_boundary";
      }
      const risk =
        relation === "inside_data"
          ? merge.endRow > merge.startRow
            ? "spans_data_rows"
            : "inside_data_single_row"
          : relation;
      return { range: address(merge), relation, risk };
    }),
  };
}
