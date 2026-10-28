import {
  assertToolAccess,
  assertToolWriteAccess,
  FileOperationError,
  recordDocumentAccess,
} from "@excelmanus/kernel";
import { arraysOf, printNamesOf, printSettingsOf } from "@excelmanus/protocol";
import { materializeArrays } from "./array-formulas.ts";
import { scalarValue } from "./cell-value.ts";
import { workbookProtection } from "./checkpoint.ts";
import { namesOf } from "./defined-names.ts";
import { publishNew, workbookExportTool } from "./export.ts";
import { tablesOf } from "./tables.ts";
import { elements, textOf, xmlAttrs } from "./xml.ts";

// workbook_read / workbook_analyze（06 §4.1–4.2）：只读活文档工具。
// 数据面：overview/range/search；分析面：sql（内存 SQLite，只许 SELECT/WITH）
// 与 profile（列画像）。结果统一带 docRevs；上限 2000 格 / 16000 字符，截断给游标。

import { formatRange, indexToCol, parseRange, type RangeRef } from "@excelmanus/core";
import type { ToolContext, ToolDefinition, WorkbookActivity } from "@excelmanus/kernel";
import {
  AnalyzeSaveTo,
  type ToolErrorCode,
  type ToolResult,
  toToolErrorCode,
} from "@excelmanus/protocol";
import type { ICellData, IWorkbookData, IWorksheetData } from "@univerjs/core";
import { z } from "zod";
import { CheckRule, checkTables, diffTables } from "./analysis.ts";
import { workbookEditTool } from "./edit.ts";
import { formulaGraph } from "./formula-graph.ts";
import { chartCacheMetadata, objectsOf, preservedMetadata } from "./objects.ts";
import { pivotMetadata } from "./pivot-codec.ts";
import { displayText } from "./render.ts";
import { pivotReportFacts, savedSheetFingerprint, sortPreflight } from "./report-facts.ts";
import { CF_RESOURCE, DV_RESOURCE, rulesResource } from "./rule-codec.ts";
import { DocNotFoundError, type DocumentService } from "./service.ts";
import {
  type AlignmentSource,
  SourceAlignmentInput,
  verifySourceAlignment,
} from "./source-alignment.ts";
import { runSql, type SqlTable } from "./sql-runner.ts";
import { workbookSheets } from "./summary.ts";

const MAX_CELLS = 2000;
const MAX_CHARS = 16000;
const SQL_PREVIEW_ROWS = 200;
const SEARCH_LIMIT = 100;
const PROFILE_TOP = 5;
export const WORKBOOK_ANALYZE_SQL_TABLE = "data";
export const WORKBOOK_ANALYZE_SQL_SHEET_PLACEHOLDER = "{{sheet}}";

interface DocRef {
  docId: string;
  path: string;
  rev: number;
  name: string;
  sheetOrder: string[];
  sheets: Record<string, IWorksheetData>;
  snapshot: IWorkbookData;
  /** 按 id 或表名取表。 */
  sheet(idOrName: string | undefined): IWorksheetData;
}

async function openDoc(
  svc: DocumentService,
  ctx: ToolContext,
  docId?: string,
  path?: string,
): Promise<DocRef> {
  svc.editTarget(ctx.workspaceId, ctx.workspaceRoot, { docId, path });
  let id: string;
  if (docId !== undefined) {
    id = (await svc.entry(docId, ctx.workspaceRoot)).meta.id;
  } else if (path !== undefined) {
    id = (await svc.open(ctx.workspaceId, ctx.workspaceRoot, path)).meta.id;
  } else {
    throw new Error("缺少 docId 或 path");
  }
  const current = await svc.snapshot(id, ctx.workspaceRoot);
  const meta = current.meta,
    snapshot = materializeArrays(current.snapshot);
  const sheets = snapshot.sheets as Record<string, IWorksheetData>;
  const sheetOrder = snapshot.sheetOrder;
  return {
    docId: meta.id,
    path: meta.path,
    rev: meta.rev,
    name: snapshot.name,
    sheetOrder,
    sheets,
    snapshot,
    sheet(idOrName) {
      const s =
        idOrName !== undefined
          ? Object.values(sheets).find((x) => x.id === idOrName || x.name === idOrName)
          : sheets[sheetOrder[0] ?? ""];
      if (!s)
        throw new FileOperationError(
          "NOT_FOUND",
          `工作表不存在：${idOrName ?? "(默认)"}。可用工作表：${JSON.stringify(sheetOrder.map((id) => sheets[id]?.name ?? id))}`,
        );
      return s;
    },
  };
}

const docRevsOf = (docId: string, rev: number) => ({ docRevs: { [docId]: rev } });

/** 异常自带的错误码（FileOperationError 等）收敛到 06 §9 词表；没有码时用 fallback。 */
const codeOf = (e: unknown, fallback: ToolErrorCode): ToolErrorCode => {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" ? toToolErrorCode(code) : fallback;
};

// ---------- range 读取 ----------

