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
