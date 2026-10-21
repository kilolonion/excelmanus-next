// workbook_edit 的 ChangeOp 判别联合 → Univer 命令序列（07 §3.3 编译步）。
// 写集与结构操作直接从 op 推导（agent 来源，坐标用变换前的写入坐标）。

import {
  assertSortableRange,
  indexToCol,
  MAX_C,
  MAX_R,
  newId,
  normalizeDataValidationRule,
  parseRange,
  type RangeRef,
  rangeRefToA1,
  rewriteTableReferences,
  type StructuralOp,
  structuralTouchesInterior,
  transformRange,
} from "@excelmanus/core";
import {
  AXIS_GROUP_MUTATION,
  ChartObject,
  ImageObject,
  OBJECT_LAYER_MUTATION,
  PRINT_STATE_MUTATION,
  printNamesOf,
  printSettingsOf,
  ShapeObject,
  TABLE_STATE_MUTATION,
} from "@excelmanus/protocol";
import { Direction, type IWorkbookData, type IWorksheetData } from "@univerjs/core";
import { type ITableJson, TableColumnDataTypeEnum } from "@univerjs/sheets-table";
import { z } from "zod";
import { namesOf, setNames } from "./defined-names.ts";
import { FIND_REPLACE_COMMAND, findReplacePattern } from "./find-replace.ts";
import { shiftFormula } from "./formula-shift.ts";
import {
  AXIS_SIZE_COMMAND,
  COPY_SHEET_COMMAND,
  FILL_COMMAND,
  FILTER_COMMAND,
  LINK_COMMAND,
  RENAME_SHEET_COMMAND,
} from "./layout-commands.ts";
import { objectsOf } from "./objects.ts";
import { resolvePivotRefreshTarget } from "./pivot-codec.ts";
import { CF_RESOURCE, DV_RESOURCE, rulesResource, setRulesResource } from "./rule-codec.ts";
import { BORDER_STYLES } from "./style-constants.ts";
import { sheetNamesOf } from "./summary.ts";
import { setTables, tablesOf } from "./tables.ts";
import { visualToolRule } from "./visual-tool-rule.ts";
import type { XlsxPreservation } from "./xlsx.ts";

// ---------- 输入 schema ----------

const cellScalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const writeRange = z
  .string()
  .min(1)
  .describe(
    "A1 区域。多工作表时必须显式写表名，如 '核对'!A1:B5；只有单表时可省略，sheet.add 不会切换默认表。",
  );

const tableAdd = z.strictObject({
  op: z.literal("table.add"),
  range: writeRange.describe("包含表头和至少一行数据的区域；创建真正的 Excel 表对象，不是普通筛选"),
  name: z.string().min(1).max(255),
  columns: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(255),
        formula: z
          .string()
          .startsWith("=")
          .optional()
          .describe("可选计算列公式，以首个数据行为基准，向下平移相对引用，保留绝对引用"),
      }),
    )
    .min(1)
    .max(1000)
    .describe("按区域列顺序提供列名，写入表头；formula 同时写入计算列元数据与每行公式"),
});
const tableColumnFormula = z.strictObject({
  op: z.literal("table.column_formula"),
  sheet: z.string().min(1),
  table: z.string().min(1),
  column: z.string().min(1).describe("表对象中的列名"),
  formula: z
    .string()
    .startsWith("=")
    .describe("首个数据行公式，向下平移相对引用；不改表头及合计行"),
});

const pivotMarkRefreshOnLoad = z.strictObject({
  op: z.literal("pivot.mark_refresh_on_load"),
  sheet: z.string().min(1).describe("已有缓存的本地源工作表，不是透视表显示工作表"),
  cacheId: z
    .string()
    .regex(/^\d+$/)
    .describe(
      "workbook_read mode=objects 返回的 workbook cacheId；只设置 refreshOnLoad=true，影响共享该缓存的所有透视表，不立即刷新",
    ),
});

const sheetAdd = z.strictObject({
  op: z.literal("sheet.add"),
  name: z.string().min(1),
  index: z.int().nonnegative().optional(),
});
const sheetRename = z.strictObject({
  op: z.literal("sheet.rename"),
  sheet: z.string().min(1),
  name: z.string().min(1),
});
const sheetDelete = z.strictObject({ op: z.literal("sheet.delete"), sheet: z.string().min(1) });
const sheetCopy = z.strictObject({
  op: z.literal("sheet.copy"),
  sheet: z.string(),
  name: z.string().min(1),
  index: z.int().nonnegative().optional(),
});
const sheetMove = z.strictObject({
  op: z.literal("sheet.move"),
  sheet: z.string(),
  index: z.int().nonnegative(),
});
const sheetHide = z.strictObject({
  op: z.literal("sheet.hide"),
  sheet: z.string(),
  hidden: z.boolean(),
});
const cellsFill = z.strictObject({
  op: z.literal("cells.fill"),
  source: writeRange.describe("已写入的模板区域，如 订单!F2:H2；可来自同批前面的 cells.set"),
  range: writeRange.describe(
    "填充目标，如 订单!F3:H13；copy 自动平移公式相对引用并保留 $ 绝对引用",
  ),
  mode: z.enum(["copy", "series"]).default("copy"),
});
const axisSize = z
  .strictObject({
    op: z.literal("axis.size"),
    sheet: z.string(),
    axis: z.enum(["rows", "cols"]),
    at: z.int().positive(),
    count: z.int().positive().max(1000),
    mode: z.enum(["pixels", "scale", "auto"]),
    value: z
      .number()
      .positive()
      .max(2000)
      .optional()
      .describe("pixels 模式为像素数，scale 模式为倍率"),
    pixels: z
      .number()
      .positive()
      .max(2000)
      .optional()
      .describe("仅 mode=pixels，等价于 value；二者同时提供必须相同"),
  })
  .superRefine((a, ctx) => {
    if (a.pixels !== undefined && a.mode !== "pixels")
      ctx.addIssue({
        code: "custom",
        path: ["pixels"],
        message: "pixels 只适用于 mode=pixels；scale 请用 value 倍率",
      });
    if (a.mode !== "auto" && a.value === undefined && a.pixels === undefined)
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: "pixels 模式需要 value 或 pixels；scale 模式需要 value",
      });
    if (a.value !== undefined && a.pixels !== undefined && a.value !== a.pixels)
      ctx.addIssue({
        code: "custom",
        path: ["pixels"],
        message: "pixels 与 value 不一致，不能确定目标尺寸",
      });
  });
const filterSet = z.strictObject({
  op: z.literal("filter.set"),
  range: z.string(),
  clear: z
    .boolean()
    .default(false)
    .describe("true 仅移除筛选，不能同时传筛选 columns；设置筛选请省略或传 false"),
  columns: z
    .array(
      z.union([
        z.strictObject({
          column: z.int().positive(),
          values: z
            .array(z.union([z.string(), z.number(), z.boolean()]))
            .max(1000)
            .describe("精确枚举匹配，不解析 >=300 等表达式；数值比较请用 condition"),
          blank: z.boolean().default(false).describe("是否同时显示空白单元格，默认不包含"),
        }),
        z.strictObject({
          column: z.int().positive(),
          condition: z
            .strictObject({
              operator: z.enum([
                "equal",
                "notEqual",
                "greaterThan",
                "greaterThanOrEqual",
                "lessThan",
                "lessThanOrEqual",
              ]),
              value: z.number(),
            })
            .describe("数值比较条件，例如金额至少300：operator=greaterThanOrEqual,value=300"),
        }),
      ]),
    )
    .max(100)
    .default([]),
});
const hyperlinkSet = z.strictObject({
  op: z.literal("hyperlink.set"),
  range: z.string(),
  url: z
    .string()
    .max(2048)
    .regex(/^(?:https?:\/\/|mailto:|#)/i)
    .nullable(),
  label: z.string().max(32767).optional(),
});
const cellsSet = z.strictObject({
  op: z.literal("cells.set"),
  range: writeRange,
  values: z.array(z.array(cellScalar)).min(1),
});
const cellsClear = z.strictObject({
  op: z.literal("cells.clear"),
  range: writeRange,
  what: z.enum(["contents", "formats", "all"]).default("all"),
});
const borderSide = z
  .object({
    style: z.enum(BORDER_STYLES),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .default("#000000"),
  })
  .nullable();
const styleSet = z.strictObject(
  {
    op: z.literal("style.set"),
    range: writeRange,
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    fontColor: z.string().optional(),
    fill: z.string().optional(),
    numFmt: z.string().optional(),
    hAlign: z.enum(["left", "center", "right"]).optional(),
    vAlign: z.enum(["top", "center", "bottom"]).optional(),
    fontSize: z.number().min(1).max(409).optional(),
    fontFamily: z.string().min(1).max(100).optional(),
    indent: z.int().min(0).max(250).optional(),
    borders: z
      .object({
        top: borderSide.optional(),
        bottom: borderSide.optional(),
        left: borderSide.optional(),
        right: borderSide.optional(),
      })
      .optional(),
    wrap: z.boolean().optional(),
  },
  {
    error: (issue) =>
      issue.code === "unrecognized_keys"
        ? `style.set 多余字段：${issue.keys.join(", ")}。style.set 不传 sheet；表名写入 range，如 {"op":"style.set","range":"'汇总'!A1:D5","bold":true}。样式字段直接放在操作内，不嵌套 style。`
        : undefined,
  },
);
const mergeOp = z.strictObject({ op: z.literal("merge"), range: writeRange });
const unmergeOp = z.strictObject({ op: z.literal("unmerge"), range: writeRange });
const rowsInsert = z.strictObject({
  op: z.literal("rows.insert"),
  sheet: z.string().min(1),
  at: z.int().positive(),
  count: z.int().positive(),
});
const rowsDelete = z.strictObject({
  op: z.literal("rows.delete"),
  sheet: z.string().min(1),
  at: z.int().positive(),
  count: z.int().positive(),
});
const colsInsert = z.strictObject({
  op: z.literal("cols.insert"),
  sheet: z.string().min(1),
  at: z.int().positive(),
  count: z.int().positive(),
});
const colsDelete = z.strictObject({
  op: z.literal("cols.delete"),
  sheet: z.string().min(1),
  at: z.int().positive(),
  count: z.int().positive(),
});
const freezeOp = z.strictObject({
  op: z.literal("freeze"),
  sheet: z.string().min(1),
  rows: z.int().nonnegative(),
  cols: z.int().nonnegative(),
});
/** ADR 0002：同步等待进行中的公式重算完成（受工具 timeoutMs 约束），不产生写入。 */
const recalculateOp = z.strictObject({ op: z.literal("recalculate") });

const findReplace = z.strictObject({
  op: z.literal("find_replace"),
  range: z.string(),
  find: z.string().min(1).max(10000),
  replacement: z
    .string()
    .max(32767)
    .describe(
      "替换文本；regex=true 时支持 JS 替换标记 $1、$2、$&、$$、$<name>；否则全部按字面量处理",
    ),
  regex: z
    .boolean()
    .default(false)
    .describe(
      "find_replace 专用：true 时 find 是 JS 正则源文本，不含 / 分隔符；默认 false 为字面量。始终全局替换，大小写由 caseSensitive 控制",
    ),
  caseSensitive: z.boolean().default(false),
  formulas: z.boolean().default(false),
});
const axisHide = z.strictObject({
  op: z.literal("axis.hide"),
  sheet: z.string(),
  axis: z.enum(["rows", "cols"]),
  at: z.int().positive(),
  count: z.int().positive().max(10000),
  hidden: z.boolean(),
});
const axisGroup = z.strictObject({
  op: z.literal("axis.group"),
  sheet: z.string(),
  axis: z.enum(["rows", "cols"]),
  at: z.int().positive(),
  count: z.int().positive().max(10000),
  level: z.int().min(0).max(7),
});
const axisCollapse = z.strictObject({
  op: z.literal("axis.collapse"),
  sheet: z.string(),
  axis: z.enum(["rows", "cols"]),
  at: z.int().positive(),
  count: z.int().positive().max(10000),
  collapsed: z
    .boolean()
    .describe(
      "只改指定汇总行/列的折叠标记，不改 hidden 或分组层级；完整展开需同批 axis.hide hidden=false 和 axis.collapse collapsed=false",
    ),
});
const imageAdd = z.strictObject({
  op: z.literal("image.add"),
  sheet: z.string(),
  path: z.string().min(1),
  anchor: ImageObject.shape.anchor.default("E2"),
  width: z.int().min(1).max(4000).default(320),
  height: z.int().min(1).max(4000).default(240),
  title: z.string().max(500).default(""),
  offsetX: ImageObject.shape.offsetX,
  offsetY: ImageObject.shape.offsetY,
});
const imageUpdate = ImageObject.pick({
  anchor: true,
  width: true,
  height: true,
  offsetX: true,
  offsetY: true,
})
  .partial()
  .extend({
    op: z.literal("image.update"),
    sheet: z.string().min(1),
    id: z.string().min(1),
  })
  .strict();
const shapeFields = ShapeObject.omit({ id: true, drawingObjectId: true });
const shapeAdd = shapeFields
  .extend({
    op: z.literal("shape.add"),
    sheet: z.string().min(1),
    id: ShapeObject.shape.id.optional(),
    title: ShapeObject.shape.title.default(""),
    text: ShapeObject.shape.text.default(""),
    anchor: ShapeObject.shape.anchor.default("E2"),
    width: ShapeObject.shape.width.default(160),
    height: ShapeObject.shape.height.default(80),
    fill: ShapeObject.shape.fill.default("#4472C4"),
    stroke: ShapeObject.shape.stroke.default("#2F528F"),
    textColor: ShapeObject.shape.textColor.default("#FFFFFF"),
  })
  .strict();
const shapeUpdate = ShapeObject.pick({
  anchor: true,
  width: true,
  height: true,
  offsetX: true,
  offsetY: true,
})
  .partial()
  .extend({
    op: z.literal("shape.update"),
    sheet: z.string().min(1),
    id: z.string().min(1),
  })
  .strict();
const shapeDelete = z.strictObject({
  op: z.literal("shape.delete"),
  sheet: z.string().min(1),
  id: z.string().min(1),
});
const noteSet = z.strictObject({
  op: z.literal("note.set"),
  sheet: z.string().min(1),
  ref: z.string().regex(/^[A-Z]{1,3}[1-9][0-9]{0,6}$/),
  text: z.string().max(32767).nullable(),
  author: z.string().max(500).default(""),
});
const imageDelete = z.strictObject({
  op: z.literal("image.delete"),
  sheet: z.string().min(1),
  id: z.string().min(1),
});
const chartFields = ChartObject.omit({ id: true, chartPart: true, drawingPart: true }).extend({
  range: ChartObject.shape.range.describe(
    "chart.add/update 的数据区域必须位于目标 sheet；当前不支持跨表数据源。需要跨表看板时可在目标表建立公式引用的数据区域。",
  ),
});
const chartAdd = chartFields.extend({
  op: z.literal("chart.add"),
  sheet: z.string().min(1),
  id: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,100}$/)
    .optional(),
});
const chartUpdate = chartFields
  .extend({
    anchor: ChartObject.shape.anchor.removeDefault(),
    width: ChartObject.shape.width.removeDefault(),
    height: ChartObject.shape.height.removeDefault(),
  })
  .partial()
  .extend({ op: z.literal("chart.update"), sheet: z.string().min(1), id: z.string().min(1) });
