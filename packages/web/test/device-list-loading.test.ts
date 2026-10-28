import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  states: [] as unknown[],
  cursor: 0,
  effects: [] as Array<() => void | (() => void)>,
  callbacks: [] as Array<() => Promise<void>>,
  list: vi.fn(),
  toast: vi.fn(),
  retry: null as null | (() => void),
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return {
    ...actual,
    useEffect: (effect: () => void | (() => void)) => {
      mocks.effects.push(effect);
    },
    useCallback: (callback: () => Promise<void>) => {
      mocks.callbacks.push(callback);
      return callback;
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
vi.mock("@/lib/backend/api", () => ({
  isDesktop: () => true,
  signOut: vi.fn(),
  errorMessage: (e: Error) => e.message,
}));
vi.mock("@/components/ui/toaster", () => ({ toast: mocks.toast }));
vi.mock("@/lib/settings/devices", () => ({ listDevices: mocks.list, revokeDevice: vi.fn() }));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => {
    if (children === "重新读取列表") mocks.retry = onClick ?? null;
    return createElement("button", null, children);
  },
}));

import { AccessTab } from "../src/components/settings/AccessTab";

const flush = () => new Promise((done) => setTimeout(done, 0));
function render() {
  mocks.cursor = 0;
  mocks.effects = [];
  mocks.callbacks = [];
  return renderToString(createElement(AccessTab));
}
function mount() {
  render();
  const cleanups = mocks.effects.map((run) => run());
  return {
    load: mocks.callbacks[0],
    close: () => {
      for (const run of cleanups) run?.();
    },
  };
}
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.states = [];
  mocks.retry = null;
});
test("device list failure can retry the read in place", async () => {
  mocks.list.mockRejectedValueOnce(new Error("list unavailable"));
  const page = mount();
  await flush();
  expect(render()).toContain("list unavailable");
  expect(render()).toContain("重新读取列表");
  mocks.list.mockResolvedValueOnce([]);
  mocks.retry?.();
  await flush();
  expect(mocks.list).toHaveBeenCalledTimes(2);
  expect(render()).not.toContain("list unavailable");
  page.close();
});
test("device list ignores read failure after the panel closes", async () => {
  const pending = deferred();
  mocks.list.mockReturnValueOnce(pending.promise);
  const page = mount();
  page.close();
  pending.reject(new Error("late error"));
  await flush();
  expect(mocks.states).not.toContain("late error");
});
