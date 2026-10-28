import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ loaded: false, error: null as string | null }));
vi.mock("@/stores/app-store", () => ({
  useAppStore: (select: (s: unknown) => unknown) =>
    select({ profilesLoaded: mocks.loaded, profilesError: mocks.error }),
  refreshProfiles: vi.fn(),
}));
vi.mock("@/components/settings/model/ProfileSection", () => ({
  ProfileSection: () => "模型列表内容",
}));
vi.mock("@/components/settings/model/RoleModelSection", () => ({ RoleModelSection: () => null }));
vi.mock("@/components/settings/model/SubscriptionPanel", () => ({ SubscriptionPanel: () => null }));

import { ModelTab } from "../src/components/settings/ModelTab";

test("the initial model settings view shows loading instead of empty configuration", () => {
  mocks.loaded = false;
  mocks.error = null;
  const html = renderToString(createElement(ModelTab));
  expect(html).toContain("正在加载模型配置");
  expect(html).not.toContain("模型列表内容");
});
test("failed initial model loading offers retry without revealing empty configuration", () => {
  mocks.loaded = false;
  mocks.error = "temporary";
  const html = renderToString(createElement(ModelTab));
  expect(html).toContain("模型配置暂时无法显示");
  expect(html).toContain("重试");
  expect(html).not.toContain("模型列表内容");
});
test("confirmed model data reveals the regular configuration view", () => {
  mocks.loaded = true;
  mocks.error = null;
  expect(renderToString(createElement(ModelTab))).toContain("模型列表内容");
});
