import { normalizeTableCells } from "@excelmanus/core";
import type { TableManager } from "@univerjs/sheets-table";

type Values = Record<string, Record<string, unknown>>;
function hasFormula(cells: Values): boolean {
  for (const row of Object.values(cells))
    for (const cell of Object.values(row ?? {}))
      if (cell && typeof cell === "object" && "f" in cell && typeof cell.f === "string")
        return true;
  return false;
}

/** Plain edits need no table lookup; formula edits only need reference metadata. */
export function normalizeEditorTableValues(
  cells: Values,
  sheetId: string,
  unitId: string,
  manager: Pick<TableManager, "getTableList" | "getTableById">,
): void {
  if (!hasFormula(cells)) return;
  const tables = manager.getTableList(unitId).flatMap((info) => {
    const table = manager.getTableById(unitId, info.id);
    return table
      ? [
          {
            name: info.name,
            sheet: "",
            sheetId: info.subUnitId,
            range: info.range,
            columns: info.columns.map((column) => column.displayName),
            showHeader: info.showHeader !== false,
            showFooter: table.isShowFooter(),
          },
        ]
      : [];
  });
  normalizeTableCells(cells, sheetId, tables);
}
