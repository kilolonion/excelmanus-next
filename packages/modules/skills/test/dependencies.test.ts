import { expect, test } from "vitest";
import { missingSkillTools, parseSkillMd } from "../src/index.ts";

test("可选路线缺少工具不阻断主任务，必需依赖与未声明的未知引用仍阻断", () => {
  const skill = parseSkillMd(
    "---\nname: batch-demo\ndescription: 批处理\nrequires-tools: [workbook_read]\noptional-tools: [agent_spawn]\n---\n可用 `agent_spawn` 分工，否则顺序处理。\n",
  );
  expect(missingSkillTools(skill, new Set(["workbook_read"]))).toEqual([]);
  expect(missingSkillTools(skill, new Set())).toEqual(["workbook_read"]);
  expect(
    missingSkillTools(skill, new Set(["workbook_read"]), ["参考资料使用 `workbook_missing`。"]),
  ).toEqual(["workbook_missing"]);
});
