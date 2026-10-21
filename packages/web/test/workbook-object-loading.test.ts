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
  api: () => ({ getDocImage: mocks.list }),
  errorMessage: (e: Error) => e.message,
}));
vi.mock("@/components/ui/toaster", () => ({ toast: mocks.toast }));
vi.mock("@/stores/workbook-store", () => ({
  useWorkbookStore: { getState: () => ({ workspaceId: "ws" }) },
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => {
    if (children === "重新加载") mocks.retry = onClick ?? null;
    return createElement("button", null, children);
  },
}));

import { WorkbookObject } from "../src/components/excel/WorkbookObject";

const flush = () => new Promise((done) => setTimeout(done, 0));
const baseImage = { id: "img", width: 200, height: 100 };
function render(docId = "doc", image = baseImage) {
  mocks.cursor = 0;
  mocks.effects = [];
  mocks.callbacks = [];
  return renderToString(
    createElement(WorkbookObject, {
      popup: {
        extraProps: {
          docId,
          sheetId: "sheet",
          image,
        },
      },
    }),
  );
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
beforeEach(() => {
  vi.clearAllMocks();
  mocks.states = [];
  mocks.retry = null;
});
test("workbook image failure offers a retry that reads the same object again", async () => {
  mocks.list.mockRejectedValueOnce(new Error("image unavailable"));
  const page = mount();
  await flush();
  expect(render()).toContain("image unavailable");
  expect(render()).toContain("重新加载");
  mocks.retry?.();
  expect(mocks.states[2]).toBe(1);
  page.close();
  render();
  mocks.list.mockReturnValueOnce(new Promise(() => {}));
  const cleanups = mocks.effects.map((run) => run());
  expect(mocks.list).toHaveBeenCalledTimes(2);
  expect(mocks.list).toHaveBeenLastCalledWith("ws", "doc", "sheet", "img");
  for (const run of cleanups) run?.();
});

test("a refreshed image never renders the previous object URL before its effect runs", async () => {
  mocks.list.mockResolvedValue(new Blob(["image"], { type: "image/png" }));
  const page = mount();
  await flush();
  expect(render()).toContain("blob:");
  const next = render("doc", { ...baseImage });
  expect(next).not.toContain('src="blob:');
  page.close();
});
test("a prior object failure is hidden immediately when the source changes", async () => {
  mocks.list.mockRejectedValue(new Error("old image failure"));
  const page = mount();
  await flush();
  expect(render()).toContain("old image failure");
  expect(render("new-doc")).not.toContain("old image failure");
  page.close();
});