interface Region {
  sheet: IWorksheetData;
  sheetId: string;
  sheetName: string;
  /** 0 基闭区间。 */
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

function resolveRegion(doc: DocRef, sheetName: string | undefined, range: string): Region {
  const parsed = parseRange(range);
  const sheet = doc.sheet(parsed.sheet ?? sheetName);
  const name = sheet.name ?? parsed.sheet ?? "Sheet1";
  return {
    sheet,
    sheetId: sheet.id ?? name,
    sheetName: name,
    r0: parsed.startRow - 1,
    c0: parsed.startCol - 1,
    r1: Math.min(parsed.endRow - 1, sheet.rowCount - 1),
    c1: Math.min(parsed.endCol - 1, sheet.columnCount - 1),
  };
}

function wholeSheet(doc: DocRef, sheetName: string | undefined): Region {
  const sheet = doc.sheet(sheetName);
  return {
    sheet,
    sheetId: sheet.id ?? sheet.name ?? "Sheet1",
    sheetName: sheet.name ?? "Sheet1",
    r0: 0,
    c0: 0,
    r1: sheet.rowCount - 1,
    c1: sheet.columnCount - 1,
  };
}

const cellText = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

function readRegion(
  region: Region,
  facets: ("values" | "formulas" | "layout" | "styles" | "rules")[],
  snapshot: IWorkbookData,
  offset: number,
): { out: Record<string, unknown>; consumedRows: number; truncated: boolean } {
  const { sheet } = region;
  const arrays = arraysOf(sheet);
  const out: Record<string, unknown> = {};
  const wantValues = facets.includes("values");
  const wantFormulas = facets.includes("formulas");
  const values: unknown[][] = [];
  const displayValues: (string | null)[][] = [];
  const blankCells: string[] = [];
  const formulas: (string | null)[][] = [];
  const styles: unknown[][] = [];
  if (region.c1 - region.c0 + 1 > MAX_CELLS)
    throw new Error("单次读取区域最多2000列，请拆分列范围读取");
  let cells = 0;
  // Include the new worksheetRows receipt in the same whole-row page budget.
  // Like values, a single row may exceed the budget, but each page makes progress.
  let chars = 2; // JSON array brackets
  let consumedRows = 0;
  let truncated = false;

  for (let r = region.r0 + offset; r <= region.r1; r++) {
    if (consumedRows > 0 && (cells + region.c1 - region.c0 + 1 > MAX_CELLS || chars >= MAX_CHARS)) {
      truncated = true;
      break;
    }
    const vRow: unknown[] = [];
    const dRow: (string | null)[] = [];
    const sRow: unknown[] = [];
    const fRow: (string | null)[] = [];
    const rowCells = sheet.cellData?.[r] as Record<number, ICellData> | undefined;

    for (let c = region.c0; c <= region.c1; c++) {
      const cell = rowCells?.[c];
      const style =
        typeof cell?.s === "string" ? snapshot.styles?.[cell.s] : (cell?.s ?? snapshot.styles?.s0);
      if (wantValues) {
        const value = scalarValue(cell) ?? "";
        vRow.push(value);
        let supported = true;
        const shown = displayText(value, style?.n?.pattern ?? undefined, () => {
          supported = false;
        });
        const display = supported ? shown : null;
        dRow.push(display);
        chars += JSON.stringify(display).length;
        if (cell?.v == null && !cell?.f && !cell?.si) {
          const address = `${indexToCol(c + 1)}${r + 1}`;
          blankCells.push(address);
          chars += address.length;
        }
        chars += cellText(cell?.v).length;
      }
      if (wantFormulas) {
        const array = arrays.find(
          (a) =>
            a.mode === "fixed" &&
            r >= a.range.startRow &&
            r <= a.range.endRow &&
            c >= a.range.startColumn &&
            c <= a.range.endColumn,
        );
        const f = array ? `{${array.formula}}` : typeof cell?.f === "string" ? cell.f : null;
        fRow.push(f);
        if (f !== null) chars += f.length;
      }
      cells += 1;
      if (facets.includes("styles")) {
        sRow.push(style ?? null);
        chars += JSON.stringify(style ?? null).length;
      }
    }
    if (wantValues) {
      values.push(vRow);
      displayValues.push(dRow);
    }
    if (wantFormulas) formulas.push(fRow);
    if (facets.includes("styles")) styles.push(sRow);
    chars += String(r + 1).length + (consumedRows > 0 ? 1 : 0);
    consumedRows += 1;
  }
  if (wantValues) {
    out.values = values;
    out.displayValues = displayValues;
    out.displayBasis = "same_snapshot_number_format";
    out.blankCells = blankCells;
  }
  if (wantFormulas) {
    out.formulas = formulas;
    if (arrays.length)
      out.arrayFormulas = arrays.filter(
        (a) =>
          a.range.startRow <= region.r1 &&
          a.range.endRow >= region.r0 &&
          a.range.startColumn <= region.c1 &&
          a.range.endColumn >= region.c0,
      );
  }
  if (facets.includes("styles")) out.styles = styles;
  if (facets.includes("rules")) {
    const overlaps = (rule: Record<string, unknown>) =>
      Array.isArray(rule.ranges) &&
      rule.ranges.some((range) => {
        const r = range as Record<string, number>;
        return (
          r.startRow! <= region.r1 &&
          r.endRow! >= region.r0 &&
          r.startColumn! <= region.c1 &&
          r.endColumn! >= region.c0
        );
      });
    out.rules = {
      conditionalFormats: (rulesResource(snapshot, CF_RESOURCE)[region.sheetId] ?? []).filter(
        overlaps,
      ),
      dataValidations: (rulesResource(snapshot, DV_RESOURCE)[region.sheetId] ?? []).filter(
        overlaps,
      ),
    };
  }
  out.coverage = Object.fromEntries(
    ["values", "formulas", "styles", "layout", "rules"].map((facet) => [
      facet,
      facets.includes(facet as (typeof facets)[number]) ? "read" : "not_requested",
    ]),
  );

  if (facets.includes("layout"))
    out.hyperlinks = Object.entries(sheet.cellData ?? {}).flatMap(([r, cells]) =>
      Number(r) >= region.r0 && Number(r) <= region.r1
        ? Object.entries(cells ?? {}).flatMap(([c, raw]) => {
            const cell = raw as ICellData;
            return Number(c) >= region.c0 &&
              Number(c) <= region.c1 &&
              cell?.custom?.excelmanusHyperlink
              ? [
                  {
                    cell: `${indexToCol(Number(c) + 1)}${Number(r) + 1}`,
                    link: cell.custom.excelmanusHyperlink,
                  },
                ]
              : [];
          })
        : [],
    );
  if (facets.includes("layout")) {
    const rawOutline = (sheet.custom?.excelmanusOutlineSettings ?? {}) as Record<string, string>;
    const outlineDefaulted: string[] = [];
    const outlineBoolean = (key: string, fallback: boolean) => {
      const value = rawOutline[key];
      if (value === undefined) {
        outlineDefaulted.push(key);
        return fallback;
      }
      if (["1", "true", "on"].includes(value.toLowerCase())) return true;
      if (["0", "false", "off"].includes(value.toLowerCase())) return false;
      return null;
    };
    const merges = (sheet.mergeData ?? []).filter(
      (m) =>
        m.startRow <= region.r1 &&
        m.endRow >= region.r0 &&
        m.startColumn <= region.c1 &&
        m.endColumn >= region.c0,
    );
    const columnWidths: Record<number, number> = {};
    for (let c = region.c0; c <= region.c1; c++) {
      const w = (sheet.columnData as Record<number, { w?: number }> | undefined)?.[c]?.w;
      if (w !== undefined) columnWidths[c] = w;
    }
    const rowHeights: Record<number, number> = {};
    for (let r = region.r0; r <= region.r1; r++) {
      const h = (sheet.rowData as Record<number, { h?: number }> | undefined)?.[r]?.h;
      if (h !== undefined) rowHeights[r] = h;
    }
    const filter =
      (
        rulesResource(snapshot, "SHEET_FILTER_PLUGIN") as Record<
          string,
          { cachedFilteredOut?: number[] }
        >
      )[region.sheetId] ?? null;
    const filteredRows = new Set(filter?.cachedFilteredOut ?? []);
    const rowVisibility = {
      rowNumberBase: 1,
      rowStateHiddenRows: [] as number[],
      filteredOutRows: [] as number[],
      effectiveHiddenRows: [] as number[],
      visibleRows: [] as number[],
    };
    for (let r = region.r0 + offset; r < region.r0 + offset + consumedRows; r++) {
      const rowStateHidden = !!sheet.rowData?.[r]?.hd;
      const filteredOut = filteredRows.has(r);
      if (rowStateHidden) rowVisibility.rowStateHiddenRows.push(r + 1);
      if (filteredOut) rowVisibility.filteredOutRows.push(r + 1);
      (rowStateHidden || filteredOut
        ? rowVisibility.effectiveHiddenRows
        : rowVisibility.visibleRows
      ).push(r + 1);
    }
    out.layout = {
      rowVisibility,
      freeze: sheet.freeze ?? { xSplit: 0, ySplit: 0, startRow: 0, startColumn: 0 },
      mergesScope: "effective_range_intersections",
      merges: merges.map((m) => ({
        ...m,
        range: `${indexToCol(m.startColumn + 1)}${m.startRow + 1}:${indexToCol(m.endColumn + 1)}${m.endRow + 1}`,
        anchor: `${indexToCol(m.startColumn + 1)}${m.startRow + 1}`,
        intersectsReturnedWindow:
          consumedRows > 0 &&
          m.startRow < region.r0 + offset + consumedRows &&
          m.endRow >= region.r0 + offset,
        anchorInReturnedWindow:
          consumedRows > 0 &&
          m.startRow >= region.r0 + offset &&
          m.startRow < region.r0 + offset + consumedRows &&
          m.startColumn >= region.c0 &&
          m.startColumn <= region.c1,
      })),
      columnWidths,
      rowHeights,
      outline: {
        raw: rawOutline,
        effective: {
          summaryBelow: outlineBoolean("summaryBelow", true),
          summaryRight: outlineBoolean("summaryRight", true),
          showOutlineSymbols: outlineBoolean("showOutlineSymbols", true),
          applyStyles: outlineBoolean("applyStyles", false),
        },
        defaulted: outlineDefaulted,
      },
      rows: Object.fromEntries(
        Object.entries(sheet.rowData ?? {}).filter(
          ([index]) => Number(index) >= region.r0 && Number(index) <= region.r1,
        ),
      ),
      filter,
      columns: Object.fromEntries(
        Object.entries(sheet.columnData ?? {}).filter(
          ([index]) => Number(index) >= region.c0 && Number(index) <= region.c1,
        ),
      ),
    };
  }
  return { out, consumedRows, truncated };
}

// ---------- SQL ----------

// REPLACE(...) 是只读字符串函数；REPLACE INTO 仍是禁止的写语句。
const FORBIDDEN_SQL =
  /\b(attach|detach|pragma|vacuum|reindex|insert|update|delete|drop|alter|create|truncate)\b|\breplace\b(?!\s*\()/i;

function checkSql(sql: string): string | undefined {
  const s = sql.trim().replace(/;\s*$/, "");
  if (s.includes(";")) return "只允许单条语句";
  if (!/^\s*(select|with)\b/i.test(s)) return "只允许 SELECT/WITH 查询";
  if (FORBIDDEN_SQL.test(s)) return "查询包含只读范围之外的关键字";
  return undefined;
}

/**
 * The SQL tool exposes the selected worksheet/range as the `data` table. Keep
 * the prompt-friendly `{{sheet}}` spelling as a compatibility alias so a
 * model does not have to know the internal table name.
 */
function normalizeSql(sql: string): string {
  return sql.replace(/\{\{\s*sheet\s*\}\}/gi, WORKBOOK_ANALYZE_SQL_TABLE);
}

function colName(raw: unknown, idx: number, used: Set<string>): string {
  let n = String(raw ?? "").trim();
  if (n === "") n = `col${idx + 1}`;
  if (used.has(n)) {
    let i = 2;
    while (used.has(`${n}_${i}`)) i += 1;
    n = `${n}_${i}`;
  }
  used.add(n);
  return n;
}

/** 把区域装入内存表 `data`：首行为列名，无类型声明（BLOB affinity 保留原生类型）。 */
function loadRegionTable(
  doc: DocRef,
  sheetName: string | undefined,
  range: string | undefined,
  name = WORKBOOK_ANALYZE_SQL_TABLE,
): SqlTable {
  const region =
    range !== undefined && range !== ""
      ? resolveRegion(doc, sheetName, range)
      : wholeSheet(doc, sheetName);
  const { sheet, r0, c0, r1, c1 } = region;
  const used = new Set<string>();
  const cols: string[] = [];
  for (let c = c0; c <= c1; c++) {
    cols.push(colName(sheet.cellData?.[r0]?.[c]?.v, c - c0, used));
  }
  if (cols.length === 0 || (r1 - r0) * cols.length > 200000)
    throw new FileOperationError("LIMIT_EXCEEDED", "SQL 每个输入最多20万格，请指定较小区域");
  const rows: SqlTable["rows"] = [];
  for (let r = r0 + 1; r <= r1; r++)
    rows.push(
      cols.map((_, i) => {
        const v = sheet.cellData?.[r]?.[c0 + i]?.v;
        return v === undefined || v === null
          ? null
          : typeof v === "boolean"
            ? v
              ? 1
              : 0
            : typeof v === "number" || typeof v === "string"
              ? v
              : String(v);
      }),
    );
  return { name, columns: cols, rows };
}

// ---------- profile ----------

function profileRegion(doc: DocRef, sheetName: string | undefined, range: string | undefined) {
  const region =
    range !== undefined && range !== ""
      ? resolveRegion(doc, sheetName, range)
      : wholeSheet(doc, sheetName);
  const { sheet, r0, c0, r1, c1 } = region;
  const cols: Record<string, unknown>[] = [];
  for (let c = c0; c <= c1; c++) {
    const name = cellText(sheet.cellData?.[r0]?.[c]?.v) || `col${c - c0 + 1}`;
    let nonNull = 0;
    let numeric = 0;
    let sum = 0;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    const distinct = new Set<string>();
    const freq = new Map<string, number>();
    let frequencyTrackingTruncated = false;
    for (let r = r0 + 1; r <= r1; r++) {
      const v = sheet.cellData?.[r]?.[c]?.v;
      if (v === undefined || v === null || v === "") continue;
      nonNull += 1;
      const s = String(v);
      if (distinct.size < 10000) distinct.add(s);
      if (freq.size < 500 || freq.has(s)) freq.set(s, (freq.get(s) ?? 0) + 1);
      else frequencyTrackingTruncated = true;
      if (typeof v === "number") {
        numeric += 1;
        sum += v;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    const type =
      nonNull === 0 ? "empty" : numeric === nonNull ? "number" : numeric === 0 ? "string" : "mixed";
    const top = [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, PROFILE_TOP)
      .map(([v, count]) => ({ v, count }));
    const coveredNonNull = top.reduce((total, entry) => total + entry.count, 0);
    cols.push({
      name,
      column: indexToCol(c + 1),
      type,
      nonNull,
      distinct: distinct.size,
      ...(numeric > 0 ? { min, max, mean: sum / numeric, sum } : {}),
      top,
      topCoverage: {
        coveredNonNull,
        totalNonNull: nonNull,
        truncated: coveredNonNull < nonNull,
        frequencyTrackingTruncated,
      },
    });
  }
  return {
    sheet: region.sheetName,
    range: formatRange({
      sheet: region.sheetName,
      startRow: region.r0 + 1,
      startCol: region.c0 + 1,
      endRow: region.r1 + 1,
      endCol: region.c1 + 1,
    }),
    dataRows: Math.max(0, region.r1 - region.r0),
    columns: cols,
  };
}

// ---------- 搜索 ----------

function searchDoc(
  doc: DocRef,
  query: string,
): { matches: Record<string, unknown>[]; truncated: boolean } {
  const q = query.toLowerCase();
  const matches: Record<string, unknown>[] = [];
  let truncated = false;
  outer: for (const sheetId of doc.sheetOrder) {
    const sheet = doc.sheets[sheetId];
    if (!sheet) continue;
    const name = sheet.name ?? sheetId;
    for (const [rs, row] of Object.entries(sheet.cellData ?? {})) {
      for (const [cs, cell] of Object.entries(row as Record<string, ICellData>)) {
        const text = cellText(cell?.v);
        const f = typeof cell?.f === "string" ? cell.f : "";
        if (text.toLowerCase().includes(q) || f.toLowerCase().includes(q)) {
          matches.push({
            ref: `'${name}'!${indexToCol(Number(cs) + 1)}${Number(rs) + 1}`,
            text: text.slice(0, 80),
            ...(f !== "" ? { formula: f } : {}),
          });
          if (matches.length >= SEARCH_LIMIT) {
            truncated = true;
            break outer;
          }
        }
      }
    }
  }
  return { matches, truncated };
}

// ---------- 输入 schema ----------

const readInput = z.object({
  docId: z.string().optional(),
  path: z.string().optional(),
  mode: z.enum(["overview", "range", "search", "objects", "table", "formula_graph", "print"]),
  depth: z.int().min(1).max(5).default(1),
  imageId: z.string().optional(),
  sheet: z.string().optional(),
  range: z.string().optional(),
  facets: z.array(z.enum(["values", "formulas", "styles", "layout", "rules"])).optional(),
  offset: z.number().int().min(0).optional(),
  query: z.string().optional(),
});

const analyzeInput = z.object({
  docId: z.string().optional(),
  path: z.string().optional(),
  mode: z.enum(["sql", "profile", "diff", "check", "sort_preflight", "source_alignment"]),
  alignment: SourceAlignmentInput.optional().describe(
    '仅 mode=source_alignment 必填。目标 range 不含表头，headerRow 为实际表头行；sources 每项需明确 range，source 必须精确匹配别名。完整调用示例：{"path":"result.xlsx","mode":"source_alignment","range":"明细!A2:C3","sources":[{"name":"src","path":"source.xlsx","range":"原表!A1:B8"}],"alignment":{"headerRow":1,"requiredColumns":["客户ID"],"bindings":[{"kind":"cell","column":"客户ID","source":"src","referenceColumn":"客户来源","rowColumn":"源行","mergeAnchor":true}]}}',
  ),
  hasHeader: z.boolean().default(false),
  right: z
    .object({
      path: z.string().optional(),
      docId: z.string().optional(),
      sheet: z.string().optional(),
      range: z.string().optional(),
    })
    .optional(),
  keys: z.array(z.string()).max(20).optional(),
  checks: z
    .array(CheckRule)
    .min(1)
    .max(20)
    .optional()
    .describe(
      'mode=check 必填的规则对象数组，不是字符串数组；column 用表头原文，range 首行含表头。row_expression 返回 passed/failedCount，失败不能因工具 status=ok 而忽略；并列 SELECT 数字不等于校验，单表等式通过也不证明来源完整。完整调用示例：{"path":"result.xlsx","mode":"check","range":"月表!A1:E3","checks":[{"kind":"row_expression","expression":"\\"净变动分\\" = \\"订单分\\" - \\"退款分\\" - \\"回款分\\""}]}',
    ),
  offset: z.int().nonnegative().default(0),
  sheet: z.string().optional(),
  range: z.string().optional(),
  sql: z.string().optional(),
  saveTo: AnalyzeSaveTo.optional(),
  sources: z
    .array(
      z.object({
        name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
        path: z.string().optional(),
        docId: z.string().optional(),
        sheet: z.string().optional(),
        range: z.string().optional(),
      }),
    )
    .max(12)
    .optional(),
});

const queryTarget = z
  .strictObject({
    docId: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    sheet: z.string().min(1).optional(),
    range: z.string().min(1).optional(),
  })
  .refine((a) => a.path !== undefined || a.docId !== undefined, {
    path: ["path"],
    message: "需要 path 或 docId；同时提供时必须指向同一工作簿",
  });

const querySource = queryTarget.safeExtend({
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
  range: z.string().min(1).describe("显式原始读取范围，首行作为 SQL 表头"),
});

/** 新模型入口只读；历史 analyze 与脚本调用保持原契约。 */
export const WorkbookQueryInput = z.discriminatedUnion("mode", [
  z
    .strictObject({
      mode: z.literal("sql"),
      sql: z.string().min(1),
      sources: z
        .array(querySource)
        .min(1)
        .max(13)
        .describe("显式声明所有来源，必须含唯一 name=data 主来源；其他名称用作 SQL 表别名"),
    })
    .superRefine((a, ctx) => {
      if (!a.sources.some((source) => source.name === WORKBOOK_ANALYZE_SQL_TABLE))
        ctx.addIssue({
          code: "custom",
          path: ["sources"],
          message: "SQL 来源必须包含 name=data 主来源",
        });
      const names = new Set<string>();
      for (const [i, source] of a.sources.entries()) {
        const name = source.name.toLowerCase();
        if (names.has(name) || name.startsWith("sqlite_"))
          ctx.addIssue({
            code: "custom",
            path: ["sources", i, "name"],
            message: "SQL 来源名称必须唯一且不能使用 sqlite_ 保留前缀",
          });
        names.add(name);
      }
    }),
  queryTarget.safeExtend({ mode: z.literal("profile") }),
  queryTarget.safeExtend({
    mode: z.literal("diff"),
    right: queryTarget,
    keys: z.array(z.string()).max(20).optional(),
    offset: z.int().nonnegative().default(0),
  }),
  queryTarget.safeExtend({
    mode: z.literal("sort_preflight"),
    range: z.string().min(1),
    hasHeader: z.boolean().default(false),
  }),
]);

export const WorkbookQueryJsonSchema = z.toJSONSchema(WorkbookQueryInput, {
  io: "input",
  override: ({ jsonSchema }) => {
    // Preserve the executable target alternative in the model schema too.
    if (jsonSchema.properties?.path && jsonSchema.properties.docId)
      jsonSchema.anyOf = [{ required: ["path"] }, { required: ["docId"] }];
    const sources = jsonSchema.properties?.sources;
    if (sources && typeof sources === "object") {
      sources.contains = {
        type: "object",
        properties: { name: { const: WORKBOOK_ANALYZE_SQL_TABLE } },
        required: ["name"],
      };
      sources.minContains = 1;
      sources.maxContains = 1;
    }
  },
});

function queryAnalyzeArgs(args: unknown): z.infer<typeof analyzeInput> {
  const query = WorkbookQueryInput.parse(args);
  if (query.mode !== "sql") return analyzeInput.parse(query);
  const primary = query.sources.find((source) => source.name === WORKBOOK_ANALYZE_SQL_TABLE)!;
  return analyzeInput.parse({
    mode: query.mode,
    sql: query.sql,
    docId: primary.docId,
    path: primary.path,
    sheet: primary.sheet,
    range: primary.range,
    sources: query.sources.filter((source) => source !== primary),
  });
}

/** Wrap the registered implementation so its current access, provenance and effect hooks stay intact. */
export function workbookQueryTool(analyze: ToolDefinition): ToolDefinition {
  return {
    ...analyze,
    name: "workbook_query",
    title: "查询工作簿",
    modelVisible: true,
    description:
      '只读查询、画像、比较与排序预检，不创建或修改文件。sql 必须声明完整 sources，唯一 name=data 是主表，其他名称为 JOIN/UNION 别名；每源20万格、合计40万格、查询10秒，预览最多200行。例：{"mode":"sql","sources":[{"name":"data","path":"source.xlsx","range":"Data!A1:B20"}],"sql":"SELECT SUM(amount) AS amount FROM data"}。同题同时要求分组与总体时，优先在一个查询中用 UNION ALL 等已支持语法返回分组行和明确标记的总体行，避免先交付目录检查后才补算总体。源数据明细行数用 COUNT(*) 等对实际来源计算，不把查询返回行数 rowCount 当作明细数。结果保留实际来源、范围、修订、SHA与截断状态；用于直接回答用户的查询应返回分组名称，并用用户原文术语命名结果列，避免缩写别名，不猜测单位。SQL 列名只是查询标签，不认证业务单位，也不能把 SQLite 类型转换当精确身份核验。profile 返回列画像和有覆盖限制的 top，不代表完整值清单；例：{"mode":"profile","path":"source.xlsx","range":"Data!A1:B20"}。diff 需要 right，可按 keys 或位置比较，来源行号使用返回的真实 worksheetRow；例：{"mode":"diff","path":"left.xlsx","right":{"path":"right.xlsx"}}。sort_preflight 必须明确 range，hasHeader 默认 false；例：{"mode":"sort_preflight","path":"source.xlsx","range":"Data!A1:B20","hasHeader":true}。safe 仅表示所检排序合并条件通过，不表示已排序；blocked 表示未执行。业务验证使用 workbook_check，写入使用 workbook_edit 或 run_script；不接受 saveTo。',
    input: WorkbookQueryInput,
    inputJsonSchema: WorkbookQueryJsonSchema,
    effect: "read",
    replay: "safe",
    targets: (args, scope) => analyze.targets(queryAnalyzeArgs(args), scope),
    activity: (args) => analyze.activity?.(queryAnalyzeArgs(args)) ?? null,
    async execute(args, ctx): Promise<ToolResult> {
      let parsed: z.infer<typeof analyzeInput>;
      try {
        parsed = queryAnalyzeArgs(args);
      } catch (error) {
        return {
          status: "error",
          error: {
            code: "INVALID_ARGUMENT",
            message: `参数无效，未执行：${error instanceof Error ? error.message : String(error)}`,
            retryable: false,
          },
        };
      }
      return analyze.execute(parsed, ctx);
    },
  };
}

// ---------- 工具定义 ----------

/** 工作簿活动（11 §3.4）：给界面叠加层的"正在读取/写入"区域。 */
function activityOf(
  kind: "read" | "write",
  a: {
    docId?: string | undefined;
    path?: string | undefined;
    sheet?: string | undefined;
    range?: string | undefined;
  },
): WorkbookActivity | null {
  if (!a.docId && !a.path) return null;
  const range = a.range
    ? a.sheet && !a.range.includes("!")
      ? `${a.sheet}!${a.range}`
      : a.range
    : null;
  return {
    kind,
    ...(a.docId ? { docId: a.docId } : {}),
    ...(a.path ? { path: a.path } : {}),
    ranges: range ? [range] : [],
  };
}

export function workbookTools(svc: DocumentService): ToolDefinition[] {
  const workbookRead: ToolDefinition = {
    name: "workbook_read",
    title: "读取工作簿",
    description:
      "观察工作簿内容与结构，不修改文件。objects/overview 的 macroEvidence 从同一份当前磁盘包给出 VBA 字节长度/SHA256、真实关系/内容类型和工作簿/工作表 codeName；checkpoint.isCurrent=false 时不能当当前已保存修订。cellEditSupport=conditional 仅表示普通字面值 cells.set 在现有单元格保真检查下可尝试，当前 hash 不保证未来保存；编辑后必须重读并比较已保存包。签名、歧义或不支持类型应停止，不能靠二进制文本读取或额外probe猜测。只做静态检查，不执行宏、不验证宏运行结果。sourceFile 返回文档打开时与当前磁盘 SHA256、changedSinceOpen 和计算缓存是否只在内存；changedSinceOpen 不表示本次调用导致变化，computed-in-memory-not-persisted 不代表缓存已保存，rev/mtime 不能替代字节核验。range/formula_graph 返回当前内存值，不等于已保存缓存；外部公式在内存中可能为 #REF!，即使下载包仍保留原缓存。必须同时检查 sourceFile.calculation；外链保存缓存读 externalLinkDetails/checkpointExternalLinks，不据内存结果声称外链已更新。读取 xlsx/csv 工作簿快照；只取任务需要的区域和 facets，聚合统计可用 workbook_query，版式核对可用 workbook_render。mode=overview 返回工作表清单与规模，以及 tables 中的 Excel 表对象（名称、范围、列名及计算列公式）；表名未知时不要猜 Sheet1，可从清单取实际名称；单表读取可省略 sheet。mode=range 返回指定区域（facets: values|formulas|styles|layout|rules，紧凑行数组，超 2000 格或 16000 字符截断并返回 nextOffset；readWindow 分开保留裁剪前 requestedRange、裁剪后分页前 effectiveRange、clipped 与本页 returnedRange；complete 只表示 offset 后已无剩余，不保证原请求全部已读）；values 默认附同快照数字格式生成的 displayValues 和 displayBasis，不必请求完整 styles；displayValues 与 values 同形，null 明示格式不支持，空白显示仍为空字符串，不代表原生 Excel 视觉或保存缓存。values 仍以空字符串显示空值；blankCells 列出本次返回区域内无值且无公式的单元格，保真复制时将这些地址写为 null，不把它们变成空字符串。layout.merges 保留与 effectiveRange 相交的真实完整合并几何，0基原坐标不变；range/anchor 是 A1 坐标，不含锚点值。intersectsReturnedWindow/anchorInReturnedWindow 只表示几何与本页返回窗口的关系，不证明已读锚点值；空页二者均为 false，裁剪/分页不得冒充全域已读。values/blankCells 保持原值，不填充合并格或普通空白。layout 会返回 hyperlinks 的实际目标，核验链接用它，不要把 XLSX 当文本读取。layout.rows/columns 与 filter 内的行列索引均为0基；rows.hd 是独立行隐藏状态（包括手动/分组隐藏），不含全部筛选隐藏。layout.rowVisibility 使用1基行号，只覆盖 readWindow.returnedRange 内实际返回的全部行（包括表头，不是仅明细）：rowStateHiddenRows 来自 rows.hd，filteredOutRows 来自 filter.cachedFilteredOut，effectiveHiddenRows 是两者并集，visibleRows 是其余行；核验可见编号使用 visibleRows 对应 values，不能只看 rows.hd。筛选本身已隐藏不匹配行，不要另用 axis.hide 模拟，否则移除筛选后独立隐藏状态仍在。custom.excelmanusOutlineLevel 缺省0，custom.excelmanusCollapsed 缺省false，分组层级、隐藏和折叠标记互不等同；outline.raw 保留 outlinePr 原属性，effective/defaulted 标明缺省值，不代表浏览器支持原生分组±交互。mode=print 返回当前修订所有或指定 sheet 的打印区域、重复行列、手动分页、原始 pageSetup/pageSetUpPr/pageMargins/printOptions/headerFooter 属性与动态字段串；effective/defaulted 区分原值和 OOXML 默认值，fit 模式忽略 scale，未知或复杂项标明只保留。打印读取不修改原件，不是浏览器分页结果。mode=search 按子串搜索单元格。range/table 的 worksheetRows 与每个实际返回行一一对应，为真实 Excel 1-based 行号，不是数据行序号；保留空行和隐藏行。mode=table 将 range 首行作为表头返回对象行，worksheetRows 不含表头，headerWorksheetRow 标识表头位置；mode=formula_graph 核对公式引用：返回公式、当前快照计算值及静态前驱/下游依赖；references.cells 给出引用单元格地址、实际值和公式，可用来排查引用错位。depth=1–5，引用值合计最多2000格，valueCoverage/各引用 truncated 明示截断；无法计算的值标记 valueAvailable=false，动态/外部等引用标明静态解析限制。mode=objects 的 reportFacts 是用于受控最终报告的宿主白名单事实：工作表清单、透视/源/缓存/切片器关联与保存总计身份；savedDisplayTotal 只在单度量、单层行列轴且明确 grand/location 对应时定位真实保存单元格，未知布局明确 unsupported，不聚合 cacheRecords，不执行刷新；checkpoint.isCurrent=false 时不能当当前已保存结果。mode=objects 返回图表、图片、可编辑平面形状 shapes（rect/ellipse/rightArrow）及当前修订传统批注 notes（ref/author/text），核验批注用 notes，不要为试探读取而改写正文；preserved 是原始保真包中的 OOXML 信息，externalLinks 是对象部件路径清单（overview 的 unsupported 计数还可能包含关系部件）；externalLinkDetails 只读给出实际外链目标字符串及 saved_worksheet/saved_external_link 两层保存缓存，updated=false 表示未执行更新，objects/overview 的 checkpointExternalLinks 的 isCurrent/packageState 区分已确认检查点与仅保真基底；目标永不自动访问，未知或歧义关联会明确说明，truncated=true 不能当作全量核验。外部公式只保留，不支持新增、覆盖、移动或本地重算；普通不涉及外链公式的单元格编辑允许；含外部定义名间接引用或外部数组公式的工作簿暂仅支持读取。 pivotTables/pivotCaches/slicerCaches/slicers 按实际关系给出源范围与关联，raw/effective/defaulted 区分原始属性和缺省值；checkpointPivots 明确最近保存修订，pendingPivotRefresh 只列当前修订待保存的标记，不能据标记声称缓存或透视显示结果已刷新，切片器仅保留不新增浏览器交互。drawings 列出实际保留的绘图及 editable/reason；未出现在 shapes 中不代表原件没有形状，复杂或未知绘图仅保留，不支持编辑。另含 checkpointCharts 的最近保存图表引用/缓存采样；isCurrent=false 时缓存不是当前修订，不能据此声称已更新。无需使用 files.readText 读取 XLSX 二进制核验缓存。指定 imageId 提取该图片给视觉模型。输入 docId 或工作区相对 path。",
    input: readInput,
    output: z.record(z.string(), z.unknown()),
    effect: "read",
    targets: (a) =>
      typeof (a as { path?: unknown }).path === "string" ? [(a as { path: string }).path] : [],
    activity: (a: z.infer<typeof readInput>) =>
      a.mode === "search"
        ? activityOf("read", { docId: a.docId, path: a.path })
        : activityOf("read", a),
    replay: "safe",
    timeoutMs: 60_000,
    roles: ["main", "lead", "worker", "reader"],
    async execute(args, ctx): Promise<ToolResult> {
      const a = readInput.parse(args);
      try {
        if (a.mode === "objects" || a.mode === "overview")
          svc.assertMacroReadOpen(ctx.workspaceId, ctx.workspaceRoot, a);
        const doc = await openDoc(svc, ctx, a.docId, a.path);
        const base = {
          docId: doc.docId,
          path: doc.path,
          ...docRevsOf(doc.docId, doc.rev),
          sourceFile: await svc.sourceStatus(doc.docId, ctx.workspaceRoot),
        };
        const macroEnvelope = async () => {
          const captured = await svc.macroEvidence(doc.docId, ctx.workspaceRoot);
          if (
            captured.rev !== doc.rev ||
            captured.path !== doc.path ||
            captured.sourceFile.currentSha256 !== base.sourceFile.currentSha256
          )
            throw new FileOperationError(
              "VERSION_CONFLICT",
              "工作簿在读取快照与宏证据之间发生变化，请重新读取；未把旧内容标记为新修订。",
            );
          // Ordinary workbooks keep their existing result envelope.
          return captured.macroEvidence ? captured : {};
        };
        const objectMetadata = Object.entries(doc.sheets).map(([sheetId, sheet]) => {
          const objects = objectsOf(sheet);
          return {
            sheetId,
            sheet: sheet.name,
            charts: objects.charts,
            images: objects.images.map(({ data: _data, ...metadata }) => metadata),
            shapes: objects.shapes ?? [],
            notes: objects.notes ?? [],
          };
        });
        const preserved = () =>
          svc.entry(doc.docId, ctx.workspaceRoot).then((e) => {
            const metadata = preservedMetadata(e.imported.preservation?.parts ?? {});
            recordDocumentAccess({
              kind: "package-cache-parse",
              path: doc.path,
              docId: doc.docId,
              rev: doc.rev,
              mode: a.mode,
              packageState: "actor-preserved-package",
            });
            return metadata;
          });
        const externalCheckpointOf = (
          entry: Awaited<ReturnType<DocumentService["entry"]>>,
          catalogue: ReturnType<typeof preservedMetadata>,
        ) => {
          const isCurrent =
            entry.checkpointRev === doc.rev &&
            !entry.rebased &&
            !entry.external &&
            !entry.readError &&
            !entry.meta.checkpointError &&
            base.sourceFile.currentSha256 === entry.checkpointHash;
          return {
            ...catalogue.externalLinkDetails,
            checkpointRev: entry.checkpointRev,
            currentRev: doc.rev,
            isCurrent,
            packageState: isCurrent ? "confirmed_checkpoint" : "preserved_base_only",
          };
        };
        if (a.mode === "print") {
          const sheetIds = a.sheet ? [doc.sheet(a.sheet).id] : doc.sheetOrder;
          ctx.reads.record(
            doc.docId,
            sheetIds.map((sheetId) => ({
              sheetId,
              r0: 0,
              c0: 0,
              r1: 1048575,
              c1: 16383,
            })),
            doc.rev,
          );
          return {
            status: "ok",
            data: {
              ...base,
              mode: "print",
              source: "current_revision",
              rev: doc.rev,
              print: sheetIds.map((sheetId) => {
                const sheet = doc.sheets[sheetId]!;
                const raw = printSettingsOf(sheet);
                const names = printNamesOf(doc.snapshot, sheetId);
                const defaulted: string[] = [];
                const numberValue = (key: string, fallback: number) => {
                  const value = raw.pageSetup?.[key];
                  if (value === undefined) {
                    defaulted.push(key);
                    return fallback;
                  }
                  return Number.isFinite(Number(value)) ? Number(value) : null;
                };
                if (raw.pageSetup?.orientation === undefined) defaulted.push("orientation");
                if (raw.pageSetUpPr?.fitToPage === undefined) defaulted.push("fitToPage");
                const manual = (entries: Record<string, string>[] | undefined) =>
                  (entries ?? [])
                    .filter((entry) => entry.man === "1" || entry.man === "true")
                    .map((entry) => Number(entry.id))
                    .filter(Number.isFinite);
                return {
                  sheetId,
                  sheet: sheet.name,
                  ...names,
                  raw,
                  afterRows: manual(raw.rowBreaks?.breaks),
                  afterColumns: manual(raw.colBreaks?.breaks),
                  effective: {
                    paperSize: numberValue("paperSize", 1),
                    orientation: raw.pageSetup?.orientation ?? "default",
                    fitToWidth: numberValue("fitToWidth", 1),
                    fitToHeight: numberValue("fitToHeight", 1),
                    scale: numberValue("scale", 100),
                    mode: ["1", "true"].includes(raw.pageSetUpPr?.fitToPage ?? "")
                      ? "fit"
                      : "scale",
                  },
                  defaulted,
                  unsupported: [...names.unsupported, ...(raw.unsupported ?? [])],
                  semantics:
                    "raw 为当前修订的原始 OOXML 属性/页眉页脚动态串，未填默认；effective/defaulted 使用 OOXML 缺省值，fit 模式忽略 scale。afterRows/afterColumns 为1基行/列之后。未知属性仅原样保留；复杂名称仅保留原公式，null 不表示原件不存在。浏览器预览不是 Excel 分页引擎。",
                };
              }),
            },
          };
        }
        if (a.mode === "objects") {
          // Object catalogue reads include source/cache relationships used by later edits.
          ctx.reads.record(
            doc.docId,
            doc.sheetOrder.map((sheetId) => ({ sheetId, r0: 0, c0: 0, r1: 1048575, c1: 16383 })),
            doc.rev,
          );
          const entry = await svc.entry(doc.docId, ctx.workspaceRoot);
          const catalogue = await preserved();
          const checkpointExternalLinks = externalCheckpointOf(entry, catalogue);
          const pivots = pivotMetadata(entry.imported.preservation?.parts ?? {});
          const checkpointPivots = {
            source: "last_checkpoint",
            rev: entry.checkpointRev,
            currentRev: doc.rev,
            isCurrent:
              entry.checkpointRev === doc.rev &&
              !entry.rebased &&
              !entry.external &&
              !entry.readError &&
              !entry.meta.checkpointError &&
              base.sourceFile.currentSha256 === entry.checkpointHash,
            ...pivots,
            semantics: "缓存记录、透视显示值和切片器状态是最近保存的结果；刷新标记不代表已经刷新。",
          };
          const pendingPivotRefresh = {
            source: "current_revision",
            rev: doc.rev,
            caches: Object.entries(doc.sheets).flatMap(([sheetId, sheet]) =>
              Object.entries(objectsOf(sheet).pivotRefreshOnLoad ?? {}).flatMap(
                ([cacheId, raw]) => {
                  const saved = pivots.pivotCaches.find((cache) => cache.cacheId === cacheId);
                  if (saved?.refreshOnLoad.raw === raw) return [];
                  return [
                    {
                      sheetId,
                      sheet: sheet.name,
                      cacheId,
                      refreshOnLoad: {
                        raw,
                        effective: raw === "true" || raw === "1",
                        defaulted: raw === null,
                      },
                      pivots: saved?.pivots ?? [],
                    },
                  ];
                },
              ),
            ),
            semantics:
              "仅标记下次由 Excel 打开时刷新，共享缓存的所有关联透视表都会受影响；未执行刷新或改写缓存记录，浏览器不渲染切片器交互。",
          };
          const reportFacts = pivotReportFacts(doc.sheets, pivots, {
            rev: checkpointPivots.rev,
            currentRev: doc.rev,
            isCurrent: checkpointPivots.isCurrent,
          });
          if (a.imageId) {
            const image = Object.values(doc.sheets)
              .flatMap((sheet) => objectsOf(sheet).images)
              .find((image) => image.id === a.imageId);
            if (!image) throw new FileOperationError("NOT_FOUND", "图片对象不存在");
            const entry = await svc.entry(doc.docId, ctx.workspaceRoot);
            const bytes = image.mediaPart
              ? entry.imported.preservation?.parts[image.mediaPart]
              : undefined;
            const data = image.data ?? (bytes ? Buffer.from(bytes).toString("base64") : undefined);
            if (!data) throw new FileOperationError("NOT_FOUND", "图片内容不可用");
            return {
              status: "ok",
              data: {
                ...base,
                mode: "objects",
                objects: objectMetadata,
                preserved: catalogue,
                checkpointExternalLinks,
                checkpointPivots,
                pendingPivotRefresh,
                reportFacts,
                ...(await macroEnvelope()),
              },
              images: [{ mediaType: image.mediaType, data }],
            };
          }
          return {
            status: "ok",
            data: {
              ...base,
              mode: "objects",
              objects: objectMetadata,
              preserved: catalogue,
              checkpointExternalLinks,
              checkpointPivots,
              pendingPivotRefresh,
              reportFacts,
              checkpointCharts: await svc.entry(doc.docId, ctx.workspaceRoot).then((e) => ({
                source: "last_checkpoint",
                rev: e.checkpointRev,
                currentRev: doc.rev,
                isCurrent:
                  e.checkpointRev === doc.rev &&
                  !e.external &&
                  !e.readError &&
                  !e.meta.checkpointError,
                ...chartCacheMetadata(e.imported.preservation?.parts ?? {}),
              })),
              ...(await macroEnvelope()),
            },
          };
        }
        if (a.mode === "overview") {
          const e = await svc.entry(doc.docId, ctx.workspaceRoot);
          const snapshot = (await svc.snapshot(doc.docId, ctx.workspaceRoot)).snapshot;
          const catalogue = await preserved();
          return {
            status: "ok",
            data: {
              ...base,
              mode: "overview",
              ...(await macroEnvelope()),
              name: doc.name,
              sheets: workbookSheets({ sheetOrder: doc.sheetOrder, sheets: doc.sheets }),
              unsupported: e.imported.unsupported,
              unsupportedCountsAre: "preserved_package_parts_not_object_counts",
              pivotCounts: (() => {
                const p = pivotMetadata(e.imported.preservation?.parts ?? {});
                return { pivotTableCount: p.pivotTableCount, cacheCount: p.cacheCount };
              })(),
              protection: workbookProtection(e.imported),
              packageFormat: e.imported.preservation
                ? {
                    macroEnabled: elements(
                      textOf(
                        e.imported.preservation.parts["[Content_Types].xml"] ?? new Uint8Array(),
                      ),
                      "Override",
                    ).some((el) => {
                      const attrs = xmlAttrs(el.open);
                      return (
                        attrs.PartName === "/xl/workbook.xml" &&
                        attrs.ContentType === "application/vnd.ms-excel.sheet.macroEnabled.main+xml"
                      );
                    }),
                    vbaProjectPresent: Object.keys(e.imported.preservation.parts).some((part) =>
                      /^xl\/vbaProject\.bin$/i.test(part),
                    ),
                    evidence: "OOXML package content types and parts; macros are not executed",
                  }
                : undefined,
              tables: tablesOf(snapshot),
              definedNames: Object.values(namesOf(snapshot)),
              conditionalFormats: rulesResource(snapshot, CF_RESOURCE),
              dataValidations: rulesResource(snapshot, DV_RESOURCE),
              objects: objectMetadata,
              preserved: catalogue,
              checkpointExternalLinks: externalCheckpointOf(e, catalogue),
            },
          };
        }
        if (a.mode === "table" || a.mode === "formula_graph") {
          if (!a.range) throw new Error(`${a.mode} 模式需要 range`);
          const region = resolveRegion(doc, a.sheet, a.range);
          const target = {
            sheetId: region.sheetId,
            r0: region.r0,
            r1: region.r1,
            c0: region.c0,
            c1: region.c1,
          };
          ctx.reads.record(
            doc.docId,
            a.mode === "formula_graph"
              ? Object.keys(doc.sheets).map((sheetId) => ({
                  sheetId,
                  r0: 0,
                  c0: 0,
                  r1: 1048575,
                  c1: 16383,
                }))
              : [target],
            doc.rev,
          );
          if (a.mode === "formula_graph")
            return {
              status: "ok",
              data: { ...base, mode: a.mode, ...formulaGraph(doc.snapshot, target, a.depth) },
            };
          const table = loadRegionTable(doc, a.sheet, a.range),
            offset = a.offset ?? 0;
          const rows = table.rows
            .slice(offset, offset + 200)
            .map((row) => Object.fromEntries(table.columns.map((name, i) => [name, row[i]])));
          return {
            status: "ok",
            data: {
              ...base,
              mode: a.mode,
              columns: table.columns,
              rows,
              // Table rows exclude the first (header) worksheet row. Blank and
              // hidden rows are retained by loadRegionTable, not filtered out.
              worksheetRows: rows.map((_, i) => region.r0 + offset + i + 2),
              headerWorksheetRow: region.r0 + 1,
              total: table.rows.length,
              ...(offset + rows.length < table.rows.length
                ? { nextOffset: offset + rows.length }
                : {}),
              header: "first_row",
            },
          };
        }
        if (a.mode === "range") {
          if (a.range === undefined) throw new Error("range 模式需要 range 参数");
          const region = resolveRegion(doc, a.sheet, a.range);
          const requestedRange = formatRange({ ...parseRange(a.range), sheet: region.sheetName });
          const effectiveRange = formatRange({
            sheet: region.sheetName,
            startRow: region.r0 + 1,
            startCol: region.c0 + 1,
            endRow: region.r1 + 1,
            endCol: region.c1 + 1,
          });
          const facets = a.facets ?? ["values"];
          const { out, consumedRows, truncated } = readRegion(
            region,
            facets,
            doc.snapshot,
            a.offset ?? 0,
          );
          if (facets.includes("rules")) {
            const entry = await svc.entry(doc.docId, ctx.workspaceRoot),
              preservation = entry.imported.preservation;
            const part = preservation?.sheetParts[region.sheetId]?.path;
            const xml = part ? new TextDecoder().decode(preservation?.parts[part]) : "";
            const total =
              (xml.match(/<(?:\w+:)?cfRule\b/g) ?? []).length +
              (xml.match(/<(?:\w+:)?dataValidation\b/g) ?? []).length;
            const known =
              (rulesResource(entry.imported.snapshot, CF_RESOURCE)[region.sheetId] ?? []).length +
              (rulesResource(entry.imported.snapshot, DV_RESOURCE)[region.sheetId] ?? []).length;
            const unknown = Math.max(0, total - known);
            if (unknown) {
              (out.coverage as Record<string, string>).rules = "partial";
              (out.rules as Record<string, unknown>).unsupportedOriginalCount = unknown;
            }
          }
          // 记录读集：range 模式记入所读区域（03 §6.1，截断的也算读过）
          ctx.reads.record(
            doc.docId,
            [
              {
                sheetId: region.sheetId,
                r0: region.r0,
                c0: region.c0,
                r1: region.r1,
                c1: region.c1,
              } satisfies RangeRef,
            ],
            doc.rev,
          );
          return {
            status: "ok",
            data: {
              ...base,
              mode: "range",
              sheet: region.sheetName,
              range: effectiveRange,
              // Keep pagination ahead of verbose facets so context truncation cannot hide it.
              truncated,
              ...(truncated ? { nextOffset: (a.offset ?? 0) + Math.max(1, consumedRows) } : {}),
              worksheetRows: Array.from(
                { length: consumedRows },
                (_, i) => region.r0 + (a.offset ?? 0) + i + 1,
              ),
              readWindow: {
                requestedRange,
                effectiveRange,
                clipped: requestedRange !== effectiveRange,
                offset: a.offset ?? 0,
                returnedRows: consumedRows,
                totalRows: Math.max(0, region.r1 - region.r0 + 1),
                complete: !truncated,
                returnedRange:
                  consumedRows > 0
                    ? formatRange({
                        sheet: region.sheetName,
                        startRow: region.r0 + (a.offset ?? 0) + 1,
                        startCol: region.c0 + 1,
                        endRow: region.r0 + (a.offset ?? 0) + consumedRows,
                        endCol: region.c1 + 1,
                      })
                    : null,
                remainingRange: truncated
                  ? formatRange({
                      sheet: region.sheetName,
                      startRow: region.r0 + (a.offset ?? 0) + consumedRows + 1,
                      startCol: region.c0 + 1,
                      endRow: region.r1 + 1,
                      endCol: region.c1 + 1,
                    })
                  : null,
              },
              ...out,
            },
          };
        }
        // search：命中单元格记入读集
        if (a.query === undefined || a.query === "") throw new Error("search 模式需要 query");
        const { matches, truncated } = searchDoc(doc, a.query);
        if (matches.length > 0) {
          const ranges: RangeRef[] = [];
          for (const m of matches) {
            try {
              const p = parseRange(String(m.ref));
              const sheet = doc.sheet(p.sheet);
              ranges.push({
                sheetId: sheet.id ?? p.sheet ?? "",
                r0: p.startRow - 1,
                c0: p.startCol - 1,
                r1: p.endRow - 1,
                c1: p.endCol - 1,
              });
            } catch {
              // 单个引用解析失败不影响其他命中
            }
          }
          if (ranges.length > 0) ctx.reads.record(doc.docId, ranges, doc.rev);
        }
        return {
          status: "ok",
          data: { ...base, mode: "search", query: a.query, matches, truncated },
        };
      } catch (e) {
        if (e instanceof DocNotFoundError) {
          return {
            status: "error",
            error: { code: "NOT_FOUND", message: e.message, retryable: false },
          };
        }
        return {
          status: "error",
          error: {
            code: codeOf(e, "INTERNAL"),
            message: e instanceof Error ? e.message : String(e),
            retryable: false,
          },
        };
      }
    },
  };

  const workbookAnalyze: ToolDefinition = {
    name: "workbook_analyze",
    title: "分析工作簿",
    description: `对工作簿区域做查询、统计、差异比较或结果校验。复制/宽转长/关联后的身份与来源核验用 mode=source_alignment；金额一致性用 mode=check 的显式等式，不能用汇总自洽替代来源核验。source_alignment 仅验证目标中声明字段，不会发现目标中完全遗漏的源行；另核源行×月份覆盖及排除依据，不能以存活行通过或合计相等代替记录完整性。排除金额不等于身份未知，应按身份来源独立核验。不修改来源，只有显式 saveTo 才写入输出工作簿，reader 不允许 saveTo。复杂自定义计算可选 run_script。mode=sql 把指定工作表/区域（首行为表头）注册为 SQLite 的 ${WORKBOOK_ANALYZE_SQL_TABLE} 表并执行只读 SELECT/WITH 查询（也兼容 ${WORKBOOK_ANALYZE_SQL_SHEET_PLACEHOLDER} 作为 ${WORKBOOK_ANALYZE_SQL_TABLE} 的占位符），可传 sources:[{name,path,docId,sheet,range}] 加载其他文件/工作表，以 name 作为 SQL 表名做 JOIN/UNION；每源20万格、合计40万格、查询10秒上限。预览 ≤200 行；mode=sort_preflight 必须传明确 range，hasHeader 默认 false，仅读取排序目标与真实合并几何，复用排序执行的合并边界规则；status=blocked 是预检阻断且未执行，safe 仅表示数据区域与合并无交集，不等于已排序或所有其他条件安全。targetRange/dataRange 区分含表头目标与实际数据区域，merges.relation 区分跨边界、区内和区外，risk 区分跨数据行与同一行合并；跨行合并不能作为独立完整行无损重排，不要为取得拒绝回执尝试危险排序。savedSheet 仅在磁盘 SHA 匹配当前已保存检查点时提供整张工作表 XML 及非其他工作表 XML 包部件指纹，scope 与 targetRange 分开；它不是该次预检执行排序或整过程未改的证明。mode=profile 返回每列的类型/非空数/去重数/min/max/mean/top 值；top 最多列出5种非空值，topCoverage 的 coveredNonNull/totalNonNull/truncated 明示列表覆盖记录数与截断，frequencyTrackingTruncated=true 表示超过500种值的频次跟踪上限，此时 top 也不保证全局高频排名；不得把 top 当完整值清单或据此推断其余值；mode=diff 用 right 指定另一区域，可按 keys 组合键或位置比较；返回 left/right 的来源文件、工作表与区域，changes 中 beforeWorksheetRow/afterWorksheetRow 是两侧实际工作表行号（缺失侧为 null），报告来源位置应直接使用它们，不按结果排序猜行号；beforeRow/afterRow 为不含表头的1基明细行；mode=source_alignment 在保存后只读核验显式来源映射，不能用汇总自洽替代。range 必须是目标数据行区域（不含表头），alignment:{headerRow,requiredColumns,bindings}；sources 每项必须含明确 range。字段绑定 {kind:cell,column,source,referenceColumn,scale?,mergeAnchor?,rowColumn?,sameColumnAs?} 按目标引用列读取真实源格，严格区分空白/空串/0/文本ID；{kind:period,column,source,yearReferenceColumn,monthReferenceColumn,valueReferenceColumn} 只支持来源四位年及1–12月，联合核实际同列/合并几何，不能任意映射月份；{kind:lookup,column,source,keys:[{targetColumn,sourceColumn}],valueColumn,where?:[{column,equals}],duplicatePolicy?:reject|identical_rows,duplicateColumns?,conflictPolicy?:unverified|expect_blank} 独立核身份，目标NULL/排除状态不跳过。lookup源range首行为表头；identical_rows必须声明源全部列，冲突默认unverified，expect_blank仅按显式规则要求目标真空白，不证明业务上应隔离。复制/宽转长/关联后应按任务明确声明需验证字段并调用；不支持的转换、遗漏绑定、超预算及版本不符为unverified，不猜业务。verification仅说明声明域，uncoveredColumns和sourcePolicies必须披露，未调用或未覆盖不得声称全面正确。mode=check 用 checks 校验 required/unique/range/pattern/foreign_key/row_expression/cell/total/formula_errors，cell.row 为不含表头的1基明细行。输入 docId 或工作区相对 path。`,
    input: analyzeInput,
    inputJsonSchema: z.toJSONSchema(analyzeInput, { io: "input" }),
    output: z.record(z.string(), z.unknown()),
    effect: (a: z.infer<typeof analyzeInput> | null) => (a?.saveTo ? "write" : "read"),
    effectIntents: (a) => {
      const q = analyzeInput.parse(a);
      if (!q.saveTo) return [];
      const path = q.saveTo.path ?? q.path ?? (q.docId ? svc.meta(q.docId)?.path : undefined);
      return path ? [{ kind: q.saveTo.path ? "create" : "mutate", path }] : [];
    },
    targets: (a, scope) => {
      const q = analyzeInput.parse(a);
      if (q.saveTo && scope) {
        const target = q.saveTo.path ?? q.path ?? (q.docId ? svc.meta(q.docId)?.path : undefined);
        if (!target) throw new FileOperationError("INVALID_ARGUMENT", "saveTo 写入目标不可用");
        assertToolWriteAccess(target, scope.workspaceRoot, q.saveTo.path ? "create" : "mutate");
      }
      return [
        ...(q.path ? [q.path] : []),
        ...(q.saveTo?.path ? [q.saveTo.path] : []),
        ...(q.sources ?? []).flatMap((s) => (s.path ? [s.path] : [])),
        ...(q.right?.path ? [q.right.path] : []),
      ];
    },
    activity: (a: z.infer<typeof analyzeInput>) => activityOf("read", a),
    replay: (a: z.infer<typeof analyzeInput> | null) => (a?.saveTo ? "unsafe" : "safe"),
    timeoutMs: 60_000,
    roles: ["main", "lead", "worker", "reader"],
    async execute(args, ctx): Promise<ToolResult> {
      const a = analyzeInput.parse(args);
      if (a.saveTo && ctx.role === "reader") {
        return {
          status: "error",
          error: { code: "INVALID_ARGUMENT", message: "reader 角色不能写入", retryable: false },
        };
      }
      try {
        if (a.saveTo) {
          const target = a.saveTo.path ?? a.path ?? (a.docId ? svc.meta(a.docId)?.path : undefined);
          if (!target) throw new FileOperationError("INVALID_ARGUMENT", "saveTo 写入目标不可用");
          assertToolWriteAccess(target, ctx.workspaceRoot, a.saveTo.path ? "create" : "mutate");
        }
        if (a.right?.docId || a.right?.path)
          svc.editTarget(ctx.workspaceId, ctx.workspaceRoot, a.right);
        for (const source of a.sources ?? [])
          if (source.docId || source.path)
            svc.editTarget(ctx.workspaceId, ctx.workspaceRoot, source);
        if (a.mode === "source_alignment") {
          svc.assertSavedReadOpen(ctx.workspaceId, ctx.workspaceRoot, a);
          for (const source of a.sources ?? [])
            svc.assertSavedReadOpen(
              ctx.workspaceId,
              ctx.workspaceRoot,
              source.path || source.docId ? source : a,
            );
        }
        const doc = await openDoc(svc, ctx, a.docId, a.path);
        const base = {
          docId: doc.docId,
          path: doc.path,
          ...docRevsOf(doc.docId, doc.rev),
          sourceFile: await svc.sourceStatus(doc.docId, ctx.workspaceRoot),
        };
        if (a.mode === "source_alignment") {
          if (a.saveTo || !a.range || !a.alignment || !a.sources?.length)
            throw new Error("source_alignment 只读，需要 range、alignment 和明确 sources");
          const declarations = a.sources.map((s) => {
            if (!s.range) throw new Error("source_alignment 每个来源需要明确 range");
            return { ...s, range: s.range };
          });
          const sources: AlignmentSource[] = [];
          const observed = [
            { doc, status: base.sourceFile, entry: await svc.entry(doc.docId, ctx.workspaceRoot) },
          ];
          const record = (
            d: DocRef,
            sheet: string | undefined,
            range: string,
            headerRow?: number,
          ) => {
            const r = resolveRegion(d, sheet, range);
            const parsed = parseRange(range);
            if (parsed.endRow - 1 !== r.r1 || parsed.endCol - 1 !== r.c1)
              throw new Error("source_alignment 不允许裁剪来源或目标区域");
            ctx.reads.record(
              d.docId,
              [
                { sheetId: r.sheetId, r0: r.r0, r1: r.r1, c0: r.c0, c1: r.c1 },
                ...(headerRow === undefined
                  ? []
                  : [
                      {
                        sheetId: r.sheetId,
                        r0: headerRow - 1,
                        r1: headerRow - 1,
                        c0: r.c0,
                        c1: r.c1,
                      },
                    ]),
              ],
              d.rev,
            );
            base.docRevs[d.docId] = d.rev;
          };
          record(doc, a.sheet, a.range, a.alignment.headerRow);
          for (const s of declarations) {
            svc.assertSavedReadOpen(
              ctx.workspaceId,
              ctx.workspaceRoot,
              s.path || s.docId ? s : { docId: doc.docId },
            );
            const other = s.path || s.docId ? await openDoc(svc, ctx, s.docId, s.path) : doc;
            record(other, s.sheet, s.range);
            sources.push({ ...other, name: s.name, range: s.range, sheet: s.sheet });
            observed.push({
              doc: other,
              status: await svc.sourceStatus(other.docId, ctx.workspaceRoot),
              entry: await svc.entry(other.docId, ctx.workspaceRoot),
            });
          }
          // Re-read disk fingerprints before a synchronous verification pass; actor entry revisions
          // below remain live objects, so awaits above cannot certify a stale snapshot.
          const finalStatuses: Awaited<ReturnType<DocumentService["sourceStatus"]>>[] = [];
          for (const item of observed)
            finalStatuses.push(await svc.sourceStatus(item.doc.docId, ctx.workspaceRoot));
          const verification = verifySourceAlignment({
            target: doc,
            range: a.range,
            sheet: a.sheet,
            sources,
            ...a.alignment,
          });
          const invalid = observed.filter(
            (item, i) =>
              item.entry.meta.rev !== item.doc.rev ||
              item.entry.checkpointRev !== item.doc.rev ||
              item.status.pendingWrite ||
              finalStatuses[i]!.pendingWrite ||
              item.status.calculation !== "no-unpersisted-calculation-observed" ||
              finalStatuses[i]!.calculation !== "no-unpersisted-calculation-observed" ||
              item.entry.computedInMemoryOnly ||
              item.status.currentSha256 !== finalStatuses[i]!.currentSha256 ||
              item.entry.checkpointHash !== finalStatuses[i]!.currentSha256,
          );
          if (invalid.length) {
            verification.status = "unverified";
            verification.unverifiedCount += invalid.length;
            verification.coveredColumns = [];
            verification.uncoveredColumns = [
              ...new Set([...verification.uncoveredColumns, ...a.alignment.requiredColumns]),
            ];
            for (const item of invalid)
              if (verification.failures.length < 100)
                verification.failures.push({
                  targetCell: item.doc.path,
                  ruleIndex: -1,
                  code: "SNAPSHOT_NOT_CURRENT_SAVED_VERSION",
                });
            verification.failuresTruncated =
              verification.failedCount + verification.unverifiedCount >
              verification.failures.length;
          }
          return {
            status: "ok",
            data: {
              ...base,
              mode: a.mode,
              verification,
              versionBindings: observed.map((item, i) => ({
                docId: item.doc.docId,
                path: item.doc.path,
                rev: item.doc.rev,
                sha256: finalStatuses[i]!.currentSha256,
                checkpointRev: item.entry.checkpointRev,
                isCurrentSaved: !invalid.includes(item),
              })),
            },
          };
        }
        if (a.mode === "sort_preflight") {
          if (!a.range) throw new Error("sort_preflight 需要明确 range");
          if (a.saveTo) throw new Error("sort_preflight 只读，不支持 saveTo");
          const parsed = parseRange(a.range);
          if (a.sheet && parsed.sheet && doc.sheet(a.sheet).id !== doc.sheet(parsed.sheet).id)
            throw new Error("sheet 与 range 中的工作表不一致");
          const sheet = doc.sheet(parsed.sheet ?? a.sheet);
          const target = {
            startRow: parsed.startRow - 1,
            endRow: parsed.endRow - 1,
            startColumn: parsed.startCol - 1,
            endColumn: parsed.endCol - 1,
          };
          const preflight = sortPreflight(sheet, target, a.hasHeader);
          const entry = await svc.entry(doc.docId, ctx.workspaceRoot);
          // No awaits below: an actor edit/checkpoint between the earlier reads invalidates this
          // identity, rather than assigning the current revision to an older preserved package.
          const isCurrent =
            entry.meta.id === doc.docId &&
            entry.meta.path === doc.path &&
            entry.meta.rev === doc.rev &&
            entry.checkpointRev === doc.rev &&
            entry.checkpointHash === base.sourceFile.currentSha256 &&
            !base.sourceFile.pendingWrite &&
            !entry.rebased &&
            !entry.external &&
            !entry.readError &&
            !entry.meta.checkpointError;
          const fingerprint = isCurrent
            ? savedSheetFingerprint(entry.imported.preservation?.parts, String(sheet.name))
            : undefined;
          const savedSheet = {
            scope: "worksheet_xml_and_nonworksheet_package_parts",
            status: fingerprint ? "confirmed_checkpoint" : "unavailable",
            sheet: sheet.name,
            checkpointRev: entry.checkpointRev,
            packageSha256: base.sourceFile.currentSha256,
            ...(fingerprint ?? {
              reason:
                "保存包身份、当前检查点或完整工作表部件关系未确认，不据内存快照证明整表原样。",
            }),
          };
          if (fingerprint)
            recordDocumentAccess({
              kind: "package-cache-parse",
              path: doc.path,
              docId: doc.docId,
              rev: doc.rev,
              mode: a.mode,
              packageState: "confirmed_checkpoint",
            });
          ctx.reads.record(
            doc.docId,
            [
              {
                sheetId: sheet.id,
                r0: fingerprint ? 0 : target.startRow,
                r1: fingerprint ? 1048575 : target.endRow,
                c0: fingerprint ? 0 : target.startColumn,
                c1: fingerprint ? 16383 : target.endColumn,
              },
            ],
            doc.rev,
          );
          return {
            status: "ok",
            data: {
              ...base,
              mode: a.mode,
              range: preflight.targetRange,
              sortPreflight: { ...preflight, savedSheet },
            },
          };
        }
        if (a.mode === "diff" || a.mode === "check") {
          if (a.saveTo) throw new Error("saveTo 仅支持 sql 模式");
          const table = loadRegionTable(doc, a.sheet, a.range);
          const record = (d: DocRef, sheet: string | undefined, range: string | undefined) => {
            const r = range ? resolveRegion(d, sheet, range) : wholeSheet(d, sheet);
            ctx.reads.record(
              d.docId,
              [{ sheetId: r.sheetId, r0: r.r0, r1: r.r1, c0: r.c0, c1: r.c1 }],
              d.rev,
            );
            base.docRevs[d.docId] = d.rev;
            return r;
          };
          const leftRegion = record(doc, a.sheet, a.range);
          if (a.mode === "diff") {
            if (!a.right) throw new Error("diff 模式需要 right");
            const right =
              a.right.path || a.right.docId
                ? await openDoc(svc, ctx, a.right.docId, a.right.path)
                : doc;
            const rightRegion = record(right, a.right.sheet, a.right.range);
            const source = (d: DocRef, region: typeof leftRegion) => ({
              docId: d.docId,
              path: d.path,
              sheet: region.sheetName,
              range: formatRange({
                sheet: region.sheetName,
                startRow: region.r0 + 1,
                startCol: region.c0 + 1,
                endRow: region.r1 + 1,
                endCol: region.c1 + 1,
              }),
              headerRow: region.r0 + 1,
            });
            const diff = diffTables(
              table,
              loadRegionTable(right, a.right.sheet, a.right.range),
              a.keys,
              a.offset,
            );
            return {
              status: "ok",
              data: {
                ...base,
                mode: a.mode,
                ...diff,
                left: source(doc, leftRegion),
                right: source(right, rightRegion),
                worksheetRowNumbering: "1-based worksheet rows, includes header",
                changes: diff.changes.map((change) => ({
                  ...change,
                  beforeWorksheetRow:
                    change.beforeRow === null ? null : leftRegion.r0 + 1 + change.beforeRow,
                  afterWorksheetRow:
                    change.afterRow === null ? null : rightRegion.r0 + 1 + change.afterRow,
                })),
              },
            };
          }
          if (!a.checks?.length) throw new Error("check 模式需要 checks");
          const tables = [table];
          for (const src of a.sources ?? []) {
            if (tables.some((t) => t.name.toLowerCase() === src.name.toLowerCase()))
              throw new Error("数据源名称重复");
            const other =
              src.path || src.docId ? await openDoc(svc, ctx, src.docId, src.path) : doc;
            tables.push(loadRegionTable(other, src.sheet, src.range, src.name));
            record(other, src.sheet, src.range);
          }
          return {
            status: "ok",
            data: { ...base, mode: a.mode, ...(await checkTables(tables, a.checks, ctx.signal)) },
          };
        }
        if (a.mode === "sql") {
          if (a.sql === undefined) throw new Error("sql 模式需要 sql 参数");
          const sql = normalizeSql(a.sql);
          const bad = checkSql(sql);
          if (bad !== undefined) {
            return {
              status: "error",
              error: { code: "INVALID_ARGUMENT", message: bad, field: "sql", retryable: false },
            };
          }
          {
            const tables = [loadRegionTable(doc, a.sheet, a.range)];
            const record = async (
              d: DocRef,
              sheet: string | undefined,
              range: string | undefined,
              name: string,
            ) => {
              const r = range ? resolveRegion(d, sheet, range) : wholeSheet(d, sheet);
              ctx.reads.record(
                d.docId,
                [{ sheetId: r.sheetId, r0: r.r0, r1: r.r1, c0: r.c0, c1: r.c1 }],
                d.rev,
              );
              return {
                name,
                docId: d.docId,
                path: d.path,
                rev: d.rev,
                sheet: r.sheetName,
                range: formatRange({
                  sheet: r.sheetName,
                  startRow: r.r0 + 1,
                  endRow: r.r1 + 1,
                  startCol: r.c0 + 1,
                  endCol: r.c1 + 1,
                }),
                sourceFile:
                  d.docId === doc.docId
                    ? base.sourceFile
                    : await svc.sourceStatus(d.docId, ctx.workspaceRoot),
              };
            };
            const sources = [await record(doc, a.sheet, a.range, WORKBOOK_ANALYZE_SQL_TABLE)];
            for (const source of a.sources ?? []) {
              if (
                tables.some((t) => t.name.toLowerCase() === source.name.toLowerCase()) ||
                source.name.toLowerCase().startsWith("sqlite_")
              )
                throw new FileOperationError(
                  "INVALID_ARGUMENT",
                  "SQL 数据源名称重复或使用保留名称",
                );
              const other =
                source.docId || source.path
                  ? await openDoc(svc, ctx, source.docId, source.path)
                  : doc;
              tables.push(loadRegionTable(other, source.sheet, source.range, source.name));
              base.docRevs[other.docId] = other.rev;
              sources.push(await record(other, source.sheet, source.range, source.name));
            }
            if (tables.reduce((sum, t) => sum + t.rows.length * t.columns.length, 0) > 400000)
              throw new FileOperationError("LIMIT_EXCEEDED", "SQL 全部输入合计最多40万格");
            const { rows: all, columns: resultColumns } = await runSql(
              tables,
              sql.trim().replace(/;\s*$/, ""),
              ctx.signal,
            );
            let saved: unknown;
            if (a.saveTo) {
              const values = [
                resultColumns,
                ...all.map((r) =>
                  Object.values(r).map((v) =>
                    v === null
                      ? null
                      : typeof v === "number" || typeof v === "boolean" || typeof v === "string"
                        ? v
                        : String(v),
                  ),
                ),
              ];
              if (!values[0]?.length)
                throw new FileOperationError("INVALID_ARGUMENT", "空查询没有结果列，无法保存");
              if (values.length * (values[0]?.length ?? 0) > 200000)
                throw new FileOperationError("LIMIT_EXCEEDED", "saveTo 最多 20 万格");
              if (a.saveTo.path) {
                const savedRange = `A1:${indexToCol(values[0]!.length)}${values.length}`;
                const snap: IWorkbookData = {
                  id: "analysis",
                  name: a.saveTo.path,
                  appVersion: "1.0.2",
                  locale: "zh-CN" as never,
                  styles: {},
                  sheetOrder: ["s0"],
                  sheets: {
                    s0: {
                      id: "s0",
                      name: a.saveTo.sheet,
                      rowCount: values.length,
                      columnCount: values[0]?.length ?? 1,
                      cellData: Object.fromEntries(
                        values.map((row, r) => [
                          r,
                          Object.fromEntries(
                            row.map((v, c) => [
                              c,
                              { v, t: typeof v === "number" ? 1 : typeof v === "boolean" ? 3 : 2 },
                            ]),
                          ),
                        ]),
                      ),
                    },
                  },
                };
                const publication = await publishNew(svc, ctx, a.saveTo.path, snap);
                if (publication.status !== "ok") return publication;
                saved = {
                  ...(publication.data as Record<string, unknown>),
                  sheet: a.saveTo.sheet,
                  range: savedRange,
                };
              } else {
                const result = await svc.submit(doc.docId, ctx.workspaceRoot, {
                  baseRev: doc.rev,
                  source: { kind: "agent", id: `${ctx.sessionId}/${ctx.agentId}` },
                  sessionId: ctx.sessionId,
                  toolCallId: ctx.toolCallId,
                  ops: [
                    { op: "sheet.add", name: a.saveTo.sheet },
                    {
                      op: "cells.set",
                      range: `'${a.saveTo.sheet.replaceAll("'", "''")}'!A1`,
                      values,
                    },
                  ],
                });
                if (!result.ok)
                  return {
                    status: "error",
                    error: {
                      code: toToolErrorCode(result.code),
                      message: result.message,
                      retryable: false,
                    },
                  };
                saved = {
                  docId: doc.docId,
                  rev: result.rev,
                  ...(result.backupPath ? { backupPath: result.backupPath } : {}),
                };
              }
            }
            return {
              status: "ok",
              data: {
                ...base,
                ...(saved ? { saved } : {}),
                mode: "sql",
                sql: sql.trim().replace(/;\s*$/, ""),
                sources,
                columns: resultColumns,
                rows: all.slice(0, SQL_PREVIEW_ROWS).map((r) => Object.values(r)),
                rowCount: all.length,
                truncated: all.length > SQL_PREVIEW_ROWS,
              },
            };
          }
        }
        // profile
        if (a.saveTo) throw new FileOperationError("INVALID_ARGUMENT", "saveTo 仅支持 sql 模式");
        const profile = profileRegion(doc, a.sheet, a.range);
        const region = a.range ? resolveRegion(doc, a.sheet, a.range) : wholeSheet(doc, a.sheet);
        ctx.reads.record(
          doc.docId,
          [
            {
              sheetId: region.sheetId,
              r0: region.r0,
              r1: region.r1,
              c0: region.c0,
              c1: region.c1,
            },
          ],
          doc.rev,
        );
        return {
          status: "ok",
          data: {
            ...base,
            mode: "profile",
            ...profile,
            sources: [
              {
                docId: doc.docId,
                path: doc.path,
                rev: doc.rev,
                sheet: profile.sheet,
                range: profile.range,
                sourceFile: base.sourceFile,
              },
            ],
          },
        };
      } catch (e) {
        if (e instanceof DocNotFoundError) {
          return {
            status: "error",
            error: { code: "NOT_FOUND", message: e.message, retryable: false },
          };
        }
        // 未带码的异常多为 SQL 语法/缺参数，按参数问题报告让模型修正
        return {
          status: "error",
          error: {
            code: codeOf(e, "INVALID_ARGUMENT"),
            message: e instanceof Error ? e.message : String(e),
            retryable: false,
          },
        };
      }
    },
  };

  return [workbookRead, workbookAnalyze, workbookEditTool(svc), workbookExportTool(svc)];
}
