import { z } from "zod";

export const OBJECT_LAYER_MUTATION = "excelmanus.mutation.set-sheet-objects";
export const ChartObject = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  type: z.enum(["column", "bar", "line", "pie", "doughnut", "scatter", "area", "combo"]),
  title: z.string().max(500),
  range: z.string().min(1).max(300),
  anchor: z
    .string()
    .regex(/^[A-Z]{1,3}[1-9][0-9]{0,6}$/)
    .default("E2"),
  width: z.number().int().min(100).max(2000).default(640),
  height: z.number().int().min(100).max(2000).default(360),
  chartPart: z
    .string()
    .regex(/^xl\/charts\/[A-Za-z0-9_.-]+\.xml$/)
    .optional(),
  drawingPart: z
    .string()
    .regex(/^xl\/drawings\/[A-Za-z0-9_.-]+\.xml$/)
    .optional(),
});
export type ChartObject = z.infer<typeof ChartObject>;
export const ImageObject = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  title: z.string().max(500),
  anchor: z.string().regex(/^[A-Z]{1,3}[1-9][0-9]{0,6}$/),
  width: z.number().int().min(1).max(4000),
  height: z.number().int().min(1).max(4000),
  mediaPart: z
    .string()
    .regex(/^xl\/media\/[A-Za-z0-9_.-]+$/)
    .optional(),
  mediaType: z.enum(["image/png", "image/jpeg", "image/gif"]),
  data: z.string().max(14_000_000).optional(),
});
export type ImageObject = z.infer<typeof ImageObject>;
export const WorkbookObjects = z.object({
  charts: z.array(ChartObject).max(100),
  images: z.array(ImageObject).max(100).default([]),
});
export type WorkbookObjects = z.infer<typeof WorkbookObjects>;
export const SheetObjectsMutation = z.object({
  unitId: z.string(),
  subUnitId: z.string(),
  objects: WorkbookObjects,
});

/** Same validated mutation handler on server and browser. No engine dependency in protocol. */
export function sheetObjectsMutation(
  type: number,
  sheetOf: (
    unitId: string,
    sheetId: string,
  ) =>
    | {
        getCustomMetadata(): unknown;
        setCustomMetadata(value: Record<string, unknown>): void;
      }
    | undefined
    | null
    | void,
) {
  return {
    id: OBJECT_LAYER_MUTATION,
    type,
    handler: (_accessor: unknown, input: unknown): boolean => {
      const parsed = SheetObjectsMutation.safeParse(input);
      if (!parsed.success) return false;
      const { unitId, subUnitId, objects } = parsed.data;
      const sheet = sheetOf(unitId, subUnitId);
      if (!sheet) return false;
      const previous = sheet.getCustomMetadata();
      sheet.setCustomMetadata({
        ...(previous && typeof previous === "object" ? previous : {}),
        excelmanusObjects: objects,
      });
      return true;
    },
  };
}

export const AXIS_GROUP_MUTATION = "excelmanus.mutation.set-axis-group";
export const AxisGroupMutation = z.object({
  unitId: z.string(),
  subUnitId: z.string(),
  axis: z.enum(["rows", "cols"]),
  levels: z
    .record(z.string().regex(/^\d+$/), z.number().int().min(0).max(7))
    .refine((v) => Object.keys(v).length <= 10000),
});
export function axisGroupMutation(
  type: number,
  sheetOf: (
    unitId: string,
    sheetId: string,
  ) =>
    | {
        getRowManager(): {
          getRowOrCreate(index: number): unknown;
          getCustomMetadata(index: number): unknown;
          setCustomMetadata(index: number, value: Record<string, unknown> | undefined): void;
        };
        getColumnManager(): {
          getColumnOrCreate(index: number): unknown;
          getCustomMetadata(index: number): unknown;
          setCustomMetadata(index: number, value: Record<string, unknown> | undefined): void;
        };
      }
    | undefined
    | null
    | void,
) {
  return {
    id: AXIS_GROUP_MUTATION,
    type,
    handler: (_accessor: unknown, input: unknown): boolean => {
      const p = AxisGroupMutation.safeParse(input);
      if (!p.success) return false;
      const { unitId, subUnitId, axis, levels } = p.data;
      if (Object.keys(levels).some((k) => Number(k) > (axis === "rows" ? 1048575 : 16383)))
        return false;
      const sheet = sheetOf(unitId, subUnitId);
      if (!sheet) return false;
      const manager = axis === "rows" ? sheet.getRowManager() : sheet.getColumnManager();
      for (const [key, level] of Object.entries(levels)) {
        const index = Number(key),
          old = manager.getCustomMetadata(index);
        const custom = { ...(old && typeof old === "object" ? old : {}) } as Record<
          string,
          unknown
        >;
        if (level) custom.excelmanusOutlineLevel = level;
        else delete custom.excelmanusOutlineLevel;
        if (axis === "rows") sheet.getRowManager().getRowOrCreate(index);
        else sheet.getColumnManager().getColumnOrCreate(index);
        manager.setCustomMetadata(index, Object.keys(custom).length ? custom : undefined);
      }
      return true;
    },
  };
}
