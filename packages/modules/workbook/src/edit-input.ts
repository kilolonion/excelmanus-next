import { z } from "zod";
import { ChangeOp } from "./ops.ts";

export const WorkbookEditInput = z
  .object({
    docId: z.string().min(1).optional().describe("已打开文档的 id；新建时不接受"),
    path: z.string().min(1).optional().describe("工作区相对路径；新建时必须是尚不存在的 .xlsx"),
    baseRev: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("显式基于的修订号，省略则按读集推定"),
    dryRun: z.boolean().optional().describe("预览参数与操作，不创建文件、不提交修订"),
    create: z.boolean().optional().describe("新建 .xlsx，默认含一个空白 Sheet1；不覆盖已有文件"),
    ops: z
      .array(ChangeOp)
      .describe("按顺序原子执行；create=true 时允许 [] 创建空工作簿，否则至少一个操作"),
  })
  .superRefine((a, ctx) => {
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
