import { beforeEach, expect, test, vi } from "vitest";
import type { SessionState } from "../src/lib/session/types";

const h = vi.hoisted(() => ({
  session: null as unknown as SessionState,
  selectors: [] as ((s: any) => unknown)[],
  effects: [] as (() => void)[],
  refs: [] as any[],
  ri: 0,
}));
vi.mock("react", async (original) => {
  const r = await original<typeof import("react")>();
  return {
    ...r,
    useMemo: (fn: () => unknown) => fn(),
    useCallback: (fn: unknown) => fn,
    useState: (value: unknown) => [value, vi.fn()],
    useRef: (value: unknown) => {
      const index = h.ri++;
      h.refs[index] ??= { current: value };
      return h.refs[index];
    },
    useLayoutEffect: (fn: () => void) => h.effects.push(fn),
  };
});
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: () => ({
    getTotalSize: () => 60,
    getVirtualItems: () => [],
    measureElement: vi.fn(),
  }),
}));
vi.mock("@/stores/chat-store", async (original) => {
  const actual = await original<typeof import("../src/stores/chat-store")>();
  return {
    ...actual,
    useChatStore: Object.assign((select: (s: any) => unknown) => {
      h.selectors.push(select);
      return select(view());
    }, actual.useChatStore),
  };
});

import { MessageStream } from "../src/components/chat/MessageStream";
import { initialSessionState, reduceSession } from "../src/lib/session/reducer";

const optimistic: never[] = [];
function view() {
  return {
    session: h.session,
    sessionId: "s",
    viewAgentId: "main",
    optimistic,
    compacting: {},
    loading: false,
    hasOlder: false,
    loadingOlder: false,
    olderError: null,
  };
}
function render(): any {
  h.ri = 0;
  const root = MessageStream();
  return (root.type as () => unknown)();
}
function delta() {
  h.session = reduceSession(h.session, {
    type: "delta",
    topic: "session:s",
    agentId: "main",
    stepId: "step",
    part: 1,
    kind: "text",
    payload: "new",
  });
}
beforeEach(() => {
  h.session = initialSessionState();
  h.selectors = [];
  h.effects = [];
  h.refs = [];
  h.ri = 0;
});

test("plain streaming deltas do not invalidate the full message viewport subscriptions", () => {
  render();
  const selectors = [...h.selectors];
  const before = selectors.map((select) => select(view()));
  delta();
  expect(selectors.filter((select, i) => !Object.is(select(view()), before[i]))).toHaveLength(0);
});

test("viewport subscriptions still react to real history and busy changes", () => {
  render();
  const selectors = [...h.selectors];
  const changed = (update: () => void) => {
    const before = selectors.map((select) => select(view()));
    update();
    return selectors.some((select, i) => !Object.is(select(view()), before[i]));
  };
  expect(
    changed(() => {
      h.session = {
        ...h.session,
        timelines: {
          main: [
            {
              kind: "user",
              id: "u",
              seq: 1,
              agentId: "main",
              at: "2026-01-01",
              text: "new row",
              mode: "queue",
              status: "applied",
              attachments: [],
              context: [],
              clientMessageId: "u",
            },
          ],
        },
      };
    }),
  ).toBe(true);
  expect(
    changed(() => {
      h.session = { ...h.session, roster: { main: { id: "main", status: "running" } as never } };
    }),
  ).toBe(true);
});

function find(node: any, predicate: (node: any) => boolean): any {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) return node.map((n) => find(n, predicate)).find(Boolean);
  return predicate(node) ? node : find(node.props?.children, predicate);
}

