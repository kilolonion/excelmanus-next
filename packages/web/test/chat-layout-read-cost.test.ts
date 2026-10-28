import { beforeEach, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  slots: [] as any[],
  index: 0,
  effects: [] as (() => void)[],
  deferred: "",
}));
vi.mock("react", async (original) => {
  const r = await original<typeof import("react")>();
  const memo = (fn: () => unknown, deps: unknown[]) => {
    const i = h.index++,
      old = h.slots[i];
    if (old && deps.length === old.deps.length && deps.every((d, j) => Object.is(d, old.deps[j])))
      return old.value;
    const value = fn();
    h.slots[i] = { deps, value };
    return value;
  };
  const effect = (fn: () => void, deps: unknown[]) =>
    memo(() => {
      h.effects.push(fn);
    }, deps);
  const overrides = {
    memo: (fn: unknown) => fn,
    useDeferredValue: () => h.deferred,
    useMemo: memo,
    useCallback: (fn: unknown, deps: unknown[]) => memo(() => fn, deps),
    useEffect: effect,
    useLayoutEffect: effect,
    useRef: (value: unknown) => (h.slots[h.index++] ??= { current: value }),
    useState: (initial: any) => {
      const i = h.index++;
      if (!(i in h.slots)) h.slots[i] = typeof initial === "function" ? initial() : initial;
      return [
        h.slots[i],
        (v: any) => {
          h.slots[i] = typeof v === "function" ? v(h.slots[i]) : v;
        },
      ];
    },
  };
  return { ...r, ...overrides, default: { ...r, ...overrides } };
});
import { MemoizedMarkdown } from "../src/components/chat/assistant-blocks/MemoizedMarkdown";
import { UserMessage } from "../src/components/chat/UserMessage";
function render(fn: () => any) {
  h.index = 0;
  return fn();
}
function find(node: any, predicate: (node: any) => boolean): any {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) return node.map((n) => find(n, predicate)).find(Boolean);
  return predicate(node) ? node : find(node.props?.children, predicate);
}
function flush() {
  const pending = h.effects.splice(0);
  for (const effect of pending) effect();
}
beforeEach(() => {
  h.slots = [];
  h.index = 0;
  h.effects = [];
  h.deferred = "short";
});

test("streaming markdown avoids hidden collapse measurements for every text delta", () => {
  let reads = 0;
  for (let i = 0; i < 100; i++) {
    const tree = render(() => MemoizedMarkdown({ content: `text ${i}`, isStreamingText: true }));
    find(tree, (n) => !!n.props?.ref).props.ref.current = {
      get scrollHeight() {
        reads++;
        return 800;
      },
    };
    flush();
  }
  expect(reads).toBe(0);
});

test("finishing without a final text delta measures the actual final body and offers expansion", () => {
  const content = "long final markdown";
  const show = (isStreamingText: boolean) =>
    render(() => MemoizedMarkdown({ content, isStreamingText }));
  const tree = show(true);
  let height = 40;
  find(tree, (n) => !!n.props?.ref).props.ref.current = {
    get scrollHeight() {
      return height;
    },
  };
  flush();
  height = 800;
  show(false);
  flush();
  expect(find(show(false), (n) => n.type === "button")).toBeTruthy();
});

test.each([40, 320, 500])(
  "message editor reads height %i once per resize and keeps overflow behavior",
  (naturalHeight) => {
    const props = {
      text: "message",
      context: [],
      attachments: [],
      state: "sent" as const,
      onRestart: vi.fn(),
    };
    const show = () => render(() => UserMessage(props));
    const tree = show();
    flush();
    find(
      tree,
      (n) =>
        typeof n.props?.onClick === "function" && n.props?.title === "点击编辑，从这里重新开始",
    ).props.onClick();
    const editor = find(show(), (n) => n.type === "textarea");
    let reads = 0;
    const element = {
      value: "message",
      style: { height: "", overflowY: "" },
      focus: vi.fn(),
      setSelectionRange: vi.fn(),
      get scrollHeight() {
        reads++;
        return naturalHeight;
      },
    };
    editor.props.ref.current = element;
    flush();
    expect(reads).toBe(1);
    expect(element.style).toEqual({
      height: `${Math.min(naturalHeight, 320)}px`,
      overflowY: naturalHeight > 320 ? "auto" : "hidden",
    });
  },
);

test("completed markdown remeasures replacement content and preserves expand/collapse controls", () => {
  let content = "long";
  const show = () => render(() => MemoizedMarkdown({ content }));
  const tree = show();
  let height = 800;
  find(tree, (n) => !!n.props?.ref).props.ref.current = {
    get scrollHeight() {
      return height;
    },
  };
  flush();
  find(show(), (n) => n.type === "button").props.onClick();
  expect(find(show(), (n) => n.type === "button").props.children).toContain("收起");
  find(show(), (n) => n.type === "button").props.onClick();
  content = "short";
  height = 40;
  show();
  flush();
  expect(find(show(), (n) => n.type === "button")).toBeUndefined();
});
