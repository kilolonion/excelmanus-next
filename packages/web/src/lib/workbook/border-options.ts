import type { BorderStyleTypes, BorderType } from "@univerjs/core";

export function borderValue(
  type: BorderType | `${BorderType}`,
  style: BorderStyleTypes,
  rawColor: string,
) {
  if (type === "none") return { type, style, color: "#000000" };
  let hex = rawColor.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(hex)) hex = [...hex].map((c) => c + c).join("");
  return /^[0-9a-f]{6}$/i.test(hex) ? { type, style, color: `#${hex.toUpperCase()}` } : null;
}
