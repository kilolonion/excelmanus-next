export function parseZoomPercent(value: string): number | null {
  const text = value.trim().replace(/[%％]$/, "").trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  return Math.round(Math.min(400, Math.max(10, Number(text))));
}
