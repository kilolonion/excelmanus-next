import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  index: 0,
  memos: [] as Array<{ deps: unknown[]; value: unknown }>,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useMemo: (fn: () => unknown, deps: unknown[]) => {
    const i = state.index++,
      old = state.memos[i];
    if (old && deps.every((v, j) => Object.is(v, old.deps[j]))) return old.value;
    const value = fn();
    state.memos[i] = { deps, value };
    return value;
  },
}));
vi.mock("../src/components/sidebar/file-tree-helpers", async (original) => {
  const actual = await original<typeof import("../src/components/sidebar/file-tree-helpers")>();
  return { ...actual, flattenFiles: vi.fn(actual.flattenFiles) };
});

import { flattenFiles } from "../src/components/sidebar/file-tree-helpers";
import { useFileListing } from "../src/components/sidebar/use-file-listing";

const dirs = {
  "": [
    { kind: "file" as const, path: "a.xlsx", name: "a.xlsx" },
    { kind: "file" as const, path: "b.xlsx", name: "b.xlsx" },
    { kind: "file" as const, path: ".hidden", name: ".hidden" },
  ],
};
let result: ReturnType<typeof useFileListing>;
function render(query = "", showSystem = false, data = dirs) {
  state.index = 0;
  function Probe() {
    result = useFileListing(data, showSystem, query);
    return null;
  }
  renderToString(createElement(Probe));
  return result;
}
beforeEach(() => {
  state.memos = [];
  vi.mocked(flattenFiles).mockClear();
});
test("visible files and hidden count share one filtered traversal", () => {
  expect(render().hiddenCount).toBe(1);
  expect(flattenFiles).toHaveBeenCalledTimes(1);
});
test("typing a search or changing visibility does not traverse unchanged directories again", () => {
  render();
  vi.mocked(flattenFiles).mockClear();
  expect(render("a").visibleFiles.map((f) => f.path)).toEqual(["a.xlsx"]);
  expect(render("", true).visibleFiles).toHaveLength(3);
  expect(flattenFiles).not.toHaveBeenCalled();
  expect(render("", false, { "": dirs[""].slice(0, 1) }).visibleFiles).toHaveLength(1);
});

test("successive search keys reuse normalized paths until directory contents change", () => {
  render("a");
  const lower = vi.spyOn(String.prototype, "toLocaleLowerCase");
  try {
    expect(render("b").visibleFiles.map((f) => f.path)).toEqual(["b.xlsx"]);
    // Only the new query is normalized; file paths were normalized by the first search.
    expect(lower).toHaveBeenCalledTimes(1);
  } finally {
    lower.mockRestore();
  }
});
