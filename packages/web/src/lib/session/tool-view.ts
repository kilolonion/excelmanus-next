// 工具调用的展示状态：把日志状态（计划 / 运行 / 待授权 / 待回答 / 结果）收敛成界面用的一个值。

import type { ApprovalState, QuestionState, ToolState } from "./types";

export type ToolDisplayStatus =
  | "pending"
  | "running"
  | "approval"
  | "question"
  | "success"
  | "partial"
  | "error"
  | "denied"
  | "not_executed"
  | "uncertain";

export function toolDisplayStatus(
  tool: ToolState,
  approval?: ApprovalState,
  question?: QuestionState,
): ToolDisplayStatus {
  switch (tool.phase) {
    case "planned":
      return "pending";
    case "running":
      return "running";
    case "approval":
      return approval?.status === "pending"
        ? "approval"
        : approval?.status === "denied"
          ? "denied"
          : "running";
    case "question":
      return question?.status === "pending" ? "question" : "running";
    case "done":
      break;
  }
  switch (tool.status) {
    case "ok":
      return "success";
    case "partial":
      return "partial";
    case "not_executed":
      return "not_executed";
    case "uncertain":
      return "uncertain";
    default:
      return tool.result?.error?.code === "APPROVAL_DENIED" ? "denied" : "error";
  }
}

export function isToolActive(status: ToolDisplayStatus): boolean {
  return (
    status === "pending" || status === "running" || status === "approval" || status === "question"
  );
}

/** 内容另有专门展示的工具（任务清单、呈现卡片）：成功时不再单独显示工具卡。 */
export const SELF_RENDERED_TOOLS = new Set(["todo", "present"]);

/** 单独成卡、不并入「执行步骤」分组的工具：提问与派生子代理。 */
export function isStandaloneTool(name: string): boolean {
  return name === "ask_user" || name === "agent_spawn";
}
