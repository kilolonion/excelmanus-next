import { z } from "zod";
import { ChangeOp } from "./ops.ts";

export const WorkbookEditInput = z
  .object({
    docId: z.string().min(1).optional().describe("已打开文档的 id；新建时不接受"),
    path: z
      .string()
      .min(1)
      .optional()
      .describe(
        "工作区相对路径；同时提供 docId 时必须指向同一工作簿；新建时必须是尚不存在的 .xlsx",
      ),
    baseRev: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("显式基于的修订号，省略则按读集推定"),
    dryRun: z.boolean().optional().describe("预览参数与操作，不创建文件、不提交修订"),
    create: z.boolean().optional().describe("新建 .xlsx，默认含一个空白 Sheet1；不覆盖已有文件"),
    sheetNames: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe("仅 create=true：按顺序建立这些工作表，不再额外创建 Sheet1；省略时保留默认 Sheet1"),
    ops: z
      .array(ChangeOp)
      .describe("按顺序原子执行；create=true 时允许 [] 创建空工作簿，否则至少一个操作"),
  })
  .superRefine((a, ctx) => {
    if (a.sheetNames && !a.create)
      ctx.addIssue({
        code: "custom",
        path: ["sheetNames"],
        message: "sheetNames 仅用于新建工作簿；修改已有表名请用 sheet.rename",
      });
    if (a.create && (!a.path || a.docId))
      ctx.addIssue({
        code: "custom",
        path: ["path"],
        message: "create=true 需要新的 path，不能提供 docId",
      });
    if (!a.create && !a.path && !a.docId)
      ctx.addIssue({ code: "custom", path: ["path"], message: "需要 docId 或 path" });
    if (!a.create && a.ops.length === 0)
      ctx.addIssue({
        code: "custom",
        path: ["ops"],
        message: "修改已有工作簿至少需要一个操作；创建空工作簿请传 create=true 和 ops=[]",
      });
  });

/** 模型侧投影为扁平字段，避免部分模型误选联合分支；执行仍用原始判别联合严格校验。 */
export const WorkbookEditJsonSchema = z.toJSONSchema(WorkbookEditInput, {
  override: ({ zodSchema, jsonSchema }) => {
    if (zodSchema === ChangeOp) {
      const branches = jsonSchema.oneOf!;
      type FieldSchema = NonNullable<typeof jsonSchema.properties>[string];
      const fields = new Map<string, FieldSchema[]>();
      for (const branch of branches) {
        for (const [name, rule] of Object.entries(branch.properties ?? {})) {
          if (name === "op") continue;
          const variants = fields.get(name) ?? [];
          if (!variants.some((item) => JSON.stringify(item) === JSON.stringify(rule))) {
            variants.push(rule);
          }
          fields.set(name, variants);
        }
      }
      jsonSchema.type = "object";
      jsonSchema.properties = {
        op: { type: "string", enum: ChangeOp.options.map((option) => option.shape.op.value) },
      };
      for (const [name, variants] of fields) {
        jsonSchema.properties[name] =
          variants.length === 1
            ? variants[0]!
            : {
                anyOf: variants.map((rule) =>
                  typeof rule === "boolean" ? (rule ? {} : { not: {} }) : rule,
                ),
              };
      }
      const sheet = jsonSchema.properties.sheet;
      if (typeof sheet === "object") {
        const operations = ChangeOp.options
          .filter((option) => "sheet" in option.shape)
          .map((option) => option.shape.op.value);
        sheet.description = `sheet 仅用于 ${operations.join(", ")}。style.set 不传 sheet，表名写入 range，如 '汇总'!A1:D5。`;
      }
      jsonSchema.required = ["op"];
      jsonSchema.additionalProperties = false;
      jsonSchema.description =
        "Each operation accepts only op and the fields listed for that operation. Do not borrow fields from other operations.\n" +
        branches
          .map((branch, i) => {
            const required = (branch.required ?? []).filter((name) => name !== "op");
            const optional = Object.keys(branch.properties ?? {}).filter(
              (name) => name !== "op" && !required.includes(name),
            );
            return `${ChangeOp.options[i]!.shape.op.value}: required ${required.join(", ") || "none"}; optional ${optional.join(", ") || "none"}`;
          })
          .join("\n");
      delete jsonSchema.oneOf;
    }
    if (jsonSchema.const !== undefined) {
      jsonSchema.enum = [jsonSchema.const];
      delete jsonSchema.const;
    }
  },
});

/** 显式建表名称编译到现有原子操作链；预览、工具和脚本使用相同语义。 */
export function workbookEditOps(a: z.infer<typeof WorkbookEditInput>): z.infer<typeof ChangeOp>[] {
  if (!a.create || !a.sheetNames) return a.ops;
  const [first, ...rest] = a.sheetNames;
  const initial: z.infer<typeof ChangeOp>[] =
    first === "Sheet1" ? [] : [{ op: "sheet.rename", sheet: "Sheet1", name: first! }];
  initial.push(...rest.map((name) => ({ op: "sheet.add" as const, name })));
  return [...initial, ...a.ops];
}
