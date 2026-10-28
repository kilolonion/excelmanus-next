import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  memos: [] as Array<{ deps: unknown[]; value: unknown }>,
  index: 0,
  items: [
    { kind: "file" as const, name: "a.xlsx", path: "a.xlsx" },
    { kind: "file" as const, name: "b.xlsx", path: "b.xlsx" },
  ],
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
vi.mock("@/stores/files-store", async (original) => ({
  ...(await original<typeof import("../src/stores/files-store")>()),
  useFilesStore: (select: (s: unknown) => unknown) =>
    select({ dirs: { "": state.items }, loading: {}, errors: {} }),
}));
vi.mock("../src/components/sidebar/FileRowMenu", () => ({ FileRowMenu: () => null }));
vi.mock("@/lib/file-sorting", async (original) => {
  const actual = await original<typeof import("../src/lib/file-sorting")>();
  return { ...actual, sortFiles: vi.fn(actual.sortFiles) };
});

import { DirChildren, type TreeContext } from "../src/components/sidebar/TreeNodeItem";
import { sortFiles } from "../src/lib/file-sorting";

test("tree rerenders only resort when ordering inputs actually change", () => {
  const ctx: TreeContext = {
    marks: new Map(),
    sort: "name",
    openPaths: new Set(),
    selectedPaths: new Set(),
    selectMode: false,
    showSystem: false,
    onOpen() {},
    dragEntries: (e) => [e],
    onInfo() {},
    onUploadTo() {},
  };
  const render = () => {
    state.index = 0;
    return renderToString(createElement(DirChildren, { path: "", depth: 0, ctx }));
  };
  expect(render()).toContain("a.xlsx");
  ctx.marks = new Map([["b.xlsx", "modified"]]);
  render();
  expect(sortFiles).toHaveBeenCalledTimes(1);
  ctx.sort = "session";
  render();
  expect(sortFiles).toHaveBeenCalledTimes(2);
  expect(vi.mocked(sortFiles).mock.results.at(-1)?.value[0].name).toBe("b.xlsx");
  state.items = [{ kind: "file", name: "new.xlsx", path: "new.xlsx" }];
  expect(render()).toContain("new.xlsx");
  expect(sortFiles).toHaveBeenCalledTimes(3);
});
