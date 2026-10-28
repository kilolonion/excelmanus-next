import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { expect, test, vi } from "vitest";

vi.mock("@/lib/backend/api", () => ({
  api: vi.fn(),
  desktop: () => null,
  errorMessage: (e: Error) => e.message,
}));
vi.mock("@/stores/app-store", () => ({
  useAppStore: (select: (s: unknown) => unknown) =>
    select({ workspaces: [], settings: { memoryInjection: true } }),
  onAppEvent: vi.fn(),
  refreshSettings: vi.fn(),
  updateSettings: vi.fn(),
}));
vi.mock("@/components/settings/model/form-widgets", () => ({ GlassSelect: () => null }));

import { MemoryTab } from "../src/components/settings/MemoryTab";
import { SkillsTab } from "../src/components/settings/SkillsTab";

test("memory first paint shows loading, not a false empty library or zero count", () => {
  const html = renderToString(createElement(MemoryTab));
  expect(html).toContain("正在读取记忆列表");
  expect(html).not.toContain("Agent 尚未记录任何记忆");
  expect(html).not.toContain("Agent 已保留");
});
test("skills first paint shows loading, not a false empty list or zero count", () => {
  const html = renderToString(createElement(SkillsTab));
  expect(html).toContain("正在读取技能列表");
  expect(html).not.toContain("暂无已加载的技能包");
  expect(html).not.toContain("已加载");
});
