import { beforeEach, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  slots: [] as any[],
  index: 0,
  sessions: [] as any[],
  activeSessionId: null as string | null,
  roster: {} as Record<string, unknown>,
  dark: false,
}));
vi.mock("react", async (original) => {
  const r = await original<typeof import("react")>();
  return {
    ...r,
    useRef: (value: unknown) => (h.slots[h.index++] ??= { current: value }),
    useEffect: () => {},
    useState: (value: unknown) => {
      const i = h.index++;
      if (!(i in h.slots)) h.slots[i] = value;
      return [
        h.slots[i],
        (next: any) => {
          h.slots[i] = typeof next === "function" ? next(h.slots[i]) : next;
        },
      ];
    },
    useMemo: (fn: () => unknown, deps: unknown[]) => {
      const i = h.index++,
        old = h.slots[i];
      if (old && deps.every((d, j) => Object.is(d, old.deps[j]))) return old.value;
      const value = fn();
      h.slots[i] = { value, deps };
      return value;
    },
  };
});
vi.mock("@/stores/files-store", () => ({ listAllFiles: vi.fn() }));
vi.mock("@/lib/open-file", () => ({ openWorkspaceFile: vi.fn() }));
vi.mock("@/lib/shortcuts", () => ({ isMac: () => false, runShortcut: vi.fn() }));
vi.mock("@/lib/theme", () => ({ isDarkTheme: () => h.dark, setTheme: vi.fn() }));
vi.mock("@/stores/ui-store", () => ({
  useUIStore: (select: any) => select({ quickOpen: true, setQuickOpen: vi.fn() }),
}));
vi.mock("@/stores/chat-store", () => ({
  useChatStore: (select: any) => select({ session: { roster: h.roster } }),
}));
vi.mock("@/stores/session-store", () => ({
  selectSession: vi.fn(),
  useSessionStore: (select: any) =>
    select({ sessions: h.sessions, activeSessionId: h.activeSessionId }),
}));

import { QuickOpen } from "../src/components/command/QuickOpen";

function nodes(n: any): any[] {
  if (!n || typeof n !== "object") return [];
  if (Array.isArray(n)) return n.flatMap(nodes);
  return [n, ...nodes(n.props?.children)];
}
function body() {
  return nodes(QuickOpen()).find((n) => n.type?.name === "QuickOpenBody");
}
function render(root: any) {
  h.index = 0;
  return root.type(root.props);
}
function search(root: any, tree: any, value: string) {
  nodes(tree)
    .find((n) => n.type === "input")
    .props.onChange({ target: { value } });
  return render(root);
}
function options(tree: any) {
  return nodes(tree).filter((n) => n.props?.role === "option");
}
beforeEach(() => {
  h.slots = [];
  h.index = 0;
  h.sessions = [];
  h.activeSessionId = null;
  h.roster = {};
  h.dark = false;
  vi.restoreAllMocks();
});
test("typing does not rebuild file candidates or sort and format conversation dates", () => {
  let dates = 0,
    paths = 0;
  h.sessions = Array.from({ length: 100 }, (_, i) => ({
    id: String(i),
    title: `Report ${i}`,
    get updatedAt() {
      dates++;
      return "2026-10-01T00:00:00Z";
    },
  }));
  const files = Array.from({ length: 100 }, (_, i) => ({
    name: `report${i}.xlsx`,
    kind: "file",
    get path() {
      paths++;
      return `folder/report${i}.xlsx`;
    },
  }));
  const root = body();
  render(root);
  h.slots[1] = files;
  const first = render(root);
  dates = 0;
  paths = 0;
  const next = search(root, first, "report");
  search(root, next, "report1");
  expect(dates).toBe(0);
  expect(paths).toBe(0);
});
test("candidate normalization is reused across query changes while ranking stays live", () => {
  h.sessions = [{ id: "s", title: "Alpha report", updatedAt: "2026-10-01T00:00:00Z" }];
  const root = body();
  render(root);
  h.slots[1] = [{ path: "folder/alpha.xlsx" }, { path: "folder/beta.xlsx" }];
  const first = render(root);
  const lower = vi.spyOn(String.prototype, "toLowerCase");
  const alpha = search(root, first, "ALPHA");
  expect(JSON.stringify(options(alpha))).toContain("alpha.xlsx");
  const beta = search(root, alpha, "beta");
  expect(JSON.stringify(options(beta))).toContain("beta.xlsx");
  expect(JSON.stringify(options(beta))).not.toContain("alpha.xlsx");
  expect(lower.mock.calls.length).toBeLessThan(5);
});
test("data and task-state changes refresh their own candidates and current conversation label", () => {
  h.sessions = [{ id: "s", title: "Alpha", updatedAt: "2026-10-01T00:00:00Z" }];
  const root = body();
  const first = render(root);
  h.activeSessionId = "s";
  const current = render(root);
  expect(JSON.stringify(options(current))).toContain("当前");
  h.sessions = [{ ...h.sessions[0], title: "Renamed" }];
  expect(JSON.stringify(options(render(root)))).toContain("Renamed");
  h.roster = { main: { status: "running" } };
  const stopped = search(root, first, "停止");
  expect(JSON.stringify(options(stopped))).toContain("停止当前任务");
  h.roster = {};
  expect(JSON.stringify(options(render(root)))).not.toContain("停止当前任务");
  h.dark = true;
  const theme = search(root, render(root), "主题");
  expect(JSON.stringify(options(theme))).toContain("切换到浅色主题");
  h.slots[1] = [{ path: "new-folder/gamma.xlsx" }];
  expect(JSON.stringify(options(search(root, theme, "gamma")))).toContain("gamma.xlsx");
});

test("search does not sort the full matching file or conversation lists", () => {
  h.sessions = Array.from({ length: 2000 }, (_, i) => ({
    id: String(i),
    title: `report ${i}`,
    updatedAt: "2026-10-01T00:00:00Z",
  }));
  const root = body();
  render(root);
  h.slots[1] = Array.from({ length: 5000 }, (_, i) => ({ path: `folder/report${i}.xlsx` }));
  const first = render(root);
  const sort = vi.spyOn(Array.prototype, "sort");
  try {
    const tree = search(root, first, "report");
    expect(options(tree)).toHaveLength(20);
    expect(sort.mock.contexts.some((list) => Array.isArray(list) && list.length > 12)).toBe(false);
  } finally {
    sort.mockRestore();
  }
});