const chartRemove = z.strictObject({
  op: z.literal("chart.delete"),
  sheet: z.string().min(1),
  id: z.string().min(1),
});
function validatePixelSize(
  input: { pixels?: number; mode?: "pixels"; value?: number },
  ctx: z.RefinementCtx,
) {
  if (input.pixels === undefined && !(input.mode === "pixels" && input.value !== undefined))
    ctx.addIssue({
      code: "custom",
      path: ["pixels"],
      message: "提供 pixels，或 mode:'pixels' 与 value",
    });
  if (input.value !== undefined && input.mode !== "pixels")
    ctx.addIssue({ code: "custom", path: ["mode"], message: "value 必须同时指定 mode:'pixels'" });
  if (input.pixels !== undefined && input.value !== undefined && input.pixels !== input.value)
    ctx.addIssue({
      code: "custom",
      path: ["value"],
      message: "pixels 与 value 不一致，不能确定目标尺寸",
    });
}
const rowHeight = z
  .strictObject({
    op: z.literal("rows.height"),
    axis: z.literal("rows").optional().describe("可省略；如提供，必须为 rows"),
    sheet: z.string(),
    at: z.int().positive(),
    count: z.int().positive(),
    pixels: z
      .number()
      .min(1)
      .max(1000)
      .optional()
      .describe("目标像素数；也可用 mode=pixels 与 value"),
    mode: z.literal("pixels").optional(),
    value: z.number().min(1).max(1000).optional(),
  })
  .superRefine(validatePixelSize);
const colWidth = z
  .strictObject({
    op: z.literal("cols.width"),
    axis: z.literal("cols").optional().describe("可省略；如提供，必须为 cols"),
    sheet: z.string(),
    at: z.int().positive(),
    count: z.int().positive(),
    pixels: z
      .number()
      .min(1)
      .max(2000)
      .optional()
      .describe("目标像素数；也可用 mode=pixels 与 value"),
    mode: z.literal("pixels").optional(),
    value: z.number().min(1).max(2000).optional(),
  })
  .superRefine(validatePixelSize);
const sortRange = z.strictObject({
  op: z.literal("sort"),
  range: z.string(),
  header: z.boolean().default(true),
  keys: z
    .array(z.object({ column: z.int().positive(), order: z.enum(["asc", "desc"]) }))
    .min(1)
    .max(32),
});
const ruleOperator = z.enum([
  "between",
  "notBetween",
  "equal",
  "notEqual",
  "greaterThan",
  "greaterThanOrEqual",
  "lessThan",
  "lessThanOrEqual",
]);
const cfSet = z.strictObject({
  op: z
    .literal("cf.add")
    .describe("新增规则置于最高优先级；批量多条按提交顺序后加者优先。同 id 更新也移到最高优先级。"),
  range: z.string(),
  id: z.string().optional(),
  kind: z.enum(["formula", "number", "blank", "duplicate", "unique", "dataBar", "colorScale"]),
  formula: z.string().optional(),
  operator: ruleOperator.optional(),
  values: z
    .array(z.number())
    .max(3)
    .optional()
    .describe(
      "number 条件的1或2个界值；dataBar 固定最小/最大值；colorScale 固定2或3个递增阈值；视觉规则省略时按数据最小/最大（3色中点50%分位）",
    ),
  colors: z
    .array(z.string().regex(/^#[0-9a-fA-F]{6}$/))
    .min(2)
    .max(3)
    .optional()
    .describe("仅 colorScale，按低到高提供2或3种颜色；dataBar 使用 fill 指定条颜色"),
  fill: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  fontColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  bold: z.boolean().optional(),
});
const cfRemove = z.strictObject({
  op: z.literal("cf.remove"),
  sheet: z.string(),
  id: z.string(),
});
const dvSet = z.strictObject({
  op: z.literal("dv.add"),
  range: z.string(),
  id: z.string().optional(),
  type: z.enum(["whole", "decimal", "list", "date", "time", "textLength", "custom"]),
  operator: ruleOperator.optional(),
  formula1: z
    .string()
    .describe(
      'list 使用逗号分隔选项，也接受 Excel 引号字符串（如 "待处理,完成"）；范围或名称引用以 = 开头。其他类型为比较值或公式。',
    ),
  formula2: z.string().optional(),
  allowBlank: z.boolean().default(true),
  error: z.string().max(255).optional(),
});
const dvRemove = z.strictObject({
  op: z.literal("dv.remove"),
  sheet: z.string(),
  id: z.string(),
});
const nameSet = z.strictObject({
  op: z.literal("name.set"),
  name: z.string().min(1).max(255),
  range: z
    .string()
    .describe("命名区域，带工作表名的 A1 区域；保存为绝对引用。可用于 dv.add 的 =名称。"),
  scope: z
    .string()
    .optional()
    .describe("可选作用域工作表名或 id；省略为工作簿级。相同名称与作用域则更新。"),
});
const printSet = z.strictObject({
  op: z.literal("print.set"),
  sheet: z.string().min(1),
  printArea: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe("单矩形 A1 区域，如 A1:F24；可带本表名。null 清除本表打印区域，省略保留。"),
  repeatRows: z
    .string()
    .regex(/^\$?[1-9]\d*:\$?[1-9]\d*$/)
    .nullable()
    .optional()
    .describe("重复标题整行，如 1:3（1–1048576）；保留已有重复标题列。null 仅清除重复行。"),
  afterRows: z
    .array(z.int().min(1).max(1048575))
    .max(1026)
    .nullable()
    .optional()
    .describe("完整替换手动水平分页：1 基第几行之后，例如 [10] 是第 10 行后；null 清除手动分页。"),
  afterColumns: z
    .array(z.int().min(1).max(16383))
    .max(1026)
    .nullable()
    .optional()
    .describe("完整替换手动垂直分页：1 基第几列之后，例如 [4] 是 D 列后；null 清除手动分页。"),
  paperSize: z
    .int()
    .positive()
    .max(65535)
    .nullable()
    .optional()
    .describe("OOXML paperSize 编号，9=A4；null 删除显式设置。"),
  orientation: z.enum(["default", "portrait", "landscape"]).nullable().optional(),
  fitToWidth: z
    .int()
    .min(0)
    .max(32767)
    .nullable()
    .optional()
    .describe("横向页数，0 不限；非 null 同时启用 fitToPage。"),
  fitToHeight: z
    .int()
    .min(0)
    .max(32767)
    .nullable()
    .optional()
    .describe("纵向页数，0 不限；非 null 同时启用 fitToPage。"),
  oddHeader: z
    .string()
    .max(32767)
    .nullable()
    .optional()
    .describe("Excel 原始页眉串，保留 &F/&A/&P/&N 动态字段；null 删除。"),
  oddFooter: z
    .string()
    .max(32767)
    .nullable()
    .optional()
    .describe("Excel 原始页脚串，保留 &F/&A/&P/&N 动态字段；null 删除。"),
});
export const ChangeOp = z.discriminatedUnion("op", [
  printSet,
  nameSet,
  pivotMarkRefreshOnLoad,
  tableAdd,
  tableColumnFormula,
  filterSet,
  hyperlinkSet,
  sheetCopy,
  sheetMove,
  sheetHide,
  cellsFill,
  axisSize,
  findReplace,
  axisHide,
  axisGroup,
  axisCollapse,
  imageAdd,
  imageUpdate,
  imageDelete,
  shapeAdd,
  shapeUpdate,
  shapeDelete,
  noteSet,
  cfSet,
  cfRemove,
  dvSet,
  dvRemove,
  chartAdd,
  chartUpdate,
  chartRemove,
  rowHeight,
  colWidth,
  sortRange,
  sheetAdd,
  sheetRename,
  sheetDelete,
  cellsSet,
  cellsClear,
  styleSet,
  mergeOp,
  unmergeOp,
  rowsInsert,
  rowsDelete,
  colsInsert,
  colsDelete,
  freezeOp,
  recalculateOp,
]);
export type ChangeOp = z.infer<typeof ChangeOp>;

// ---------- 编译 ----------

export interface CompiledCommand {
  id: string;
  params: Record<string, unknown>;
}

interface SheetCtx {
  id: string;
  data: IWorksheetData;
}

export interface CompiledOps {
  commands: CompiledCommand[];
  /** op 推导的写集（变换前坐标）。 */
  ranges: RangeRef[];
  structural: StructuralOp[];
  /** 写入的公式单元格 A1（sheet!A1）。 */
  formulas: string[];
  /** 写集估算单元格数（20 万格限制用；无界区域不计入）。 */
  estCells: number;
  /** 含需快照回滚的操作（remove-sheet）。 */
  needsSnapshot: boolean;
  sheetNames: Map<string, string>;
}

export class OpCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpCompileError";
  }
}

