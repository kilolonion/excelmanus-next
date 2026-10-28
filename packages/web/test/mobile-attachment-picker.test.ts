import { beforeEach, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  slots: [] as any[],
  index: 0,
  effects: [] as (() => void)[],
  workspaceId: "w1",
  list: vi.fn(),
  pick: vi.fn(),
  close: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
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
  useRef: (value: unknown) => {
    const i = h.index++;
    h.slots[i] ??= { current: value };
    return h.slots[i];
  },
  useEffect: (fn: () => undefined | (() => void), deps: unknown[]) => {
    const i = h.index++,
      old = h.slots[i];
    if (old && deps.every((d, j) => Object.is(d, old.deps[j]))) return;
    h.effects.push(() => {
      old?.cleanup?.();
      h.slots[i] = { deps, cleanup: fn() };
    });
  },
}));
vi.mock("@/stores/files-store", () => ({
  listAllFiles: h.list,
  useFilesStore: Object.assign((f: any) => f({ workspaceId: h.workspaceId }), {
    getState: () => ({ workspaceId: h.workspaceId }),
  }),
}));
vi.mock("@/lib/backend/api", () => ({ errorMessage: (e: Error) => e.message }));

import { WorkspaceAttachmentPicker } from "../src/components/chat/WorkspaceAttachmentPicker";

type Node = { type: unknown; props: Record<string, any> };
function walk(v: unknown): Node[] {
  if (Array.isArray(v)) return v.flatMap(walk);
  if (!v || typeof v !== "object") return [];
  const n = v as Node;
  return [n, ...walk(n.props?.children)];
}
function content(v: any): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(content).join("");
  return v && typeof v === "object" ? content(v.props?.children) : "";
}
function render() {
  h.index = 0;
  const n = walk(WorkspaceAttachmentPicker({ onPick: h.pick, onClose: h.close }));
  const effects = h.effects.splice(0);
  for (const fn of effects) fn();
  return n;
}
function button(nodes: Node[], label: string) {
  return nodes.find((n) => n.props?.onClick && content(n) === label)!.props;
}
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
beforeEach(() => {
  h.slots = [];
  h.index = 0;
  h.effects = [];
  h.workspaceId = "w1";
  vi.clearAllMocks();
  h.list.mockResolvedValue([{ path: "Budget.xlsx" }, { path: "Photo.jpg" }]);
});
test("search and dismiss do not modify the draft; only a chosen file is attached", async () => {
  const first = render();
  expect(content(first[0])).toContain("正在读取文件");
  await settle();
  let tree = render();
  tree
    .find((n) => n.props?.["aria-label"] === "搜索工作区文件")!
    .props.onChange({ target: { value: "Budget" } });
  tree = render();
  expect(content(tree[0])).not.toContain("Photo.jpg");
  expect(h.pick).not.toHaveBeenCalled();
  tree[0].props.onOpenChange(false);
  expect(h.close).toHaveBeenCalledOnce();
  expect(h.pick).not.toHaveBeenCalled();
  button(tree, "Budget.xlsx").onClick();
  expect(h.pick).toHaveBeenCalledExactlyOnceWith("Budget.xlsx");
});
test("picker failure remains visible and retry makes a new directory read", async () => {
  h.list.mockRejectedValueOnce(new Error("temporary"));
  render();
  await settle();
  let tree = render();
  expect(tree.some((n) => n.props?.role === "alert")).toBe(true);
  button(tree, "重新读取").onClick();
  render();
  await settle();
  tree = render();
  expect(h.list).toHaveBeenCalledTimes(2);
  expect(content(tree[0])).toContain("Budget.xlsx");
});
test("workspace change hides old files immediately and old selection callback cannot attach", async () => {
  render();
  await settle();
  const previous = button(render(), "Budget.xlsx");
  h.workspaceId = "w2";
  const tree = render();
  expect(content(tree[0])).not.toContain("Budget.xlsx");
  previous.onClick();
  expect(h.pick).not.toHaveBeenCalled();
});
test("closing cancels further traversal and ignores a late directory failure", async () => {
  let reject!: (e: Error) => void;
  h.list.mockImplementation(
    () =>
      new Promise((_, r) => {
        reject = r;
      }),
  );
  render();
  const isCurrent = h.list.mock.calls[0][2];
  expect(isCurrent()).toBe(true);
  for (const slot of h.slots) slot?.cleanup?.();
  expect(isCurrent()).toBe(false);
  reject(new Error("late"));
  await settle();
  expect(h.slots[2]).toBe(null);
});
