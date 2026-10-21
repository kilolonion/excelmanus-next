import type { ReactElement, ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  si: 0,
  mi: 0,
  states: [] as any[],
  setters: [] as any[],
  memos: [] as any[],
  close: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: () => {},
  useState: (initial: any) => {
    const i = h.si++;
    if (!(i in h.states)) h.states[i] = initial;
    h.setters[i] ??= (v: any) => {
      h.states[i] = typeof v === "function" ? v(h.states[i]) : v;
    };
    return [h.states[i], h.setters[i]];
  },
  useMemo: (read: () => unknown, deps: unknown[]) => memo(read, deps),
  useCallback: (fn: unknown, deps: unknown[]) => memo(() => fn, deps),
}));
function memo(read: () => unknown, deps: unknown[]) {
  const i = h.mi++,
    old = h.memos[i];
  if (old && deps.length === old.deps.length && deps.every((v, j) => Object.is(v, old.deps[j])))
    return old.value;
  const value = read();
  h.memos[i] = { value, deps };
  return value;
}
vi.mock("@/stores/ui-store", () => ({
  useUIStore: (s: any) =>
    s({ compare: { left: "left.xlsx", right: "right.xlsx" }, closeCompare: h.close }),
}));
vi.mock("@/stores/chat-store", () => ({ useChatStore: (s: any) => s({ workspaceId: "ws" }) }));
vi.mock("@/stores/files-store", () => ({
  useFilesStore: (s: any) => s({ version: 1 }),
  listAllFiles: vi.fn(),
}));
vi.mock("@/lib/open-file", () => ({ openWorkspaceFile: vi.fn() }));

import { CompareDialog } from "../src/components/excel/CompareDialog";
import { openWorkspaceFile } from "../src/lib/open-file";

function find(node: any, predicate: (n: any) => boolean): any {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) return node.map((n) => find(n, predicate)).find(Boolean);
  return predicate(node) ? node : find(node.props?.children, predicate);
}
function rows(node: any, out: any[] = []): any[] {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) rows(child, out);
    return out;
  }
  if (node.props?.selectionKey !== undefined || (node.type === "tr" && node.key !== null))
    out.push(node);
  else rows(node.props?.children, out);
  return out;
}
function render() {
  h.si = 0;
  h.mi = 0;
  const outer = CompareDialog();
  const body = find(outer, (n) => n.type?.name === "CompareBody");
  return body.type(body.props);
}
function sameProps(a: any, b: any) {
  return (
    a.type === b.type &&
    Object.keys(a.props).length === Object.keys(b.props).length &&
    Object.keys(a.props).every((k) => Object.is(a.props[k], b.props[k]))
  );
}
beforeEach(() => {
  h.memos = [];
  h.setters = [];
  vi.clearAllMocks();
  const cells = Array.from({ length: 2000 }, (_, i) => ({
    cell: `A${i + 1}`,
    kind: "modified",
    left: { value: i, formula: null },
    right: { value: i + 1, formula: null },
  }));
  h.states = [
    "left.xlsx",
    "right.xlsx",
    [],
    false,
    null,
    0,
    {
      left: { path: "left.xlsx" },
      right: { path: "right.xlsx" },
      sheets: [{ name: "Sheet1", status: "both", changed: cells.length, cells }],
    },
    false,
    null,
    new Set(),
    false,
    0,
    "Sheet1",
  ];
});
test("changing one checkbox leaves the other comparison row props reusable", () => {
  const before = rows(render());
  h.states[9] = new Set([JSON.stringify(["Sheet1", "A1"])]);
  const after = rows(render());
  expect(after).toHaveLength(2000);
  expect(after.filter((r, i) => !sameProps(before[i], r))).toHaveLength(1);
  expect(after[0].type.$$typeof).toBe(Symbol.for("react.memo"));
});
test("unrelated loading status keeps comparison row props stable, while merge state updates all", () => {
  const before = rows(render());
  h.states[3] = true;
  expect(rows(render()).every((r, i) => sameProps(before[i], r))).toBe(true);
  h.states[10] = true;
  expect(rows(render()).filter((r, i) => !sameProps(before[i], r))).toHaveLength(2000);
});
test("comparison row toggles retain selection keys and locate the correct source", () => {
  const entry = rows(render())[0];
  expect(entry.type.type).toBeTypeOf("function");
  const tree = entry.type.type(entry.props);
  find(tree, (n) => n.props?.["aria-label"] === "合并 Sheet1!A1").props.onCheckedChange(true);
  expect([...h.states[9]]).toEqual([JSON.stringify(["Sheet1", "A1"])]);
  find(tree, (n) => n.props?.className === "em-compare-cell").props.onClick();
  expect(openWorkspaceFile).toHaveBeenCalledWith("left.xlsx", { range: "Sheet1!A1" });
  h.states[6] = { ...h.states[6], sheets: [{ ...h.states[6].sheets[0], status: "rightOnly" }] };
  const changed = rows(render())[0];
  find(
    changed.type.type(changed.props),
    (n) => n.props?.className === "em-compare-cell",
  ).props.onClick();
  expect(openWorkspaceFile).toHaveBeenLastCalledWith("right.xlsx", { range: "Sheet1!A1" });
});
test("new comparison data replaces displayed values and calculation-only cells remain disabled", () => {
  const first = rows(render())[0];
  const changed = {
    ...h.states[6].sheets[0].cells[0],
    left: { value: 3, formula: "SUM(B1:B2)" },
    right: { value: 4, formula: "SUM(B1:B2)" },
  };
  h.states[6] = { ...h.states[6], sheets: [{ ...h.states[6].sheets[0], cells: [changed] }] };
  const next = rows(render())[0];
  expect(sameProps(first, next)).toBe(false);
  const tree = next.type.type(next.props);
  expect(find(tree, (n) => n.props?.["aria-label"] === "合并 Sheet1!A1").props.disabled).toBe(true);
  const html = renderToString(tree as ReactElement<ReactNode>);
  expect(html).toContain("计算结果");
  expect(html).toContain("=SUM(B1:B2) → 4");
});

test("checkbox changes reuse right-side file choices and changing the left file invalidates them", () => {
  h.states[2] = [{ path: "left.xlsx" }, { path: "right.xlsx" }, { path: "third.xlsx" }];
  const choices = (tree: any) => find(tree, (n) => n.props?.ariaLabel === "右侧表格").props.options;
  const initial = choices(render());
  expect(initial.map((o: any) => o.value)).toEqual(["right.xlsx", "third.xlsx"]);
  h.states[9] = new Set([JSON.stringify(["Sheet1", "A2"])]);
  expect(choices(render())).toBe(initial);
  h.states[0] = "third.xlsx";
  expect(choices(render()).map((o: any) => o.value)).toEqual(["left.xlsx", "right.xlsx"]);
});
