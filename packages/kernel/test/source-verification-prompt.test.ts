import { expect, test } from "vitest";
import { buildSystemPrompt } from "../src/prompts.ts";

test("execution principle separates coverage, provenance and amounts before completion", () => {
  const prompt = buildSystemPrompt({
    workspaceName: "test",
    permissionMode: "default",
    date: "2026-01-01",
  });
  expect(prompt).toContain("分别核验记录完整性、身份与来源、金额一致性");
  expect(prompt).toContain("发现矛盾先解决或明确披露，再声称完成");
  expect(prompt).not.toContain("source_alignment");
  expect(prompt).not.toContain("row_expression");
});
