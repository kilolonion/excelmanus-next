import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  pinned: null as string | null,
  index: 0,
  memos: [] as Array<{ deps: unknown[]; value: unknown }>,
  memoIndex: 0,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (value: unknown) => [state.index++ === 0 ? state.pinned : value, vi.fn()],
  useMemo: (fn: () => unknown, deps: unknown[]) => {
    const i = state.memoIndex++,
      previous = state.memos[i];
    if (previous && deps.every((v, j) => Object.is(v, previous.deps[j]))) return previous.value;
    const value = fn();
    state.memos[i] = { deps, value };
    return value;
  },
}));
vi.mock("@tanstack/react-virtual", () => ({
  defaultRangeExtractor: () => [],
  useVirtualizer: () => ({
    getVirtualItems: () => [],
    getTotalSize: () => 64000,
    measureElement() {},
  }),
}));
vi.mock("../src/components/sidebar/FileRowMenu", () => ({ FileRowMenu: () => null }));
vi.mock("@/lib/file-sorting", async (original) => {
  const actual = await original<typeof import("../src/lib/file-sorting")>();
  return { ...actual, sortFiles: vi.fn(actual.sortFiles) };
});

import { FlatFileListView } from "../src/components/sidebar/FlatFileListView";
import { sortFiles } from "../src/lib/file-sorting";

const files = Array.from({ length: 1000 }, (_, i) => ({
  name: `f${i}.xlsx`,
  path: `f${i}.xlsx`,
  kind: "file" as const,
}));
beforeEach(() => {
  state.index = 0;
  state.pinned = null;
  state.memos = [];
  vi.mocked(sortFiles).mockClear();
});
function render(
  marks = new Map(),
  scrollRef: { current: HTMLDivElement | null } | null = { current: null },
  visibleFiles = files,
) {
  state.index = 0;
  state.memoIndex = 0;
  return renderToString(
    createElement(FlatFileListView, {
      files: visibleFiles,
      marks,
      scrollRef: scrollRef ?? undefined,
      sort: "name",
      openPaths: new Set<string>(),
      selectMode: false,
      selectedPaths: new Set<string>(),
      onOpen() {},
      onInfo() {},
      dragEntries: (entry) => [entry],
    }),
  );
}
test("unmeasured virtual lists render a bounded fallback instead of every file", () => {
  const html = render();
  expect((html.match(/aria-label="打开 f/g) ?? []).length).toBeLessThanOrEqual(24);
  expect(html).toContain("height:64000px");
});
test("fallback retains an offscreen active menu row without mounting the full list", () => {
  state.pinned = "f999.xlsx";
  const html = render();
  expect(html).toContain('aria-label="打开 f999.xlsx"');
  expect((html.match(/aria-label="打开 f/g) ?? []).length).toBeLessThanOrEqual(25);
});
test("changing conversation marks does not resort a name-ordered list", () => {
  render();
  render(new Map([["f999.xlsx", "modified"]]));
  expect(sortFiles).toHaveBeenCalledTimes(1);
});

test("fallback follows the viewport and clamps when search results shrink", () => {
  const scroll = { current: { scrollTop: 32000, clientHeight: 640 } as HTMLDivElement };
  expect(render(new Map(), scroll)).toContain('aria-label="打开 f495.xlsx"');
  const small = render(new Map(), scroll, files.slice(0, 3));
  expect((small.match(/aria-label="打开 f/g) ?? []).length).toBe(3);
});
test("nonvirtual consumers still render all rows", () => {
  const html = render(new Map(), null, files.slice(0, 30));
  expect((html.match(/aria-label="打开 f/g) ?? []).length).toBe(30);
});

test("ordinary rerenders do not scan all paths when no menu, rename or drag is active", () => {
  const path = vi.fn((i: number) => `f${i}.xlsx`);
  const entries = files.map((file, i) => ({
    ...file,
    get path() {
      return path(i);
    },
  }));
  render(new Map(), { current: null }, entries);
  path.mockClear();
  render(new Map(), { current: null }, entries);
  expect(path.mock.calls.length).toBeLessThan(200);
});