interface CompileCtx {
  preservation?: XlsxPreservation;
  images?: Record<string, { data: string; mediaType: ImageObject["mediaType"] }>;
  unitId: string;
  snapshot: IWorkbookData;
}

function resolveSheet(ctx: CompileCtx, idOrName: string | undefined): SheetCtx {
  const sheets = (ctx.snapshot.sheets ?? {}) as Record<string, IWorksheetData>;
  if (idOrName === undefined) {
    const first = ctx.snapshot.sheetOrder?.[0];
    const s = first ? sheets[first] : undefined;
    if (!first || !s) throw new OpCompileError("工作簿没有工作表");
    return { id: first, data: s };
  }
  if (sheets[idOrName]) return { id: idOrName, data: sheets[idOrName] as IWorksheetData };
  for (const [id, s] of Object.entries(sheets)) {
    if (s.name === idOrName) return { id, data: s };
  }
  throw new OpCompileError(`工作表不存在：${idOrName}`);
}

/** A1 区域（可带 Sheet! 前缀）→ 表 + 0 基矩形。 */
function regionOf(
  ctx: CompileCtx,
  a1: string,
  defaultSheet?: string,
): { sheet: SheetCtx; ref: RangeRef } {
  const parsed = parseRange(a1);
  if (
    parsed.sheet === undefined &&
    defaultSheet === undefined &&
    ctx.snapshot.sheetOrder.length > 1
  )
    throw new OpCompileError(
      `区域 ${a1} 缺少工作表名称。多表写入必须使用 '工作表名'!${a1}；新增工作表不会切换后续操作目标，请给每个区域指定表名。`,
    );
  const sheet = resolveSheet(ctx, parsed.sheet ?? defaultSheet);
  return {
    sheet,
    ref: {
      sheetId: sheet.id,
      r0: parsed.startRow - 1,
      c0: parsed.startCol - 1,
      r1: parsed.endRow - 1,
      c1: parsed.endCol - 1,
    },
  };
}

const univerRange = (r: RangeRef) => ({
  startRow: r.r0,
  startColumn: r.c0,
  endRow: r.r1,
  endColumn: r.c1,
});

const cellData = (v: string | number | boolean | null): Record<string, unknown> => {
  if (v === null) return { v: null };
  if (typeof v === "number") return { v, t: 2 };
  if (typeof v === "boolean") return { v, t: 3 };
  if (v.startsWith("=")) return { f: v };
  return { v, t: 1 };
};

/** cells.set 实际写入的矩形：range 左上角 + values 尺寸。 */
function cellsSetTarget(sheetId: string, ref: RangeRef, values: unknown[][]): RangeRef {
  const rows = values.length;
  const cols = Math.max(1, ...values.map((r) => r.length));
  return { sheetId, r0: ref.r0, c0: ref.c0, r1: ref.r0 + rows - 1, c1: ref.c0 + cols - 1 };
}

const HALIGN = { left: 1, center: 2, right: 3 } as const;

