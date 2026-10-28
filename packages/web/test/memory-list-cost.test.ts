import { beforeEach, expect, test, vi } from "vitest";
const h = vi.hoisted(() => ({
  slots: [] as any[],
  memos: [] as any[],
  index: 0,
  stateIndex: 0,
  workspaces: [] as any[],
}));
vi.mock("react", async (original) => {
  const r = await original<typeof import("react")>();
  const memo = (fn: () => unknown, deps: unknown[]) => {
    const i = h.index++,
      old = h.memos[i];
    if (old && deps.every((v, j) => Object.is(v, old.deps[j]))) return old.value;
    const value = fn();
    h.memos[i] = { deps, value };
    return value;
  };
  return {
    ...r,
    useMemo: memo,
    useCallback: (fn: unknown, deps: unknown[]) => memo(() => fn, deps),
    useEffect: () => {},
    useRef: () => ({ current: 0 }),
    useState: (initial: unknown) => {
      const i = h.stateIndex++;
      if (!(i in h.slots)) h.slots[i] = initial;
      return [
        h.slots[i],
        (value: unknown) => {
          h.slots[i] = value;
        },
      ];
    },
  };
});
vi.mock("@/stores/app-store", () => ({
  useAppStore: (fn: (s: any) => unknown) => fn({ workspaces: h.workspaces }),
  onAppEvent: () => () => {},
}));
import { MemoryTab } from "../src/components/settings/MemoryTab";
function render() {
  h.index = 0;
  h.stateIndex = 0;
  return MemoryTab();
}
beforeEach(() => {
  h.slots = [];
  h.memos = [];
  h.stateIndex = 0;
  h.index = 0;
  h.workspaces = [];
});
test("memory rows share date formatting and avoid repeated workspace scans", () => {
  const workspaceRead = vi.fn(() => "w");
  const categoryRead = vi.fn(() => "preference");
  h.workspaces = [
    {
      get id() {
        return workspaceRead();
      },
      name: "QA",
    },
  ];
  render();
  h.slots[0] = Array.from({ length: 100 }, (_, i) => ({
    id: String(i),
    get category() {
      return categoryRead();
    },
    content: "row",
    workspaceId: "w",
    updatedAt: "2026-10-18T00:00:00Z",
    lastUsedAt: "2026-10-18T01:00:00Z",
  }));
  h.slots[1] = false;
  const locale = vi.spyOn(Date.prototype, "toLocaleString"),
    formatter = vi.spyOn(Intl, "DateTimeFormat");
  workspaceRead.mockClear();
  try {
    render();
    expect(locale).not.toHaveBeenCalled();
    expect(formatter).toHaveBeenCalledTimes(1);
    expect(workspaceRead.mock.calls.length).toBeLessThanOrEqual(1);
    workspaceRead.mockClear();
    categoryRead.mockClear();
    h.slots[2] = "typing";
    render();
    expect(workspaceRead).not.toHaveBeenCalled();
    expect(categoryRead).not.toHaveBeenCalled();
  } finally {
    locale.mockRestore();
    formatter.mockRestore();
  }
});

test("memory list refreshes grouping, workspace labels and dates when source data changes", () => {
  h.workspaces = [{ id: "w", name: "Old workspace" }];
  render();
  h.slots[0] = [
    {
      id: "m",
      category: "preference",
      content: "old body",
      workspaceId: "w",
      updatedAt: "invalid-date",
      lastUsedAt: null,
    },
  ];
  h.slots[1] = false;
  expect(JSON.stringify(render())).toContain("工作区：Old workspace");
  expect(JSON.stringify(render())).toContain("invalid-date");
  h.workspaces = [{ id: "w", name: "New workspace" }];
  h.slots[0] = [
    {
      ...h.slots[0][0],
      category: "domain",
      content: "new body",
      updatedAt: "2026-10-18T00:00:00Z",
    },
  ];
  const output = JSON.stringify(render());
  expect(output).toContain("工作区：New workspace");
  expect(output).toContain("业务知识");
  expect(output).toContain("new body");
  expect(output).not.toContain("old body");
  expect(output).not.toContain("invalid-date");
});
