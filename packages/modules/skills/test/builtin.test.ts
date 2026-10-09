// 04 §7.1 检查规则【硬性】：内置技能 frontmatter 合法、声明 requires-tools，
// 正文引用的工具名必须存在于工具目录（06 §8 主代理 21 个内置工具）。

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { parse as parseYaml } from "yaml";
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
  test("目录与当前文档清单一致，不以固定数量验收", () => {
    const doc = readFileSync(join(DIR, "../../docs/12-skills-memory-mcp.md"), "utf8");
    const section = doc.split("### 1.6")[1]?.split("## 2.")[0] ?? "";
    const listed = [...section.matchAll(/^\| `([a-z0-9-]+)` \|/gm)].map((m) => m[1]);
    expect(names.sort()).toEqual(listed.sort());
  });
  for (const name of names) {
    test(name, () => {
      const text = readFileSync(join(DIR, name, "SKILL.md"), "utf8");
      const skill = parseSkillMd(text);
      expect(parseYaml(text.split("---")[1] ?? "")).toHaveProperty("requires-tools");
      expect(skill.name).toBe(name);
      expect(skill.description.length).toBeLessThanOrEqual(100);
      for (const t of skill.requiresTools) expect(TOOLS.has(t), `requires-tools: ${t}`).toBe(true);
      for (const t of skill.optionalTools) expect(TOOLS.has(t), `optional-tools: ${t}`).toBe(true);
      for (const t of referencedToolNames(skill.body, TOOLS))
        expect(TOOLS.has(t), `正文引用 ${t}`).toBe(true);
      for (const match of skill.body.matchAll(/\]\(([^)]+\.md)\)/g)) {
        const root = join(DIR, name);
        const target = resolve(root, match[1] ?? "");
        expect(relative(root, target).startsWith(".."), "参考资料必须在本技能目录内").toBe(false);
        const reference = readFileSync(target, "utf8");
        for (const t of referencedToolNames(reference, TOOLS))
          expect(TOOLS.has(t), `参考资料引用 ${t}`).toBe(true);
      }
    });
  }
});