export function compileOps(ctx: CompileCtx, ops: ChangeOp[]): CompiledOps {
  ctx = { ...ctx, snapshot: structuredClone(ctx.snapshot) };
  // Validate every target before producing any command, even when cells.set precedes it.
  const pivotOps = ops.filter((op) => op.op === "pivot.mark_refresh_on_load");
  if (
    pivotOps.length &&
    ops.some((op) =>
      /^(rows|cols)\.(insert|delete)$|^sheet\.(rename|delete|copy|move)$/.test(op.op),
    )
  )
    throw new OpCompileError("透视缓存刷新标记不能与源结构变化同批提交");
  for (const op of pivotOps) {
    const sheet = resolveSheet(ctx, op.sheet);
    resolvePivotRefreshTarget(
      ctx.preservation?.parts ?? {},
      ctx.preservation?.sheetParts ?? {},
      ctx.snapshot,
      sheet.id,
      op.cacheId,
    );
  }
  const sheetNames = sheetNamesOf(ctx.snapshot);
  const commands: CompiledCommand[] = [];
  const ranges: RangeRef[] = [];
  const structural: StructuralOp[] = [];
  const formulas: string[] = [];
  let estCells = 0;
  let needsSnapshot = false;
  const unitId = ctx.unitId;

  for (const op of ops) {
    switch (op.op) {
      case "pivot.mark_refresh_on_load": {
        const sheet = resolveSheet(ctx, op.sheet);
        const objects = objectsOf(sheet.data);
        objects.pivotRefreshOnLoad = { ...objects.pivotRefreshOnLoad, [op.cacheId]: "true" };
        sheet.data.custom = { ...sheet.data.custom, excelmanusObjects: objects };
        commands.push({
          id: OBJECT_LAYER_MUTATION,
          params: { unitId, subUnitId: sheet.id, objects },
        });
        ranges.push({ sheetId: sheet.id, r0: 0, c0: 0, r1: MAX_R, c1: MAX_C });
        break;
      }
      case "print.set": {
        const sheet = resolveSheet(ctx, op.sheet);
        const settings = structuredClone(printSettingsOf(sheet.data));
        const parsedNames = printNamesOf(ctx.snapshot, sheet.id);
        const namePrefix = `'${sheet.data.name.replaceAll("'", "''")}'!`;
        const checkSupported = (field: string) => {
          if (
            settings.unsupported?.some(
              (key) =>
                key === "invalidPrintMetadata" || key === field || field.startsWith(`${key}.`),
            )
          )
            throw new OpCompileError(`打印设置 ${field} 含不支持的结构，仅保留，不能编辑`);
        };
        const setBuiltin = (builtin: string, formulaOrRefString: string | null) => {
          const names = namesOf(ctx.snapshot);
          const matches = Object.values(names).filter(
            (name) =>
              name.localSheetId === sheet.id && name.name.toLowerCase() === builtin.toLowerCase(),
          );
          if (matches.length > 1)
            throw new OpCompileError(`本表 ${builtin} 重复，不能确定编辑目标`);
          const old = matches[0];
          if (formulaOrRefString === null) {
            if (old) {
              delete names[old.id];
              commands.push({
                id: "formula.mutation.remove-defined-name",
                params: { unitId, id: old.id },
              });
            }
          } else {
            const id = old?.id ?? newId("name");
            const name = { ...old, id, name: builtin, localSheetId: sheet.id, formulaOrRefString };
            names[id] = name;
            commands.push({ id: "formula.mutation.set-defined-name", params: { unitId, ...name } });
          }
          setNames(ctx.snapshot, names);
        };
        if (op.printArea !== undefined) {
          let formula: string | null = null;
          if (op.printArea !== null) {
            const addressStart = op.printArea.lastIndexOf("!") + 1;
            const address = op.printArea.slice(addressStart).replaceAll("$", "");
            if (!/^[A-Z]{1,3}[1-9]\d*(?::[A-Z]{1,3}[1-9]\d*)?$/i.test(address))
              throw new OpCompileError("printArea 只支持单个矩形 A1 区域");
            const target = regionOf(ctx, op.printArea.slice(0, addressStart) + address, sheet.id);
            if (target.sheet.id !== sheet.id)
              throw new OpCompileError("printArea 必须属于指定的工作表");
            formula = `${namePrefix}$${indexToCol(target.ref.c0 + 1)}$${target.ref.r0 + 1}:$${indexToCol(target.ref.c1 + 1)}$${target.ref.r1 + 1}`;
          }
          setBuiltin("_xlnm.Print_Area", formula);
        }
        if (op.repeatRows !== undefined) {
          if (parsedNames.unsupported.includes("Print_Titles"))
            throw new OpCompileError("现有重复标题含不支持的引用，不能安全保留重复列");
          const refs: string[] = [];
          if (op.repeatRows !== null) {
            const [start, end] = op.repeatRows.replaceAll("$", "").split(":").map(Number);
            if (!start || !end || start > end || end > MAX_R + 1)
              throw new OpCompileError("repeatRows 必须是顺序有效的整行范围，如 1:3");
            refs.push(`${namePrefix}$${start}:$${end}`);
          }
          if (parsedNames.repeatColumns)
            refs.push(
              `${namePrefix}${parsedNames.repeatColumns
                .split(":")
                .map((col) => `$${col}`)
                .join(":")}`,
            );
          setBuiltin("_xlnm.Print_Titles", refs.length ? refs.join(",") : null);
        }
        for (const field of ["paperSize", "orientation", "fitToWidth", "fitToHeight"] as const) {
          if (op[field] === undefined) continue;
          checkSupported("pageSetup");
          const attrs = { ...settings.pageSetup };
          if (op[field] === null) delete attrs[field];
          else attrs[field] = String(op[field]);
          settings.pageSetup = attrs;
          if ((field === "fitToWidth" || field === "fitToHeight") && op[field] !== null) {
            checkSupported("pageSetUpPr");
            settings.pageSetUpPr = { ...settings.pageSetUpPr, fitToPage: "1" };
          }
        }
        for (const field of ["oddHeader", "oddFooter"] as const) {
          if (op[field] === undefined) continue;
          checkSupported(`headerFooter.${field}`);
          settings.headerFooter ??= { attributes: {} };
          if (op[field] === null) delete settings.headerFooter[field];
          else settings.headerFooter[field] = op[field];
        }
        for (const [field, key, max] of [
          ["afterRows", "rowBreaks", MAX_C],
          ["afterColumns", "colBreaks", MAX_R],
        ] as const) {
          if (op[field] === undefined) continue;
          checkSupported(key);
          const positions = [...new Set(op[field] ?? [])].sort((a, b) => a - b);
          // Replace manual breaks only; implicit/automatic breaks remain untouched.
          const automatic =
            settings[key]?.breaks.filter((entry) => entry.man !== "1" && entry.man !== "true") ??
            [];
          const entries = [
            ...automatic,
            ...positions.map((id) => ({ id: String(id), min: "0", max: String(max), man: "1" })),
          ];
          settings[key] = {
            attributes: {
              ...settings[key]?.attributes,
              count: String(entries.length),
              manualBreakCount: String(positions.length),
            },
            breaks: entries,
          };
        }
        sheet.data.custom = { ...sheet.data.custom, excelmanusPrintSettings: settings };
        commands.push({
          id: PRINT_STATE_MUTATION,
          params: { unitId, subUnitId: sheet.id, settings },
        });
        ranges.push({ sheetId: sheet.id, r0: 0, c0: 0, r1: MAX_R, c1: MAX_C });
        break;
      }
      case "name.set": {
        if (/^_xlnm\.Print_(Area|Titles)$/i.test(op.name))
          throw new OpCompileError("打印内置名称请使用 print.set，避免丢失整行标题或工作表作用域");
        if (
          !/^[\p{L}_\\][\p{L}\p{N}_.\\]*$/u.test(op.name) ||
          /^(?:[A-Z]{1,3}[1-9]\d*|R\d+C\d+|R|C)$/i.test(op.name)
        )
          throw new OpCompileError("定义名不能是单元格地址，需以文字或下划线开头");
        const addressStart = op.range.lastIndexOf("!") + 1;
        const { sheet, ref } = regionOf(
          ctx,
          op.range.slice(0, addressStart) + op.range.slice(addressStart).replaceAll("$", ""),
        );
        const localSheetId = op.scope ? resolveSheet(ctx, op.scope).id : undefined;
        const names = namesOf(ctx.snapshot);
        const old = Object.values(names).find(
          (n) =>
            n.name.toLowerCase() === op.name.toLowerCase() &&
            (n.localSheetId === "AllDefaultWorkbook" ? undefined : n.localSheetId) === localSheetId,
        );
        const id = old?.id ?? newId("name");
        const formulaOrRefString = `'${sheet.data.name.replaceAll("'", "''")}'!$${indexToCol(ref.c0 + 1)}$${ref.r0 + 1}:$${indexToCol(ref.c1 + 1)}$${ref.r1 + 1}`;
        const name = {
          ...old,
          id,
          name: op.name,
          formulaOrRefString,
          ...(localSheetId ? { localSheetId } : {}),
        };
        setNames(ctx.snapshot, { ...names, [id]: name });
        commands.push({ id: "formula.mutation.set-defined-name", params: { unitId, ...name } });
        for (const sheetId of ctx.snapshot.sheetOrder)
          ranges.push({ sheetId, r0: 0, c0: 0, r1: MAX_R, c1: MAX_C });
        needsSnapshot = true;
        break;
      }
      case "table.add":
      case "table.column_formula": {
        const all = tablesOf(ctx.snapshot);
        const sheet =
          op.op === "table.add" ? regionOf(ctx, op.range).sheet : resolveSheet(ctx, op.sheet);
        const tables = all[sheet.id]?.tables ?? [];
        let table: ITableJson | undefined;
        let changedColumns: number[];
        if (op.op === "table.add") {
          if (
            !/^[\p{L}_][\p{L}\p{N}_.]*$/u.test(op.name) ||
            /^(?:[A-Z]{1,3}\d+|R\d+C\d+|R|C)$/i.test(op.name)
          )
            throw new OpCompileError("表名称不能是单元格地址，需以文字或下划线开头");
          if (
            Object.values(all).some((s) =>
              s.tables.some((t) => t.name.toLowerCase() === op.name.toLowerCase()),
            )
          )
            throw new OpCompileError("表名称已存在");
          const { ref } = regionOf(ctx, op.range);
          if (ref.r1 <= ref.r0 || ref.c1 - ref.c0 + 1 !== op.columns.length)
            throw new OpCompileError("表范围需包含表头和数据行，columns 数量须与区域列数一致");
          if ((ref.r1 - ref.r0 + 1) * op.columns.length > 200000)
            throw new OpCompileError("单次表对象操作最多20万格");
          if (new Set(op.columns.map((c) => c.name.toLowerCase())).size !== op.columns.length)
            throw new OpCompileError("表列名称不能重复");
          const range = univerRange(ref);
          const overlaps = (r: typeof range) =>
            r.startRow <= range.endRow &&
            r.endRow >= range.startRow &&
            r.startColumn <= range.endColumn &&
            r.endColumn >= range.startColumn;
          if (tables.some((t) => overlaps(t.range)) || (sheet.data.mergeData ?? []).some(overlaps))
            throw new OpCompileError("表范围不能与已有表或合并单元格重叠");
          table = {
            id: newId("tbl"),
            name: op.name,
            range,
            options: {
              showHeader: true,
              showFooter: false,
              showAutoFilter: true,
              tableStyleId: "table-default-0",
            },
            columns: op.columns.map((c, i) => ({
              id: String(i + 1),
              displayName: c.name,
              dataType: TableColumnDataTypeEnum.None,
              formula: c.formula ?? "",
              meta: {},
              style: {},
            })),
            filters: {},
            meta: {},
          };
          tables.push(table);
          commands.push({
            id: "sheet.mutation.set-range-values",
            params: {
              unitId,
              subUnitId: sheet.id,
              cellValue: {
                [ref.r0]: Object.fromEntries(
                  op.columns.map((c, i) => [
                    ref.c0 + i,
                    { v: c.name, f: null, si: null, p: null, t: 1 },
                  ]),
                ),
              },
              trigger: "excelmanus.table-edit",
            },
          });
          changedColumns = op.columns.flatMap((c, i) => (c.formula ? [i] : []));
        } else {
          table = tables.find((t) => t.name.toLowerCase() === op.table.toLowerCase());
          if (!table)
            throw new OpCompileError("表对象不存在；先用 workbook_read overview 核对表对象名称");
          const index = table.columns.findIndex(
            (c) => c.displayName.toLowerCase() === op.column.toLowerCase(),
          );
          if (index < 0) throw new OpCompileError("计算列名称不存在");
          table.columns[index]!.formula = op.formula;
          changedColumns = [index];
        }
        const first = table.range.startRow + (table.options.showHeader === false ? 0 : 1);
        const last = table.range.endRow - (table.options.showFooter ? 1 : 0);
        if (last < first || (last - first + 1) * Math.max(1, changedColumns.length) > 200000)
          throw new OpCompileError("计算列范围无效或超过20万格");
        all[sheet.id] = { ...all[sheet.id], tables };
        const cellValue: Record<
          number,
          Record<number, { f: string; v: null; si: null; p: null }>
        > = {};
        for (const i of changedColumns)
          for (let r = first; r <= last; r++) {
            const c = table.range.startColumn + i;
            cellValue[r] ??= {};
            let f = shiftFormula(table.columns[i]!.formula, 0, r - first);
            // Use the engine-compatible current-row spelling without losing table references.
            for (const [sid, entry] of Object.entries(all))
              for (const t of entry.tables) {
                const reference = {
                  name: t.name,
                  sheet: ctx.snapshot.sheets[sid]!.name ?? sid,
                  range: t.range,
                  columns: t.columns.map((column) => column.displayName),
                  showHeader: t.options.showHeader !== false,
                  showFooter: !!t.options.showFooter,
                };
                f = rewriteTableReferences(
                  f,
                  reference,
                  reference,
                  r,
                  sid === sheet.id && t.id === table.id,
                  true,
                );
              }
            cellValue[r]![c] = {
              f,
              v: null,
              si: null,
              p: null,
            };
            formulas.push(`${sheet.data.name ?? sheet.id}!${indexToCol(c + 1)}${r + 1}`);
          }
        setTables(ctx.snapshot, all);
        commands.push({
          id: TABLE_STATE_MUTATION,
          params: { unitId, subUnitId: sheet.id, tables: structuredClone(tables) },
        });
        if (changedColumns.length)
          commands.push({
            id: "sheet.mutation.set-range-values",
            params: { unitId, subUnitId: sheet.id, cellValue, trigger: "excelmanus.table-edit" },
          });
        ranges.push({ sheetId: sheet.id, r0: 0, c0: 0, r1: MAX_R, c1: MAX_C });
        estCells += (last - first + 1) * changedColumns.length + table.columns.length;
        needsSnapshot = true;
        break;
      }
      case "note.set": {
        const sheet = resolveSheet(ctx, op.sheet);
        const objects = objectsOf(sheet.data);
        objects.notes = (objects.notes ?? []).filter((note) => note.ref !== op.ref);
        if (op.text !== null) objects.notes.push({ ref: op.ref, text: op.text, author: op.author });
        sheet.data.custom = { ...sheet.data.custom, excelmanusObjects: objects };
        commands.push({
          id: OBJECT_LAYER_MUTATION,
          params: { unitId, subUnitId: sheet.id, objects },
        });
        ranges.push({ sheetId: sheet.id, r0: 0, c0: 0, r1: MAX_R, c1: MAX_C });
        break;
      }
      case "image.delete": {
        const sheet = resolveSheet(ctx, op.sheet);
        const objects = objectsOf(sheet.data);
        if (!objects.images.some((image) => image.id === op.id))
          throw new OpCompileError("图片不存在");
        objects.images = objects.images.filter((image) => image.id !== op.id);
        sheet.data.custom = { ...sheet.data.custom, excelmanusObjects: objects };
        commands.push({
          id: OBJECT_LAYER_MUTATION,
          params: { unitId, subUnitId: sheet.id, objects },
        });
        ranges.push({ sheetId: sheet.id, r0: 0, c0: 0, r1: MAX_R, c1: MAX_C });
        break;
      }
      case "image.update":
      case "shape.add":
      case "shape.update":
      case "shape.delete": {
        const sheet = resolveSheet(ctx, op.sheet);
        const objects = objectsOf(sheet.data);
        if (op.op === "image.update") {
          const image = objects.images.find((item) => item.id === op.id);
          if (!image) throw new OpCompileError("图片不存在");
          const { op: _op, sheet: _sheet, id: _id, ...patch } = op;
          Object.assign(
            image,
            patch,
            op.anchor !== undefined ? { offsetX: op.offsetX ?? 0, offsetY: op.offsetY ?? 0 } : {},
          );
        } else {
          const shapes = objects.shapes ?? [];
          objects.shapes = shapes;
          if (op.op === "shape.add") {
            const id = op.id ?? newId("shape");
            if (shapes.some((item) => item.id === id)) throw new OpCompileError("形状 ID 已存在");
            shapes.push(ShapeObject.parse({ ...op, id }));
          } else {
            const shape = shapes.find((item) => item.id === op.id);
            if (!shape)
              throw new OpCompileError(
                "该 ID 不属于当前可编辑形状；复杂或未知绘图仅保留，不支持修改。请先读取 objects 与 preserved.drawings",
              );
            if (op.op === "shape.delete")
              objects.shapes = shapes.filter((item) => item.id !== op.id);
            else {
              const { op: _op, sheet: _sheet, id: _id, ...patch } = op;
              Object.assign(
                shape,
                patch,
                op.anchor !== undefined
                  ? { offsetX: op.offsetX ?? 0, offsetY: op.offsetY ?? 0 }
                  : {},
              );
            }
          }
        }
        sheet.data.custom = { ...sheet.data.custom, excelmanusObjects: objects };
        commands.push({
          id: OBJECT_LAYER_MUTATION,
          params: { unitId, subUnitId: sheet.id, objects },
        });
        ranges.push({ sheetId: sheet.id, r0: 0, c0: 0, r1: MAX_R, c1: MAX_C });
        break;
      }
      case "image.add": {
        const sheet = resolveSheet(ctx, op.sheet),
          image = ctx.images?.[op.path];
        if (!image) throw new OpCompileError("图片必须是工作区内可读取的 PNG/JPEG/GIF 文件");
        parseRange(op.anchor);
        const objects = objectsOf(sheet.data);
        objects.images.push(
          ImageObject.parse({
            id: newId("img"),
            title: op.title,
            anchor: op.anchor,
            width: op.width,
            height: op.height,
            offsetX: op.offsetX,
            offsetY: op.offsetY,
            ...image,
          }),
        );
        sheet.data.custom = { ...sheet.data.custom, excelmanusObjects: objects };
        commands.push({
          id: OBJECT_LAYER_MUTATION,
          params: { unitId, subUnitId: sheet.id, objects },
        });
        ranges.push({ sheetId: sheet.id, r0: 0, c0: 0, r1: MAX_R, c1: MAX_C });
        break;
      }
      case "cf.add":
      case "dv.add": {
        const { sheet, ref } = regionOf(ctx, op.range);
        const isCf = op.op === "cf.add";
        const resource = isCf ? CF_RESOURCE : DV_RESOURCE;
        const stored = rulesResource(ctx.snapshot, resource);
        const rules = stored[sheet.id] ?? [];
        const id = op.id ?? newId(isCf ? "cf" : "dv");
        const old = rules.find((r) => (isCf ? r.cfId : r.uid) === id);
        if (old)
          commands.push({
            id: isCf
              ? "sheet.mutation.delete-conditional-rule"
              : "data-validation.mutation.removeRule",
            params: { unitId, subUnitId: sheet.id, ...(isCf ? { cfId: id } : { ruleId: id }) },
          });
        let rule: Record<string, unknown>;
        if (op.op === "cf.add") {
          if (op.kind === "dataBar" || op.kind === "colorScale") {
            rule = {
              cfId: id,
              ranges: [univerRange(ref)],
              stopIfTrue: false,
              rule: visualToolRule(op),
            };
          } else {
            if (op.fill === undefined && op.fontColor === undefined && op.bold === undefined)
              throw new OpCompileError("条件格式至少需要一个样式字段");
            const style = {
              ...(op.fill ? { bg: { rgb: op.fill } } : {}),
              ...(op.fontColor ? { cl: { rgb: op.fontColor } } : {}),
              ...(op.bold !== undefined ? { bl: op.bold ? 1 : 0 } : {}),
            };
            let condition: Record<string, unknown>;
            if (op.kind === "formula") {
              if (!op.formula) throw new OpCompileError("公式条件格式需要 formula");
              condition = {
                subType: "formula",
                value: op.formula.startsWith("=") ? op.formula : `=${op.formula}`,
              };
            } else if (op.kind === "number") {
              const between = op.operator === "between" || op.operator === "notBetween";
              if (!op.operator || op.values?.length !== (between ? 2 : 1))
                throw new OpCompileError("数值条件格式需要 operator 及相应1或2个 values");
              condition = {
                subType: "number",
                operator: op.operator,
                value: between ? op.values : op.values[0],
              };
            } else if (op.kind === "blank")
              condition = { subType: "text", operator: "containsBlanks" };
            else
              condition = { subType: op.kind === "duplicate" ? "duplicateValues" : "uniqueValues" };
            rule = {
              cfId: id,
              ranges: [univerRange(ref)],
              stopIfTrue: false,
              rule: { type: "highlightCell", ...condition, style },
            };
          }
        } else {
          if ((op.operator === "between" || op.operator === "notBetween") && !op.formula2)
            throw new OpCompileError("区间验证需要 formula2");
          rule = normalizeDataValidationRule({
            uid: id,
            ranges: [univerRange(ref)],
            type: op.type,
            operator: op.operator ?? "between",
            formula1:
              op.type === "list" && /^=?"(?:[^"]|"")*"$/.test(op.formula1)
                ? op.formula1.replace(/^=/, "").slice(1, -1).replaceAll('""', '"')
                : op.formula1,
            ...(op.formula2 ? { formula2: op.formula2 } : {}),
            allowBlank: op.allowBlank,
            showErrorMessage: true,
            errorStyle: "stop",
            showDropDown: true,
            error: op.error ?? "输入不满足数据验证规则",
          });
        }
        stored[sheet.id] = [...rules.filter((r) => (isCf ? r.cfId : r.uid) !== id), rule];
        setRulesResource(ctx.snapshot, resource, stored);
        commands.push({
          id: isCf ? "sheet.mutation.add-conditional-rule" : "data-validation.mutation.addRule",
          params: { unitId, subUnitId: sheet.id, rule },
        });
        ranges.push(ref);
        break;
      }
      case "cf.remove":
      case "dv.remove": {
        const sheet = resolveSheet(ctx, op.sheet);
        const isCf = op.op === "cf.remove";
        const name = isCf ? CF_RESOURCE : DV_RESOURCE;
        const stored = rulesResource(ctx.snapshot, name),
          rules = stored[sheet.id] ?? [];
        const rule = rules.find((r) => (isCf ? r.cfId : r.uid) === op.id);
        if (!rule) throw new OpCompileError("规则不存在");
        stored[sheet.id] = rules.filter((r) => (isCf ? r.cfId : r.uid) !== op.id);
        setRulesResource(ctx.snapshot, name, stored);
        commands.push({
          id: isCf
            ? "sheet.mutation.delete-conditional-rule"
            : "data-validation.mutation.removeRule",
          params: { unitId, subUnitId: sheet.id, ...(isCf ? { cfId: op.id } : { ruleId: op.id }) },
        });
        ranges.push({ sheetId: sheet.id, r0: 0, c0: 0, r1: MAX_R, c1: MAX_C });
        break;
      }
      case "chart.add":
      case "chart.update":
      case "chart.delete": {
        const sheet = resolveSheet(ctx, op.sheet);
        const objects = objectsOf(sheet.data);
        const id = op.op === "chart.add" ? (op.id ?? newId("chrt")) : op.id;
        const existing = objects.charts.find((c) => c.id === id);
        if (op.op === "chart.add" && existing) throw new OpCompileError("图表 ID 已存在");
        if (op.op !== "chart.add" && !existing) throw new OpCompileError("图表不存在");
        if (op.op === "chart.delete") objects.charts = objects.charts.filter((c) => c.id !== id);
        else {
          const { op: _op, sheet: _sheet, ...fields } = op;
          const chart = ChartObject.parse({ ...existing, ...fields, id });
          const range = parseRange(chart.range);
          if (range.sheet && range.sheet !== sheet.id && range.sheet !== sheet.data.name)
            throw new OpCompileError("图表数据必须属于目标工作表");
          if (range.endRow <= range.startRow || range.endCol <= range.startCol)
            throw new OpCompileError("图表区域需包含标题行、分类列和数据");
          chart.range = `${indexToCol(range.startCol)}${range.startRow}:${indexToCol(range.endCol)}${range.endRow}`;
          if (existing) objects.charts = objects.charts.map((c) => (c.id === id ? chart : c));
          else objects.charts.push(chart);
        }
        sheet.data.custom = { ...sheet.data.custom, excelmanusObjects: objects };
        commands.push({
          id: OBJECT_LAYER_MUTATION,
          params: { unitId, subUnitId: sheet.id, objects },
        });
        ranges.push({ sheetId: sheet.id, r0: 0, c0: 0, r1: MAX_R, c1: MAX_C });
        break;
      }
      case "axis.hide":
      case "axis.group":
      case "axis.collapse": {
        const sheet = resolveSheet(ctx, op.sheet),
          rows = op.axis === "rows";
        const end = op.at + op.count - 2;
        if (end > (rows ? MAX_R : MAX_C)) throw new OpCompileError("行列区域越界");
        const range = {
          startRow: rows ? op.at - 1 : 0,
          endRow: rows ? end : MAX_R,
          startColumn: rows ? 0 : op.at - 1,
          endColumn: rows ? MAX_C : end,
        };
        if (op.op === "axis.hide")
          commands.push({
            id: `sheet.mutation.set-${rows ? "row" : "col"}-${op.hidden ? "hidden" : "visible"}`,
            params: { unitId, subUnitId: sheet.id, ranges: [range] },
          });
        else
          commands.push({
            id: AXIS_GROUP_MUTATION,
            params: {
              unitId,
              subUnitId: sheet.id,
              axis: op.axis,
              [op.op === "axis.group" ? "levels" : "collapsed"]: Object.fromEntries(
                Array.from({ length: op.count }, (_, i) => [
                  op.at - 1 + i,
                  op.op === "axis.group" ? op.level : op.collapsed,
                ]),
              ),
            },
          });
        ranges.push({
          sheetId: sheet.id,
          r0: range.startRow,
          r1: range.endRow,
          c0: range.startColumn,
          c1: range.endColumn,
        });
        break;
      }
      case "rows.height":
      case "cols.width": {
        const sheet = resolveSheet(ctx, op.sheet);
        const rows = op.op === "rows.height";
        const pixels = op.pixels ?? op.value;
        if (pixels === undefined) throw new OpCompileError("缺少像素尺寸");
        const range = {
          startRow: rows ? op.at - 1 : 0,
          endRow: rows ? op.at + op.count - 2 : MAX_R,
          startColumn: rows ? 0 : op.at - 1,
          endColumn: rows ? MAX_C : op.at + op.count - 2,
        };
        if ((rows ? range.endRow : range.endColumn) > (rows ? MAX_R : MAX_C))
          throw new OpCompileError("尺寸区域越界");
        commands.push({
          id: rows
            ? "sheet.mutation.set-worksheet-row-height"
            : "sheet.mutation.set-worksheet-col-width",
          params: {
            unitId,
            subUnitId: sheet.id,
            ranges: [range],
            ...(rows ? { rowHeight: pixels } : { colWidth: pixels }),
          },
        });
        ranges.push({
          sheetId: sheet.id,
          r0: range.startRow,
          r1: range.endRow,
          c0: range.startColumn,
          c1: range.endColumn,
        });
        break;
      }
      case "sort": {
        const { sheet, ref } = regionOf(ctx, op.range);
        assertSortableRange(
          { ...univerRange(ref), startRow: ref.r0 + (op.header ? 1 : 0) },
          sheet.data.mergeData ?? [],
        );
        if (op.keys.some((key) => key.column < ref.c0 + 1 || key.column > ref.c1 + 1))
          throw new OpCompileError("排序键必须在目标区域内，列号从1开始");
        commands.push({
          id: "sheet.command.sort-range",
          params: {
            unitId,
            subUnitId: sheet.id,
            range: univerRange(ref),
            hasTitle: op.header,
            orderRules: op.keys.map((key) => ({ colIndex: key.column - 1, type: key.order })),
          },
        });
        ranges.push(ref);
        estCells += (ref.r1 - ref.r0 + 1) * (ref.c1 - ref.c0 + 1);
        needsSnapshot = true;
        break;
      }
      case "filter.set": {
        if (op.clear && op.columns.length)
          throw new OpCompileError(
            "clear=true 表示移除筛选，不能同时设置 columns；设置筛选请用 clear=false",
          );
        const { sheet, ref } = regionOf(ctx, op.range);
        if (
          ref.r1 <= ref.r0 ||
          (ref.r1 - ref.r0 + 1) * (ref.c1 - ref.c0 + 1) > 200000 ||
          op.columns.some((c) => c.column - 1 < ref.c0 || c.column - 1 > ref.c1)
        )
          throw new OpCompileError("筛选区域须含表头和明细，最多20万格，筛选列须在区域内");
        commands.push({
          id: FILTER_COMMAND,
          params: { ...op, unitId, subUnitId: sheet.id, range: univerRange(ref) },
        });
        ranges.push(ref);
        needsSnapshot = true;
        break;
      }
      case "hyperlink.set": {
        const { sheet, ref } = regionOf(ctx, op.range);
        if (ref.r0 !== ref.r1 || ref.c0 !== ref.c1)
          throw new OpCompileError("超链接一次指定一个单元格");
        if (ref.r1 >= sheet.data.rowCount) {
          sheet.data.rowCount = ref.r1 + 1;
          commands.push({
            id: "sheet.mutation.set-worksheet-row-count",
            params: { unitId, subUnitId: sheet.id, rowCount: sheet.data.rowCount },
          });
        }
        if (ref.c1 >= sheet.data.columnCount) {
          sheet.data.columnCount = ref.c1 + 1;
          commands.push({
            id: "sheet.mutation.set-worksheet-column-count",
            params: { unitId, subUnitId: sheet.id, columnCount: sheet.data.columnCount },
          });
        }
        commands.push({
          id: LINK_COMMAND,
          params: { ...op, unitId, subUnitId: sheet.id, row: ref.r0, col: ref.c0 },
        });
        ranges.push(ref);
        break;
      }
      case "cells.fill": {
        const { sheet, ref } = regionOf(ctx, op.range),
          source = regionOf(ctx, op.source);
        if (source.sheet.id !== sheet.id) throw new OpCompileError("填充源和目标须在同一工作表");
        if ((ref.r1 - ref.r0 + 1) * (ref.c1 - ref.c0 + 1) > 200000)
          throw new OpCompileError("填充最多20万格");
        if (ref.r1 >= sheet.data.rowCount) {
          sheet.data.rowCount = ref.r1 + 1;
          commands.push({
            id: "sheet.mutation.set-worksheet-row-count",
            params: { unitId, subUnitId: sheet.id, rowCount: sheet.data.rowCount },
          });
        }
        if (ref.c1 >= sheet.data.columnCount) {
          sheet.data.columnCount = ref.c1 + 1;
          commands.push({
            id: "sheet.mutation.set-worksheet-column-count",
            params: { unitId, subUnitId: sheet.id, columnCount: sheet.data.columnCount },
          });
        }
        commands.push({
          id: FILL_COMMAND,
          params: {
            unitId,
            subUnitId: sheet.id,
            sourceRange: univerRange(source.ref),
            targetRange: univerRange(ref),
            applyType: op.mode === "series" ? "SERIES" : "COPY",
          },
        });
        ranges.push(ref);
        needsSnapshot = true;
        break;
      }
      case "axis.size": {
        const sheet = resolveSheet(ctx, op.sheet);
        const { pixels, ...size } = op;
        const value = op.value ?? pixels;
        if (
          op.at + op.count - 2 > (op.axis === "rows" ? MAX_R : MAX_C) ||
          (op.mode !== "auto" && value === undefined)
        )
          throw new OpCompileError("尺寸参数无效");
        commands.push({
          id: AXIS_SIZE_COMMAND,
          params: { ...size, value, unitId, subUnitId: sheet.id },
        });
        ranges.push({
          sheetId: sheet.id,
          r0: op.axis === "rows" ? op.at - 1 : 0,
          r1: op.axis === "rows" ? op.at + op.count - 2 : MAX_R,
          c0: op.axis === "cols" ? op.at - 1 : 0,
          c1: op.axis === "cols" ? op.at + op.count - 2 : MAX_C,
        });
        break;
      }
      case "find_replace": {
        try {
          findReplacePattern(op.find, op.regex, op.caseSensitive);
        } catch {
          throw new OpCompileError(
            "find_replace.find 正则表达式无效；请检查括号、转义及字符组，不要包含 / 分隔符",
          );
        }
        const { sheet, ref } = regionOf(ctx, op.range);
        const size = (ref.r1 - ref.r0 + 1) * (ref.c1 - ref.c0 + 1);
        if (size > 200000) throw new OpCompileError("查找替换单次最多20万格");
        commands.push({
          id: FIND_REPLACE_COMMAND,
          params: { ...op, unitId, subUnitId: sheet.id, range: univerRange(ref) },
        });
        ranges.push(ref);
        estCells += size;
        break;
      }
      case "cells.set": {
        const { sheet, ref } = regionOf(ctx, op.range);
        // 只写 values 覆盖的矩形（以 range 左上角为锚点）；range 多出的部分不动（P1-34）
        const target = cellsSetTarget(sheet.id, ref, op.values);
        const value = Array.from({ length: target.r1 - target.r0 + 1 }, (_, i) =>
          Array.from({ length: target.c1 - target.c0 + 1 }, (_, j) =>
            cellData(op.values[i]?.[j] ?? null),
          ),
        );
        for (let i = 0; i < value.length; i++) {
          for (let j = 0; j < (value[i] as unknown[]).length; j++) {
            const cell = value[i]?.[j] as Record<string, unknown> | undefined;
            if (typeof cell?.f === "string") {
              formulas.push(
                `${sheet.data.name ?? sheet.id}!${indexToCol(target.c0 + j + 1)}${target.r0 + i + 1}`,
              );
            }
          }
        }
        if (target.r1 >= (sheet.data.rowCount ?? 1)) {
          sheet.data.rowCount = target.r1 + 1;
          commands.push({
            id: "sheet.mutation.set-worksheet-row-count",
            params: { unitId, subUnitId: sheet.id, rowCount: sheet.data.rowCount },
          });
        }
        if (target.c1 >= (sheet.data.columnCount ?? 1)) {
          sheet.data.columnCount = target.c1 + 1;
          commands.push({
            id: "sheet.mutation.set-worksheet-column-count",
            params: { unitId, subUnitId: sheet.id, columnCount: sheet.data.columnCount },
          });
        }
        commands.push({
          id: "sheet.command.set-range-values",
          params: { unitId, subUnitId: sheet.id, range: univerRange(target), value },
        });
        ranges.push(target);
        estCells += (target.r1 - target.r0 + 1) * (target.c1 - target.c0 + 1);
        break;
      }
      case "cells.clear": {
        const { sheet, ref } = regionOf(ctx, op.range);
        const id =
          op.what === "contents"
            ? "sheet.command.clear-selection-content"
            : op.what === "formats"
              ? "sheet.command.clear-selection-format"
              : "sheet.command.clear-selection-all";
        // 整列/整行清除只把已用区域交给 Univer，写集仍保留原区域供冲突判断。
        const used = {
          ...ref,
          r1: Math.min(ref.r1, (sheet.data.rowCount ?? 1) - 1),
          c1: Math.min(ref.c1, (sheet.data.columnCount ?? 1) - 1),
        };
        if (used.r1 >= used.r0 && used.c1 >= used.c0)
          commands.push({
            id,
            params: { unitId, subUnitId: sheet.id, ranges: [univerRange(used)] },
          });
        ranges.push(ref);
        estCells += (used.r1 - used.r0 + 1) * (used.c1 - used.c0 + 1);
        break;
      }
      case "style.set": {
        const { sheet, ref } = regionOf(ctx, op.range);
        const styles: Array<{ type: string; value: unknown }> = [];
        if (op.bold !== undefined) styles.push({ type: "bl", value: op.bold ? 1 : 0 });
        if (op.italic !== undefined) styles.push({ type: "it", value: op.italic ? 1 : 0 });
        if (op.fontColor !== undefined) styles.push({ type: "cl", value: { rgb: op.fontColor } });
        if (op.fill !== undefined) styles.push({ type: "bg", value: { rgb: op.fill } });
        if (op.numFmt !== undefined) styles.push({ type: "n", value: { pattern: op.numFmt } });
        if (op.hAlign !== undefined) styles.push({ type: "ht", value: HALIGN[op.hAlign] });
        if (op.fontSize !== undefined) styles.push({ type: "fs", value: op.fontSize });
        if (op.indent !== undefined) styles.push({ type: "pd", value: { l: op.indent * 21 } });
        if (op.fontFamily !== undefined) styles.push({ type: "ff", value: op.fontFamily });
        if (op.vAlign !== undefined)
          styles.push({ type: "vt", value: { top: 1, center: 2, bottom: 3 }[op.vAlign] });
        if (op.borders !== undefined)
          styles.push({
            type: "bd",
            value: Object.fromEntries(
              Object.entries(op.borders).map(([key, value]) => [
                { top: "t", bottom: "b", left: "l", right: "r" }[key],
                value ? { s: BORDER_STYLES.indexOf(value.style), cl: { rgb: value.color } } : null,
              ]),
            ),
          });
        if (op.wrap !== undefined) styles.push({ type: "tb", value: op.wrap ? 3 : 2 });
        if (styles.length === 0) throw new OpCompileError("style.set 没有提供任何样式字段");
        for (const style of styles) {
          commands.push({
            id: "sheet.command.set-style",
            params: { unitId, subUnitId: sheet.id, range: univerRange(ref), style },
          });
        }
        ranges.push(ref);
        estCells += (ref.r1 - ref.r0 + 1) * (ref.c1 - ref.c0 + 1);
        break;
      }
      case "merge": {
        const { sheet, ref } = regionOf(ctx, op.range);
        commands.push({
          id: "sheet.command.add-worksheet-merge",
          params: {
            unitId,
            subUnitId: sheet.id,
            selections: [univerRange(ref)],
            defaultMerge: true,
          },
        });
        ranges.push(ref);
        break;
      }
      case "unmerge": {
        const { sheet, ref } = regionOf(ctx, op.range);
        commands.push({
          id: "sheet.command.remove-worksheet-merge",
          params: { unitId, subUnitId: sheet.id, ranges: [univerRange(ref)] },
        });
        ranges.push(ref);
        break;
      }
      case "rows.insert":
      case "rows.delete": {
        const sheet = resolveSheet(ctx, op.sheet);
        const index = op.at - 1;
        const lastCol = Math.max(0, (sheet.data.columnCount ?? 1) - 1);
        const range = {
          startRow: index,
          endRow: index + op.count - 1,
          startColumn: 0,
          endColumn: lastCol,
        };
        const rowCount = sheet.data.rowCount ?? 1;
        if (op.op === "rows.insert") {
          // Univer 以 startRow-1 为锚点（继承行高）：插在第 1 行时改用本行为锚点，
          // 插在现有行之后先扩行数，使锚点落在最后一行（P1-23）
          if (index > rowCount) {
            commands.push({
              id: "sheet.mutation.set-worksheet-row-count",
              params: { unitId, subUnitId: sheet.id, rowCount: index },
            });
          }
          commands.push({
            id: "sheet.command.insert-row-by-range",
            params: {
              unitId,
              subUnitId: sheet.id,
              range,
              ...(index === 0 ? { direction: Direction.UP } : {}),
            },
          });
          // 新插入行是空白行，不继承相邻汇总行的行高、隐藏或分组元数据。
          commands.push({
            id: "sheet.mutation.set-row-data",
            params: {
              unitId,
              subUnitId: sheet.id,
              rowData: Object.fromEntries(
                Array.from({ length: op.count }, (_, i) => [index + i, null]),
              ),
            },
          });
          sheet.data.rowCount = Math.max(rowCount, index) + op.count;
        } else {
          commands.push({
            id: "sheet.command.remove-row-by-range",
            params: { unitId, subUnitId: sheet.id, range },
          });
          sheet.data.rowCount = Math.max(1, rowCount - op.count);
        }
        // 冲突写集只记插入/删除的条带；尾部位移由 structural 变换承担，
        // 否则之后任何 stale 写都会整表冲突，平移语义失效。
        ranges.push({
          sheetId: sheet.id,
          r0: index,
          c0: 0,
          r1: index + op.count - 1,
          c1: lastCol,
        });
        structural.push({
          sheetId: sheet.id,
          kind: op.op === "rows.insert" ? "insertRows" : "deleteRows",
          index,
          count: op.count,
        });
        estCells += op.count * (sheet.data.columnCount ?? 1);
        break;
      }
      case "cols.insert":
      case "cols.delete": {
        const sheet = resolveSheet(ctx, op.sheet);
        const index = op.at - 1;
        const lastRow = Math.max(0, (sheet.data.rowCount ?? 1) - 1);
        const range = {
          startRow: 0,
          endRow: lastRow,
          startColumn: index,
          endColumn: index + op.count - 1,
        };
        const columnCount = sheet.data.columnCount ?? 1;
        if (op.op === "cols.insert") {
          if (index > columnCount) {
            commands.push({
              id: "sheet.mutation.set-worksheet-column-count",
              params: { unitId, subUnitId: sheet.id, columnCount: index },
            });
          }
          commands.push({
            id: "sheet.command.insert-col-by-range",
            params: {
              unitId,
              subUnitId: sheet.id,
              range,
              ...(index === 0 ? { direction: Direction.LEFT } : {}),
            },
          });
          sheet.data.columnCount = Math.max(columnCount, index) + op.count;
        } else {
          commands.push({
            id: "sheet.command.remove-col-by-range",
            params: { unitId, subUnitId: sheet.id, range },
          });
          sheet.data.columnCount = Math.max(1, columnCount - op.count);
        }
        ranges.push({
          sheetId: sheet.id,
          r0: 0,
          c0: index,
          r1: lastRow,
          c1: index + op.count - 1,
        });
        structural.push({
          sheetId: sheet.id,
          kind: op.op === "cols.insert" ? "insertCols" : "deleteCols",
          index,
          count: op.count,
        });
        estCells += op.count * (sheet.data.rowCount ?? 1);
        break;
      }
      case "sheet.copy": {
        const source = resolveSheet(ctx, op.sheet);
        if (
          op.name.length > 31 ||
          /[[\]:*?/\\]/.test(op.name) ||
          Object.values(ctx.snapshot.sheets).some((s) => s.name === op.name)
        )
          throw new OpCompileError("工作表名称无效或重复");
        if (
          objectsOf(source.data).charts.length ||
          objectsOf(source.data).images.length ||
          (objectsOf(source.data).shapes?.length ?? 0) ||
          (objectsOf(source.data).threadedComments?.length ?? 0) ||
          [CF_RESOURCE, DV_RESOURCE, "SHEET_FILTER_PLUGIN"].some((name) => {
            const value: unknown = rulesResource(ctx.snapshot, name)[source.id];
            return Array.isArray(value)
              ? value.length > 0
              : !!value && typeof value === "object" && "ref" in value && !!value.ref;
          })
        )
          throw new OpCompileError("含对象或规则的工作表不能安全复制，请复制值和样式到新表");
        const id = newId("sheet"),
          index = op.index ?? ctx.snapshot.sheetOrder.length;
        if (index > ctx.snapshot.sheetOrder.length) throw new OpCompileError("复制索引越界");
        const added = { ...structuredClone(source.data), id, name: op.name, hidden: 0 };
        commands.push({
          id: COPY_SHEET_COMMAND,
          params: { unitId, subUnitId: source.id, id, name: op.name, index },
        });
        ctx.snapshot.sheets[id] = added;
        ctx.snapshot.sheetOrder.splice(index, 0, id);
        sheetNames.set(id, op.name);
        ranges.push({ sheetId: source.id, r0: 0, c0: 0, r1: MAX_R, c1: MAX_C });
        structural.push({ sheetId: id, kind: "insertSheet", index, count: 0 });
        needsSnapshot = true;
        break;
      }
      case "sheet.move": {
        const sheet = resolveSheet(ctx, op.sheet),
          fromOrder = ctx.snapshot.sheetOrder.indexOf(sheet.id);
        if (op.index >= ctx.snapshot.sheetOrder.length) throw new OpCompileError("移动索引越界");
        commands.push({
          id: "sheet.mutation.set-worksheet-order",
          params: { unitId, subUnitId: sheet.id, fromOrder, toOrder: op.index },
        });
        ctx.snapshot.sheetOrder.splice(fromOrder, 1);
        ctx.snapshot.sheetOrder.splice(op.index, 0, sheet.id);
        ranges.push({ sheetId: "*", r0: 0, c0: 0, r1: MAX_R, c1: MAX_C });
        needsSnapshot = true;
        break;
      }
      case "sheet.hide": {
        const sheet = resolveSheet(ctx, op.sheet);
        if (
          op.hidden &&
          !Object.entries(ctx.snapshot.sheets).some(([id, s]) => id !== sheet.id && !s.hidden)
        )
          throw new OpCompileError("至少保留一个可见工作表");
        commands.push({
          id: "sheet.mutation.set-worksheet-hidden",
          params: { unitId, subUnitId: sheet.id, hidden: op.hidden ? 1 : 0 },
        });
        sheet.data.hidden = op.hidden ? 1 : 0;
        ranges.push({ sheetId: sheet.id, r0: 0, c0: 0, r1: MAX_R, c1: MAX_C });
        needsSnapshot = true;
        break;
      }
      case "sheet.add": {
        if (
          !op.name ||
          op.name.length > 31 ||
          /[[\]:*?/\\]/.test(op.name) ||
          Object.values(ctx.snapshot.sheets).some((s) => s.name === op.name)
        )
          throw new OpCompileError("工作表名称无效或重复");
        const id = newId("sheet");
        const index = op.index ?? ctx.snapshot.sheetOrder?.length ?? 0;
        if (index > ctx.snapshot.sheetOrder.length) throw new OpCompileError("工作表插入索引越界");
        const added = { id, name: op.name, rowCount: 1000, columnCount: 26, cellData: {} };
        commands.push({
          id: "sheet.command.insert-sheet",
          params: {
            unitId,
            index,
            sheet: added,
          },
        });
        ctx.snapshot.sheets[id] = added;
        sheetNames.set(id, op.name);
        ctx.snapshot.sheetOrder.splice(index, 0, id);
        structural.push({ sheetId: id, kind: "insertSheet", index, count: 0 });
        break;
      }
      case "sheet.rename": {
        const sheet = resolveSheet(ctx, op.sheet);
        commands.push({
          id: RENAME_SHEET_COMMAND,
          params: { unitId, subUnitId: sheet.id, name: op.name },
        });
        if (
          !op.name ||
          op.name.length > 31 ||
          /[[\]:*?/\\]/.test(op.name) ||
          Object.values(ctx.snapshot.sheets).some((s) => s.id !== sheet.id && s.name === op.name)
        )
          throw new OpCompileError("工作表名称无效或重复");
        sheet.data.name = op.name;
        sheetNames.set(sheet.id, op.name);
        structural.push({ sheetId: sheet.id, kind: "renameSheet", index: 0, count: 0 });
        break;
      }
      case "sheet.delete": {
        const sheet = resolveSheet(ctx, op.sheet);
        if ((ctx.snapshot.sheetOrder ?? []).length <= 1) {
          throw new OpCompileError("不能删除最后一个工作表");
        }
        const index = (ctx.snapshot.sheetOrder ?? []).indexOf(sheet.id);
        commands.push({
          id: "sheet.command.remove-sheet",
          params: { unitId, subUnitId: sheet.id },
        });
        ranges.push({ sheetId: sheet.id, r0: 0, c0: 0, r1: MAX_R, c1: MAX_C });
        structural.push({
          sheetId: sheet.id,
          kind: "removeSheet",
          index: Math.max(0, index),
          count: 0,
        });
        needsSnapshot = true;
        delete ctx.snapshot.sheets[sheet.id];
        ctx.snapshot.sheetOrder.splice(index, 1);
        break;
      }
      case "freeze": {
        const sheet = resolveSheet(ctx, op.sheet);
        commands.push({
          id: "sheet.command.set-frozen",
          params: {
            unitId,
            subUnitId: sheet.id,
            startRow: op.rows,
            startColumn: op.cols,
            ySplit: op.rows,
            xSplit: op.cols,
          },
        });
        break;
      }
      case "recalculate":
        break;
    }
  }
  return { commands, ranges, structural, formulas, estCells, needsSnapshot, sheetNames };
}

