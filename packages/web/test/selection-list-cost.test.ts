import { beforeEach, expect, test, vi } from "vitest";
const h = vi.hoisted(() => ({ states: [] as any[], memos: [] as any[], si: 0, mi: 0 }));
vi.mock("react", async (original) => {
  const r = await original<typeof import("react")>();
  return {
    ...r,
    useState: (initial: any) => {
      const i = h.si++;
      if (!(i in h.states)) h.states[i] = initial;
      return [
        h.states[i],
        (v: any) => {
          h.states[i] = typeof v === "function" ? v(h.states[i]) : v;
        },
      ];
    },
    useMemo: (fn: () => unknown, deps: unknown[]) => {
      const i = h.mi++,
        old = h.memos[i];
      if (old && deps.every((v, j) => Object.is(v, old.deps[j]))) return old.value;
      const value = fn();
      h.memos[i] = { deps, value };
      return value;
    },
  };
});
import { RangeDataDialog, type RangeDataContext } from "../src/components/excel/RangeDataDialog";
function render(context: RangeDataContext, onApply = vi.fn().mockResolvedValue(undefined)): any {
  h.si = 0;
  h.mi = 0;
  return RangeDataDialog({ context, onApply, onClose: vi.fn() });
}
function find(node: any, match: (node: any) => boolean): any {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) return node.map((n) => find(n, match)).find(Boolean);
  return match(node) ? node : find(node.props?.children, match);
}
function context(values: string[], selected?: string[]): RangeDataContext {
  return {
    kind: "filter",
    label: "QA!A1:A10",
    unitId: "b",
    subUnitId: "s",
    range: { startRow: 0, endRow: 9, startColumn: 0, endColumn: 0 },
    revision: 1,
    columns: [{ index: 0, label: "A", values, ...(selected ? { selected } : {}) }],
  };
}
beforeEach(() => {
  h.states = [];
  h.memos = [];
  vi.restoreAllMocks();
});
test("opening a filter with no search does not normalize every value", () => {
  const c = context(Array.from({ length: 2000 }, (_, i) => `value-${i}`));
  const lower = vi.spyOn(String.prototype, "toLowerCase");
  render(c);
  expect(lower.mock.calls.length).toBe(0);
  lower.mockRestore();
});
test("visible checkbox membership does not linearly search the selected list", () => {
  const values = Array.from({ length: 2000 }, (_, i) => `value-${i}`),
    selected = [...values].reverse();
  const includes = vi.spyOn(selected, "includes");
  render(context(values, selected));
  expect(includes.mock.calls.length).toBe(0);
});
test("deselecting search results retains other selected values and applies the exact selection", async () => {
  const c = context(["", "Apple", "apricot", "pear"]);
  render(c);
  h.states[4] = "AP";
  const tree = render(c);
  find(tree, (n) => n.props?.children === "取消搜索结果").props.onClick();
  const apply = vi.fn().mockResolvedValue(undefined);
  const next = render(c, apply);
  await find(next, (n) => n.props?.children === "应用").props.onClick();
  await Promise.resolve();
  expect(apply).toHaveBeenCalledWith({ kind: "filter", column: 0, values: ["", "pear"] });
});

test("search normalizes the query once and individual toggles keep selection current", () => {
  const c = context(["Apple", "apricot", "pear"]);
  render(c);
  h.states[4] = "AP";
  const lower = vi.spyOn(String.prototype, "toLowerCase");
  const tree = render(c);
  expect(lower.mock.calls.length).toBe(4);
  lower.mockRestore();
  const checkbox = find(
    tree,
    (n) => n.props?.checked === true && typeof n.props?.onCheckedChange === "function",
  );
  checkbox.props.onCheckedChange(false);
  const next = render(c);
  expect(
    find(next, (n) => n.props?.checked === false && typeof n.props?.onCheckedChange === "function"),
  ).toBeTruthy();
  expect(h.states[3][0]).toEqual(["apricot", "pear"]);
});
test("sorting skips unused value searching and keeps the sort request", async () => {
  const c = { ...context(["b", "a", ""]), kind: "sort" as const };
  const apply = vi.fn().mockResolvedValue(undefined);
  const lower = vi.spyOn(String.prototype, "toLowerCase");
  const tree = render(c, apply);
  expect(lower.mock.calls.length).toBe(0);
  lower.mockRestore();
  await find(tree, (n) => n.props?.children === "应用").props.onClick();
  await Promise.resolve();
  expect(apply).toHaveBeenCalledWith({ kind: "sort", column: 0, header: true, order: "asc" });
});

test("narrowing the filter input reuses the current column's normalized values", () => {
  const c = context(Array.from({ length: 2000 }, (_, i) => `value-${i}`));
  render(c);
  h.states[4] = "value";
  const lower = vi.spyOn(String.prototype, "toLowerCase");
  render(c);
  expect(lower.mock.calls.length).toBe(2001);
  lower.mockClear();
  h.states[4] = "value-19";
  render(c);
  expect(lower.mock.calls.length).toBe(1);
  lower.mockRestore();
});

test("switching filter columns resets the query and does not reuse another column's matches", () => {
  const c = context(["Apple", "apricot"]);
  c.range.endColumn = 1;
  c.columns.push({ index: 1, label: "B", values: ["pear", "plum"] });
  render(c);
  h.states[4] = "ap";
  const first = render(c);
  find(
    first,
    (n) => n.props?.children === "B" && typeof n.props?.onSelect === "function",
  ).props.onSelect();
  expect(h.states[4]).toBe("");
  h.states[4] = "pe";
  const second = render(c);
  expect(find(second, (n) => n.type === "span" && n.props?.children === "pear")).toBeTruthy();
  expect(find(second, (n) => n.type === "span" && n.props?.children === "Apple")).toBeUndefined();
  expect(find(second, (n) => n.type === "span" && n.props?.children === "plum")).toBeUndefined();
});
