import { beforeEach, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  slots: [] as any[],
  index: 0,
  cleanup: [] as (() => void)[],
  session: { activeSessionId: "s1", activeWorkspaceId: "w1" },
  create: vi.fn(),
  toast: vi.fn(),
  picker: vi.fn(),
  sidebar: vi.fn(),
  settings: vi.fn(),
  mode: vi.fn(),
  reader: false,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const i = h.index++;
    if (!(i in h.slots)) h.slots[i] = initial;
    return [
      h.slots[i],
      (value: unknown) => {
        h.slots[i] = typeof value === "function" ? value(h.slots[i]) : value;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const i = h.index++;
    h.slots[i] ??= { current: initial };
    return h.slots[i];
  },
  useEffect: (effect: () => () => void) => {
    const i = h.index++;
    if (!h.slots[i]) {
      h.slots[i] = true;
      h.cleanup.push(effect());
    }
  },
}));
vi.mock("framer-motion", () => ({ motion: { span: "span" }, useReducedMotion: () => false }));
vi.mock("@/stores/session-store", () => ({
  createSession: h.create,
  useSessionStore: { getState: () => h.session },
}));
vi.mock("@/stores/ui-store", () => ({
  useUIStore: {
    getState: () => ({
      openWorkbookPicker: h.picker,
      setSidebarOpen: h.sidebar,
      openSettings: h.settings,
    }),
  },
}));
vi.mock("@/stores/chat-store", () => ({
  effectiveChatMode: () => "ask",
  setChatMode: h.mode,
  useChatStore: (fn: (s: unknown) => unknown) =>
    fn({
      viewAgentId: "main",
      session: { roster: { main: { role: h.reader ? "reader" : "editor" } } },
    }),
}));
vi.mock("@/components/ui/toaster", () => ({ toast: h.toast }));
vi.mock("@/lib/backend/api", () => ({ errorMessage: (e: Error) => e.message }));
vi.mock("@/components/chat/TopModelSelector", () => ({ TopModelSelector: () => null }));
vi.mock("@/components/chat/ModeBadges", () => ({ ModeBadges: () => null }));
vi.mock("@/components/chat/ThinkingLevelSelector", () => ({ ThinkingLevelSelector: () => null }));
vi.mock("@/components/chat/ContextUsageButton", () => ({ ContextUsageButton: () => null }));

import { ChatModeTabs } from "../src/components/chat/ChatModeTabs";
import {
  MobileComposerTools,
  MobileNewConversation,
} from "../src/components/chat/MobileComposerTools";
import { WorkbookActionMenu } from "../src/components/excel/WorkbookActionMenu";

type Node = { type: unknown; props: Record<string, any> };
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object") return [];
  const node = value as Node;
  return [node, ...nodes(node.props?.children)];
}
function render() {
  h.index = 0;
  return nodes(MobileNewConversation());
}
function options() {
  h.index = 0;
  return nodes(MobileComposerTools());
}
function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(text).join("");
  return value && typeof value === "object" ? text((value as Node).props?.children) : "";
}
function button(tree: Node[], label: string) {
  return tree.find(
    (n) =>
      n.props?.onClick && (n.props["aria-label"] === label || text(n.props.children) === label),
  )!.props;
}
beforeEach(() => {
  h.slots = [];
  h.index = 0;
  h.cleanup = [];
  h.reader = false;
  h.session = { activeSessionId: "s1", activeWorkspaceId: "w1" };
  vi.clearAllMocks();
});
test("composer options no longer mix destination navigation with generation settings", () => {
  button(options(), "对话选项").onClick();
  const tree = options();
  expect(tree.find((n) => n.props?.className === "em-mobile-actions-sheet")!.props.open).toBe(true);
  expect(text(tree[0])).not.toContain("新建对话");
  expect(text(tree[0])).not.toContain("打开表格");
  expect(text(tree[0])).toContain("思考强度");
});
test("new conversation keeps original workspace and blocks repeated taps", async () => {
  let resolve!: () => void;
  h.create.mockImplementation(
    () =>
      new Promise<void>((r) => {
        resolve = r;
      }),
  );
  const action = button(render(), "新建对话");
  action.onClick();
  action.onClick();
  expect(h.create).toHaveBeenCalledExactlyOnceWith("w1");
  expect(button(render(), "新建对话").disabled).toBe(true);
  resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(button(render(), "新建对话").disabled).toBe(false);
});
test("new-conversation failure remains retryable without leaking after navigation", async () => {
  h.create.mockRejectedValue(new Error("offline"));
  button(render(), "新建对话").onClick();
  await Promise.resolve();
  await Promise.resolve();
  expect(h.toast).toHaveBeenCalledWith({ tone: "error", title: "offline" });
  h.toast.mockClear();
  let reject!: (e: Error) => void;
  h.create.mockImplementation(
    () =>
      new Promise((_, r) => {
        reject = r;
      }),
  );
  button(render(), "新建对话").onClick();
  h.session = { activeSessionId: "s2", activeWorkspaceId: "w2" };
  reject(new Error("late"));
  await Promise.resolve();
  await Promise.resolve();
  expect(h.toast).not.toHaveBeenCalled();
});
test("compact mode menu preserves read-only restrictions and existing mode action", () => {
  h.reader = true;
  const tree = nodes(ChatModeTabs({ compact: true }));
  const items = tree.filter((n) => n.props?.onSelect);
  expect(items).toHaveLength(3);
  expect(items[0].props.disabled).toBe(true);
  items[2].props.onSelect();
  expect(h.mode).toHaveBeenCalledExactlyOnceWith("plan");
  expect(tree.some((n) => n.props?.["aria-label"] === "聊天模式：问答")).toBe(true);
});
test("workbook menu retains action callbacks and disabled state with labelled touch targets", () => {
  const run = vi.fn();
  const tree = nodes(
    WorkbookActionMenu({
      actions: [
        { label: "下载文件", onSelect: run },
        { label: "打印", onSelect: run, disabled: true },
      ],
    }),
  );
  const items = tree.filter((n) => n.props?.onSelect);
  expect(items[0].props.className).toContain("min-h-11");
  items[0].props.onSelect();
  expect(run).toHaveBeenCalledOnce();
  expect(items[1].props.disabled).toBe(true);
});

test("closing options does not navigate or start a conversation", () => {
  button(options(), "对话选项").onClick();
  const sheet = options().find((n) => n.props?.className === "em-mobile-actions-sheet")!.props;
  sheet.onOpenChange(false);
  expect(h.create).not.toHaveBeenCalled();
  expect(h.picker).not.toHaveBeenCalled();
  expect(h.settings).not.toHaveBeenCalled();
});
test("unmounted composer ignores late create failure", async () => {
  let reject!: (e: Error) => void;
  h.create.mockImplementation(
    () =>
      new Promise((_, r) => {
        reject = r;
      }),
  );
  button(render(), "新建对话").onClick();
  for (const cleanup of h.cleanup) cleanup?.();
  reject(new Error("late after unmount"));
  await Promise.resolve();
  await Promise.resolve();
  expect(h.toast).not.toHaveBeenCalled();
});

test("new conversation failure is scoped to the originating workspace even with the same empty session", async () => {
  let reject!: (e: Error) => void;
  h.create.mockImplementation(
    () =>
      new Promise((_, r) => {
        reject = r;
      }),
  );
  button(render(), "新建对话").onClick();
  h.session = { activeSessionId: "s1", activeWorkspaceId: "w2" };
  reject(new Error("old workspace"));
  await Promise.resolve();
  await Promise.resolve();
  expect(h.toast).not.toHaveBeenCalled();
});
