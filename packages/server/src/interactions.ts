import type { QuestionCoordinator, SessionLog, ToolDefinition } from "@excelmanus/kernel";
import { PresentPayload, type ToolResult } from "@excelmanus/protocol";
import type { DocumentService } from "@excelmanus/workbook";
import { z } from "zod";
import { finalizeNumeric, numericFinalization, presentVerifiedFile } from "./numeric-finalizer.ts";

const output = z.record(z.string(), z.unknown());
const ok = (data: unknown): ToolResult => ({ status: "ok", data });

const askInput = z.strictObject({
  type: z.enum(["choice", "text", "range_confirm", "range_pick", "change_confirm"]),
  spec: z.record(z.string(), z.unknown()),
  timeoutSeconds: z.number().positive().max(86_400).optional(),
});
const presentExample = '{"payload":{"kind":"file","path":"报告.xlsx"}}';
const payloadSchema = z.strictObject({
  payload: PresentPayload.describe(
    `必须嵌套在 payload 内，不把 kind/path/range 放到根节点。例：${presentExample}`,
  ),
});
const payloadInput = z.strictObject({
  payload: z.preprocess((value, ctx) => {
    if (value === undefined) {
      ctx.addIssue({ code: "custom", message: `缺少 payload；调用格式：${presentExample}` });
      return z.NEVER;
    }
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }, PresentPayload),
});
const finalizationInput = z.strictObject({
  finalize: z.preprocess((value) => {
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }, numericFinalization),
});
const presentInput = z.union([payloadInput, finalizationInput], {
  error: `请使用 payload 或 finalize 独立分支；文件调用格式：${presentExample}`,
});
const todoExamples =
  'set 只传 op 和 items：{"op":"set","items":[{"id":"1","title":"核验","status":"pending"}]}；update 只传 op、todoId 和要改的 status/result：{"op":"update","todoId":"1","status":"done"}。不要混用两种操作的字段。';
const todoObjectError: z.core.$ZodErrorMap = (issue) =>
  issue.code === "unrecognized_keys"
    ? `多余字段：${issue.keys.join(", ")}。${todoExamples}`
    : undefined;
const todoSchema = z.discriminatedUnion("op", [
  z.strictObject(
    {
      op: z.literal("set"),
      items: z
        .array(z.record(z.string(), z.unknown()))
        .describe(
          '待办对象数组，每项用稳定 id、title 和 status（pending/in_progress/done）。例：[{"id":"1","title":"核验","status":"pending"}]。不是 JSON 字符串。',
        ),
    },
    { error: todoObjectError },
  ),
  z.strictObject(
    {
      op: z.literal("update"),
      todoId: z.string().describe("set 时对应条目的 id；不是标题，也不重复传 items"),
      status: z.string().optional().describe("pending、in_progress 或 done"),
      result: z.unknown().optional(),
    },
    { error: todoObjectError },
  ),
]);

const todoInput = z.preprocess((value) => {
  if (
    !value ||
    typeof value !== "object" ||
    !("op" in value) ||
    value.op !== "set" ||
    !("items" in value) ||
    typeof value.items !== "string"
  )
    return value;
  try {
    return { ...value, items: JSON.parse(value.items) };
  } catch {
    return value;
  }
}, todoSchema);

export function interactionTools(
  log: SessionLog,
  questions: QuestionCoordinator,
  documents?: DocumentService,
): ToolDefinition[] {
  const ask: ToolDefinition<z.infer<typeof askInput>> = {
    name: "ask_user",
    title: "向用户提问",
    description: "向用户提出选择、文本或区域确认问题；返回 questionId，等待用户通过界面回答。",
    input: askInput,
    output,
    effect: "interactive",
    targets: () => [],
    replay: "unsafe",
    timeoutMs: 86_400_000,
    roles: ["main", "lead", "worker", "reader"],
    execute(args, ctx) {
      const question = questions.request(ctx.sessionId, ctx.agentId, {
        questionType: args.type,
        spec: args.spec,
        toolCallId: ctx.toolCallId,
        turnId: ctx.turnId,
        stepId: ctx.stepId,
        timeoutSeconds: args.timeoutSeconds,
      });
      return ok({
        questionId: question.id,
        status: "pending",
        ...(args.timeoutSeconds ? { timeoutSeconds: args.timeoutSeconds } : {}),
      });
    },
  };
  const present: ToolDefinition<z.infer<typeof presentInput>> = {
    name: "present",
    title: "呈现内容",
    description: `非终结呈现：显示文件预览、定位区域或其他 UI 内容，不表示业务任务已完成。最终结果用 deliver 检查当前事实与任务状态后交付。文件格式：${presentExample}。`,
    input: presentInput,
    inputJsonSchema: z.toJSONSchema(payloadSchema),
    output,
    effect: "interactive",
    targets: () => [],
    replay: "safe",
    timeoutMs: 30_000,
    roles: ["main", "lead", "worker", "reader"],
    finalizesTurn: (args) =>
      args !== null && typeof args === "object" && Object.hasOwn(args, "finalize"),
    finalReply(args, result) {
      if (!("finalize" in args) || result.status !== "ok") return undefined;
      const data = result.data as { finalText?: unknown } | undefined;
      return typeof data?.finalText === "string" ? data.finalText : undefined;
    },
    execute(args, ctx) {
      if ("finalize" in args) return finalizeNumeric(log, documents, args.finalize, ctx);
      if (args.payload.kind === "file")
        return presentVerifiedFile(log, documents, args.payload.path, ctx);
      log.append(ctx.sessionId, ctx.agentId, [{ type: "ui.present", data: args.payload }]);
      return ok({ presented: true });
    },
  };
  const todo: ToolDefinition<z.infer<typeof todoInput>> = {
    name: "todo",
    modelVisible: false,
    title: "维护待办",
    description: `用 set 整体替换待办清单，或用 update 更新一项状态与结果。${todoExamples}`,
    input: todoInput,
    inputJsonSchema: z.toJSONSchema(todoSchema),
    output,
    effect: "state",
    targets: () => [],
    replay: "safe",
    timeoutMs: 30_000,
    roles: ["main", "lead", "worker", "reader"],
    execute(args, ctx) {
      if (args.op === "set") {
        log.append(ctx.sessionId, ctx.agentId, [{ type: "todo.set", data: { items: args.items } }]);
      } else {
        log.append(ctx.sessionId, ctx.agentId, [
          {
            type: "todo.updated",
            data: {
              todoId: args.todoId,
              ...(args.status !== undefined ? { status: args.status } : {}),
              ...(args.result !== undefined ? { result: args.result } : {}),
            },
          },
        ]);
      }
      return ok({ updated: true });
    },
  };
  return [ask, present, todo];
}
