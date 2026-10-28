/** Univer 的单元格格式快捷键；CSV 提前拦截，XLSX 交给画布处理。 */
export function isWorkbookFormatShortcut(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">,
): boolean {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return false;
  const key = event.key.toLowerCase();
  return event.shiftKey ? ["x", ".", ",", ">", "<"].includes(key) : ["b", "i", "u"].includes(key);
}
