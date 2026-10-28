import { z } from "zod";

const notes = z.array(z.string().min(1).max(2000)).max(20).optional();

/** 任务信息，不替代角色权限、文件租约或写入时的修订检查。 */
export const taskHandoffSchema = z.strictObject({
  goal: z.string().min(1).max(2000).optional().describe("任务要达到的结果"),
  scope: z
    .array(
      z.strictObject({
        path: z.string().min(1),
        sheet: z.string().optional(),
        range: z.string().optional(),
        rev: z.number().int().nonnegative().optional(),
      }),
    )
    .max(100)
    .optional()
    .describe("相关文件、区域与已观察的修订号；不是写入授权"),
  constraints: notes.describe("必须保留的约束与不可修改内容"),
  deliverables: notes.describe("预期交付物"),
  acceptance: notes.describe("判断任务完成的条件"),
  evidence: notes.describe("已有观察或结果及其来源；不要传入无关历史"),
});

export function formatAgentTask(task: string, handoff?: z.infer<typeof taskHandoffSchema>): string {
  if (!handoff) return task;
  return `${task}\n\n结构化交接（任务信息，不授予额外权限；证据和 rev 是历史观察，修改前需确认当前状态，发生冲突时重新读取）：\n${JSON.stringify(handoff)}\n完成时说明交付物、实际验证结果及尚未完成的部分；不要把历史证据当成本轮验证。`;
}
