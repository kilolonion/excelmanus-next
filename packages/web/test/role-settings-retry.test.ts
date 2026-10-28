import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  states: [] as unknown[],
  cursor: 0,
  effects: [] as Array<() => undefined | (() => void)>,
  retry: null as null | (() => void),
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: (effect: () => undefined | (() => void)) => {
      mocks.effects.push(effect);
    },
    useState: (initial: unknown) => {
      const i = mocks.cursor++;
      if (!(i in mocks.states))
        mocks.states[i] = typeof initial === "function" ? initial() : initial;
      return [
        mocks.states[i],
        (value: unknown) => {
          mocks.states[i] = typeof value === "function" ? value(mocks.states[i]) : value;
        },
      ];
    },
  };
});
vi.mock("@/components/ui/button", async () => {
  const { createElement } = await import("react");
  return {
    Button: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => {
      if (children === "重新读取") mocks.retry = onClick ?? null;
      return createElement("button", null, children);
    },
  };
});
vi.mock("@/components/settings/model/form-widgets", () => ({ GlassSelect: () => null }));
vi.mock("@/lib/backend/api", () => ({ api: () => ({}), errorMessage: (e: Error) => e.message }));
vi.mock("@/stores/app-store", () => ({
  useAppStore: (select: (s: unknown) => unknown) =>
    select({
      settings: null,
      profiles: [{ id: "m", model: "test-model", provider: "openai", isDefault: true }],
      connections: [],
    }),
  refreshSettings: mocks.refresh,
  refreshProfiles: vi.fn(),
  updateSettings: vi.fn(),
}));
vi.mock("@/lib/shortcuts", () => ({ shortcutHelp: () => [] }));

vi.mock("@/components/settings/SettingsFoldSection", () => ({
  SettingsFoldSection: ({ children }: { children: ReactNode }) => children,
}));

import { RoleModelSection } from "../src/components/settings/model/RoleModelSection";

const flush = () => new Promise((done) => setTimeout(done, 0));
function render() {
  mocks.cursor = 0;
  mocks.effects = [];
  return renderToString(createElement(RoleModelSection));
}
function effects() {
  const cleanups = mocks.effects.map((run) => run());
  return () => {
    for (const cleanup of cleanups) cleanup?.();
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.states = [];
  mocks.effects = [];
  mocks.retry = null;
});
test("failed role settings reads offer a local retry that actually starts a fresh request", async () => {
  mocks.refresh.mockRejectedValueOnce(new Error("settings unavailable"));
  render();
  effects();
  await flush();
  const failed = render();
  expect(failed).toContain("settings unavailable");
  expect(failed).toContain("重新读取");
  mocks.refresh.mockResolvedValueOnce({});
  mocks.retry?.();
  render();
  effects();
  await flush();
  expect(mocks.refresh).toHaveBeenCalledTimes(2);
  expect(render()).not.toContain("settings unavailable");
});
test("closing the role settings page ignores its late load error", async () => {
  let reject!: (error: Error) => void;
  mocks.refresh.mockReturnValueOnce(
    new Promise((_yes, no) => {
      reject = no;
    }),
  );
  render();
  const close = effects();
  close();
  reject(new Error("old settings failure"));
  await flush();
  expect(mocks.states).not.toContain("old settings failure");
});
