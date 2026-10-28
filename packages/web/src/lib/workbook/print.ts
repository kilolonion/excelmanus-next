import type { ICellData, IStyleData, IWorkbookData, IWorksheetData } from "@univerjs/core";

export interface PrintObject {
  left: number;
  top: number;
  width: number;
  height: number;
  src: string;
  title: string;
}
export interface PrintEffect {
  style?: IStyleData;
  isShowValue?: boolean;
  iconSrc?: string;
  dataBar?: {
    color: string;
    value: number;
    startPoint: number;
    isGradient: boolean;
    isShowValue: boolean;
  };
}

export interface PrintRange {
  startRow: number;
  endRow: number;
  startColumn: number;
  endColumn: number;
}
const esc = (s: unknown) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
const color = (s: unknown, fallback: string) => {
  if (typeof s !== "string") return fallback;
  if (/^#?(?:[a-f\d]{3}|[a-f\d]{6}|[a-f\d]{8})$/i.test(s)) return `#${s.replace(/^#/, "")}`;
  if (/^rgba?\([\d\s.,%/]+\)$/i.test(s)) return s;
  return fallback;
};

export function printRange(sheet: Partial<IWorksheetData>, selection?: PrintRange): PrintRange {
  let range = selection
    ? { ...selection }
    : { startRow: 0, startColumn: 0, endRow: 0, endColumn: 0 };
  if (!selection)
    for (const [r, row] of Object.entries(sheet.cellData ?? {}))
      for (const [c, cell] of Object.entries((row ?? {}) as Record<string, ICellData>)) {
        if (cell && (cell.v != null || cell.f || cell.p)) {
          range.endRow = Math.max(range.endRow, +r);
          range.endColumn = Math.max(range.endColumn, +c);
        }
      }
  // Expand intersecting merges so selection export never loses the anchor text.
  let changed = true;
  while (changed) {
    changed = false;
    for (const m of sheet.mergeData ?? []) {
      if (
        m.endRow < range.startRow ||
        m.startRow > range.endRow ||
        m.endColumn < range.startColumn ||
        m.startColumn > range.endColumn
      )
        continue;
      const next = {
        startRow: Math.min(range.startRow, m.startRow),
        endRow: Math.max(range.endRow, m.endRow),
        startColumn: Math.min(range.startColumn, m.startColumn),
        endColumn: Math.max(range.endColumn, m.endColumn),
      };
      if (JSON.stringify(next) !== JSON.stringify(range)) {
        range = next;
        changed = true;
      }
    }
  }
  if ((range.endRow - range.startRow + 1) * (range.endColumn - range.startColumn + 1) > 20000)
    throw new Error("导出区域超过 20,000 个单元格，请缩小选区后导出");
  return range;
}

export function buildPrintHtml({
  sheet,
  styles,
  range,
  display,
  orientation,
  title,
  effects = {},
  objects = [],
}: {
  sheet: Partial<
    Pick<
      IWorksheetData,
      | "cellData"
      | "rowData"
      | "columnData"
      | "mergeData"
      | "defaultRowHeight"
      | "defaultColumnWidth"
    >
  >;
  styles: IWorkbookData["styles"];
  range: PrintRange;
  display: string[][];
  orientation: "portrait" | "landscape";
  title: string;
  effects?: Record<string, PrintEffect>;
  objects?: PrintObject[];
}): string {
  const rows = Array.from(
    { length: range.endRow - range.startRow + 1 },
    (_, i) => range.startRow + i,
  ).filter((r) => !sheet.rowData?.[r]?.hd);
  const cols = Array.from(
    { length: range.endColumn - range.startColumn + 1 },
    (_, i) => range.startColumn + i,
  ).filter((c) => !sheet.columnData?.[c]?.hd);
  const covered = new Set<string>(),
    merges = new Map<
      string,
      { rows: number; cols: number; sourceRow: number; sourceCol: number }
    >();
  for (const m of sheet.mergeData ?? []) {
    const rr = rows.filter((r) => r >= m.startRow && r <= m.endRow),
      cc = cols.filter((c) => c >= m.startColumn && c <= m.endColumn);
    if (!rr.length || !cc.length) continue;
    merges.set(`${rr[0]}:${cc[0]}`, {
      rows: rr.length,
      cols: cc.length,
      sourceRow: m.startRow,
      sourceCol: m.startColumn,
    });
    for (const r of rr)
      for (const c of cc) if (r !== rr[0] || c !== cc[0]) covered.add(`${r}:${c}`);
  }
  const width = cols.reduce(
    (sum, c) => sum + (sheet.columnData?.[c]?.w ?? sheet.defaultColumnWidth ?? 88),
    0,
  );
  const pageWidth = orientation === "landscape" ? 1028 : 700;
  const zoom = Math.min(1, pageWidth / Math.max(width, 1));
  const body = rows
    .map(
      (r) =>
        `<tr style="height:${sheet.rowData?.[r]?.h ?? sheet.defaultRowHeight ?? 24}px">${cols
          .map((c) => {
            if (covered.has(`${r}:${c}`)) return "";
            const m = merges.get(`${r}:${c}`),
              sr = m?.sourceRow ?? r,
              sc = m?.sourceCol ?? c;
            const cell = sheet.cellData?.[sr]?.[sc];
            const effect = effects[`${sr}:${sc}`];
            const st: IStyleData = {
              ...((typeof cell?.s === "string" ? styles?.[cell.s] : cell?.s) ?? {}),
              ...effect?.style,
            };
            const decorations = [st.ul?.s ? "underline" : "", st.st?.s ? "line-through" : ""]
              .filter(Boolean)
              .join(" ");
            const css = `color:${color(st.cl?.rgb, "#222222")};background:${color(st.bg?.rgb, "#ffffff")};font-size:${st.fs ?? 11}px;font-weight:${st.bl ? "bold" : "normal"};font-style:${st.it ? "italic" : "normal"};text-align:${st.ht === 2 ? "center" : st.ht === 3 || typeof cell?.v === "number" ? "right" : "left"};vertical-align:${st.vt === 1 ? "top" : st.vt === 3 ? "bottom" : "middle"};white-space:${st.tb === 3 ? "pre-wrap" : "pre"};text-decoration:${decorations || "none"};${borderCss(st)}`;
            const text =
              display[sr - range.startRow]?.[sc - range.startColumn] ?? String(cell?.v ?? "");
            return `<td${m ? ` rowspan="${m.rows}" colspan="${m.cols}"` : ""} style="${css}">${effectMarkup(effect)}${borderMarkup(st)}<div style="position:absolute;inset:1px;overflow:hidden;padding:2px 4px 2px ${effect?.iconSrc ? 22 : 4}px;display:flex;flex-direction:column;justify-content:${st.vt === 1 ? "flex-start" : st.vt === 3 ? "flex-end" : "center"}"><span>${effect?.isShowValue === false ? "" : esc(text)}</span></div></td>`;
          })
          .join("")}</tr>`,
    )
    .join("");
  const height = rows.reduce(
    (sum, r) => sum + (sheet.rowData?.[r]?.h ?? sheet.defaultRowHeight ?? 24),
    0,
  );
  const pageHeight = (orientation === "landscape" ? 650 : 980) / zoom;
  const table = `<table><colgroup>${cols.map((c) => `<col style="width:${sheet.columnData?.[c]?.w ?? sheet.defaultColumnWidth ?? 88}px">`).join("")}</colgroup><tbody>${body}</tbody></table>`;
  const drawings = objects
    .map(
      (o) =>
        `<img alt="${esc(o.title)}" src="${esc(o.src)}" style="position:absolute;left:${o.left}px;top:${o.top}px;width:${o.width}px;height:${o.height}px;object-fit:contain;background:white"/>`,
    )
    .join("");
  const pages = Array.from({ length: Math.max(1, Math.ceil(height / pageHeight)) }, (_, page) => {
    const offset = page * pageHeight;
    return `<section class="print-page"><h1>${esc(title)}</h1><div style="position:relative;overflow:hidden;width:${width}px;height:${Math.min(pageHeight, height - offset)}px;zoom:${zoom}"><div style="position:relative;top:${-offset}px">${table}${drawings}</div></div></section>`;
  }).join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(title)}</title><style>@page{size:A4 ${orientation};margin:12mm}*{box-sizing:border-box}body{margin:0;background:white;color:#222;font-family:"Noto Sans CJK SC","Microsoft YaHei",sans-serif}h1{font-size:14px;font-weight:500;margin:0 0 12px}.print-page{break-after:page}.print-page:last-child{break-after:auto}table{border-collapse:collapse;table-layout:fixed;width:${width}px}td{position:relative;border:1px solid #ccc;padding:0;white-space:pre-wrap;overflow-wrap:anywhere}body{-webkit-print-color-adjust:exact;print-color-adjust:exact}@media screen{body{padding:24px}.print-page{margin-bottom:24px}}</style></head><body>${pages}</body></html>`;
}

function borderCss(style: IStyleData): string {
  return (
    [
      ["t", "top"],
      ["b", "bottom"],
      ["l", "left"],
      ["r", "right"],
    ] as const
  )
    .flatMap(([key, side]) => {
      const border = style.bd?.[key];
      if (!border) return [];
      const line =
        border.s === 7
          ? "double"
          : border.s === 3
            ? "dotted"
            : [4, 5, 6, 9, 10, 11, 12].includes(border.s)
              ? "dashed"
              : "solid";
      const width =
        border.s === 0
          ? 0
          : border.s === 7 || border.s === 13
            ? 3
            : border.s >= 8
              ? 2
              : border.s === 2
                ? 0.5
                : 1;
      return [
        `border-${side}:${width}px ${line} ${[5, 6, 10, 11, 12].includes(border.s) ? "transparent" : color(border.cl?.rgb, "#000000")}`,
      ];
    })
    .join(";");
}
function effectMarkup(effect?: PrintEffect): string {
  let html = effect?.iconSrc
    ? `<img alt="条件格式图标" src="${esc(effect.iconSrc)}" style="position:absolute;z-index:1;left:3px;top:3px;width:16px;height:16px"/>`
    : "";
  const bar = effect?.dataBar;
  if (bar) {
    const start = Math.max(0, Math.min(100, bar.startPoint));
    const width =
      (Math.min(100, Math.abs(bar.value)) * (bar.value >= 0 ? 100 - start : start)) / 100;
    const left = bar.value >= 0 ? start : start - width;
    const fill = color(bar.color, "#638ec6");
    html += `<span style="position:absolute;top:3px;bottom:3px;left:${left}%;width:${width}%;background:${bar.isGradient ? `linear-gradient(to ${bar.value >= 0 ? "right" : "left"},${fill},#ffffff)` : fill}"></span>`;
  }
  return html;
}

function borderMarkup(style: IStyleData): string {
  const lines = (
    [
      ["t", "0", "0", "100%", "0"],
      ["b", "0", "100%", "100%", "100%"],
      ["l", "0", "0", "0", "100%"],
      ["r", "100%", "0", "100%", "100%"],
    ] as const
  )
    .flatMap(([key, x1, y1, x2, y2]) => {
      const b = style.bd?.[key];
      if (!b || ![5, 6, 10, 11, 12].includes(b.s)) return [];
      const dash = [6, 11].includes(b.s) ? "6 3 1 3 1 3" : "6 3 1 3";
      return [
        `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color(b.cl?.rgb, "#000000")}" stroke-width="${b.s >= 10 ? 2 : 1}" stroke-dasharray="${dash}"/>`,
      ];
    })
    .join("");
  return lines
    ? `<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" style="position:absolute;inset:0;overflow:visible;pointer-events:none;z-index:2">${lines}</svg>`
    : "";
}
