import type { QuestionCoordinator, SessionLog, ToolDefinition } from "@excelmanus/kernel";
import { PresentPayload, type ToolResult } from "@excelmanus/protocol";
import { z } from "zod";

const output = z.record(z.string(), z.unknown());
const ok = (data: unknown): ToolResult => ({ status: "ok", data });

const askInput = z.strictObject({
  type: z.enum(["choice", "text", "range_confirm", "range_pick", "change_confirm"]),
  spec: z.record(z.string(), z.unknown()),
  timeoutSeconds: z.number().positive().max(86_400).optional(),
});
const presentInput = z.strictObject({ payload: PresentPayload });
const todoInput = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("set"), items: z.array(z.record(z.string(), z.unknown())) }),
  z.strictObject({
    op: z.literal("update"),
    todoId: z.string(),
    status: z.string().optional(),
    result: z.unknown().optional(),
  }),
]);

export function interactionTools(
  log: SessionLog,
  questions: QuestionCoordinator,
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
    description:
      "非阻塞地向用户呈现内容：kind=focus 在工作台里指给用户看某个区域（docId 或 path 加 range，附一句 note）；kind=file 交付一个工作区文件（path）。",
    input: presentInput,
    output,
    effect: "interactive",
    targets: () => [],
    replay: "safe",
    timeoutMs: 30_000,
    roles: ["main", "lead", "worker", "reader"],
    execute(args, ctx) {
      log.append(ctx.sessionId, ctx.agentId, [{ type: "ui.present", data: args.payload }]);
      return ok({ presented: true });
    },
  };
  const todo: ToolDefinition<z.infer<typeof todoInput>> = {
    name: "todo",
    title: "维护待办",
    description: "用 set 整体替换待办清单，或用 update 更新一项状态与结果。",
    input: todoInput,
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
