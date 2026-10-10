import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";
import { v1EvalCases } from "../../fixtures/v1-evals/cases.ts";

test("V1 有40个唯一且可离线校验的合成评测任务，含公式/图表/视觉/12文件", () => {
  expect(v1EvalCases).toHaveLength(40);
  expect(new Set(v1EvalCases.map((c) => c.id)).size).toBe(40);
  expect(v1EvalCases.some((c) => Object.keys(c.files).length === 12)).toBe(true);
  expect(v1EvalCases.some((c) => c.image)).toBe(true);
  expect(v1EvalCases.some((c) => c.outputs.some((o) => o.nativeCharts === 1))).toBe(true);
  for (const c of v1EvalCases) {
    expect(c.prompt.length).toBeGreaterThan(20);
    expect(c.outputs.every((o) => o.cells.length > 0)).toBe(true);
    expect(c.manual.length).toBeGreaterThan(0);
  }
  const result = spawnSync(process.execPath, ["scripts/evaluate-v1.ts", "--validate"], {
    encoding: "utf8",
    timeout: 30000,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("40 个场景");
  expect(result.stdout).toContain("真实模型效果未验证");
}, 35000);
