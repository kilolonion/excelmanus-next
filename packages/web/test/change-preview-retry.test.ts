import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  values: [] as unknown[],
  index: 0,
  effects: [] as (() => (() => void) | void)[],
  before: vi.fn(),
  snapshot: vi.fn(),
  retry: null as null | (() => void),
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState: (initial: unknown) => {
      const index = state.index++;
      if (!(index in state.values)) state.values[index] = initial;
      return [
        state.values[index],
        (value: unknown) => {
          state.values[index] = typeof value === "function" ? value(state.values[index]) : value;
        },
      ];
    },
    useEffect: (effect: () => (() => void) | void) => {
      state.effects.push(effect);
    },
  };
});
vi.mock("@/lib/backend/api", () => ({
  api: () => ({ getDocRevBefore: state.before, getDocSnapshot: state.snapshot }),
  errorMessage: (error: Error) => error.message,
}));
vi.mock("@/stores/workbook-store", () => ({
  useWorkbookStore: () => 1,
  focusRange: vi.fn(),
  openWorkbook: vi.fn(),
}));
vi.mock("@/stores/chat-store", () => ({ useChatStore: vi.fn() }));
vi.mock("@/components/ui/button", async () => {
  const { createElement } = await import("react");
  return {
    Button: (props: { onClick: () => void; children: string }) => {
      state.retry = props.onClick;
      return createElement("button", props);
    },
  };
});

import { BeforeAfter } from "../src/components/excel/ChangeNavigator";

let rev = 0;
function render() {
  state.index = 0;
  state.effects = [];
  return renderToString(
    createElement(BeforeAfter, { workspaceId: "ws", docId: "doc", rev, range: "Sheet1!A1" }),
  );
}
beforeEach(() => {
  rev += 1;
  state.values = [];
  state.before
    .mockReset()
    .mockResolvedValue({ cells: [{ row: 0, col: 0, sheet: "Sheet1", value: "old" }] });
  state.snapshot
    .mockReset()
    .mockResolvedValue({
      snapshot: { sheets: { sheet: { name: "Sheet1", cellData: { 0: { 0: { v: "new" } } } } } },
    });
});
test("failed before/after reads stay visible and retry actually requests and recovers", async () => {
  state.before.mockRejectedValueOnce(new Error("读取暂时失败"));
  render();
  state.effects[0]();
  await vi.waitFor(() => expect(render()).toContain("重新读取"));
  expect(render()).toContain("读取暂时失败");
  state.retry?.();
  render();
  state.effects[0]();
  await vi.waitFor(() => expect(render()).toContain("old"));
  expect(render()).toContain("new");
  expect(render()).not.toContain("重新读取");
  expect(state.before).toHaveBeenCalledTimes(2);
});
test("closing before/after preview ignores late read errors", async () => {
  let reject!: (reason: Error) => void;
  state.before.mockReturnValueOnce(
    new Promise((_resolve, no) => {
      reject = no;
    }),
  );
  render();
  const cancel = state.effects[0]();
  cancel?.();
  reject(new Error("迟到错误"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(render()).not.toContain("迟到错误");
});
