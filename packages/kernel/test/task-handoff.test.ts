import { describe, expect, test } from "vitest";
import { formatAgentTask, taskHandoffSchema } from "../src/task-handoff.ts";

describe("子任务交接", () => {
  test("无交接时保留原任务，有交接时保留区域、验收和证据版本", () => {
    expect(formatAgentTask("核对合计")).toBe("核对合计");
    const handoff = taskHandoffSchema.parse({
      goal: "合计与明细一致",
      scope: [{ path: "报表.xlsx", sheet: "收入", range: "A1:D20", rev: 7 }],
      constraints: ["不要修改原表"],
      deliverables: ["差异列表"],
      acceptance: ["逐项列出不一致的合计"],
      evidence: ["已读取 D20=120，rev=7"],
    });
    const task = formatAgentTask("核对合计", handoff);
    expect(task).toContain("核对合计");
    expect(task).toContain(JSON.stringify(handoff));
    expect(task).toContain("不授予额外权限");
    expect(task).toContain("重新读取");
  });

  test("拒绝无效修订号和未定义字段", () => {
    expect(taskHandoffSchema.safeParse({ scope: [{ path: "a.xlsx", rev: -1 }] }).success).toBe(
      false,
    );
    expect(taskHandoffSchema.safeParse({ grantWrite: true }).success).toBe(false);
  });
});