export { rangeRefToA1 };

// ---------- stale 坐标平移（07 §3.3：baseRev 之后的结构操作要先作用到本次写入坐标） ----------

type SheetResolver = (nameOrId: string | undefined) => string | undefined;

/** 依次把结构操作应用到一个 RangeRef；任一返回 "deleted" 即整体删除。 */
function applyStructurals(ref: RangeRef, structurals: StructuralOp[]): RangeRef | "deleted" {
  let cur = ref;
  for (const s of structurals) {
    const t = transformRange(cur, s);
    if (t === "deleted") return "deleted";
    cur = t;
  }
  return cur;
}

/**
 * ChangeOp 的坐标字段经历史结构操作平移后重渲染。
 * - range 型 op（cells.clear、style.set、merge、unmerge）：变换 A1 区域；
 * - cells.set：写入矩形整体平移；内部被插入/删除 → "ambiguous"；
 * - rows/cols 型 op：变换 at 下标点；
 * - 目标表被 removeSheet → "deleted"；renameSheet 不改变坐标（sheet 解析走 id）。
 */
export function transformChangeOp(
  op: ChangeOp,
  structurals: StructuralOp[],
  sheetIdOf: SheetResolver,
): ChangeOp | "deleted" | "ambiguous" {
  switch (op.op) {
    case "pivot.mark_refresh_on_load":
    case "print.set":
    case "name.set":
    case "table.add":
    case "table.column_formula":
    case "cells.fill":
      return structurals.length ? "ambiguous" : op;
    case "cells.set": {
      // values 与单元格逐一对应：目标矩形内部被插入/删除行列时无法确定性平移（P0-08）
      const parsed = parseRange(op.range);
      const sheetId = sheetIdOf(parsed.sheet);
      if (sheetId === undefined) return "deleted";
      let cur = cellsSetTarget(
        sheetId,
        { sheetId, r0: parsed.startRow - 1, c0: parsed.startCol - 1, r1: 0, c1: 0 },
        op.values,
      );
      for (const s of structurals) {
        const t = transformRange(cur, s);
        if (t === "deleted") return "deleted";
        if (structuralTouchesInterior(cur, s)) return "ambiguous";
        cur = t;
      }
      const anchor = { ...cur, r1: cur.r0, c1: cur.c0 };
      return { ...op, range: rangeRefToA1(anchor, sheetId) };
    }
    case "filter.set":
    case "hyperlink.set":
    case "find_replace":
    case "cf.add":
    case "dv.add":
    case "sort":
    case "cells.clear":
    case "style.set":
    case "merge":
    case "unmerge": {
      const parsed = parseRange(op.range);
      const sheetId = sheetIdOf(parsed.sheet);
      if (sheetId === undefined) return "deleted";
      const ref: RangeRef = {
        sheetId,
        r0: parsed.startRow - 1,
        c0: parsed.startCol - 1,
        r1: parsed.endRow - 1,
        c1: parsed.endCol - 1,
      };
      const t = applyStructurals(ref, structurals);
      if (t === "deleted") return "deleted";
      return { ...op, range: rangeRefToA1(t, t.sheetId) };
    }
    case "axis.size":
    case "axis.hide":
    case "axis.group":
    case "axis.collapse": {
      const sheetId = sheetIdOf(op.sheet);
      if (sheetId === undefined) return "deleted";
      const rows = op.axis === "rows";
      const ref = {
        sheetId,
        r0: rows ? op.at - 1 : 0,
        r1: rows ? op.at + op.count - 2 : MAX_R,
        c0: rows ? 0 : op.at - 1,
        c1: rows ? MAX_C : op.at + op.count - 2,
      };
      const t = applyStructurals(ref, structurals);
      if (t === "deleted") return "deleted";
      return {
        ...op,
        sheet: sheetId,
        at: (rows ? t.r0 : t.c0) + 1,
        count: rows ? t.r1 - t.r0 + 1 : t.c1 - t.c0 + 1,
      };
    }
    case "rows.height":
    case "rows.insert":
    case "rows.delete": {
      const sheetId = sheetIdOf(op.sheet);
      if (sheetId === undefined) return "deleted";
      const point: RangeRef = { sheetId, r0: op.at - 1, c0: 0, r1: op.at - 1, c1: 0 };
      const t = applyStructurals(point, structurals);
      if (t === "deleted") return "deleted";
      return { ...op, at: t.r0 + 1 };
    }
    case "cols.width":
    case "cols.insert":
    case "cols.delete": {
      const sheetId = sheetIdOf(op.sheet);
      if (sheetId === undefined) return "deleted";
      const point: RangeRef = { sheetId, r0: 0, c0: op.at - 1, r1: 0, c1: op.at - 1 };
      const t = applyStructurals(point, structurals);
      if (t === "deleted") return "deleted";
      return { ...op, at: t.c0 + 1 };
    }
    case "cf.remove":
    case "dv.remove":
    case "image.add":
    case "image.update":
    case "image.delete":
    case "shape.add":
    case "shape.update":
    case "shape.delete":
    case "note.set":
    case "chart.add":
    case "chart.update":
    case "chart.delete":
    case "sheet.copy":
    case "sheet.move":
    case "sheet.hide":
    case "sheet.rename":
    case "sheet.delete":
    case "freeze": {
      const sheetId = sheetIdOf(op.sheet);
      if (sheetId === undefined) return "deleted";
      for (const s of structurals) {
        if (s.kind === "removeSheet" && s.sheetId === sheetId) return "deleted";
      }
      // sheet 引用改传 id，renameSheet 之后的旧表名仍能解析
      return { ...op, sheet: sheetId };
    }
    case "sheet.add":
    case "recalculate":
      return op;
  }
}

