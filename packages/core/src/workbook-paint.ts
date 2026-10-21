// Shared canvas painting for browser and headless server renderers.
export interface WorkbookPaintCell {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  header?: boolean;
  bold?: boolean;
  italic?: boolean;
  color?: string;
  fill?: string;
  align?: "left" | "center" | "right";
  fontSize?: number;
  borders?: Partial<
    Record<"t" | "b" | "l" | "r" | "tl_br" | "bl_tr", { style: number; color: string }>
  >;
  dataBar?: { start: number; end: number; color: string; gradient: boolean };
  icon?: { type: string; index: number; count: number };
}
export interface WorkbookPaintContext {
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  textBaseline: string;
  textAlign: string;
  font: string;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  save(): void;
  restore(): void;
  beginPath(): void;
  rect(x: number, y: number, w: number, h: number): void;
  clip(): void;
  measureText(text: string): { width: number };
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
  fill(): void;
  closePath(): void;
  arc(x: number, y: number, r: number, start: number, end: number): void;
  setLineDash(values: number[]): void;
  createLinearGradient(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
  ): { addColorStop(offset: number, color: string): void };
  fillText(text: string, x: number, y: number): void;
}
const GRID = "#d9d9d9";
const HEAD_BG = "#f3f3f3";
const HEAD_TEXT = "#666666";

function safeColor(c: string | undefined, fallback: string): string {
  return c && /^#?[0-9a-fA-F]{3,8}$/.test(c) ? (c.startsWith("#") ? c : `#${c}`) : fallback;
}

