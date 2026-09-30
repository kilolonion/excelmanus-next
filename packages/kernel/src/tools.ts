// ToolDefinition 与 CapabilityModule（06 §2.1 全字段、03 §4.3）。

import type { DatabaseSync } from "node:sqlite";
import type { AgentRole, ReplayKind, ToolResult } from "@excelmanus/protocol";
import type { z } from "zod";
import type { Projection } from "./session-log.ts";

export type ToolEffect =
  | "read"
  | "write"
  | "destructive"
  | "external"
  | "interactive"
  | "agent"
  | "state";

export interface ToolContext {
  /** 会话所属工作区 id（workspaces 表）。 */
  workspaceId: string;
  workspaceRoot: string;
  signal: AbortSignal;
  sessionId: string;
  agentId: string;
  toolCallId: string;
}

export interface ToolDefinition<A = unknown> {
  /** 小写蛇形。 */
  name: string;
  /** 中文显示名（工具卡片）。 */
  title: string;
  /** 发给模型的说明（06 §2.2）。 */
  description: string;
  input: z.ZodType<A>;
  output: z.ZodType;
  // 回调参数标 never：使 ToolDefinition<具体参数> 可赋给异构集合 ToolDefinition<unknown>；
  // 作者如需读 args 可自行标注具体类型（never 可赋给一切参数类型）。
  effect: ToolEffect | ((args: never) => ToolEffect);
  /** 本次调用会读/写哪些路径，用于审批展示与目标高亮。 */
  targets(args: A): string[];
  /** 中断后能否安全重放。 */
  replay: ReplayKind | ((args: never) => ReplayKind);
  timeoutMs: number;
  roles: AgentRole[];
  execute(args: A, ctx: ToolContext): Promise<ToolResult> | ToolResult;
}

export interface CapabilityModule {
  id: string;
  tools?: ToolDefinition[];
  migrations?: string[];
  projections?: Projection[];
}

/** 模块数据库访问别名（避免重复 import node:sqlite 类型）。 */
export type { DatabaseSync };
