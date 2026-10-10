import { FileOperationError } from "@excelmanus/kernel";
import { publishNew, workbookExportTool } from "./export.ts";

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
import { objectsOf, preservedMetadata } from "./objects.ts";
import { CF_RESOURCE, DV_RESOURCE, rulesResource } from "./rule-codec.ts";
import { DocNotFoundError, type DocumentService } from "./service.ts";
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
  let id: string;
  if (docId !== undefined) {
    id = (await svc.entry(docId, ctx.workspaceRoot)).meta.id;
  } else if (path !== undefined) {
    id = (await svc.open(ctx.workspaceId, ctx.workspaceRoot, path)).meta.id;
  } else {
    throw new Error("缺少 docId 或 path");
  }
  const { meta, snapshot } = await svc.snapshot(id, ctx.workspaceRoot);
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
      if (!s) throw new Error(`工作表不存在：${idOrName ?? "(默认)"}`);
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
  const out: Record<string, unknown> = {};
  const wantValues = facets.includes("values");
  const wantFormulas = facets.includes("formulas");
  const values: unknown[][] = [];
  const formulas: (string | null)[][] = [];
  const styles: unknown[][] = [];
  if (region.c1 - region.c0 + 1 > MAX_CELLS)
    throw new Error("单次读取区域最多2000列，请拆分列范围读取");
  let cells = 0;
  let chars = 0;
  let consumedRows = 0;
  let truncated = false;

  for (let r = region.r0 + offset; r <= region.r1; r++) {
    if (consumedRows > 0 && (cells + region.c1 - region.c0 + 1 > MAX_CELLS || chars >= MAX_CHARS)) {
      truncated = true;
      break;
    }
    const vRow: unknown[] = [];
    const sRow: unknown[] = [];
    const fRow: (string | null)[] = [];
    const rowCells = sheet.cellData?.[r] as Record<number, ICellData> | undefined;

    for (let c = region.c0; c <= region.c1; c++) {
      const cell = rowCells?.[c];
      if (wantValues) {
        vRow.push(cell?.v ?? "");
        chars += cellText(cell?.v).length;
      }
      if (wantFormulas) {
        const f = typeof cell?.f === "string" ? cell.f : null;
        fRow.push(f);
        if (f !== null) chars += f.length;
      }
      cells += 1;
      if (facets.includes("styles")) {
        const style =
          typeof cell?.s === "string"
            ? snapshot.styles?.[cell.s]
            : (cell?.s ?? snapshot.styles?.s0);
        sRow.push(style ?? null);
        chars += JSON.stringify(style ?? null).length;
      }
    }
    if (wantValues) values.push(vRow);
    if (wantFormulas) formulas.push(fRow);
    if (facets.includes("styles")) styles.push(sRow);
    consumedRows += 1;
  }
  if (wantValues) out.values = values;
  if (wantFormulas) out.formulas = formulas;
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
    out.layout = {
      freeze: sheet.freeze ?? { xSplit: 0, ySplit: 0, startRow: 0, startColumn: 0 },
      merges,
      columnWidths,
      rowHeights,
      rows: Object.fromEntries(
        Object.entries(sheet.rowData ?? {}).filter(
          ([index]) => Number(index) >= region.r0 && Number(index) <= region.r1,
        ),
      ),
      filter: rulesResource(snapshot, "SHEET_FILTER_PLUGIN")[region.sheetId] ?? null,
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

const FORBIDDEN_SQL =
  /\b(attach|detach|pragma|vacuum|reindex|insert|update|delete|drop|alter|create|replace|truncate)\b/i;

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
    for (let r = r0 + 1; r <= r1; r++) {
      const v = sheet.cellData?.[r]?.[c]?.v;
      if (v === undefined || v === null || v === "") continue;
      nonNull += 1;
      const s = String(v);
      if (distinct.size < 10000) distinct.add(s);
      if (freq.size < 500 || freq.has(s)) freq.set(s, (freq.get(s) ?? 0) + 1);
      if (typeof v === "number") {
        numeric += 1;
        sum += v;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    const type =
      nonNull === 0 ? "empty" : numeric === nonNull ? "number" : numeric === 0 ? "string" : "mixed";
    cols.push({
      name,
      column: indexToCol(c + 1),
      type,
      nonNull,
      distinct: distinct.size,
      ...(numeric > 0 ? { min, max, mean: sum / numeric, sum } : {}),
      top: [...freq.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, PROFILE_TOP)
        .map(([v, count]) => ({ v, count })),
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
  mode: z.enum(["overview", "range", "search", "objects", "table", "formula_graph"]),
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
  mode: z.enum(["sql", "profile", "diff", "check"]),
  right: z
    .object({
      path: z.string().optional(),
      docId: z.string().optional(),
      sheet: z.string().optional(),
      range: z.string().optional(),
    })
    .optional(),
  keys: z.array(z.string()).max(20).optional(),
  checks: z.array(CheckRule).min(1).max(20).optional(),
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
      "读取 xlsx/csv 工作簿快照。mode=overview 返回表清单与规模；mode=range 返回指定区域（facets: values|formulas|styles|layout|rules，紧凑行数组，超 2000 格或 16000 字符截断并返回 nextOffset）；mode=search 按子串搜索单元格。mode=table 将 range 首行作为表头返回对象行；mode=formula_graph 返回 range 的静态前驱和下游依赖，depth=1–5，并标明无法解析的动态/外部引用。mode=objects 返回图表和图片元数据，指定 imageId 提取该图片给视觉模型。输入 docId 或工作区相对 path。",
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
        const doc = await openDoc(svc, ctx, a.docId, a.path);
        const base = { docId: doc.docId, path: doc.path, ...docRevsOf(doc.docId, doc.rev) };
        const objectMetadata = Object.entries(doc.sheets).map(([sheetId, sheet]) => {
          const objects = objectsOf(sheet);
          return {
            sheetId,
            sheet: sheet.name,
            charts: objects.charts,
            images: objects.images.map(({ data: _data, ...metadata }) => metadata),
          };
        });
        const preserved = () =>
          svc
            .entry(doc.docId, ctx.workspaceRoot)
            .then((e) => preservedMetadata(e.imported.preservation?.parts ?? {}));
        if (a.mode === "objects") {
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
              data: { ...base, objects: objectMetadata, preserved: await preserved() },
              images: [{ mediaType: image.mediaType, data }],
            };
          }
          return {
            status: "ok",
            data: { ...base, objects: objectMetadata, preserved: await preserved() },
          };
        }
        if (a.mode === "overview") {
          const e = await svc.entry(doc.docId, ctx.workspaceRoot);
          const snapshot = (await svc.snapshot(doc.docId, ctx.workspaceRoot)).snapshot;
          return {
            status: "ok",
            data: {
              ...base,
              mode: "overview",
              name: doc.name,
              sheets: workbookSheets({ sheetOrder: doc.sheetOrder, sheets: doc.sheets }),
              unsupported: e.imported.unsupported,
              conditionalFormats: rulesResource(snapshot, CF_RESOURCE),
              dataValidations: rulesResource(snapshot, DV_RESOURCE),
              objects: objectMetadata,
              preserved: await preserved(),
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
              range: formatRange({
                sheet: region.sheetName,
                startRow: region.r0 + 1,
                startCol: region.c0 + 1,
                endRow: region.r1 + 1,
                endCol: region.c1 + 1,
              }),
              ...out,
              truncated,
              ...(truncated ? { nextOffset: (a.offset ?? 0) + Math.max(1, consumedRows) } : {}),
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
    description: `对工作簿区域做分析。mode=sql 把指定工作表/区域（首行为表头）注册为 SQLite 的 ${WORKBOOK_ANALYZE_SQL_TABLE} 表并执行只读 SELECT/WITH 查询（也兼容 ${WORKBOOK_ANALYZE_SQL_SHEET_PLACEHOLDER} 作为 ${WORKBOOK_ANALYZE_SQL_TABLE} 的占位符），可传 sources:[{name,path,docId,sheet,range}] 加载其他文件/工作表，以 name 作为 SQL 表名做 JOIN/UNION；每源20万格、合计40万格、查询10秒上限。预览 ≤200 行；mode=profile 返回每列的类型/非空数/去重数/min/max/mean/top 值；mode=diff 用 right 指定另一区域，可按 keys 组合键或位置比较；mode=check 用 checks 校验 required/unique/range/pattern/foreign_key/row_expression/cell/total/formula_errors，cell.row 为不含表头的1基明细行。输入 docId 或工作区相对 path。`,
    input: analyzeInput,
    output: z.record(z.string(), z.unknown()),
    effect: (a: z.infer<typeof analyzeInput> | null) => (a?.saveTo ? "write" : "read"),
    targets: (a) => {
      const q = analyzeInput.parse(a);
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
        const doc = await openDoc(svc, ctx, a.docId, a.path);
        const base = { docId: doc.docId, path: doc.path, ...docRevsOf(doc.docId, doc.rev) };
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
          };
          record(doc, a.sheet, a.range);
          if (a.mode === "diff") {
            if (!a.right) throw new Error("diff 模式需要 right");
            const right =
              a.right.path || a.right.docId
                ? await openDoc(svc, ctx, a.right.docId, a.right.path)
                : doc;
            record(right, a.right.sheet, a.right.range);
            return {
              status: "ok",
              data: {
                ...base,
                mode: a.mode,
                ...diffTables(
                  table,
                  loadRegionTable(right, a.right.sheet, a.right.range),
                  a.keys,
                  a.offset,
                ),
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
            const record = (d: DocRef, sheet: string | undefined, range: string | undefined) => {
              const r = range ? resolveRegion(d, sheet, range) : wholeSheet(d, sheet);
              ctx.reads.record(
                d.docId,
                [{ sheetId: r.sheetId, r0: r.r0, r1: r.r1, c0: r.c0, c1: r.c1 }],
                d.rev,
              );
            };
            record(doc, a.sheet, a.range);
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
              record(other, source.sheet, source.range);
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
                saved = await publishNew(svc, ctx, a.saveTo.path, snap);
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
        return {
          status: "ok",
          data: { ...base, mode: "profile", ...profileRegion(doc, a.sheet, a.range) },
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
