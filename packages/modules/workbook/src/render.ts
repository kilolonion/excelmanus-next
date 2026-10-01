// workbook_render（06 §4.4、07 §8）：把活文档某修订的区域排成版式（行高列宽、合并、
// 常用样式），交给装配层注入的渲染端画成 PNG，作为视觉输入返回。

import { formatRange, indexToCol, parseRange } from "@excelmanus/core";
import type { ToolDefinition } from "@excelmanus/kernel";
import type { RenderLayout, ToolResult } from "@excelmanus/protocol";
import type { ICellData, IWorkbookData, IWorksheetData } from "@univerjs/core";
import { z } from "zod";
import type { DocumentService } from "./service.ts";

const MAX_ROWS = 80;
const MAX_COLS = 30;
const DEFAULT_COL_W = 88;
const DEFAULT_ROW_H = 24;
const HEAD_W = 44;
const HEAD_H = 22;

type Style = {
  bl?: number;
  it?: number;
  fs?: number;
  cl?: { rgb?: string | null } | null;
  bg?: { rgb?: string | null } | null;
  ht?: number | null;
  n?: { pattern?: string } | null;
};

function styleOf(snapshot: IWorkbookData, cell: ICellData | undefined): Style {
  const s = cell?.s;
  if (typeof s === "string") return (snapshot.styles?.[s] ?? {}) as Style;
  return (s ?? {}) as Style;
}

