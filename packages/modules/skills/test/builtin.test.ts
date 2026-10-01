// 04 §7.1 检查规则【硬性】：内置技能 frontmatter 合法、声明 requires-tools，
// 正文引用的工具名必须存在于工具目录（06 §8 主代理 21 个内置工具）。

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseSkillMd, referencedToolNames } from "../src/index.ts";

const TOOLS = new Set([
  "read",
  "find",
  "write",
  "edit",
  "files",
  "workbook_read",
  "workbook_analyze",
  "workbook_edit",
  "workbook_export",
  "workbook_render",
  "run_script",
  "ask_user",
  "present",
  "todo",
  "agent_spawn",
  "agent_send",
  "agent_wait",
  "agent_status",
  "agent_control",
  "skill",
  "memory",
]);
const DIR = join(import.meta.dirname, "../../../../assets/skills");

describe("内置技能", () => {
  const names = readdirSync(DIR);
  test("数量与 12 §1.6 一致", () => {
    expect(names.sort()).toEqual([
      "batch-files",
      "data-cleaning",
      "excelmanus-guide",
      "formula-help",
      "image-to-sheet",
      "reconciliation",
      "report-building",
      "script-patterns",
      "sheet-styling",
    ]);
  });
  for (const name of names) {
    test(name, () => {
      const skill = parseSkillMd(readFileSync(join(DIR, name, "SKILL.md"), "utf8"));
      expect(skill.name).toBe(name);
      expect(skill.description.length).toBeLessThanOrEqual(100);
      for (const t of skill.requiresTools) expect(TOOLS.has(t), `requires-tools: ${t}`).toBe(true);
      for (const t of referencedToolNames(skill.body, TOOLS))
        expect(TOOLS.has(t), `正文引用 ${t}`).toBe(true);
    });
  }
});
