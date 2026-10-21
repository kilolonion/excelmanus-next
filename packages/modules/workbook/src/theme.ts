type Xml = Record<string, unknown>;
function child(node: unknown, name: string): Xml | undefined {
  if (!node || typeof node !== "object") return;
  const found = Object.entries(node).find(([key]) => key.split(":").at(-1) === name)?.[1];
  return found && typeof found === "object" ? (found as Xml) : undefined;
}
export function themeColors(theme: unknown): string[] {
  const scheme = child(child(child(theme, "theme"), "themeElements"), "clrScheme");
  return [
    "lt1",
    "dk1",
    "lt2",
    "dk2",
    "accent1",
    "accent2",
    "accent3",
    "accent4",
    "accent5",
    "accent6",
    "hlink",
    "folHlink",
  ].map((name) => {
    const node = child(scheme, name),
      rgb = child(node, "srgbClr"),
      system = child(node, "sysClr");
    return String(rgb?.["@_val"] ?? system?.["@_lastClr"] ?? "");
  });
}
function tintColor(hex: string, tint: number): string {
  if (!tint) return hex;
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    delta = max - min;
  let light = (max + min) / 2,
    hue = 0,
    saturation = 0;
  if (delta) {
    saturation = delta / (1 - Math.abs(2 * light - 1));
    hue =
      (max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4) *
      60;
    if (hue < 0) hue += 360;
  }
  light = tint < 0 ? light * (1 + tint) : light * (1 - tint) + tint;
  const c = (1 - Math.abs(2 * light - 1)) * saturation,
    x = c * (1 - Math.abs(((hue / 60) % 2) - 1)),
    m = light - c / 2;
  const rgb =
    hue < 60
      ? [c, x, 0]
      : hue < 120
        ? [x, c, 0]
        : hue < 180
          ? [0, c, x]
          : hue < 240
            ? [0, x, c]
            : hue < 300
              ? [x, 0, c]
              : [c, 0, x];
  return rgb
    .map((v) =>
      Math.max(0, Math.min(255, Math.round((v + m) * 255)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")
    .toUpperCase();
}
export function resolveColor(value: unknown, theme: string[]): { rgb: string } | undefined {
  if (!value || typeof value !== "object") return;
  const node = value as Xml;
  let hex = typeof node["@_rgb"] === "string" ? String(node["@_rgb"]).slice(-6) : undefined;
  if (!hex && node["@_theme"] !== undefined) hex = theme[Number(node["@_theme"])];
  if (!hex && Number(node["@_indexed"]) >= 0 && Number(node["@_indexed"]) < 16)
    hex = ["000000", "FFFFFF", "FF0000", "00FF00", "0000FF", "FFFF00", "FF00FF", "00FFFF"][
      Number(node["@_indexed"]) % 8
    ];
  if (!hex || !/^[0-9A-F]{6}$/i.test(hex)) return;
  const tint = Number(node["@_tint"] ?? 0);
  return { rgb: `#${tintColor(hex, Number.isFinite(tint) ? Math.max(-1, Math.min(1, tint)) : 0)}` };
}