/**
 * ChangeOp 的坐标目标（op 自身坐标系）：rect = 写入矩形；rows/cols = 受影响的行/列段。
 * 不带行列坐标的 op 返回 undefined。用于按读集推定该 op 的坐标依据修订。
 */
export function changeOpTarget(
  op: ChangeOp,
  sheetIdOf: SheetResolver,
): { axis: "rect" | "rows" | "cols"; ref: RangeRef } | undefined {
  switch (op.op) {
    case "pivot.mark_refresh_on_load":
    case "print.set":
    case "table.column_formula": {
      const sheetId = sheetIdOf(op.sheet);
      return sheetId === undefined
        ? undefined
        : { axis: "rect", ref: { sheetId, r0: 0, c0: 0, r1: MAX_R, c1: MAX_C } };
    }
    case "table.add":
    case "cells.fill":
    case "cells.set":
    case "filter.set":
    case "hyperlink.set":
    case "find_replace":
    case "cf.add":
    case "dv.add":
    case "sort":
    case "cells.clear":
    case "style.set":
    case "merge":
    case "unmerge": {
      const p = parseRange(op.range);
      const sheetId = sheetIdOf(p.sheet);
      if (sheetId === undefined) return undefined;
      const ref = {
        sheetId,
        r0: p.startRow - 1,
        c0: p.startCol - 1,
        r1: p.endRow - 1,
        c1: p.endCol - 1,
      };
      return {
        axis: "rect",
        ref: op.op === "cells.set" ? cellsSetTarget(sheetId, ref, op.values) : ref,
      };
    }
    case "axis.size":
    case "axis.hide":
    case "axis.group":
    case "axis.collapse": {
      const sheetId = sheetIdOf(op.sheet);
      if (sheetId === undefined) return undefined;
      const a0 = op.at - 1,
        a1 = a0 + op.count - 1;
      return op.axis === "rows"
        ? { axis: "rows", ref: { sheetId, r0: a0, r1: a1, c0: 0, c1: MAX_C } }
        : { axis: "cols", ref: { sheetId, r0: 0, r1: MAX_R, c0: a0, c1: a1 } };
    }
    case "rows.height":
    case "rows.insert":
    case "rows.delete":
    case "cols.width":
    case "cols.insert":
    case "cols.delete": {
      const sheetId = sheetIdOf(op.sheet);
      if (sheetId === undefined) return undefined;
      const a0 = op.at - 1;
      const a1 = op.op.endsWith(".delete") ? a0 + op.count - 1 : a0;
      return op.op.startsWith("rows.")
        ? { axis: "rows", ref: { sheetId, r0: a0, r1: a1, c0: 0, c1: MAX_C } }
        : { axis: "cols", ref: { sheetId, r0: 0, r1: MAX_R, c0: a0, c1: a1 } };
    }
    default:
      return undefined;
  }
}

