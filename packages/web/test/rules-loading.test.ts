import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  states: [] as unknown[],
  cursor: 0,
  list: vi.fn(),
  toast: vi.fn(),
  callbacks: [] as Array<() => Promise<void>>,
  effects: [] as Array<() => undefined | (() => void)>,
  updates: [] as unknown[],
  refs: [] as Array<{ current: unknown }>,
  refIndex: 0,
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: (callback: () => Promise<void>) => {
      mocks.callbacks.push(callback);
      return callback;
    },
    useEffect: (effect: () => undefined | (() => void)) => {
      mocks.effects.push(effect);
    },
    useRef: (initial: unknown) => {
      const i = mocks.refIndex++;
      mocks.refs[i] ??= { current: initial };
      return mocks.refs[i];
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
  api: () => ({ listRules: mocks.list }),
  errorMessage: (e: Error) => e.message,
}));
vi.mock("@/components/ui/toaster", () => ({ toast: mocks.toast }));
vi.mock("@/stores/app-store", () => ({ onAppEvent: () => () => {} }));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (select: (s: unknown) => unknown) => select({ activeSessionId: null }),
}));

import { RulesTab } from "../src/components/settings/RulesTab";

const flush = () => new Promise((done) => setTimeout(done, 0));
const result = (id: string) => ({ items: [{ id }], totalChars: 4, maxTotalChars: 100 });
function mount(sessionId = "old") {
  mocks.cursor = 0;
  mocks.refIndex = 0;
  mocks.effects = [];
  mocks.callbacks = [];
  renderToString(createElement<{ sessionId?: string }>(RulesTab, { sessionId }));
  const cleanups = mocks.effects.map((effect) => effect());
  const load = mocks.callbacks[0];
  if (!load) throw new Error("Missing rules callback");
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
  mocks.refs = [];
  mocks.updates = [];
  mocks.list.mockResolvedValue(result("current"));
});
test("changing session invalidates the old response and old reload callback", async () => {
  let resolve!: (value: unknown) => void;
  mocks.list.mockReturnValueOnce(
    new Promise((yes) => {
      resolve = yes;
    }),
  );
  const old = mount("old");
  old.close();
  mount("new");
  await flush();
  mocks.updates = [];
  resolve(result("old"));
  await flush();
  expect(mocks.updates).toEqual([]);
  const calls = mocks.list.mock.calls.length;
  await old.load();
  expect(mocks.list).toHaveBeenCalledTimes(calls);
});
test("the latest rules refresh wins over an older request", async () => {
  let resolve!: (value: unknown) => void;
  mocks.list.mockReturnValueOnce(
    new Promise((yes) => {
      resolve = yes;
    }),
  );
  const { load } = mount();
  await load();
  expect(mocks.updates).toContainEqual(result("current").items);
  mocks.updates = [];
  resolve(result("old"));
  await flush();
  expect(mocks.updates).toEqual([]);
});
test("closing rules suppresses late error and loading updates", async () => {
  let reject!: (error: Error) => void;
  mocks.list.mockReturnValueOnce(
    new Promise((_yes, no) => {
      reject = no;
    }),
  );
  const { close } = mount();
  close();
  mocks.updates = [];
  reject(new Error("old failure"));
  await flush();
  expect(mocks.updates).toEqual([]);
  expect(mocks.toast).not.toHaveBeenCalled();
});
test("current failures still report and a later refresh can recover", async () => {
  mocks.list.mockRejectedValueOnce(new Error("current failure"));
  const { load } = mount();
  await flush();
  expect(mocks.updates).toContain("current failure");
  await load();
  expect(mocks.updates).toContainEqual(result("current").items);
});

function renderCurrent() {
  mocks.cursor = 0;
  mocks.refIndex = 0;
  return renderToString(createElement<{ sessionId?: string }>(RulesTab, { sessionId: "old" }));
}
test("rule load failure stays visible and offers a real local retry", async () => {
  mocks.list.mockRejectedValueOnce(new Error("rules unavailable"));
  const { load } = mount();
  await flush();
  const failed = renderCurrent();
  expect(failed).toContain("rules unavailable");
  expect(failed).toContain("重新读取");
  expect(failed).not.toContain("还没有全局规则");
  mocks.list.mockResolvedValueOnce({ items: [], totalChars: 0, maxTotalChars: 8000 });
  await load();
  expect(mocks.list).toHaveBeenCalledTimes(2);
  expect(renderCurrent()).toContain("还没有全局规则");
});
