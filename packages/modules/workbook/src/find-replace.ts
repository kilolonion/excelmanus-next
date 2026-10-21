import { CommandType, type ICellData, type ICommandService, type Worksheet } from "@univerjs/core";
import { z } from "zod";
/** Shared by preflight and execution so invalid patterns never begin a batch. */
export function findReplacePattern(find: string, regex: boolean, caseSensitive: boolean): RegExp {
  return new RegExp(
    regex ? find : find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    caseSensitive ? "g" : "gi",
  );
}
export const FIND_REPLACE_COMMAND = "excelmanus.command.find-replace";
const Params = z.object({
  unitId: z.string(),
  subUnitId: z.string(),
  find: z.string().min(1).max(10000),
  replacement: z.string().max(32767),
  caseSensitive: z.boolean(),
  regex: z.boolean().default(false),
  formulas: z.boolean(),
  range: z.object({
    startRow: z.int().nonnegative(),
    endRow: z.int().max(1048575),
    startColumn: z.int().nonnegative(),
    endColumn: z.int().max(16383),
  }),
});
/** Scan at execution time so preceding operations in the same atomic batch are visible. */
export function findReplaceCommand(
  commandService: ICommandService,
  sheetOf: (unitId: string, sid: string) => Worksheet | undefined | null | void,
) {
  return {
    id: FIND_REPLACE_COMMAND,
    type: CommandType.COMMAND,
    handler: async (_accessor: unknown, input: unknown): Promise<boolean> => {
      const parsed = Params.safeParse(input);
      if (!parsed.success) return false;
      const p = parsed.data,
        r = p.range;
      if (
        r.endRow < r.startRow ||
        r.endColumn < r.startColumn ||
        (r.endRow - r.startRow + 1) * (r.endColumn - r.startColumn + 1) > 200000
      )
        return false;
      const sheet = sheetOf(p.unitId, p.subUnitId);
      if (!sheet) return false;
      let pattern: RegExp;
      try {
        pattern = findReplacePattern(p.find, p.regex, p.caseSensitive);
      } catch {
        return false;
      }
      const matrix = sheet.getCellMatrix(),
        cellValue: Record<number, Record<number, ICellData>> = {};
      for (let row = r.startRow; row <= r.endRow; row++)
        for (let col = r.startColumn; col <= r.endColumn; col++) {
          const cell = matrix.getValue(row, col);
          if (!cell) continue;
          const formula = typeof cell.f === "string" && cell.f.length > 0;
          if (formula && !p.formulas) continue;
          const value = formula ? cell.f : cell.v;
          if (typeof value !== "string") continue;
          const replaced = p.regex
            ? value.replace(pattern, p.replacement)
            : value.replace(pattern, () => p.replacement);
          if (value === replaced) continue;
          const next: ICellData = {
            ...cell,
            ...(formula ? { f: replaced, v: null, p: null } : { v: replaced, p: null }),
          };
          const rowValue = cellValue[row] ?? {};
          rowValue[col] = next;
          cellValue[row] = rowValue;
        }
      if (!Object.keys(cellValue).length) return true;
      return commandService.executeCommand("sheet.mutation.set-range-values", {
        unitId: p.unitId,
        subUnitId: p.subUnitId,
        cellValue,
      });
    },
  };
}
