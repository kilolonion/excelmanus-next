/** The same bounded SVG is used by live overlays, printing and PNG renderers. */
export interface WorkbookShape {
  type: "rect" | "ellipse" | "rightArrow";
  width: number;
  height: number;
  text: string;
  fill?: string;
  stroke?: string;
  textColor?: string;
}

const escapeXml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c] ?? c;
  });
const color = (value: string | undefined, fallback: string) =>
  value && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;

export function workbookShapeSvg(
  shape: WorkbookShape,
  fontFamily = "Noto Sans CJK SC, Noto Sans CJK JP, PingFang SC, Microsoft YaHei, sans-serif",
  scale = 1,
): string {
  const w = shape.width,
    h = shape.height;
  const paint = `fill="${color(shape.fill, "none")}" stroke="${color(shape.stroke, "none")}" stroke-width="1"`;
  const geometry =
    shape.type === "ellipse"
      ? `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${Math.max(0, (w - 1) / 2)}" ry="${Math.max(0, (h - 1) / 2)}" ${paint}/>`
      : shape.type === "rightArrow"
        ? `<polygon points="0.5,${h / 4} ${w * 0.65},${h / 4} ${w * 0.65},0.5 ${w - 0.5},${h / 2} ${w * 0.65},${h - 0.5} ${w * 0.65},${h * 0.75} 0.5,${h * 0.75}" ${paint}/>`
        : `<rect x="0.5" y="0.5" width="${Math.max(0, w - 1)}" height="${Math.max(0, h - 1)}" ${paint}/>`;
  // Basic, centered plain text only. Rich text, wrapping and source font metrics are approximate.
  const lines = shape.text.split(/\r?\n/).slice(0, Math.max(1, Math.floor((h - 8) / 18)));
  const text = lines
    .map(
      (line, i) =>
        `<text x="${w / 2}" y="${h / 2 + (i - (lines.length - 1) / 2) * 18}" dominant-baseline="middle" text-anchor="middle">${escapeXml(line)}</text>`,
    )
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w * scale}" height="${h * scale}" viewBox="0 0 ${w} ${h}">${geometry}<defs><clipPath id="text"><rect x="2" y="2" width="${Math.max(0, w - 4)}" height="${Math.max(0, h - 4)}"/></clipPath></defs><g clip-path="url(#text)" fill="${color(shape.textColor, "#000000")}" font-family="${escapeXml(fontFamily)}" font-size="14">${text}</g></svg>`;
}

export function workbookShapeSource(shape: WorkbookShape, scale = 1): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(workbookShapeSvg(shape, undefined, scale))}`;
}
