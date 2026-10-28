import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settings: null as null | { defaultPermissionMode: string },
  mode: null as string | null,
}));
vi.mock("@/stores/app-store", () => ({
  useAppStore: (select: (s: unknown) => unknown) => select({ settings: mocks.settings }),
}));
vi.mock("@/stores/chat-store", () => ({
  useChatStore: (select: (s: unknown) => unknown) =>
    select({ sessionId: "s", session: { permissionMode: mocks.mode } }),
  setPermissionMode: vi.fn(),
}));

import { ModeBadges } from "../src/components/chat/ModeBadges";

test("an unknown permission setting is not displayed as standard", () => {
  mocks.mode = null;
  mocks.settings = null;
  const html = renderToString(createElement(ModeBadges));
  expect(html).toContain("权限待确认");
  expect(html).not.toContain(">标准<");
});
test("known session mode remains visible while global settings load", () => {
  mocks.mode = "confirm";
  mocks.settings = null;
  const html = renderToString(createElement(ModeBadges));
  expect(html).toContain("询问");
  expect(html).not.toContain("权限待确认");
});
test("known defaults are shown when the session has no override", () => {
  mocks.mode = null;
  mocks.settings = { defaultPermissionMode: "auto" };
  expect(renderToString(createElement(ModeBadges))).toContain("自动审批");
});
