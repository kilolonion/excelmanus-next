import type { DatabaseSync } from "node:sqlite";
import type { Usage } from "@excelmanus/protocol";

export interface AgentBudget {
  maxSteps?: number;
  maxToolCalls?: number;
  maxTokens?: number;
  wallClockMs?: number;
}

export interface BudgetUsage {
  steps: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  startedAt?: number;
}

export type BudgetLimit = "maxSteps" | "maxToolCalls" | "maxTokens" | "wallClockMs";

export interface BudgetCheck {
  ok: boolean;
  limit?: BudgetLimit;
  used?: number;
  max?: number;
}

export const DEFAULT_MAIN_BUDGET: Required<Pick<AgentBudget, "maxSteps">> = { maxSteps: 200 };
export const DEFAULT_CHILD_BUDGET: Required<Pick<AgentBudget, "maxSteps">> = { maxSteps: 60 };

export function parseBudget(raw: string | null | undefined): AgentBudget {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const number = (key: string): number | undefined => {
      const n = value[key];
      return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;
    };
    return {
      maxSteps: number("maxSteps"),
      maxToolCalls: number("maxToolCalls"),
      maxTokens: number("maxTokens"),
      wallClockMs: number("wallClockMs"),
    };
  } catch {
    return {};
  }
}

export function emptyBudgetUsage(startedAt = Date.now()): BudgetUsage {
  return {
    steps: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    startedAt,
  };
}

export function addUsage(current: BudgetUsage, usage: Usage | undefined): BudgetUsage {
  if (!usage) return current;
  const inputTokens = current.inputTokens + (usage.inputTokens ?? 0);
  const outputTokens = current.outputTokens + (usage.outputTokens ?? 0);
  const reasoningTokens = current.reasoningTokens + (usage.reasoningTokens ?? 0);
  const totalTokens =
    current.totalTokens +
    (usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0));
  return { ...current, inputTokens, outputTokens, reasoningTokens, totalTokens };
}

export function checkBudget(
  budget: AgentBudget,
  usage: BudgetUsage,
  now = Date.now(),
): BudgetCheck {
  if (budget.maxSteps !== undefined && usage.steps > budget.maxSteps)
    return { ok: false, limit: "maxSteps", used: usage.steps, max: budget.maxSteps };
  if (budget.maxToolCalls !== undefined && usage.toolCalls > budget.maxToolCalls)
    return { ok: false, limit: "maxToolCalls", used: usage.toolCalls, max: budget.maxToolCalls };
  if (budget.maxTokens !== undefined && usage.totalTokens > budget.maxTokens)
    return { ok: false, limit: "maxTokens", used: usage.totalTokens, max: budget.maxTokens };
  if (
    budget.wallClockMs !== undefined &&
    usage.startedAt !== undefined &&
    now - usage.startedAt > budget.wallClockMs
  )
    return {
      ok: false,
      limit: "wallClockMs",
      used: now - usage.startedAt,
      max: budget.wallClockMs,
    };
  return { ok: true };
}

/** 从 agents 投影读取预算和累计 token，用于重启后的保守限制。 */
export function readAgentBudget(
  db: DatabaseSync,
  sessionId: string,
  agentId: string,
): {
  budget: AgentBudget;
  usage: BudgetUsage;
} {
  const row = db
    .prepare("SELECT budget, usage FROM agents WHERE session_id = ? AND id = ?")
    .get(sessionId, agentId) as { budget: string | null; usage: string | null } | undefined;
  let usage: Partial<BudgetUsage> = {};
  if (row?.usage) {
    try {
      usage = JSON.parse(row.usage) as Partial<BudgetUsage>;
    } catch {
      usage = {};
    }
  }
  return {
    budget: parseBudget(row?.budget),
    usage: {
      ...emptyBudgetUsage(),
      ...usage,
      steps: typeof usage.steps === "number" && Number.isFinite(usage.steps) ? usage.steps : 0,
      toolCalls:
        typeof usage.toolCalls === "number" && Number.isFinite(usage.toolCalls)
          ? usage.toolCalls
          : 0,
      startedAt: undefined,
    },
  };
}
