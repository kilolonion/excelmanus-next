// workbook_render（06 §4.4、07 §8）：把活文档某修订的区域排成版式（行高列宽、合并、
// 常用样式），交给装配层注入的渲染端画成 PNG，作为视觉输入返回。

import { formatRange, indexToCol, parseRange } from "@excelmanus/core";
import type { ToolDefinition } from "@excelmanus/kernel";
import type { RenderLayout, ToolResult } from "@excelmanus/protocol";
import { type ICellData, type IWorkbookData, type IWorksheetData, numfmt } from "@univerjs/core";
import { SSF } from "xlsx";
import { z } from "zod";
import { materializeArrays } from "./array-formulas.ts";
import { FILTER_RESOURCE } from "./filter-links.ts";
import { objectsOf } from "./objects.ts";
import { conditionalPaint } from "./render-conditions.ts";
import { rulesResource } from "./rule-codec.ts";
import type { DocumentService } from "./service.ts";

// The shared canvas painter accepts hex colors, while numfmt returns names for
// Excel's eight named colors and hex strings for indexed colors.
const NUMBER_COLORS: Record<string, string> = {
  black: "#000000",
  blue: "#0000ff",
  cyan: "#00ffff",
  green: "#008000",
  magenta: "#ff00ff",
  red: "#ff0000",
  white: "#ffffff",
  yellow: "#ffff00",
};
const MAX_ROWS = 80;
const MAX_COLS = 30;
const DEFAULT_COL_W = 88;
const DEFAULT_ROW_H = 24;
const HEAD_W = 44;
const HEAD_H = 22;

