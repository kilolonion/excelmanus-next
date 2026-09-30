// ToolDefinition 与 CapabilityModule（06 §2.1 全字段、03 §4.3）。

import type { DatabaseSync } from "node:sqlite";
import type { RangeRef } from "@excelmanus/core";
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

/**
 * 每代理一份的读集表（07 §10、03 §6.1）：代理读过的文档区域与当时修订。
 * 会话卸下即丢弃——只在内存中，提交冲突用它推导 baseRev 与读集。
 */
export interface ReadTable {
  record(docId: string, ranges: RangeRef[], rev: number): void;
  get(docId: string): { ranges: RangeRef[]; minRev: number } | undefined;
}

export function createReadTable(): ReadTable {
  const map = new Map<string, { ranges: RangeRef[]; minRev: number }>();
  return {
    record(docId, ranges, rev) {
      const cur = map.get(docId);
      if (cur) {
        cur.ranges.push(...ranges);
        cur.minRev = Math.min(cur.minRev, rev);
      } else {
        map.set(docId, { ranges: [...ranges], minRev: rev });
      }
    },
    get: (docId) => map.get(docId),
  };
}

export interface ToolContext {
  /** 会话所属工作区 id（workspaces 表）。 */
  workspaceId: string;
  workspaceRoot: string;
  signal: AbortSignal;
  sessionId: string;
  agentId: string;
  toolCallId: string;
  /** 本代理的文档读集（写工具提交后也应并入写集，代理读过自己写的）。 */
  reads: ReadTable;
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
  /**
   * 04 §8.2 恢复钩子：进程中断后 open_intents 里的未决调用——有副作用的
   * 工具用它判断该调用是否已在别处落库（返回其结果）；返回 undefined = not_executed。
   */
  recover?(info: {
    sessionId: string;
    agentId: string;
    toolCallId: string;
    args: unknown;
  }): ToolResult | undefined;
}

export interface CapabilityModule {
  id: string;
  tools?: ToolDefinition[];
  migrations?: string[];
  projections?: Projection[];
}

/** 模块数据库访问别名（避免重复 import node:sqlite 类型）。 */
export type { DatabaseSync };
