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
  drawingObjectId: z.string().max(100).optional(),
  id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  title: z.string().max(500),
  anchor: z.string().regex(/^[A-Z]{1,3}[1-9][0-9]{0,6}$/),
  width: z.number().int().min(1).max(4000),
  height: z.number().int().min(1).max(4000),
  offsetX: z.number().min(0).max(4000).optional(),
  offsetY: z.number().min(0).max(4000).optional(),
  mediaPart: z
    .string()
    .regex(/^xl\/media\/[A-Za-z0-9_.-]+$/)
    .optional(),
  mediaType: z.enum(["image/png", "image/jpeg", "image/gif"]),
  data: z.string().max(14_000_000).optional(),
});
export type ImageObject = z.infer<typeof ImageObject>;
export const ShapeObject = z.object({
  id: ImageObject.shape.id,
  drawingObjectId: ImageObject.shape.drawingObjectId,
  title: ImageObject.shape.title,
  text: z.string().max(32767),
  type: z.enum(["rect", "ellipse", "rightArrow"]),
  anchor: ImageObject.shape.anchor,
  width: ImageObject.shape.width,
  height: ImageObject.shape.height,
  offsetX: ImageObject.shape.offsetX,
  offsetY: ImageObject.shape.offsetY,
  fill: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  stroke: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  textColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
});
export type ShapeObject = z.infer<typeof ShapeObject>;
export const CellNote = z.object({
  ref: z.string().regex(/^[A-Z]{1,3}[1-9][0-9]{0,6}$/),
  text: z.string().max(32767),
  author: z.string().max(500).default(""),
});
const CommentGuid = z.string().regex(/^\{?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\}?$/i);
export const ThreadComment = z.object({
  id: CommentGuid,
  personId: CommentGuid,
  parentId: CommentGuid.optional(),
  ref: z.string().regex(/^[A-Z]{1,3}[1-9][0-9]{0,6}$/),
  text: z.string().max(32767),
  author: z.string().max(500),
  dateTime: z.string().max(100).optional(),
  done: z.boolean().default(false),
});
export type ThreadComment = z.infer<typeof ThreadComment>;
export const WorkbookObjects = z.object({
  // null preserves an absent OOXML attribute; lexical values allow exact undo.
  pivotRefreshOnLoad: z
    .record(z.string().regex(/^\d+$/), z.enum(["0", "1", "false", "true"]).nullable())
    .optional(),
  threadedComments: z.array(ThreadComment).max(10000).optional(),
  notes: z.array(CellNote).max(10000).optional(),
  charts: z.array(ChartObject).max(100),
  images: z.array(ImageObject).max(100).default([]),
  shapes: z.array(ShapeObject).max(100).optional(),
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
export const AxisGroupMutation = z
  .object({
    unitId: z.string(),
    subUnitId: z.string(),
    axis: z.enum(["rows", "cols"]),
    levels: z
      .record(z.string().regex(/^\d+$/), z.number().int().min(0).max(7))
      .refine((v) => Object.keys(v).length <= 10000)
      .optional(),
    collapsed: z
      .record(z.string().regex(/^\d+$/), z.boolean())
      .refine((v) => Object.keys(v).length <= 10000)
      .optional(),
  })
  .refine((v) => v.levels !== undefined || v.collapsed !== undefined);
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
      const { unitId, subUnitId, axis, levels, collapsed } = p.data;
      const keys = new Set([...Object.keys(levels ?? {}), ...Object.keys(collapsed ?? {})]);
      if ([...keys].some((k) => Number(k) > (axis === "rows" ? 1048575 : 16383))) return false;
      const sheet = sheetOf(unitId, subUnitId);
      if (!sheet) return false;
      const manager = axis === "rows" ? sheet.getRowManager() : sheet.getColumnManager();
      for (const key of keys) {
        const index = Number(key),
          old = manager.getCustomMetadata(index);
        const custom = { ...(old && typeof old === "object" ? old : {}) } as Record<
          string,
          unknown
        >;
        if (levels?.[key] !== undefined) {
          if (levels[key]) custom.excelmanusOutlineLevel = levels[key];
          else delete custom.excelmanusOutlineLevel;
        }
        if (collapsed?.[key] !== undefined) {
          if (collapsed[key]) custom.excelmanusCollapsed = true;
          else delete custom.excelmanusCollapsed;
        }
        if (axis === "rows") sheet.getRowManager().getRowOrCreate(index);
        else sheet.getColumnManager().getColumnOrCreate(index);
        manager.setCustomMetadata(index, Object.keys(custom).length ? custom : undefined);
      }
      return true;
    },
  };
}
