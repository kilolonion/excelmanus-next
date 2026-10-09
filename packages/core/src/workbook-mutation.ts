/** 公式状态/计算结果是服务端派生数据，不能作为工作台的用户写入回送。 */
export function isDerivedWorkbookMutation(mutation: { id: string; params?: unknown }): boolean {
  if (mutation.id.startsWith("formula.mutation.")) return true;
  if (mutation.id !== "sheet.mutation.set-range-values") return false;
  const trigger = (mutation.params as { trigger?: unknown } | null)?.trigger;
  return typeof trigger !== "string" || trigger.length === 0;
}