test("isolated stream follower preserves bottom following and respects upward browsing", () => {
  const frames = new Map<number, () => void>();
  let serial = 0;
  const flush = () => {
    const batch = [...frames.values()];
    frames.clear();
    for (const frame of batch) frame();
  };
  let resized!: (entries: ResizeObserverEntry[]) => void;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: typeof resized) {
        resized = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) => {
    frames.set(++serial, fn);
    return serial;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  try {
    h.session.timelines.main = [
      {
        kind: "user",
        id: "u",
        seq: 1,
        agentId: "main",
        at: "2026-01-01",
        text: "row",
        mode: "queue",
        status: "applied",
        attachments: [],
        context: [],
        clientMessageId: "u",
      },
    ];
    const tree = render();
    const area = find(tree, (n) => !!n.props?.onViewportScroll);
    const viewport = { scrollTop: 0, scrollHeight: 1000, clientHeight: 600 };
    area.props.viewportRef.current = viewport;
    const pinned = find(tree, (n) => n.props?.className === "relative w-full pb-6");
    const measure = vi.fn(() => ({ height: 300 }));
    pinned.props.ref.current = { getBoundingClientRect: measure };
    const cleanups = h.effects
      .splice(0)
      .map((effect) => effect() as unknown as (() => void) | undefined);
    flush();
    const follower = find(tree, (n) => typeof n.props?.onTick === "function");
    expect(follower).toBeTruthy();
    viewport.scrollHeight = 1200;
    delta();
    follower.type(follower.props);
    for (const effect of h.effects.splice(0)) effect();
    // Many data notifications in one frame share a single layout read/write.
    for (let i = 0; i < 20; i++) follower.props.onTick();
    expect(viewport.scrollTop).toBe(1000);
    resized([{ borderBoxSize: [{ blockSize: 320 }] }] as unknown as ResizeObserverEntry[]);
    expect(measure).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(1);
    flush();
    expect(viewport.scrollTop).toBe(1200);
    // An already queued callback must recheck the latest reader position.
    follower.props.onTick();
    viewport.scrollTop = 300;
    area.props.onViewportScroll({ currentTarget: viewport });
    viewport.scrollHeight = 1400;
    delta();
    follower.type(follower.props);
    for (const effect of h.effects.splice(0)) effect();
    flush();
    expect(viewport.scrollTop).toBe(300);
    viewport.scrollTop = 800;
    area.props.onViewportScroll({ currentTarget: viewport });
    follower.props.onTick();
    expect(frames.size).toBe(1);
    for (const cleanup of cleanups) cleanup?.();
    expect(frames.size).toBe(0);
    flush();
    expect(viewport.scrollTop).toBe(800);
  } finally {
    vi.unstubAllGlobals();
  }
});

test("queued messages still invalidate their list subscriptions", () => {
  render();
  const selectors = [...h.selectors];
  const previous = selectors.map((select) => select(view()));
  h.session = {
    ...h.session,
    dispatches: {
      queued: {
        kind: "user",
        id: "queued",
        seq: 2,
        agentId: "main",
        at: "2026-01-01",
        text: "queue",
        mode: "queue",
        status: "queued",
        attachments: [],
        context: [],
        clientMessageId: "q",
      },
    },
  };
  expect(selectors.some((select, i) => !Object.is(select(view()), previous[i]))).toBe(true);
});

test("reasoning and snapshot deltas leave the viewport selectors stable too", () => {
  render();
  const selectors = [...h.selectors];
  const before = selectors.map((select) => select(view()));
  for (let i = 0; i < 100; i++) {
    h.session = reduceSession(h.session, {
      type: "delta",
      topic: "session:s",
      agentId: "main",
      stepId: "step",
      part: i,
      kind: "reasoning",
      payload: "thought",
    });
    expect(selectors.some((select, j) => !Object.is(select(view()), before[j]))).toBe(false);
  }
  h.session = reduceSession(h.session, {
    type: "snapshot",
    topic: "session:s",
    agentId: "main",
    stepId: "step",
    text: "restored",
    reasoning: "thought",
  } as never);
  expect(selectors.some((select, j) => !Object.is(select(view()), before[j]))).toBe(false);
});

test("rewind visibility and log cursor still reach the viewport", () => {
  h.session.timelines.main = [
    {
      kind: "user",
      id: "u",
      seq: 1,
      agentId: "main",
      at: "2026-01-01",
      text: "old",
      mode: "queue",
      status: "applied",
      attachments: [],
      context: [],
      clientMessageId: "u",
    },
  ];
  render();
  const selectors = [...h.selectors];
  const before = selectors.map((select) => select(view()));
  h.session = { ...h.session, rewinds: { main: [{ fromSeq: 1, seq: 2 }] } };
  expect(selectors.some((select, j) => !Object.is(select(view()), before[j]))).toBe(true);
  const afterRewind = selectors.map((select) => select(view()));
  h.session = { ...h.session, cursor: 3 };
  expect(selectors.some((select, j) => !Object.is(select(view()), afterRewind[j]))).toBe(true);
});
