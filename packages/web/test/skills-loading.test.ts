import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  states: [] as unknown[],
  stateIndex: 0,
  expanded: null as string | null,
  list: vi.fn(),
  detail: vi.fn(),
  toast: vi.fn(),
  callbacks: [] as Array<(...args: string[]) => Promise<void>>,
  effects: [] as Array<() => undefined | (() => void)>,
  updates: [] as unknown[],
  event: null as null | ((event: { type: string }) => void),
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: (callback: (...args: string[]) => Promise<void>) => {
      mocks.callbacks.push(callback);
      return callback;
    },
    useEffect: (effect: () => undefined | (() => void)) => {
      mocks.effects.push(effect);
    },
    useState: (initial: unknown) => {
      const i = mocks.stateIndex++;
      if (!(i in mocks.states)) mocks.states[i] = i === 2 ? mocks.expanded : initial;
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
  api: () => ({ listSkills: mocks.list, getSkill: mocks.detail }),
  errorMessage: (e: Error) => e.message,
  desktop: () => null,
}));
vi.mock("@/components/ui/toaster", () => ({ toast: mocks.toast }));
vi.mock("@/stores/app-store", () => ({
  onAppEvent: (listener: typeof mocks.event) => {
    mocks.event = listener;
    return () => {
      mocks.event = null;
    };
  },
}));

import { SkillsTab } from "../src/components/settings/SkillsTab";

const flush = () => new Promise((done) => setTimeout(done, 0));
function mount() {
  renderToString(createElement(SkillsTab));
  const cleanups = mocks.effects.map((effect) => effect());
  const load = mocks.callbacks[0],
    detail = mocks.callbacks[1];
  if (!load || !detail) throw new Error("Missing skills callbacks");
  return {
    load,
    detail,
    close: () => {
      for (const cleanup of cleanups) cleanup?.();
    },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.states = [];
  mocks.stateIndex = 0;
  mocks.expanded = null;
  mocks.callbacks = [];
  mocks.effects = [];
  mocks.updates = [];
  mocks.event = null;
  mocks.list.mockResolvedValue({ items: [] });
});
test("a stale skills list cannot overwrite the latest refresh", async () => {
  let resolve!: (value: { items: unknown[] }) => void;
  mocks.list.mockReturnValueOnce(
    new Promise((yes) => {
      resolve = yes;
    }),
  );
  const { load } = mount();
  const current = [{ name: "current" }];
  mocks.list.mockResolvedValueOnce({ items: current });
  await load();
  expect(mocks.updates).toContainEqual(current);
  mocks.updates = [];
  resolve({ items: [{ name: "old" }] });
  await flush();
  expect(mocks.updates).toEqual([]);
});
test("closing skills ignores late list errors", async () => {
  let reject!: (error: Error) => void;
  mocks.list.mockReturnValueOnce(
    new Promise((_yes, no) => {
      reject = no;
    }),
  );
  const { close } = mount();
  close();
  mocks.updates = [];
  reject(new Error("old list failed"));
  await flush();
  expect(mocks.updates).toEqual([]);
  expect(mocks.toast).not.toHaveBeenCalled();
});
test("a skill change invalidates details already being read", async () => {
  let resolve!: (value: unknown) => void;
  mocks.detail.mockReturnValueOnce(
    new Promise((yes) => {
      resolve = yes;
    }),
  );
  const { detail } = mount();
  await flush();
  const pending = detail("same");
  mocks.event?.({ type: "skills.changed" });
  await flush();
  mocks.updates = [];
  resolve({ skill: { name: "same", content: "outdated" } });
  await pending;
  expect(mocks.updates).toEqual([]);
});
test("closing skills suppresses late detail failure notices", async () => {
  let reject!: (error: Error) => void;
  mocks.detail.mockReturnValueOnce(
    new Promise((_yes, no) => {
      reject = no;
    }),
  );
  const { detail, close } = mount();
  await flush();
  const pending = detail("same");
  close();
  mocks.updates = [];
  reject(new Error("old detail failed"));
  await pending;
  expect(mocks.updates).toEqual([]);
  expect(mocks.toast).not.toHaveBeenCalled();
});
test("current detail loads and failures retain their normal feedback", async () => {
  const { detail } = mount();
  await flush();
  mocks.updates = [];
  mocks.detail.mockResolvedValueOnce({ skill: { name: "same", content: "current" } });
  await detail("same");
  expect(mocks.updates).toHaveLength(1);
  const update = mocks.updates[0] as (state: object) => object;
  expect(update({})).toEqual({ same: { name: "same", content: "current" } });
  mocks.detail.mockRejectedValueOnce(new Error("current failure"));
  await detail("same");
  expect(mocks.toast).toHaveBeenCalledWith(
    expect.objectContaining({ description: "current failure" }),
  );
});

test("a skill change re-reads the expanded detail instead of leaving it empty", async () => {
  mocks.expanded = "same";
  mocks.detail.mockResolvedValueOnce({ skill: { name: "same", content: "updated" } });
  mount();
  await flush();
  mocks.updates = [];
  mocks.event?.({ type: "skills.changed" });
  await flush();
  expect(mocks.detail).toHaveBeenCalledWith("same");
  const update = mocks.updates.find((value) => typeof value === "function") as
    | ((state: object) => object)
    | undefined;
  expect(update?.({})).toEqual({ same: { name: "same", content: "updated" } });
});

function renderCurrent() {
  mocks.stateIndex = 0;
  return renderToString(createElement(SkillsTab));
}
test("skills read failures stay visible instead of claiming no skills are loaded", async () => {
  mocks.list.mockRejectedValueOnce(new Error("skills temporarily unavailable"));
  const { load } = mount();
  await flush();
  const failed = renderCurrent();
  expect(failed).toContain("skills temporarily unavailable");
  expect(failed).toContain("重新读取");
  expect(failed).not.toContain("暂无已加载的技能包");
  await load();
  expect(mocks.list).toHaveBeenCalledTimes(2);
  expect(renderCurrent()).toContain("暂无已加载的技能包");
});
