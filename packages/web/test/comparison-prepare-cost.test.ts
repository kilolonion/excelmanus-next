import { beforeEach, expect, test, vi } from "vitest";
const h = vi.hoisted(() => ({
  states: [] as any[],
  memos: [] as any[],
  si: 0,
  mi: 0,
  confirm: vi.fn(),
  merge: vi.fn(),
}));
vi.mock("react", async (original) => {
  const r = await original<typeof import("react")>();
  return {
    ...r,
    useEffect: () => {},
    useCallback: (fn: unknown) => fn,
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
vi.mock("@/stores/ui-store", () => ({
  useUIStore: (s: any) =>
    s({ compare: { left: "a.xlsx", right: "b.xlsx" }, closeCompare: vi.fn() }),
}));
vi.mock("@/stores/files-store", () => ({
  useFilesStore: (s: any) => s({ version: 0 }),
  listAllFiles: vi.fn(),
}));
vi.mock("@/stores/chat-store", () => ({ useChatStore: (s: any) => s({ workspaceId: "ws" }) }));
vi.mock("@/lib/open-file", () => ({ openWorkspaceFile: vi.fn() }));
vi.mock("@/lib/backend/api", () => ({
  api: () => ({ mergeDocs: h.merge }),
  errorMessage: (e: any) => String(e),
}));
vi.mock("@/components/ui/confirm-dialog", () => ({ confirmAction: h.confirm }));
vi.mock("@/components/ui/toaster", () => ({ toast: vi.fn() }));
import { CompareDialog } from "../src/components/excel/CompareDialog";
function render(): any {
  h.si = 0;
  h.mi = 0;
  const root: any = CompareDialog();
  const body = root.props.children;
  return body.type(body.props);
}
function find(node: any, match: (node: any) => boolean): any {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) return node.map((n) => find(n, match)).find(Boolean);
  return match(node) ? node : find(node.props?.children, match);
}
function result(cells: any[]) {
  return {
    left: { path: "a.xlsx", docId: "a", rev: 1 },
    right: { path: "b.xlsx", docId: "b", rev: 2 },
    truncated: false,
    sheets: [
      { name: "empty", status: "both", changed: 0, cells: [] },
      { name: "data", status: "rightOnly", changed: cells.length, cells },
    ],
  };
}
beforeEach(() => {
  h.states = [];
  h.memos = [];
  h.confirm.mockReset().mockResolvedValue(true);
  h.merge.mockReset().mockResolvedValue({ rev: 3 });
});
test("selection and sheet-independent rerenders do not rescan other sheets' diff cells", () => {
  let reads = 0;
  render();
  h.states[6] = result(
    Array.from({ length: 1000 }, (_, i) => ({
      cell: `A${i + 1}`,
      kind: "added",
      get left() {
        reads++;
        return null;
      },
      right: { value: i },
    })),
  );
  h.states[12] = "empty";
  render();
  expect(reads).toBeGreaterThan(0);
  reads = 0;
  render();
  expect(reads).toBe(0);
  h.states[9] = new Set([JSON.stringify(["data", "A1"])]);
  render();
  expect(reads).toBe(0);
});
test("cached comparison candidates keep formula exclusions and the exact merge payload", async () => {
  render();
  h.states[6] = result([
    {
      cell: "A1",
      kind: "modified",
      left: { formula: "SUM(B1:B2)", value: 1 },
      right: { formula: "SUM(B1:B2)", value: 2 },
    },
    { cell: "A2", kind: "added", left: null, right: { value: 7 } },
  ]);
  h.states[12] = "empty";
  const tree = render();
  find(tree, (n) => n.props?.["aria-label"] === "选择已列出的全部差异").props.onCheckedChange(true);
  const next = render();
  await find(next, (n) => n.props?.children === "右侧 → 合并到左侧").props.onClick();
  await Promise.resolve();
  await Promise.resolve();
  expect(h.merge).toHaveBeenCalledWith("ws", {
    sourceDocId: "b",
    targetDocId: "a",
    sourceRev: 2,
    targetRev: 1,
    cells: [{ sheet: "data", cell: "A2" }],
  });
  expect(h.confirm.mock.calls[0][0].description).toContain("将新建工作表：data");
});

test("new comparison results invalidate cached candidates and discard absent selected cells", () => {
  render();
  h.states[6] = result([{ cell: "A2", kind: "added", left: null, right: { value: 7 } }]);
  h.states[12] = "empty";
  find(render(), (n) => n.props?.["aria-label"] === "选择已列出的全部差异").props.onCheckedChange(
    true,
  );
  expect(find(render(), (n) => n.props?.children === "右侧 → 合并到左侧").props.disabled).toBe(
    false,
  );
  h.states[6] = result([{ cell: "A3", kind: "added", left: null, right: { value: 8 } }]);
  expect(find(render(), (n) => n.props?.children === "右侧 → 合并到左侧").props.disabled).toBe(
    true,
  );
});
