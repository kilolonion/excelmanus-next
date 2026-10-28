/** 公式状态/计算结果是服务端派生数据，不能作为工作台的用户写入回送。 */
export function isDerivedWorkbookMutation(
  mutation: { id: string; params?: unknown },
  options?: {
    applyFormulaCalculationResult?: boolean;
    onlyLocal?: boolean;
    fromCollab?: boolean;
    excelmanusSortRejected?: boolean;
  },
): boolean {
  // Failed sort mutations still emit onCommandExecuted in Univer; they are not authored writes.
  if (mutation.id === "sheet.mutation.reorder-range" && options?.excelmanusSortRejected === true)
    return true;
  if (
    ["formula.mutation.set-defined-name", "formula.mutation.remove-defined-name"].includes(
      mutation.id,
    )
  )
    return false;
  if (mutation.id.startsWith("formula.mutation.")) return true;
  if (mutation.id !== "sheet.mutation.set-range-values") return false;
  // Runtime execution metadata is authoritative even when Univer attaches a stale trigger.
  // Never read this flag from public mutation params.
  if (options?.applyFormulaCalculationResult === true) return true;
  const trigger = (mutation.params as { trigger?: unknown } | null)?.trigger;
  return typeof trigger !== "string" || trigger.length === 0;
}