type Style = {
  bd?: Partial<
    Record<"t" | "b" | "l" | "r" | "tl_br" | "bl_tr", { s: number; cl?: { rgb?: string } }>
  >;
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

/** Use the installed Excel number-format engine; formatting never changes stored values. */
export function displayText(
  v: unknown,
  pattern: string | undefined,
  unsupported?: () => void,
): string {
  if (v === undefined || v === null) return "";
  if (typeof v !== "number" || !pattern || pattern === "General") return String(v);
  try {
    // Excel/Univer accept a bare yen symbol; SSF requires it quoted. Preserve
    // already quoted, escaped, locale and spacing tokens without rewriting them.
    const compatible = pattern.replace(/"[^"]*"|\[[^\]]*\]|\\.|_.|\*.|¥/g, (token) =>
      token === "¥" ? '"¥"' : token,
    );
    return SSF.format(compatible, v);
  } catch {
    unsupported?.();
    return String(v);
  }
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
  // Formula spill values live in the calculation resource, not authored cellData.
  snapshot = materializeArrays(snapshot);
  sheet = (snapshot.sheets[sheet.id] ?? sheet) as IWorksheetData;
  const parsed = rangeText
    ? parseRange(rangeText)
    : {
        startRow: 1,
        startCol: 1,
        endRow: 30,
        endCol: 12,
      };
  const r0 = parsed.startRow - 1;
  const c0 = parsed.startCol - 1;
  const r1 = Math.min(parsed.endRow - 1, r0 + MAX_ROWS - 1);
  const c1 = Math.min(parsed.endCol - 1, c0 + MAX_COLS - 1);
  const limitations = [
    "图表采用当前单元格数值重绘，Excel 特殊图表样式、3D 与旋转裁剪未支持；GIF 取首帧",
    "矩形、椭圆与右箭头按基本填色、边线和纯文本绘制；文本排版、右箭头比例与跨类型对象叠放顺序为近似",
    "复杂形状、组合、旋转与富文本未渲染或不保真，截图未显示不代表源文件不存在；源文件的未编辑内容仍保留",
    "图标集使用对应类别的近似矢量图标；字体与复杂数字格式非像素级 Excel 保真",
    "字体按系统默认字体近似",
  ];
  if (parsed.endRow - 1 > r1 || parsed.endCol - 1 > c1)
    limitations.unshift(`区域过大，只渲染前 ${MAX_ROWS} 行 × ${MAX_COLS} 列`);

  const colData = (sheet.columnData ?? {}) as Record<number, { w?: number; hd?: number }>;
  const defaultColW = Math.round(sheet.defaultColumnWidth ?? DEFAULT_COL_W);
  const defaultRowH = Math.round(sheet.defaultRowHeight ?? DEFAULT_ROW_H);
  const rowData = structuredClone(sheet.rowData ?? {}) as Record<
    number,
    { h?: number; hd?: number }
  >;
  // Filter-hidden rows live in the filter resource, not in manual rowData visibility.
  const filter = (
    rulesResource(snapshot, FILTER_RESOURCE) as Record<string, { cachedFilteredOut?: number[] }>
  )[sheet.id ?? ""];
  for (const row of filter?.cachedFilteredOut ?? []) rowData[row] = { ...rowData[row], hd: 1 };
  const columns: LayoutResult["columns"] = [];
  let x = HEAD_W;
  for (let c = c0; c <= c1; c++) {
    const w = colData[c]?.hd ? 0 : Math.round(colData[c]?.w ?? defaultColW);
    columns.push({ col: indexToCol(c + 1), x, w });
    x += w;
  }
  const rows: LayoutResult["rows"] = [];
  let y = HEAD_H;
  for (let r = r0; r <= r1; r++) {
    const h = rowData[r]?.hd ? 0 : Math.round(rowData[r]?.h ?? defaultRowH);
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
  const condition = conditionalPaint(snapshot, sheet, limitations);
  const cellData = (sheet.cellData ?? {}) as Record<number, Record<number, ICellData>>;
  for (let r = r0; r <= r1; r++) {
    const row = rows[r - r0];
    if (!row || row.h === 0) continue;
    for (let c = c0; c <= c1; c++) {
      const col = columns[c - c0];
      if (!col || col.w === 0 || covered.has(`${r},${c}`)) continue;
      const cell = cellData[r]?.[c];
      const visual = condition(r, c, cell?.v);
      const st = { ...styleOf(snapshot, cell), ...visual.style } as Style;
      const text = visual.hideValue
        ? ""
        : displayText(cell?.v, st.n?.pattern ?? undefined, () => {
            const note = "部分数字格式无法解析，截图显示原始值；工作簿的格式码与数值保持不变";
            if (!limitations.includes(note)) limitations.push(note);
          });
      const fill = st.bg?.rgb ?? undefined;
      let color = st.cl?.rgb;
      if (typeof cell?.v === "number" && st.n?.pattern && !visual.style?.cl) {
        try {
          const formattedColor = numfmt.formatColor(st.n.pattern, cell.v);
          if (typeof formattedColor === "string")
            color = NUMBER_COLORS[formattedColor.toLowerCase()] ?? formattedColor;
        } catch {
          // Invalid formats already fall back to the raw value above.
        }
      }

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
        ...(color ? { color } : {}),
        ...(fill ? { fill } : {}),
        ...(st.fs ? { fontSize: st.fs } : {}),
        ...(st.bd
          ? {
              borders: Object.fromEntries(
                Object.entries(st.bd)
                  .filter(([, v]) => v && v.s >= 0 && v.s <= 13)
                  .map(([k, v]) => [k, { style: v!.s, color: v!.cl?.rgb ?? "#000000" }]),
              ),
            }
          : {}),
        ...(visual.dataBar ? { dataBar: visual.dataBar } : {}),
        ...(visual.icon ? { icon: visual.icon } : {}),
        align: ht === 2 ? "center" : ht === 3 ? "right" : "left",
      });
    }
  }
  const objects = objectsOf(sheet);
  const offset = (
    index: number,
    start: number,
    data: Record<number, { hd?: number; w?: number; h?: number }>,
    fallback: number,
    key: "w" | "h",
  ) => {
    // Sparse dimensions avoid walking a million default-sized rows for distant anchors.
    let sum = (index - start) * fallback;
    for (const [raw, d] of Object.entries(data)) {
      const i = Number(raw);
      if (i >= Math.min(index, start) && i < Math.max(index, start))
        sum += (index >= start ? 1 : -1) * ((d.hd ? 0 : Math.round(d[key] ?? fallback)) - fallback);
    }
    return sum;
  };
  const position = (o: {
    anchor: string;
    width: number;
    height: number;
    offsetX?: number;
    offsetY?: number;
  }) => {
    const a = parseRange(o.anchor);
    return {
      x: HEAD_W + offset(a.startCol - 1, c0, colData, defaultColW, "w") + (o.offsetX ?? 0),
      y: HEAD_H + offset(a.startRow - 1, r0, rowData, defaultRowH, "h") + (o.offsetY ?? 0),
      w: o.width,
      h: o.height,
    };
  };
  const visible = (p: { x: number; y: number; w: number; h: number }) =>
    p.x < x && p.y < y && p.x + p.w > HEAD_W && p.y + p.h > HEAD_H;
  const charts: NonNullable<RenderLayout["charts"]> = [];
  for (const chart of objects.charts) {
    const p = position(chart);
    if (!visible(p)) continue;
    const range = parseRange(chart.range);
    if (range.endRow - range.startRow > 10000 || range.endCol - range.startCol > 32) {
      limitations.push(`图表 ${chart.title} 数据区域超限，未渲染`);
      continue;
    }
    if (range.sheet && range.sheet !== sheet.name) {
      limitations.push(`图表 ${chart.title} 跨表来源未渲染`);
      continue;
    }
    const values: NonNullable<RenderLayout["charts"]>[number]["cells"] = {};
    for (let r = range.startRow - 1; r < range.endRow; r++)
      for (let c = range.startCol - 1; c < range.endCol; c++) {
        const v = cellData[r]?.[c]?.v;
        if (v !== undefined) {
          values[r] ??= {};
          values[r]![c] = { v };
        }
      }
    charts.push({ ...p, chart, cells: values });
  }
  const images: NonNullable<RenderLayout["images"]> = [];
  for (const image of objects.images) {
    const p = position(image);
    if (!visible(p)) continue;
    if (image.data) images.push({ ...p, mediaType: image.mediaType, data: image.data });
    else limitations.push(`图片 ${image.title || image.id} 无可读取的嵌入内容，未渲染`);
  }
  const shapes: NonNullable<RenderLayout["shapes"]> = [];
  for (const shape of objects.shapes ?? []) {
    const p = position(shape);
    if (visible(p)) shapes.push({ ...p, shape });
  }
  return {
    layout: { width: x, height: y, cells, charts, images, shapes },
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
      "把工作簿区域渲染成图片作为视觉输入，用于核对版式或与原始截图对照。返回图片、渲染所用修订号、行列与像素的对应关系和渲染限制；sourceFile 为文档打开与当前磁盘字节的核验，内存计算不等于已写回。单次最多 80 行 × 30 列。",
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
      svc.editTarget(ctx.workspaceId, ctx.workspaceRoot, args);
      let docId = args.docId;
      if (!docId) {
        if (!args.path) return fail("INVALID_ARGUMENT", "缺少 path 或 docId");
        docId = (await svc.open(ctx.workspaceId, ctx.workspaceRoot, args.path)).meta.id;
      }
      const { meta, snapshot } = await svc.snapshot(docId, ctx.workspaceRoot, true);
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
      const observed = parseRange(out.range);
      ctx.reads.record(
        docId,
        [
          {
            sheetId: sheet.id ?? snapshot.sheetOrder[0] ?? "*",
            r0: observed.startRow - 1,
            c0: observed.startCol - 1,
            r1: observed.endRow - 1,
            c1: observed.endCol - 1,
          },
        ],
        meta.rev,
      );
      return {
        status: "ok",
        data: {
          docId,
          path: meta.path,
          sourceFile: await svc.sourceStatus(docId, ctx.workspaceRoot),
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