export function paintWorkbookCells(
  ctx: WorkbookPaintContext,
  cells: readonly WorkbookPaintCell[],
  fontFamily: string,
) {
  ctx.textBaseline = "middle";
  for (const cell of cells) {
    ctx.fillStyle = cell.header ? HEAD_BG : safeColor(cell.fill, "#ffffff");
    if (cell.header || cell.fill) ctx.fillRect(cell.x, cell.y, cell.w, cell.h);
  }
  // 网格线：按单元格边界描边（合并单元格自然没有内部线）
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  for (const cell of cells) ctx.strokeRect(cell.x + 0.5, cell.y + 0.5, cell.w, cell.h);
  for (const cell of cells) {
    const bar = cell.dataBar;
    if (bar) {
      const x = cell.x + 2 + (cell.w - 4) * bar.start,
        w = (cell.w - 4) * (bar.end - bar.start),
        color = safeColor(bar.color, "#16a34a");
      let fill: unknown = color;
      if (bar.gradient) {
        const g = ctx.createLinearGradient(x, 0, x + w, 0);
        g.addColorStop(0, color);
        g.addColorStop(1, "#ffffff");
        fill = g;
      }
      ctx.fillStyle = fill;
      ctx.fillRect(x, cell.y + 3, w, Math.max(0, cell.h - 6));
    }
    if (cell.icon) paintIcon(ctx, cell);
    if (cell.text === "") continue;
    const size = Math.min(Math.max(cell.fontSize ?? 11, 8), 28) * (96 / 72);
    ctx.font = `${cell.italic ? "italic " : ""}${cell.bold ? "bold " : ""}${Math.round(size)}px ${fontFamily}`;
    ctx.fillStyle = cell.header ? HEAD_TEXT : safeColor(cell.color, "#1a1c1c");
    ctx.save();
    ctx.beginPath();
    ctx.rect(cell.x + 1, cell.y + 1, cell.w - 2, cell.h - 2);
    ctx.clip();
    const pad = cell.icon ? 22 : 4;
    let align = cell.align ?? "left";
    // 放不下时先缩小字号（最多到 75%），仍放不下则左对齐从尾部裁剪，保证开头可读
    const room = cell.w - pad * 2;
    if (ctx.measureText(cell.text).width > room) {
      const shrunk = Math.max(size * 0.75, (size * room) / ctx.measureText(cell.text).width);
      ctx.font = `${cell.italic ? "italic " : ""}${cell.bold ? "bold " : ""}${Math.round(shrunk)}px ${fontFamily}`;
      if (ctx.measureText(cell.text).width > room) align = "left";
    }
    ctx.textAlign = align;
    const tx =
      align === "center"
        ? cell.x + cell.w / 2
        : align === "right"
          ? cell.x + cell.w - pad
          : cell.x + pad;
    ctx.fillText(cell.text, tx, cell.y + cell.h / 2);
    ctx.restore();
  }
  // Borders last, so adjacent fills cannot erase them. Double and dash variants keep their identity.
  for (const cell of cells)
    for (const [side, b] of Object.entries(cell.borders ?? {})) {
      if (!b || b.style === 0) continue;
      const x = cell.x,
        y = cell.y,
        w = cell.w,
        h = cell.h;
      const points: Record<string, number[]> = {
        t: [x, y, x + w, y],
        b: [x, y + h, x + w, y + h],
        l: [x, y, x, y + h],
        r: [x + w, y, x + w, y + h],
        tl_br: [x, y, x + w, y + h],
        bl_tr: [x, y + h, x + w, y],
      };
      const p = points[side];
      if (!p) continue;
      ctx.save();
      ctx.strokeStyle = safeColor(b.color, "#000000");
      ctx.lineWidth =
        b.style === 13 ? 3 : [8, 9, 10, 11, 12].includes(b.style) ? 2 : b.style === 2 ? 0.5 : 1;
      const dash = [3].includes(b.style)
        ? [1, 2]
        : [4, 9].includes(b.style)
          ? [5, 3]
          : [5, 10, 12].includes(b.style)
            ? [5, 2, 1, 2]
            : [6, 11].includes(b.style)
              ? [5, 2, 1, 2, 1, 2]
              : [];
      ctx.setLineDash(dash);
      for (const d of b.style === 7 ? [-1.5, 1.5] : [0]) {
        const dx = side === "l" || side === "r" ? d : 0,
          dy = side === "t" || side === "b" ? d : 0;
        ctx.beginPath();
        ctx.moveTo(p[0]! + dx, p[1]! + dy);
        ctx.lineTo(p[2]! + dx, p[3]! + dy);
        ctx.stroke();
      }
      ctx.restore();
    }
}
function paintIcon(ctx: WorkbookPaintContext, cell: WorkbookPaintCell) {
  const icon = cell.icon!;
  const t = icon.index / Math.max(1, icon.count - 1),
    x = cell.x + 11,
    y = cell.y + cell.h / 2;
  const color =
    icon.type.includes("Gray") || icon.type.includes("Rating") || icon.type.includes("Quarters")
      ? "#666666"
      : t < 0.34
        ? "#16a34a"
        : t < 0.67
          ? "#d99a33"
          : "#dc2626";
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  if (icon.type.includes("Arrows")) {
    const angle = -Math.PI / 2 + t * Math.PI,
      dx = Math.cos(angle) * 6,
      dy = Math.sin(angle) * 6;
    ctx.beginPath();
    ctx.moveTo(x - dx, y - dy);
    ctx.lineTo(x + dx, y + dy);
    ctx.moveTo(x + dx - Math.cos(angle - 0.6) * 5, y + dy - Math.sin(angle - 0.6) * 5);
    ctx.lineTo(x + dx, y + dy);
    ctx.lineTo(x + dx - Math.cos(angle + 0.6) * 5, y + dy - Math.sin(angle + 0.6) * 5);
    ctx.stroke();
  } else if (icon.type.includes("Flags")) {
    ctx.beginPath();
    ctx.moveTo(x - 5, y + 6);
    ctx.lineTo(x - 5, y - 6);
    ctx.lineTo(x + 5, y - 6);
    ctx.lineTo(x + 3, y);
    ctx.lineTo(x - 5, y);
    ctx.fill();
    ctx.stroke();
  } else if (icon.type.includes("Rating")) {
    for (let i = 0; i < icon.count; i++) {
      ctx.fillStyle = i < icon.count - icon.index ? color : "#dddddd";
      ctx.fillRect(x - 8 + i * 3, y + 6 - (i + 1) * 2, 2, (i + 1) * 2);
    }
  } else if (icon.type.includes("Symbols")) {
    ctx.font = "bold 14px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(t < 0.34 ? "✓" : t < 0.67 ? "!" : "×", x, y);
  } else if (icon.type.includes("Quarters")) {
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.arc(x, y, 6, -Math.PI / 2, -Math.PI / 2 + (1 - t) * Math.PI * 2);
    ctx.closePath();
    ctx.fill();
  } else if (icon.type.includes("Signs")) {
    ctx.beginPath();
    if (t < 0.34) ctx.arc(x, y, 6, 0, Math.PI * 2);
    else if (t < 0.67) {
      ctx.moveTo(x, y - 6);
      ctx.lineTo(x + 6, y + 6);
      ctx.lineTo(x - 6, y + 6);
      ctx.closePath();
    } else ctx.rect(x - 5, y - 5, 10, 10);
    ctx.fill();
  } else {
    if (icon.type.includes("RedToBlack")) ctx.fillStyle = `rgb(${Math.round(220 * (1 - t))},0,0)`;
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