interface MutationParams {
  subUnitId?: string;
  range?: { startRow: number; endRow: number; startColumn: number; endColumn: number };
  ranges?: { startRow: number; endRow: number; startColumn: number; endColumn: number }[];
  cellValue?: Record<number, Record<number, unknown>>;
  [k: string]: unknown;
}

/** Univer IRange → RangeRef。 */
const iRangeToRef = (
  sheetId: string,
  r: { startRow: number; endRow: number; startColumn: number; endColumn: number },
): RangeRef => ({ sheetId, r0: r.startRow, c0: r.startColumn, r1: r.endRow, c1: r.endColumn });

const refToIRange = (r: RangeRef) => ({
  startRow: r.r0,
  startColumn: r.c0,
  endRow: r.r1,
  endColumn: r.c1,
});

function rekeyCellValue(
  cellValue: Record<number, Record<number, unknown>>,
  structurals: StructuralOp[],
): Record<number, Record<number, unknown>> | "deleted" {
  let cur = cellValue;
  for (const s of structurals) {
    const next: Record<number, Record<number, unknown>> = {};
    for (const [rs, cols] of Object.entries(cur)) {
      const row = Number(rs);
      const ref = applyStructurals({ sheetId: s.sheetId, r0: row, c0: 0, r1: row, c1: MAX_C }, [s]);
      if (ref === "deleted") continue; // 整行被删：丢弃该行的写入
      const newCols: Record<number, unknown> = {};
      for (const [cs, v] of Object.entries(cols)) {
        const col = Number(cs);
        const cref = applyStructurals({ sheetId: s.sheetId, r0: 0, c0: col, r1: 0, c1: col }, [s]);
        if (cref === "deleted") continue;
        newCols[cref.c0] = v;
      }
      if (Object.keys(newCols).length > 0) next[ref.r0] = newCols;
    }
    cur = next;
  }
  return cur;
}

