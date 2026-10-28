import { beforeEach, expect, test, vi } from "vitest";
import type { SessionState } from "../src/lib/session/types";

const h = vi.hoisted(() => ({
  slots: [] as any[],
  index: 0,
  session: null as unknown as SessionState,
  older: vi.fn(),
  virtualOptions: null as unknown as Pick<
    import("@tanstack/react-virtual").VirtualizerOptions<HTMLDivElement, Element>,
    "scrollToFn"
  >,
}));
vi.mock("react", async (original) => {
  const r = await original<typeof import("react")>();
  const memo = (fn: () => unknown, deps: unknown[]) => {
    const i = h.index++,
      old = h.slots[i];
    if (old && deps.every((d, j) => Object.is(d, old.deps[j]))) return old.value;
    const value = fn();
    h.slots[i] = { deps, value };
    return value;
  };
  return {
    ...r,
    useMemo: memo,
    useCallback: (fn: unknown, deps: unknown[]) => memo(() => fn, deps),
    useLayoutEffect: () => {},
    useRef: (initial: unknown) => (h.slots[h.index++] ??= { current: initial }),
    useState: (initial: unknown) => {
      const i = h.index++;
      if (!(i in h.slots)) h.slots[i] = initial;
      return [
        h.slots[i],
        (next: any) => {
          h.slots[i] = typeof next === "function" ? next(h.slots[i]) : next;
        },
      ];
    },
  };
});
vi.mock("@tanstack/react-virtual", async (original) => ({
  ...(await original<typeof import("@tanstack/react-virtual")>()),
  useVirtualizer: (options: typeof h.virtualOptions) => {
    h.virtualOptions = options;
    return {
      getTotalSize: () => 60,
      getVirtualItems: () => [],
      measureElement: () => {},
    };
  },
}));
vi.mock("@/stores/chat-store", async (original) => {
  const actual = await original<typeof import("../src/stores/chat-store")>();
  return {
    ...actual,
    loadOlderChat: h.older,
    useChatStore: Object.assign(
      (select: (state: any) => unknown) =>
        select({
          session: h.session,
          sessionId: "s",
          viewAgentId: "main",
          optimistic: [],
          loading: false,
          hasOlder: true,
          loadingOlder: false,
          olderError: null,
          compacting: {},
        }),
      actual.useChatStore,
    ),
  };
});

import { elementScroll, Virtualizer } from "@tanstack/react-virtual";
import { MessageStream } from "../src/components/chat/MessageStream";
import { initialSessionState } from "../src/lib/session/reducer";

function render(): any {
  h.index = 0;
  const root = MessageStream();
  return (root.type as () => unknown)();
}
function find(node: any, match: (node: any) => boolean): any {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, match);
      if (hit) return hit;
    }
    return;
  }
  if (match(node)) return node;
  return find(node.props?.children, match);
}
function setup(scrollHeight = 1000, clientHeight = 600) {
  const tree = render(),
    area = find(tree, (n) => !!n.props?.onViewportScroll);
  const viewport = {
    scrollTop: scrollHeight - clientHeight,
    scrollHeight,
    clientHeight,
    getBoundingClientRect: () => ({ top: 0 }),
    querySelectorAll: () => [],
    scrollTo: ({ top }: { top: number }) => {
      viewport.scrollTop = Math.max(
        0,
        Math.min(top, viewport.scrollHeight - viewport.clientHeight),
      );
    },
  };
  area.props.viewportRef.current = viewport;
  const scroll = () => area.props.onViewportScroll({ currentTarget: viewport });
  scroll();
  return { viewport, scroll };
}
function hasReturnButton() {
  return !!find(render(), (n) => n.props?.children?.[1] === "回到底部");
}
beforeEach(() => {
  h.slots = [];
  h.index = 0;
  h.older.mockReset();
  h.session = initialSessionState();
  h.session.timelines.main = [
    {
      kind: "user",
      id: "u",
      seq: 1,
      agentId: "main",
      at: "2026-01-01T00:00:00Z",
      text: "test",
      mode: "queue",
      status: "applied",
      clientMessageId: "m",
      attachments: [],
      context: [],
    },
  ];
});

