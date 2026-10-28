import { z } from "zod";
export const ARRAY_STATE_MUTATION = "excelmanus.mutation.set-sheet-arrays";
export const ArrayFormula = z.object({
  id: z.string(),
  formula: z.string().min(2),
  mode: z.enum(["fixed", "dynamic"]),
  range: z.object({
    startRow: z.number().int().min(0),
    endRow: z.number().int().max(1048575),
    startColumn: z.number().int().min(0),
    endColumn: z.number().int().max(16383),
  }),
});
export type ArrayFormula = z.infer<typeof ArrayFormula>;
export const ArrayFormulas = z.array(ArrayFormula);
export function arraysOf(sheet: { custom?: unknown } | undefined): ArrayFormula[] {
  const p = ArrayFormulas.safeParse(
    (sheet?.custom as Record<string, unknown> | undefined)?.excelmanusArrays,
  );
  return p.success ? p.data : [];
}
export function fixedArrayCellFormula(a: ArrayFormula, r: number, c: number): string {
  const f = a.formula.replace(/^=/, ""),
    row = r - a.range.startRow + 1,
    col = c - a.range.startColumn + 1;
  return `=IF(AND(ROWS((${f}))=1,COLUMNS((${f}))=1),(${f}),IF(OR(ROWS((${f}))<${row},COLUMNS((${f}))<${col}),NA(),INDEX((${f}),${row},${col})))`;
}
export function arrayStateMutation(
  type: number,
  sheetOf: (
    unitId: string,
    sheetId: string,
  ) =>
    | {
        getCustomMetadata(): unknown;
        setCustomMetadata(value: Record<string, unknown>): void;
        getRowCount(): number;
        getColumnCount(): number;
        setRowCount(n: number): void;
        setColumnCount(n: number): void;
      }
    | undefined
    | null
    | void,
) {
  const Params = z.object({ unitId: z.string(), subUnitId: z.string(), arrays: ArrayFormulas });
  return {
    id: ARRAY_STATE_MUTATION,
    type,
    handler: (_accessor: unknown, input: unknown) => {
      const p = Params.safeParse(input);
      if (!p.success) return false;
      const s = sheetOf(p.data.unitId, p.data.subUnitId);
      if (!s) return false;
      for (const a of p.data.arrays) {
        s.setRowCount(
          Math.max(
            s.getRowCount(),
            Math.min(1048576, a.range.endRow + 1 + (a.mode === "dynamic" ? 1000 : 0)),
          ),
        );
        s.setColumnCount(
          Math.max(
            s.getColumnCount(),
            Math.min(16384, a.range.endColumn + 1 + (a.mode === "dynamic" ? 100 : 0)),
          ),
        );
      }
      const prev = s.getCustomMetadata();
      s.setCustomMetadata({
        ...(prev && typeof prev === "object" ? prev : {}),
        excelmanusArrays: p.data.arrays,
      });
      return true;
    },
  };
}
export const ARRAY_CACHE_RESOURCE = "SHEET_EXCELMANUS_ARRAY_PLUGIN";
type Range = ArrayFormula["range"];
type SheetSnapshot = { custom?: unknown; cellData?: unknown };
type CellMap = Record<number, Record<number, { f?: string | null; v?: unknown }>>;

export type ArrayCache = {
  ranges: Record<string, Record<number, Record<number, Range>>>;
  cells: Record<string, Record<number, Record<number, Record<string, unknown>>>>;
};
export function arrayCache(snapshot: {
  resources?: Array<{ name: string; data: string }>;
}): ArrayCache {
  const raw = snapshot.resources?.find((r) => r.name === ARRAY_CACHE_RESOURCE)?.data;
  return raw ? JSON.parse(raw) : { ranges: {}, cells: {} };
}
export function effectiveArrays(
  snapshot: {
    sheets: Record<string, SheetSnapshot>;
    resources?: Array<{ name: string; data: string }>;
  },
  sid: string,
): ArrayFormula[] {
  return effectiveArraysFromSheet(snapshot.sheets[sid], arrayCache(snapshot).ranges[sid]);
}

/** Read one live sheet with its current spill ranges, without serializing unrelated workbook data. */
export function effectiveArraysFromSheet(
  sheet: SheetSnapshot | undefined,
  ranges: ArrayCache["ranges"][string] = {},
): ArrayFormula[] {
  const data = sheet?.cellData as CellMap | undefined,
    arrays = arraysOf(sheet),
    fixed = arrays.filter((a) => a.mode === "fixed"),
    dynamic = arrays.filter(
      (a) => a.mode === "dynamic" && data?.[a.range.startRow]?.[a.range.startColumn]?.f,
    );
  let anchors: Map<string, ArrayFormula> | undefined;
  for (const [row, cols] of Object.entries(ranges))
    for (const [col, cachedRange] of Object.entries(cols ?? {})) {
      const f = data?.[Number(row)]?.[Number(col)]?.f;
      if (!f || !cachedRange) continue;
      const range = { ...cachedRange };
      // Preserve the first matching registered array, including duplicate metadata anchors.
      if (!anchors) {
        anchors = new Map();
        for (const a of dynamic) {
          const { startRow, startColumn } = a.range;
          if (Number.isNaN(startRow) || Number.isNaN(startColumn)) continue;
          const key = `${startRow}:${startColumn}`;
          if (!anchors.has(key)) anchors.set(key, a);
        }
      }
      const key = `${Number(row)}:${Number(col)}`;
      const found = anchors.get(key);
      if (found) {
        found.range = range;
        found.formula = f;
      } else {
        const a: ArrayFormula = { id: `spill_${row}_${col}`, formula: f, mode: "dynamic", range };
        dynamic.push(a);
        anchors.set(key, a);
      }
      // Unusual cache entries can move an anchor. Rebuild before the next sequential match.
      if (range.startRow !== Number(row) || range.startColumn !== Number(col)) anchors = undefined;
    }
  return [...fixed, ...dynamic];
}