/**
 * 用户来源 mutation 的坐标平移：认识 range/ranges/cellValue 形参数；
 * 其余带坐标语义的字段无法确定性平移时返回 "ambiguous"（调用方拒绝并提示重读）。
 */
export function transformMutation<M extends { id: string; params: unknown }>(
  m: M,
  structurals: StructuralOp[],
): M | "deleted" | "ambiguous" {
  const src = m.params as MutationParams;
  const sid = src.subUnitId;
  const rel = structurals.filter((s) => s.sheetId === sid || s.sheetId === "*");
  if (rel.length === 0) return m;
  if (sid !== undefined && rel.some((s) => s.kind === "removeSheet" && s.sheetId === sid)) {
    return "deleted";
  }
  const params: MutationParams = { ...src };
  if (m.id === AXIS_GROUP_MUTATION) {
    if (sid === undefined || (src.axis !== "rows" && src.axis !== "cols")) return "ambiguous";
    const rows = src.axis === "rows";
    let remaining = 0;
    for (const key of ["levels", "collapsed"] as const) {
      const values = src[key];
      if (values === undefined) continue;
      const mapped: Record<string, unknown> = {};
      for (const [index, value] of Object.entries(values as Record<string, unknown>)) {
        const at = Number(index);
        const ref = {
          sheetId: sid,
          r0: rows ? at : 0,
          r1: rows ? at : MAX_R,
          c0: rows ? 0 : at,
          c1: rows ? MAX_C : at,
        };
        const shifted = applyStructurals(ref, rel);
        if (shifted !== "deleted") mapped[String(rows ? shifted.r0 : shifted.c0)] = value;
      }
      remaining += Object.keys(mapped).length;
      params[key] = mapped;
    }
    if (!remaining) return "deleted";
  }
  if (params.range !== undefined) {
    if (sid === undefined) return "ambiguous";
    const t = applyStructurals(iRangeToRef(sid, params.range), rel);
    if (t === "deleted") return "deleted";
    params.range = refToIRange(t);
  }
  if (params.ranges !== undefined) {
    if (sid === undefined) return "ambiguous";
    const out: NonNullable<MutationParams["ranges"]> = [];
    for (const r of params.ranges) {
      const t = applyStructurals(iRangeToRef(sid, r), rel);
      if (t === "deleted") return "deleted";
      out.push(refToIRange(t));
    }
    params.ranges = out;
  }
  if (params.cellValue !== undefined) {
    if (sid === undefined) return "ambiguous";
    const t = rekeyCellValue(params.cellValue, rel);
    if (t === "deleted") return "deleted";
    params.cellValue = t;
  }
  return { ...m, params: params as M["params"] };
}