test("collapsing content and clamping the viewport to its new bottom does not load history", () => {
  const { viewport, scroll } = setup();
  viewport.scrollHeight = 650;
  viewport.scrollTop = 50;
  scroll();
  expect(h.older).not.toHaveBeenCalled();
  expect(hasReturnButton()).toBe(false);
});

test("a taller viewport clamping the scroll offset preserves bottom following", () => {
  const { viewport, scroll } = setup();
  viewport.clientHeight = 900;
  viewport.scrollTop = 100;
  scroll();
  expect(h.older).not.toHaveBeenCalled();
  expect(hasReturnButton()).toBe(false);
});

test("real upward scrolling still requests earlier history and releases bottom following", () => {
  const { viewport, scroll } = setup();
  viewport.scrollTop = 100;
  scroll();
  expect(h.older).toHaveBeenCalledTimes(1);
  expect(hasReturnButton()).toBe(true);
});

test("manual history button remains available without upward scrolling", () => {
  setup();
  const button = find(render(), (n) => n.type === "button" && n.props.children === "加载更早消息");
  button.props.onClick();
  expect(h.older).toHaveBeenCalledTimes(1);
});

function correctLayout(viewport: ReturnType<typeof setup>["viewport"], adjustment: number) {
  const scrollTo = h.virtualOptions.scrollToFn ?? elementScroll;
  scrollTo(viewport.scrollTop, { adjustments: adjustment }, {
    scrollElement: viewport,
    options: { horizontal: false },
  } as unknown as Virtualizer<HTMLDivElement, Element>);
}

test("virtualized row shrink above the reader does not request history near the top", () => {
  const { viewport, scroll } = setup(1600);
  viewport.scrollTop = 350;
  scroll();
  expect(hasReturnButton()).toBe(true);
  viewport.scrollHeight -= 250;
  correctLayout(viewport, -250);
  scroll();
  expect(viewport.scrollTop).toBe(100);
  expect(h.older).not.toHaveBeenCalled();
  expect(hasReturnButton()).toBe(true);
});

test("real upward scrolling immediately after a layout correction still loads history", () => {
  const { viewport, scroll } = setup(1600);
  viewport.scrollTop = 400;
  scroll();
  viewport.scrollHeight -= 250;
  correctLayout(viewport, -250);
  scroll();
  expect(h.older).not.toHaveBeenCalled();
  viewport.scrollTop = 120;
  scroll();
  expect(h.older).toHaveBeenCalledTimes(1);
});

test("successive size corrections preserve bottom following without loading history", () => {
  const { viewport, scroll } = setup();
  viewport.scrollHeight -= 200;
  correctLayout(viewport, -200);
  scroll();
  viewport.scrollHeight -= 150;
  correctLayout(viewport, -150);
  scroll();
  expect(h.older).not.toHaveBeenCalled();
  expect(hasReturnButton()).toBe(false);
});

test("a layout correction is recorded at the browser-clamped offset", () => {
  const { viewport, scroll } = setup(1600);
  viewport.scrollTop = 300;
  scroll();
  viewport.scrollHeight -= 400;
  correctLayout(viewport, -400);
  scroll();
  expect(viewport.scrollTop).toBe(0);
  expect(h.older).not.toHaveBeenCalled();
  viewport.scrollTop = 100;
  scroll();
  viewport.scrollTop = 50;
  scroll();
  expect(h.older).toHaveBeenCalledTimes(1);
});

test("real virtualizer measurement compensation does not start older-history loading", () => {
  const { viewport, scroll } = setup(1600);
  viewport.scrollTop = 350;
  scroll();
  const virtualizer = new Virtualizer<HTMLDivElement, Element>({
    count: 2,
    getScrollElement: () => viewport as unknown as HTMLDivElement,
    estimateSize: () => 500,
    initialRect: { width: 800, height: 600 },
    initialOffset: 350,
    scrollToFn: h.virtualOptions.scrollToFn ?? elementScroll,
    observeElementOffset: () => {},
    observeElementRect: () => {},
  });
  virtualizer.scrollElement = viewport as unknown as HTMLDivElement;
  virtualizer.getVirtualItems();
  viewport.scrollHeight -= 250;
  virtualizer.resizeItem(0, 250);
  scroll();
  expect(viewport.scrollTop).toBe(100);
  expect(h.older).not.toHaveBeenCalled();
  expect(hasReturnButton()).toBe(true);
});
