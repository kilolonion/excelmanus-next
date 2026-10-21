import { z } from "zod";
export const TABLE_STATE_MUTATION = "excelmanus.mutation.set-sheet-tables";
const range = z.object({
  startRow: z.number().int().nonnegative(),
  endRow: z.number().int().nonnegative(),
  startColumn: z.number().int().nonnegative(),
  endColumn: z.number().int().nonnegative(),
});
export const SheetTableState = z.object({
  unitId: z.string(),
  subUnitId: z.string(),
  tables: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1).max(255),
        range,
        options: z.record(z.string(), z.unknown()),
        columns: z.array(z.record(z.string(), z.unknown())),
        filters: z.record(z.string(), z.unknown()),
        meta: z.record(z.string(), z.unknown()).default({}),
      }),
    )
    .max(1000),
});
export function sheetTablesMutation(
  type: number,
  restore: (unitId: string, sheetId: string, tables: unknown[]) => boolean,
) {
  return {
    id: TABLE_STATE_MUTATION,
    type,
    handler: (_accessor: unknown, input: unknown) => {
      const p = SheetTableState.safeParse(input);
      return p.success && restore(p.data.unitId, p.data.subUnitId, p.data.tables);
    },
  };
}
