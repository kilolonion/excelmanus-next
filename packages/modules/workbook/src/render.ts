// workbook_render（06 §4.4、07 §8）：把活文档某修订的区域排成版式（行高列宽、合并、
// 常用样式），交给装配层注入的渲染端画成 PNG，作为视觉输入返回。

import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import { formatRange, indexToCol, parseRange } from "@excelmanus/core";
import {
  assertToolWriteAccess,
  atomicWrite,
  type EffectPermit,
  prepareEffectPlan,
  recheckEffectPlan,
  runWithEffectPlan,
  resolveWorkspacePath,
  type ToolDefinition,
} from "@excelmanus/kernel";
import {
  type RenderLayout,
  type ToolResult,
  WorkbookCapturePacket,
  WorkbookCaptureReceipt,
} from "@excelmanus/protocol";
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
    "此图根据活文档数据重绘（reconstructed），不是工作台浏览器视图或 Excel 原生界面的截图",
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
  chartId: z.string().min(1).max(200).optional().describe("仅捕获冻结原工作簿的既有图表对象ID；必须完整可见，不重建、不接受整表截图或reconstructed替代"),
  mode: z
    .enum(["browser-view", "reconstructed"])
    .optional()
    .describe(
      "默认 browser-view：实际工作台视图截图；reconstructed 为明确选择的数据重绘，不是原视图截图",
    ),
  path: z.string().optional().describe("工作区相对路径（与 docId 二选一）"),
  docId: z.string().optional(),
  sheet: z.string().optional().describe("工作表名；range 中带表名时可省略"),
  range: z.string().optional().describe("A1 区域，如 A1:H30；省略时渲染左上角 30 行 × 12 列"),
  rev: z.int().nonnegative().optional().describe("修订号；只能是当前修订（历史修订渲染未支持）"),
  exportPath: z
    .string()
    .min(1)
    .regex(/\.png$/i)
    .optional()
    .describe("可选：将真实PNG字节保存到授权范围内的新文件，永不覆盖；不改变viewport覆盖状态"),
});

function validExportPng(bytes: Buffer): boolean {
  if (
    bytes.length < 57 ||
    bytes.length > 8 * 1024 * 1024 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return false;
  let offset = 8,
    data = false,
    header = false;
  while (offset + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(offset),
      end = offset + size + 12;
    if (end > bytes.length) return false;
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) return false;
    if (!header) {
      if (
        type !== "IHDR" ||
        size !== 13 ||
        !bytes.readUInt32BE(offset + 8) ||
        !bytes.readUInt32BE(offset + 12)
      )
        return false;
      header = true;
    }
    if (type === "IDAT" && size > 0) data = true;
    if (type === "IEND") return size === 0 && data && end === bytes.length;
    offset = end;
  }
  return false;
}

