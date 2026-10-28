import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  states: [] as unknown[],
  cursor: 0,
  list: vi.fn(),
  toast: vi.fn(),
  callbacks: [] as Array<(q: string) => Promise<void>>,
  effects: [] as Array<() => undefined | (() => void)>,
  updates: [] as unknown[],
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: (callback: (q: string) => Promise<void>) => {
      mocks.callbacks.push(callback);
      return callback;
    },
    useEffect: (effect: () => undefined | (() => void)) => {
      mocks.effects.push(effect);
    },
    useState: (initial: unknown) => {
      const i = mocks.cursor++;
      if (!(i in mocks.states)) mocks.states[i] = initial;
      return [
        mocks.states[i],
        (value: unknown) => {
          mocks.updates.push(value);
          mocks.states[i] = typeof value === "function" ? value(mocks.states[i]) : value;
        },
      ];
    },
  };
});
vi.mock("@/lib/backend/api", () => ({
  api: () => ({ listMemories: mocks.list }),
  errorMessage: (e: Error) => e.message,
}));
vi.mock("@/components/ui/toaster", () => ({ toast: mocks.toast }));
vi.mock("@/stores/app-store", () => ({
  useAppStore: (select: (state: unknown) => unknown) =>
    select({ workspaces: [], settings: { memoryInjection: true } }),
  onAppEvent: () => () => {},
  refreshSettings: vi.fn(),
  updateSettings: vi.fn(),
}));
vi.mock("@/components/settings/model/form-widgets", () => ({ GlassSelect: () => null }));

import { MemoryTab } from "../src/components/settings/MemoryTab";

function mount() {
  renderToString(createElement(MemoryTab));
  const cleanups = mocks.effects.map((effect) => effect());
  const load = mocks.callbacks[0];
  if (!load) throw new Error("Missing search callback");
  return {
    load,
    close: () => {
      for (const cleanup of cleanups) cleanup?.();
    },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.states = [];
  mocks.cursor = 0;
  mocks.callbacks = [];
  mocks.effects = [];
  mocks.updates = [];
  vi.stubGlobal("window", { setTimeout: vi.fn(() => 1), clearTimeout: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());
test("a slow old memory search cannot replace the latest results", async () => {
  let resolve!: (value: { items: unknown[] }) => void;
  mocks.list.mockReturnValueOnce(
    new Promise((yes) => {
      resolve = yes;
    }),
  );
  const { load } = mount();
  const old = load("old");
  const latest = [{ id: "new", content: "new result" }];
  mocks.list.mockResolvedValueOnce({ items: latest });
  await load("new");
  expect(mocks.updates).toContainEqual(latest);
  mocks.updates = [];
  resolve({ items: [{ id: "old" }] });
  await old;
  expect(mocks.updates).toEqual([]);
  expect(mocks.list.mock.calls.map((args) => args[0])).toEqual(["old", "new"]);
});
test("closing or changing the search invalidates a late failure and its toast", async () => {
  let reject!: (error: Error) => void;
  mocks.list.mockReturnValueOnce(
    new Promise((_yes, no) => {
      reject = no;
    }),
  );
  const { load, close } = mount();
  const pending = load("old");
  close();
  mocks.updates = [];
  reject(new Error("old read failed"));
  await pending;
  expect(mocks.updates).toEqual([]);
  expect(mocks.toast).not.toHaveBeenCalled();
});
test("the current search still reports a failure and can request again", async () => {
  mocks.list.mockRejectedValueOnce(new Error("current read failed"));
  const { load } = mount();
  await load("current");
  expect(mocks.updates).toContain("current read failed");
  mocks.list.mockResolvedValueOnce({ items: [] });
  await load("current");
  expect(mocks.list).toHaveBeenCalledTimes(2);
});

function renderCurrent() {
  mocks.cursor = 0;
  return renderToString(createElement(MemoryTab));
}
test("memory read failures stay visible instead of claiming there are no memories", async () => {
  mocks.list.mockRejectedValueOnce(new Error("memory temporarily unavailable"));
  const { load } = mount();
  await load("");
  const failed = renderCurrent();
  expect(failed).toContain("memory temporarily unavailable");
  expect(failed).toContain("重新读取");
  expect(failed).not.toContain("Agent 尚未记录任何记忆");
  mocks.list.mockResolvedValueOnce({ items: [] });
  await load("");
  expect(mocks.list).toHaveBeenCalledTimes(2);
  expect(renderCurrent()).toContain("Agent 尚未记录任何记忆");
});
