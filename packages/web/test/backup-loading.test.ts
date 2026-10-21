import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  toast: vi.fn(),
  states: [] as unknown[],
  cursor: 0,
  refs: [] as Array<{ current: unknown }>,
  refIndex: 0,
  callbacks: [] as Array<() => Promise<void>>,
  effects: [] as Array<() => undefined | (() => void)>,
  updates: [] as unknown[],
  changeKind: null as null | ((kind: string) => void),
  changeWorkspace: null as null | ((id: string) => void),
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
      if (!(i in mocks.states))
        mocks.states[i] = typeof initial === "function" ? initial() : initial;
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
  api: () => ({ listBackups: mocks.list }),
  desktop: () => null,
  saveBlob: vi.fn(),
  errorMessage: (e: Error) => e.message,
}));
vi.mock("@/components/ui/toaster", () => ({ toast: mocks.toast }));
vi.mock("@/stores/app-store", () => ({
  useAppStore: (select: (s: unknown) => unknown) =>
    select({
      workspaces: [
        { id: "one", name: "One" },
        { id: "two", name: "Two" },
      ],
    }),
  onAppEvent: () => () => {},
  removeWorkspace: vi.fn(),
  setDefaultWorkspace: vi.fn(),
}));
vi.mock("@/components/sidebar/AddWorkspaceDialog", () => ({ AddWorkspaceDialog: () => null }));
vi.mock("@/components/settings/model/form-widgets", () => ({
  GlassSelect: ({ onChange }: { onChange: (id: string) => void }) => {
    mocks.changeWorkspace = onChange;
    return null;
  },
}));
vi.mock("@/components/settings/SettingsPageLayout", async () => {
  const { createElement } = await import("react");
  const box = ({ children }: { children: ReactNode }) => createElement("div", null, children);
  return {
    SettingsPageLayout: box,
    SettingsPagePanel: box,
    SettingsPageSubnav: ({ onChange }: { onChange: (kind: string) => void }) => {
      mocks.changeKind = onChange;
      return null;
    },
  };
});

import { WorkspaceTab } from "../src/components/settings/WorkspaceTab";

const flush = () => new Promise((done) => setTimeout(done, 0));
function mount() {
  mocks.cursor = 0;
  mocks.refIndex = 0;
  mocks.effects = [];
  mocks.callbacks = [];
  renderToString(createElement(WorkspaceTab));
  const cleanups = mocks.effects.map((run) => run());
  const load = mocks.callbacks[0];
  if (!load) throw new Error("Missing backup load callback");
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
  mocks.refs = [];
  mocks.updates = [];
  mocks.list.mockResolvedValue({ items: [] });
});
test.each(["kind", "workspace"])(
  "changing %s ignores the old backup response and reload callback",
  async (change) => {
    let resolve!: (value: unknown) => void;
    mocks.list.mockReturnValueOnce(
      new Promise((yes) => {
        resolve = yes;
      }),
    );
    const old = mount();
    old.close();
    if (change === "kind") mocks.changeKind?.("trash");
    else mocks.changeWorkspace?.("two");
    mount();
    await flush();
    mocks.updates = [];
    resolve({ items: [{ id: "old", createdAt: "2026-10-01" }] });
    await flush();
    expect(mocks.updates).toEqual([]);
    const calls = mocks.list.mock.calls.length;
    await old.load();
    expect(mocks.list).toHaveBeenCalledTimes(calls);
  },
);
test("closing backups suppresses a late failure", async () => {
  let reject!: (error: Error) => void;
  mocks.list.mockReturnValueOnce(
    new Promise((_yes, no) => {
      reject = no;
    }),
  );
  const { close } = mount();
  close();
  mocks.updates = [];
  reject(new Error("old backup failure"));
  await flush();
  expect(mocks.updates).toEqual([]);
  expect(mocks.toast).not.toHaveBeenCalled();
});
test("current backups still sort newest first", async () => {
  const older = { id: "old", createdAt: "2026-10-01" },
    newer = { id: "new", createdAt: "2026-10-02" };
  mocks.list.mockResolvedValueOnce({ items: [older, newer] });
  mount();
  await flush();
  expect(mocks.updates).toContainEqual([newer, older]);
});

function renderCurrent() {
  mocks.cursor = 0;
  mocks.refIndex = 0;
  return renderToString(createElement(WorkspaceTab));
}
test("backup read failure is not an empty list and can request again", async () => {
  mocks.list.mockRejectedValueOnce(new Error("backup service unavailable"));
  const { load } = mount();
  await flush();
  const failed = renderCurrent();
  expect(failed).toContain("backup service unavailable");
  expect(failed).not.toContain("暂无备份");
  expect(failed).toContain("重新读取");
  await load();
  expect(mocks.list).toHaveBeenCalledTimes(2);
  expect(renderCurrent()).toContain("暂无备份");
  expect(renderCurrent()).not.toContain("backup service unavailable");
});