/** 数字格式的最常见部分：小数位与千分位、百分比；其余原样显示。 */
export function displayText(v: unknown, pattern: string | undefined): string {
  if (v === undefined || v === null) return "";
  if (typeof v !== "number" || !pattern || pattern === "General") return String(v);
  // 日期/时间格式：Excel 序列号（1900 日期系统）→ 按格式码中的 y/m/d/h/m/s 组装
  const bare = pattern.replace(/"[^"]*"|\[[^\]]*\]|\\./g, "");
  if (/[yd]/i.test(bare) || /h/i.test(bare)) {
    const ms = Math.round((v - 25569) * 86400_000);
    const d = new Date(ms);
    const p2 = (n: number) => String(n).padStart(2, "0");
    const date = `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
    const time = `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}${/s/i.test(bare) ? `:${p2(d.getUTCSeconds())}` : ""}`;
    const hasDate = /[yd]/i.test(bare);
    const hasTime = /h/i.test(bare);
    return hasDate && hasTime ? `${date} ${time}` : hasDate ? date : time;
  }
  const pct = pattern.includes("%");
  const dec = /0\.(0+)/.exec(pattern)?.[1]?.length ?? 0;
  const n = pct ? v * 100 : v;
  const s = n.toLocaleString("en-US", {
    minimumFractionDigits: dec,
    maximumFractionDigits: dec,
    useGrouping: pattern.includes(","),
  });
  return pct ? `${s}%` : s;
}

export interface LayoutResult {
  layout: RenderLayout;
  range: string;
  /** 行列 ↔ 像素映射：每列左边界 x 与每行上边界 y（CSS 像素，含表头偏移）。 */
  columns: { col: string; x: number; w: number }[];
  rows: { row: number; y: number; h: number }[];
  limitations: string[];
}

export function buildLayout(
  snapshot: IWorkbookData,
  sheet: IWorksheetData,
  rangeText: string | undefined,
): LayoutResult {
  const parsed = rangeText
    ? parseRange(rangeText)
    : {
        startRow: 1,
        startCol: 1,
        endRow: Math.min(sheet.rowCount, 30),
        endCol: Math.min(sheet.columnCount, 12),
      };
  const r0 = parsed.startRow - 1;
  const c0 = parsed.startCol - 1;
  const r1 = Math.min(parsed.endRow - 1, r0 + MAX_ROWS - 1, sheet.rowCount - 1);
  const c1 = Math.min(parsed.endCol - 1, c0 + MAX_COLS - 1, sheet.columnCount - 1);
  const limitations = [
    "条件格式、边框、图表与图片未渲染（图表显示为占位说明）",
    "字体按系统默认字体近似",
  ];
  if (parsed.endRow - 1 > r1 || parsed.endCol - 1 > c1)
    limitations.unshift(`区域过大，只渲染前 ${MAX_ROWS} 行 × ${MAX_COLS} 列`);

  const colData = (sheet.columnData ?? {}) as Record<number, { w?: number; hd?: number }>;
  const rowData = (sheet.rowData ?? {}) as Record<number, { h?: number; hd?: number }>;
  const columns: LayoutResult["columns"] = [];
  let x = HEAD_W;
  for (let c = c0; c <= c1; c++) {
    const w = colData[c]?.hd ? 0 : Math.round(colData[c]?.w ?? DEFAULT_COL_W);
    columns.push({ col: indexToCol(c + 1), x, w });
    x += w;
  }
  const rows: LayoutResult["rows"] = [];
  let y = HEAD_H;
  for (let r = r0; r <= r1; r++) {
    const h = rowData[r]?.hd ? 0 : Math.round(rowData[r]?.h ?? DEFAULT_ROW_H);
    rows.push({ row: r + 1, y, h });
    y += h;
  }

  const cells: RenderLayout["cells"] = [];
  for (const col of columns) {
    if (col.w > 0)
      cells.push({
        x: col.x,
        y: 0,
        w: col.w,
        h: HEAD_H,
        text: col.col,
        header: true,
        align: "center",
      });
  }
  for (const row of rows) {
    if (row.h > 0)
      cells.push({
        x: 0,
        y: row.y,
        w: HEAD_W,
        h: row.h,
        text: String(row.row),
        header: true,
        align: "center",
      });
  }

  const merges = (sheet.mergeData ?? []) as {
    startRow: number;
    startColumn: number;
    endRow: number;
    endColumn: number;
  }[];
  const covered = new Set<string>();
  const mergeAt = new Map<string, { endRow: number; endColumn: number }>();
  for (const m of merges) {
    mergeAt.set(`${m.startRow},${m.startColumn}`, m);
    for (let r = m.startRow; r <= m.endRow; r++)
      for (let c = m.startColumn; c <= m.endColumn; c++)
        if (r !== m.startRow || c !== m.startColumn) covered.add(`${r},${c}`);
  }
  const cellData = (sheet.cellData ?? {}) as Record<number, Record<number, ICellData>>;
  for (let r = r0; r <= r1; r++) {
    const row = rows[r - r0];
    if (!row || row.h === 0) continue;
    for (let c = c0; c <= c1; c++) {
      const col = columns[c - c0];
      if (!col || col.w === 0 || covered.has(`${r},${c}`)) continue;
      const cell = cellData[r]?.[c];
      const st = styleOf(snapshot, cell);
      const text = displayText(cell?.v, st.n?.pattern ?? undefined);
      const fill = st.bg?.rgb ?? undefined;
      if (text === "" && !fill && !mergeAt.has(`${r},${c}`)) continue;
      const m = mergeAt.get(`${r},${c}`);
      const endR = m ? Math.min(m.endRow, r1) : r;
      const endC = m ? Math.min(m.endColumn, c1) : c;
      const w = columns.slice(c - c0, endC - c0 + 1).reduce((a, x2) => a + x2.w, 0);
      const h = rows.slice(r - r0, endR - r0 + 1).reduce((a, y2) => a + y2.h, 0);
      const ht = st.ht ?? (typeof cell?.v === "number" ? 3 : 1);
      cells.push({
        x: col.x,
        y: row.y,
        w,
        h,
        text,
        ...(st.bl === 1 ? { bold: true } : {}),
        ...(st.it === 1 ? { italic: true } : {}),
        ...(st.cl?.rgb ? { color: st.cl.rgb } : {}),
        ...(fill ? { fill } : {}),
        ...(st.fs ? { fontSize: st.fs } : {}),
        align: ht === 2 ? "center" : ht === 3 ? "right" : "left",
      });
    }
  }
  return {
    layout: { width: x, height: y, cells },
    range: formatRange({
      sheet: sheet.name,
      startRow: r0 + 1,
      startCol: c0 + 1,
      endRow: r1 + 1,
      endCol: c1 + 1,
    }),
    columns,
    rows,
    limitations,
  };
}

const RenderInput = z.strictObject({
  path: z.string().optional().describe("工作区相对路径（与 docId 二选一）"),
  docId: z.string().optional(),
  sheet: z.string().optional().describe("工作表名；range 中带表名时可省略"),
  range: z.string().optional().describe("A1 区域，如 A1:H30；省略时渲染左上角 30 行 × 12 列"),
  rev: z.int().nonnegative().optional().describe("修订号；只能是当前修订（历史修订渲染未支持）"),
});

export function workbookRenderTool(
  svc: DocumentService,
  render: (layout: RenderLayout) => Promise<string>,
): ToolDefinition<z.infer<typeof RenderInput>> {
  return {
    name: "workbook_render",
    title: "渲染截图",
    description:
      "把工作簿区域渲染成图片作为视觉输入，用于核对版式或与原始截图对照。返回图片、渲染所用修订号、行列与像素的对应关系和渲染限制。单次最多 80 行 × 30 列。",
    input: RenderInput,
    output: z.record(z.string(), z.unknown()),
    effect: "read",
    requiresVision: true,
    targets: (a) => (a.path ? [a.path] : []),
    replay: "safe",
    timeoutMs: 30_000,
    roles: ["main", "lead", "worker", "reader"],
    async execute(args, ctx): Promise<ToolResult> {
      const fail = (code: string, message: string): ToolResult => ({
        status: "error",
        error: { code, message, retryable: false },
      });
      let docId = args.docId;
      if (!docId) {
        if (!args.path) return fail("INVALID_ARGUMENT", "缺少 path 或 docId");
        docId = (await svc.open(ctx.workspaceId, ctx.workspaceRoot, args.path)).meta.id;
      }
      const { meta, snapshot } = await svc.snapshot(docId, ctx.workspaceRoot);
      if (args.rev !== undefined && args.rev !== meta.rev)
        return fail("UNSUPPORTED_FEATURE", `只能渲染当前修订 rev${meta.rev}`);
      const sheets = snapshot.sheets as Record<string, IWorksheetData>;
      const sheetName = args.range ? (parseRange(args.range).sheet ?? args.sheet) : args.sheet;
      const sheet = sheetName
        ? Object.values(sheets).find((s) => s.name === sheetName || s.id === sheetName)
        : sheets[snapshot.sheetOrder[0] ?? ""];
      if (!sheet) return fail("NOT_FOUND", `工作表不存在：${sheetName ?? "(默认)"}`);
      const out = buildLayout(snapshot, sheet, args.range);
      let png: string;
      try {
        png = await render(out.layout);
      } catch (e) {
        return fail("UNSUPPORTED_FEATURE", e instanceof Error ? e.message : String(e));
      }
      return {
        status: "ok",
        data: {
          docId,
          path: meta.path,
          sheet: sheet.name,
          range: out.range,
          rev: meta.rev,
          size: { width: out.layout.width, height: out.layout.height },
          columns: out.columns,
          rows: out.rows,
          limitations: out.limitations,
        },
        docRevs: { [docId]: meta.rev },
        images: [{ mediaType: "image/png", data: png }],
      };
    },
  };
}
