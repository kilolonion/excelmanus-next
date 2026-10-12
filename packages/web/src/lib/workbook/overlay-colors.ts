// 表格叠加层颜色：取自应用 token（读取 = 蓝、已修改 = 主色、待确认 = 金），主题切换后重新读取。

const TOKENS = { read: "--em-cyan", ok: "--em-primary", warn: "--em-gold" } as const;
const FALLBACK = { read: "#0078d4", ok: "#0b6b4f", warn: "#e5a100" } as const;

export type OverlayTone = keyof typeof TOKENS;

function tokenRgb(name: OverlayTone): [number, number, number] {
  const raw =
    typeof document === "undefined"
      ? ""
      : getComputedStyle(document.documentElement).getPropertyValue(TOKENS[name]).trim();
  const hex = /^#([0-9a-f]{6})$/i.test(raw) ? raw : FALLBACK[name];
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgba(name: OverlayTone, alpha: number): string {
  const [r, g, b] = tokenRgb(name);
  return alpha >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function overlayStyles() {
  return {
    reading: { fill: rgba("read", 0.06), stroke: rgba("read", 1), strokeWidth: 1.5, strokeDash: 4 },
    writing: { fill: rgba("read", 0.1), stroke: rgba("read", 1), strokeWidth: 1.5 },
    pending: { fill: rgba("warn", 0.08), stroke: rgba("warn", 1), strokeWidth: 1.5, strokeDash: 5 },
  };
}