export function workbookRenderTool(
  svc: DocumentService,
  render: (layout: RenderLayout) => Promise<string>,
  capture?: (
    packet: WorkbookCapturePacket,
    signal: AbortSignal,
  ) => Promise<{ png: string; receipt: WorkbookCaptureReceipt }>,
): ToolDefinition<z.infer<typeof RenderInput>> {
  return {
    name: "workbook_render",
    title: "渲染截图",
    description:
      "默认截图实际工作台浏览器视图并送入视觉上下文，不等于 Excel 原生界面。仅捕获一个viewport，范围未完全可见会标partial；不会静默降级。缺少浏览器时可显式选mode=reconstructed数据重绘。返回PNG字节SHA、修订、DPR/viewport和覆盖限制；内存计算不等于已写回。单次最多80行×30列。exportPath 可将本次真实PNG保存为授权范围内的新文件；必须显式给出，不覆盖，reader不可导出。chartId 可指定冻结原图表对象，只捕获完整对象像素；缺失、越界或reconstructed都明确unsupported，不新建图表替代。",
    input: RenderInput,
    output: z.record(z.string(), z.unknown()),
    effect: (args: z.infer<typeof RenderInput>) => (args.exportPath ? "write" : "read"),
    effectIntents: (args: z.infer<typeof RenderInput>) => args.exportPath ? [{ kind: "create", path: args.exportPath }] : [],
    requiresVision: true,
    targets: (a, scope) => {
      if (a.exportPath && scope) assertToolWriteAccess(a.exportPath, scope.workspaceRoot, "create");
      return a.exportPath ? [a.exportPath] : a.path ? [a.path] : [];
    },
    replay: (args: z.infer<typeof RenderInput>) => (args.exportPath ? "unsafe" : "safe"),
    timeoutMs: 45_000,
    roles: ["main", "lead", "worker", "reader"],
    async execute(args, ctx): Promise<ToolResult> {
      let publishedPath: string | undefined;
      let permit: EffectPermit | undefined;
      const fail = (code: string, message: string): ToolResult => ({
        status: publishedPath ? "partial" : "error",
        ...(publishedPath ? { data: { published: [publishedPath], publication: "saved", reporting: "incomplete" } } : {}),
        error: { code, message, retryable: false },
      });
      if (args.exportPath) {
        if (ctx.role === "reader") return fail("INVALID_ARGUMENT", "reader 不允许导出PNG文件");
        try {
          const source = args.docId ? svc.meta(args.docId)?.path : args.path;
          if (!source) return fail("INVALID_ARGUMENT", "缺少来源文件");
          permit = prepareEffectPlan({ workspaceRoot: ctx.workspaceRoot, atomicScope: "single-resource", signal: ctx.signal,
            effects: [{ operation: "read-content", path: source }, { operation: "read-metadata", path: source },
              { operation: "create", path: args.exportPath }],
          });
        } catch (error) {
          return fail(
            "INVALID_ARGUMENT",
            error instanceof Error ? error.message : "输出路径未授权",
          );
        }
      }
      const perform = async (): Promise<ToolResult> => {
      const authorizedPath = svc.editTarget(ctx.workspaceId, ctx.workspaceRoot, args);
      let docId = args.docId;
      if (!docId) {
        if (!args.path) return fail("INVALID_ARGUMENT", "缺少 path 或 docId");
        docId = (await svc.open(ctx.workspaceId, ctx.workspaceRoot, args.path)).meta.id;
      }
      const browserView = (args.mode ?? "browser-view") === "browser-view";
      if (args.chartId && !browserView) return fail("UNSUPPORTED_FEATURE","原图表对象只支持真实浏览器完整对象捕获，不支持reconstructed替代");
      if (browserView && !capture)
        return fail(
          "UNSUPPORTED_FEATURE",
          "未配置真实视图截图浏览器；可显式指定 mode=reconstructed 使用有损重绘",
        );
      const sourceBeforeSnapshot =
        browserView || args.exportPath
          ? await svc.sourceStatus(docId, ctx.workspaceRoot)
          : undefined;
      const { meta, snapshot } = await svc.snapshot(docId, ctx.workspaceRoot, true);
      if (args.rev !== undefined && args.rev !== meta.rev)
        return fail("UNSUPPORTED_FEATURE", `只能渲染当前修订 rev${meta.rev}`);
      const sheets = snapshot.sheets as Record<string, IWorksheetData>;
      const sheetName = args.range ? (parseRange(args.range).sheet ?? args.sheet) : args.sheet;
      const sheet = sheetName
        ? Object.values(sheets).find((s) => s.name === sheetName || s.id === sheetName)
        : sheets[snapshot.sheetOrder[0] ?? ""];
      if (!sheet) return fail("NOT_FOUND", `工作表不存在：${sheetName ?? "(默认)"}`);
      const chart = args.chartId ? objectsOf(sheet).charts.find(object=>object.id===args.chartId) : undefined;
      if (args.chartId && !chart) return fail("UNSUPPORTED_FEATURE","冻结原工作簿中不存在该图表对象，不能新建或重画代替");
      const chartHash = chart ? createHash("sha256").update(JSON.stringify(chart)).digest("hex") : undefined;
      if (chart) {
        if (!ctx.assertOriginalChart) return fail("UNSUPPORTED_FEATURE","缺少宿主原图表对象来源认证，不能仅凭当前ID或SHA自证原对象");
        try { await ctx.assertOriginalChart({path:meta.path,docId,sheetId:sheet.id!,chartId:chart.id}); }
        catch(error) { return fail("UNSUPPORTED_FEATURE",error instanceof Error ? error.message : String(error)); }
      }
      const savePng = async (
        bytes: Buffer,
        capture: import("@excelmanus/protocol").HarnessCaptureProvenance,
      ) => {
        if (!args.exportPath) return undefined;
        if (!validExportPng(bytes)) throw new Error("导出必须来自完整有效的PNG字节，当前图片无效");
        recheckEffectPlan(permit!);
        assertToolWriteAccess(args.exportPath, ctx.workspaceRoot, "create");
        const after = await svc.sourceStatus(docId!, ctx.workspaceRoot);
        if (
          svc.headRev(docId!) !== meta.rev ||
          sourceBeforeSnapshot?.currentSha256 !== after.currentSha256 ||
          svc.editTarget(ctx.workspaceId, ctx.workspaceRoot, { docId }) !== authorizedPath
        )
          throw new Error("导出期间文档或来源已变化，请重新截图");
        ctx.signal.throwIfAborted();
        const path = resolveWorkspacePath(ctx.workspaceRoot, args.exportPath).rel;
        recheckEffectPlan(permit!);
        const sha256 = atomicWrite(ctx.workspaceRoot, path, bytes, null);
        publishedPath = path;
        ctx.backups.markCreated(path, { sha256, size: bytes.length });
        await ctx.reportArtifactEffect?.({
          path,
          effect: "export",
          execution: "succeeded",
          persistence: "saved",
          footprint: [capture.visibleRange],
          capture,
          assetInputs: [{ path: meta.path, sha256: after.currentSha256 }],
        });
        return { path, sha256, byteLength: bytes.length, saved: true, capture };
      };
      if (browserView) {
        if (!capture)
          return fail(
            "UNSUPPORTED_FEATURE",
            "未配置真实视图截图浏览器；可显式指定 mode=reconstructed 使用有损重绘",
          );
        const requested = parseRange(args.range ?? chart?.anchor ?? "A1:L20");
        const requestedRange = formatRange({ ...requested, sheet: undefined });
        const parsed = WorkbookCapturePacket.safeParse({
          ...(args.chartId ? {chartId:args.chartId} : {}),
          workspaceId: ctx.workspaceId,
          docId,
          sheetId: sheet.id,
          rev: meta.rev,
          snapshot,
          range: requestedRange.includes(":")
            ? requestedRange
            : `${requestedRange}:${requestedRange}`,
          bounds: {
            startRow: requested.startRow - 1,
            endRow: requested.endRow - 1,
            startColumn: requested.startCol - 1,
            endColumn: requested.endCol - 1,
          },
          viewport: { width: 1180, height: 757 },
          dpr: 1,
        });
        if (!parsed.success)
          return fail(
            "LIMIT_EXCEEDED",
            `真实视图截图请求超出限制：${parsed.error.issues.map((issue) => issue.message).join("；")}`,
          );
        const sourceFile = sourceBeforeSnapshot!;
        if (svc.headRev(docId) !== meta.rev || meta.path !== authorizedPath)
          return fail("VERSION_CONFLICT", "准备截图时文档修订已变化，请重新截图");
        try {
          const captured = await capture(parsed.data, ctx.signal);
          const receipt = WorkbookCaptureReceipt.parse(captured.receipt);
          if (
            receipt.docId !== docId ||
            receipt.sheetId !== sheet.id ||
            receipt.rev !== meta.rev ||
            receipt.requestedRange !== parsed.data.range ||
            receipt.viewport.width !== parsed.data.viewport.width ||
            receipt.viewport.height !== parsed.data.viewport.height ||
            receipt.dpr !== parsed.data.dpr
          )
            return fail("VERSION_CONFLICT", "截图身份或修订不匹配，图片未进入上下文");
          if (args.chartId && (!receipt.chart || receipt.chart.id !== args.chartId ||
              receipt.chart.definitionSha256 !== chartHash || !receipt.chart.fullyVisible))
            return fail("UNSUPPORTED_FEATURE","未获得指定原图表的完整对象捕获回执，整表视图不能替代");
          if (!args.chartId && receipt.chart) return fail("INVALID_IMAGE","未请求图表对象却返回对象截图");
          if (chart && receipt.chart) {
            const bounds=receipt.chart.bounds;
            if(bounds.x+bounds.width>receipt.viewport.width || bounds.y+bounds.height>receipt.viewport.height ||
               Math.abs(bounds.width-chart.width)>=1 || Math.abs(bounds.height-chart.height)>=1)
              return fail("UNSUPPORTED_FEATURE","原图表完整对象边界与冻结尺寸或viewport不一致");
          }
          const pixelWidth = Math.round((receipt.chart?.bounds.width ?? receipt.viewport.width) * receipt.dpr);
          const pixelHeight = Math.round((receipt.chart?.bounds.height ?? receipt.viewport.height) * receipt.dpr);
          const captureComplete = receipt.chart ? true : receipt.fullyVisible;
          const after = await svc.sourceStatus(docId, ctx.workspaceRoot);
          if (
            svc.headRev(docId) !== meta.rev ||
            sourceFile.currentSha256 !== after.currentSha256 ||
            svc.editTarget(ctx.workspaceId, ctx.workspaceRoot, { docId }) !== authorizedPath
          )
            return fail("VERSION_CONFLICT", "截图期间文档或磁盘源文件发生变化，请重新截图");
          if (ctx.signal.aborted) return fail("CANCELLED", "截图已取消");
          const bytes = Buffer.from(captured.png, "base64");
          if (bytes.length > 8 * 1024 * 1024)
            return fail("LIMIT_EXCEEDED", "截图PNG超过8MiB，请缩小范围；不会有损压缩冒充保真截图");
          if (
            bytes.length < 24 ||
            !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
            bytes.readUInt32BE(16) !== pixelWidth ||
            bytes.readUInt32BE(20) !== pixelHeight
          )
            return fail("INVALID_IMAGE", "截图实际PNG像素与viewport不一致，图片未进入上下文");
          const observed = parseRange(receipt.visibleRange);
          ctx.reads.record(
            docId,
            [
              {
                sheetId: sheet.id!,
                r0: observed.startRow - 1,
                c0: observed.startCol - 1,
                r1: observed.endRow - 1,
                c1: observed.endCol - 1,
              },
            ],
            meta.rev,
          );
          const exported = await savePng(bytes, {
            sourceDocId: docId,
            sourceRevision: meta.rev,
            mode: "browser-view",
            requestedRange: parsed.data.range,
            visibleRange: receipt.visibleRange,
            fullyVisible: captureComplete,
            pixelWidth,
            pixelHeight,
            ...(receipt.chart ? {chart:receipt.chart} : {}),
          });
          return {
            status: captureComplete ? "ok" : "partial",
            data: {
              docId,
              path: meta.path,
              sourceFile,
              ...(exported ? { export: exported } : {}),
              sheet: sheet.name,
              range: receipt.visibleRange,
              requestedRange: parsed.data.range,
              rev: meta.rev,
              image: {
                mode: "browser-view",
                sha256: createHash("sha256").update(bytes).digest("hex"),
                byteLength: bytes.length,
                pixelWidth,
                pixelHeight,
                ...receipt,
                fullyVisible:captureComplete,
              },
              limitations: [
                "真实ExcelManus工作台视图，不保证与Excel原生界面像素一致",
                receipt.chart ? "chart-only：仅捕获冻结原图表的工作台对象像素，无表格UI；不是Excel原生像素一致性保证" : "仅截图当前viewport；滚动外单元格和对象不可见，原UI文本截断会如实保留",
                ...(receipt.warnings ?? []),
                ...(captureComplete
                  ? []
                  : ["请求范围没有完全进入viewport，当前图片仅部分覆盖，请分段缩小range"]),
              ],
            },
            docRevs: { [docId]: meta.rev },
            images: [{ mediaType: "image/png", data: captured.png }],
          };
        } catch (error) {
          return fail(
            ctx.signal.aborted ? "CANCELLED" : "UNSUPPORTED_FEATURE",
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      const out = buildLayout(snapshot, sheet, args.range);
      let png: string;
      try {
        png = await render(out.layout);
      } catch (e) {
        return fail("UNSUPPORTED_FEATURE", e instanceof Error ? e.message : String(e));
      }
      const bytes = Buffer.from(png, "base64");
      const isPng =
        bytes.length >= 24 &&
        bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const requested = args.range ? parseRange(args.range) : undefined;
      const cropped =
        requested !== undefined &&
        (requested.endRow - requested.startRow + 1 > MAX_ROWS ||
          requested.endCol - requested.startCol + 1 > MAX_COLS);
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
      let exported: Awaited<ReturnType<typeof savePng>>;
      try {
        exported = await savePng(bytes, {
          sourceDocId: docId,
          sourceRevision: meta.rev,
          mode: "reconstructed",
          requestedRange: args.range ?? out.range,
          visibleRange: out.range,
          fullyVisible: !cropped,
          pixelWidth: isPng ? bytes.readUInt32BE(16) : 0,
          pixelHeight: isPng ? bytes.readUInt32BE(20) : 0,
        });
      } catch (error) {
        return fail("INVALID_ARGUMENT", error instanceof Error ? error.message : "PNG导出失败");
      }
      return {
        status: cropped ? "partial" : "ok",
        data: {
          docId,
          path: meta.path,
          sourceFile: await svc.sourceStatus(docId, ctx.workspaceRoot),
          ...(exported ? { export: exported } : {}),
          sheet: sheet.name,
          range: out.range,
          requestedRange: args.range ?? out.range,
          rev: meta.rev,
          image: {
            mode: "reconstructed",
            sha256: createHash("sha256").update(bytes).digest("hex"),
            byteLength: bytes.length,
            ...(isPng
              ? {
                  pixelWidth: bytes.readUInt32BE(16),
                  pixelHeight: bytes.readUInt32BE(20),
                  scaleX: bytes.readUInt32BE(16) / out.layout.width,
                  scaleY: bytes.readUInt32BE(20) / out.layout.height,
                }
              : {}),
          },
          size: { width: out.layout.width, height: out.layout.height },
          columns: out.columns,
          rows: out.rows,
          limitations: out.limitations,
        },
        docRevs: { [docId]: meta.rev },
        images: [{ mediaType: "image/png", data: png }],
      };
      };
      return permit ? runWithEffectPlan(permit, perform) : perform();
    },
  };
}
