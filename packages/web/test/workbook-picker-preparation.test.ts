import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  states: [] as unknown[],
  si: 0,
  mi: 0,
  memos: [] as Array<{ deps: unknown[]; value: unknown }>,
  tabs: [] as Array<{ path: string }>,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: () => {},
  useState: (initial: unknown) => {
    const i = h.si++;
    if (!(i in h.states)) h.states[i] = initial;
    return [h.states[i], vi.fn()];
  },
  useMemo: (read: () => unknown, deps: unknown[]) => {
    const i = h.mi++,
      old = h.memos[i];
    if (old && deps.length === old.deps.length && deps.every((v, j) => Object.is(v, old.deps[j])))
      return old.value;
    const value = read();
    h.memos[i] = { deps, value };
    return value;
  },
}));
vi.mock("@tanstack/react-virtual", () => ({
  defaultRangeExtractor: vi.fn(),
  useVirtualizer: () => ({ getVirtualItems: () => [], getTotalSize: () => 0 }),
}));
vi.mock("@/components/ui/dialog", () => {
  const box = ({ children }: { children: ReactNode }) => children;
  return {
    Dialog: box,
    DialogHeader: box,
    DialogTitle: box,
    DialogDescription: box,
    DialogContent: box,
  };
});
vi.mock("@/stores/files-store", () => ({
  listAllFiles: vi.fn(),
  uploadFiles: vi.fn(),
  useFilesStore: (select: (s: unknown) => unknown) => select({ version: 0, workspaceId: "ws" }),
}));
vi.mock("@/stores/ui-store", () => ({
  useUIStore: (select: (s: unknown) => unknown) =>
    select({ workbookPicker: "panel", closeWorkbookPicker: vi.fn() }),
}));
vi.mock("@/stores/workbook-store", () => ({
  openWorkbook: vi.fn(),
  useWorkbookStore: (select: (s: unknown) => unknown) => select({ tabs: h.tabs }),
}));

import { OpenWorkbookDialog } from "../src/components/excel/OpenWorkbookDialog";
import * as paths from "../src/lib/paths";

function render() {
  h.si = 0;
  h.mi = 0;
  return renderToString(createElement(OpenWorkbookDialog));
}
const file = (path: string) => ({ path, name: path.split("/").pop() });
beforeEach(() => {
  h.states = [[], "workspace", "", false, null, null, 0];
  h.tabs = [];
  h.memos = [];
  vi.restoreAllMocks();
});
test("open tabs are joined without scanning the full directory for each tab", () => {
  const files = Array.from({ length: 4000 }, (_, i) => file(`dir/book${i}.xlsx`));
  h.states[0] = files;
  h.states[1] = "open";
  h.tabs = files.slice(-50).map((f) => ({ path: f.path }));
  const compare = vi.spyOn(paths, "samePath");
  expect(render()).toContain("book3950.xlsx");
  expect(compare.mock.calls.length).toBeLessThan(5000);
});
test("typing reuses normalized paths and tab preparation", () => {
  h.states[0] = Array.from({ length: 4000 }, (_, i) => file(`dir/Book${i}.xlsx`));
  h.tabs = [{ path: "dir/Book3999.xlsx" }];
  h.states[2] = "book";
  render();
  const lower = vi.spyOn(String.prototype, "toLocaleLowerCase");
  h.states[2] = "BOOK3999";
  expect(render()).toContain("Book3999.xlsx");
  expect(lower.mock.calls.length).toBeLessThan(10);
});
test("an empty query skips path search normalization", () => {
  h.states[0] = Array.from({ length: 4000 }, (_, i) => file(`dir/Book${i}.xlsx`));
  const lower = vi.spyOn(String.prototype, "toLocaleLowerCase");
  render();
  expect(lower.mock.calls.length).toBeLessThan(10);
});
test("normalized tab matches preserve first file spelling, tab order and absent-file fallback", () => {
  h.states[0] = [file("folder/first.xlsx"), file("./folder//first.xlsx"), file("other.xlsx")];
  h.states[1] = "open";
  h.tabs = [{ path: "missing.xlsb" }, { path: "./folder\\first.xlsx" }];
  const html = render();
  expect(html.indexOf("missing.xlsb")).toBeLessThan(html.indexOf("first.xlsx"));
  expect(html).toContain('title="folder/first.xlsx"');
  expect(html).not.toContain('title="./folder//first.xlsx"');
  expect(html).toContain("导入为新 .xlsx 后打开");
  expect(html.match(/shrink-0 rounded-full/g)).toHaveLength(2);
});
test("directory refresh and renamed tabs invalidate prepared search and open badges", () => {
  h.states[0] = [file("old.xlsx")];
  h.tabs = [{ path: "old.xlsx" }];
  h.states[2] = "old";
  expect(render()).toContain('title="old.xlsx"');
  h.states[0] = [file("new.xlsx")];
  h.tabs = [{ path: "new.xlsx" }];
  expect(render()).toContain("没有匹配的表格");
  h.states[2] = "  NEW  ";
  const html = render();
  expect(html).toContain('title="new.xlsx"');
  expect(html).toContain("shrink-0 rounded-full");
  h.tabs = [];
  expect(render()).not.toContain("shrink-0 rounded-full");
});
