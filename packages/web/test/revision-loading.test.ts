import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  states: [] as unknown[],
  list: vi.fn(),
  docId: "one",
  workspaceId: "ws",
  stateIndex: 0,
  callbacks: [] as Array<() => Promise<void>>,
  effects: [] as Array<() => undefined | (() => void)>,
  updates: [] as unknown[],
  keys: [] as unknown[],
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
    useState: (initial: unknown) => {
      const i = mocks.stateIndex++;
      if (!(i in mocks.states)) mocks.states[i] = i === 0 ? true : initial;
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
  api: () => ({ listDocRevisions: mocks.list }),
  ApiError: class extends Error {},
  errorMessage: (e: Error) => e.message,
}));
vi.mock("@/stores/workbook-store", () => ({
  useWorkbookStore: (select: (s: unknown) => unknown) =>
    select({ doc: { docId: mocks.docId, rev: 1 }, workspaceId: mocks.workspaceId }),
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (select: (s: unknown) => unknown) => select({ sessions: [] }),
}));
vi.mock("@/components/ui/popover", async () => {
  const { createElement } = await import("react");
  const box = ({ children }: { children: ReactNode }) => createElement("div", null, children);
  return {
    Popover: box,
    PopoverTrigger: box,
    PopoverContent: ({ children }: { children: ReactElement }) => {
      mocks.keys.push(children?.key);
      return createElement("div", null, children);
    },
  };
});
vi.mock("@/components/ui/tooltip", async () => {
  const { createElement } = await import("react");
  const box = ({ children }: { children: ReactNode }) => createElement("div", null, children);
  return { Tooltip: box, TooltipTrigger: box, TooltipContent: box };
});

import { RevisionHistory } from "../src/components/excel/RevisionHistory";

const flush = () => new Promise((done) => setTimeout(done, 0));
function mount() {
  mocks.stateIndex = 0;
  mocks.effects = [];
  mocks.callbacks = [];
  renderToString(createElement(RevisionHistory));
  const cleanups = mocks.effects.map((effect) => effect());
  const load = mocks.callbacks[0];
  if (!load) throw new Error("Missing revision load");
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
  mocks.docId = "one";
  mocks.workspaceId = "ws";
  mocks.keys = [];
  mocks.updates = [];
  mocks.list.mockResolvedValue({ items: [] });
});
test("revision view is replaced when switching documents", () => {
  mount().close();
  mocks.docId = "two";
  mount();
  expect(mocks.keys[0]).not.toEqual(mocks.keys[1]);
});
test("old revision responses cannot replace a newer refresh", async () => {
  let resolve!: (value: unknown) => void;
  mocks.list.mockReturnValueOnce(
    new Promise((yes) => {
      resolve = yes;
    }),
  );
  const { load } = mount();
  const current = [{ rev: 2 }];
  mocks.list.mockResolvedValueOnce({ items: current });
  await load();
  expect(mocks.updates).toContainEqual(current);
  mocks.updates = [];
  resolve({ items: [{ rev: 1 }] });
  await flush();
  expect(mocks.updates).toEqual([]);
});
test("closing revisions ignores old errors and prevents an old reload", async () => {
  let reject!: (error: Error) => void;
  mocks.list.mockReturnValueOnce(
    new Promise((_yes, no) => {
      reject = no;
    }),
  );
  const { load, close } = mount();
  close();
  mocks.updates = [];
  reject(new Error("old revision failure"));
  await flush();
  expect(mocks.updates).toEqual([]);
  const calls = mocks.list.mock.calls.length;
  await load();
  expect(mocks.list).toHaveBeenCalledTimes(calls);
});
test("current revision failures remain visible", async () => {
  mocks.list.mockRejectedValueOnce(new Error("current failure"));
  mount();
  await flush();
  expect(mocks.updates).toContain("current failure");
});

function renderCurrent() {
  mocks.stateIndex = 0;
  return renderToString(createElement(RevisionHistory));
}
test("revision load failure can be retried without closing the panel", async () => {
  mocks.list.mockRejectedValueOnce(new Error("revision service unavailable"));
  const { load } = mount();
  await flush();
  expect(renderCurrent()).toContain("revision service unavailable");
  expect(renderCurrent()).toContain("重新读取");
  await load();
  expect(mocks.list).toHaveBeenCalledTimes(2);
  expect(renderCurrent()).toContain("还没有修订");
});
