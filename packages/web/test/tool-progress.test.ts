import { expect, test } from "vitest";
import { pendingToolLabel } from "../src/lib/tool-labels.ts";

test("parameter streaming has a fallback name and observable progress", () => {
  expect(pendingToolLabel("", "")).toBe("正在准备：工具调用 · 等待参数");
  expect(pendingToolLabel("workbook_edit", '{"ops":[]}')).toBe(
    "正在准备：修改工作簿 · 已接收 10 字符",
  );
});
