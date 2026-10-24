import { expect, test } from "vitest";
import { buildSystemPrompt } from "../src/prompts.ts";

test("delivery guidance grounds every numeric claim and does not treat samples as exhaustive", () => {
  const prompt = buildSystemPrompt({
    workspaceName: "test",
    permissionMode: "default",
    date: "2026-01-01",
  });
  expect(prompt).toContain("最终回复中的每条数字");
  expect(prompt).toContain("底层值与格式化显示值");
  expect(prompt).toContain("不得从采样、截断或局部校验推断");
});

test("harness final contract uses host handles without presentation-dependent correctness", async () => {
  const { NUMERIC_DELIVERY_GUIDANCE: guidance } = await import("../src/numeric-delivery.ts");
  expect(guidance).toContain("deliver");
  expect(guidance).toContain("inspect");
  expect(guidance).toContain("finalize");
  expect(guidance).not.toContain("bindingId");
  expect(guidance).not.toContain('presentation:"summary"');
  expect(guidance).not.toContain("valueRefId");
  expect(guidance).not.toContain("labelRefId");
  expect(guidance).not.toContain("relation:");
  expect(guidance).toContain("文件内容核验与最终展示");
  expect(guidance).toContain("不改变业务状态");
  expect(guidance).toContain("required_output");
  expect(guidance).toContain("终结");
  expect(guidance).toContain("必报计数");
});
