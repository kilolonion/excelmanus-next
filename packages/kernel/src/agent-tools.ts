import type { ToolResult } from "@excelmanus/protocol";
import { z } from "zod";
import { formatAgentTask, taskHandoffSchema } from "./task-handoff.ts";
import type { AgentCoordinator, ToolDefinition } from "./tools.ts";

const output = z.record(z.string(), z.unknown());
const ok = (data: unknown): ToolResult => ({ status: "ok", data });
const spawnInput = z.strictObject({
  name: z.string().min(1).max(80),
  role: z.enum(["reader", "worker", "lead"]),
  task: z.string().min(1).max(8000),
  handoff: taskHandoffSchema.optional(),
  files: z.array(z.string()).max(100).optional(),
  model: z.string().optional(),
  budget: z.record(z.string(), z.unknown()).optional(),
});
const sendInput = z.strictObject({
  to: z.union([z.string(), z.array(z.string()).min(1)]),
  message: z.string().min(1).max(8000),
  urgent: z.boolean().optional(),
});
const waitInput = z.strictObject({
  for: z.enum(["any_message", "messages_from", "all_idle"]),
  agents: z.array(z.string()).optional(),
  timeoutSeconds: z.number().positive().max(1800).optional(),
});
const statusInput = z.strictObject({
  id: z.string().optional(),
  include: z.enum(["summary", "final_reply", "transcript_tail"]).optional(),
});
const controlInput = z.strictObject({
  id: z.string(),
  action: z.enum(["pause", "resume", "close", "release_lease"]),
});

export function agentTools(_coordinator: AgentCoordinator): ToolDefinition[] {
  const spawn: ToolDefinition<z.infer<typeof spawnInput>> = {
    name: "agent_spawn",
    title: "派生子代理",
    description:
      "仅在独立子任务值得分工时使用；简单任务可直接完成。handoff 可携带目标、区域、约束、交付物、验收和已有证据，不改变权限与租约。异步派生一个受角色权限与预算限制的子代理，立即返回代理 ID；超过并发上限会排队。reader 只读，worker 可读写但不能派生，lead 可派生。files 声明子代理写入租约，路径相对工作区；已有租约冲突会拒绝。结束后运行时向派生者发送最终回复与变更摘要，父代理仍需核验任务结果。",
    input: spawnInput,
    output,
    effect: "agent",
    targets: () => [],
    replay: "unsafe",
    timeoutMs: 30_000,
    roles: ["main", "lead"],
    execute(args, ctx) {
      if (!ctx.agents)
        return {
          status: "error",
          error: { code: "INTERNAL", message: "代理协调器未装配", retryable: false },
        };
      const out = ctx.agents.spawn({
        sessionId: ctx.sessionId,
        parentAgentId: ctx.agentId,
        sourceTurnId: ctx.turnId,
        name: args.name,
        role: args.role,
        task: formatAgentTask(args.task, args.handoff),
        files: args.files,
        modelProfileId: args.model,
        budget: args.budget,
      });
      return "error" in out ? out.error : ok(out);
    },
  };
  const send: ToolDefinition<z.infer<typeof sendInput>> = {
    name: "agent_send",
    title: "发送代理消息",
    description: "向父代理、子代理或兄弟代理异步发送消息。",
    input: sendInput,
    output,
    effect: "agent",
    targets: (args) => (Array.isArray(args.to) ? args.to : [args.to]),
    replay: "unsafe",
    timeoutMs: 30_000,
    roles: ["main", "lead", "worker", "reader"],
    execute(args, ctx) {
      if (!ctx.agents)
        return {
          status: "error",
          error: { code: "INTERNAL", message: "代理协调器未装配", retryable: false },
        };
      const out = ctx.agents.send({
        sessionId: ctx.sessionId,
        fromAgentId: ctx.agentId,
        to: Array.isArray(args.to) ? args.to : [args.to],
        message: args.message,
        urgent: args.urgent,
      });
      return "error" in out ? out.error : ok(out);
    },
  };
  const wait: ToolDefinition<z.infer<typeof waitInput>> = {
    name: "agent_wait",
    title: "等待代理",
    description: "等待消息或指定代理全部进入空闲/终态，等待不消耗模型调用。",
    input: waitInput,
    output,
    effect: "agent",
    targets: () => [],
    replay: "safe",
    timeoutMs: 1_800_000,
    roles: ["main", "lead", "worker", "reader"],
    execute(args, ctx) {
      if (!ctx.agents)
        return {
          status: "error",
          error: { code: "INTERNAL", message: "代理协调器未装配", retryable: false },
        };
      return ctx.agents.wait({
        sessionId: ctx.sessionId,
        requesterAgentId: ctx.agentId,
        for: args.for,
        agents: args.agents,
        timeoutSeconds: args.timeoutSeconds ?? 300,
        signal: ctx.signal,
      });
    },
  };
  const status: ToolDefinition<z.infer<typeof statusInput>> = {
    name: "agent_status",
    title: "查看代理状态",
    description: "查看团队名册或一个可见代理的状态与用量摘要。",
    input: statusInput,
    output,
    effect: "read",
    targets: () => [],
    replay: "safe",
    timeoutMs: 30_000,
    roles: ["main", "lead", "worker", "reader"],
    execute(args, ctx) {
      if (!ctx.agents)
        return {
          status: "error",
          error: { code: "INTERNAL", message: "代理协调器未装配", retryable: false },
        };
      return ok(ctx.agents.status(ctx.sessionId, ctx.agentId, args.id, args.include));
    },
  };
  const control: ToolDefinition<z.infer<typeof controlInput>> = {
    name: "agent_control",
    title: "管理子代理",
    description: "暂停、继续、关闭自己的后代代理，或释放其文件租约。",
    input: controlInput,
    output,
    effect: "agent",
    targets: (args) => [args.id],
    replay: "unsafe",
    timeoutMs: 30_000,
    roles: ["main", "lead"],
    execute(args, ctx) {
      if (!ctx.agents)
        return {
          status: "error",
          error: { code: "INTERNAL", message: "代理协调器未装配", retryable: false },
        };
      const out = ctx.agents.control({
        agentId: args.id,
        action: args.action,
        sessionId: ctx.sessionId,
        requesterAgentId: ctx.agentId,
      });
      return "error" in out ? out.error : ok(out);
    },
  };
  return [spawn, send, wait, status, control];
}
