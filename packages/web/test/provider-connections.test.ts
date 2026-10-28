import type { ModelProfile, ProviderConnection } from "@excelmanus/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { ProfileEditor } from "../src/components/settings/model/ProfileEditor";
import { ProfileSection } from "../src/components/settings/model/ProfileSection";
import { toPickerModel } from "../src/hooks/use-model-selection";
import { useAppStore } from "../src/stores/app-store";

const connection = (id: string): ProviderConnection => ({
  id,
  name: `供应商 ${id}`,
  provider: "custom-openai-compatible",
  baseUrl: "https://same.test/v1",
  hasCredential: false,
  apiKeyMasked: null,
  accountId: null,
  modelCount: 0,
  modelsUpdatedAt: null,
  createdAt: "now",
  updatedAt: "now",
});
test("empty supplier cards stay visible and same-host connections stay separate", () => {
  const initial = useAppStore.getInitialState();
  const old = { ...initial };
  Object.assign(initial, {
    connections: [connection("one"), connection("two")],
    profiles: [],
    providers: [],
  });
  try {
    const html = renderToStaticMarkup(createElement(ProfileSection));
    expect(html).toContain("供应商 one");
    expect(html).toContain("供应商 two");
    expect(html).toContain("添加供应商");
    expect(html.match(/连接已就绪/g)).toHaveLength(2);
  } finally {
    Object.assign(initial, old);
  }
});
test("model form selects IDs without asking again for URL or key", () => {
  const html = renderToStaticMarkup(
    createElement(ProfileEditor, { connection: connection("one"), onClose: () => {} }),
  );
  expect(html).toContain("模型 ID");
  expect(html).toContain("高级选项");
  expect(html).not.toContain("API Key");
  expect(html).not.toContain("接口地址");
});
test("picker uses connection name for grouping and actual model for label", () => {
  const item = toPickerModel(
    {
      id: "p",
      connectionId: "one",
      model: "actual-model",
      name: "alias",
      provider: "custom-openai-compatible",
      isDefault: true,
    } as ModelProfile,
    new Map([["one", "Work gateway"]]),
  );
  expect(item).toMatchObject({
    connectionId: "one",
    providerLabel: "Work gateway",
    label: "actual-model",
  });
});
