/** ISO 8601 UTC 时间字符串（全库与协议统一）。 */
export function nowIso(): string {
  return new Date().toISOString();
}
