import { afterEach, beforeEach, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  slots: [] as any[],
  index: 0,
  pending: [] as (() => void)[],
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useRef: (value: unknown) => (h.slots[h.index++] ??= { current: value }),
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
    useCallback: (fn: unknown, deps: unknown[]) => {
      const i = h.index++,
        old = h.slots[i];
      if (old && deps.every((d, j) => Object.is(d, old.deps[j]))) return old.fn;
      h.slots[i] = { fn, deps };
      return fn;
    },
    useEffect: (effect: () => (() => void) | undefined, deps: unknown[]) => {
      const i = h.index++,
        old = h.slots[i];
      if (old && deps.every((d, j) => Object.is(d, old.deps[j]))) return;
      h.pending.push(() => {
        old?.cleanup?.();
        h.slots[i] = { deps, cleanup: effect() };
      });
    },
  };
});

import { ScrollablePreview } from "../src/components/chat/ScrollablePreview";

let frames: Map<number, FrameRequestCallback>, nextFrame: number;
let mutations: Array<() => void>;
let el: {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
};
function render() {
  h.index = 0;
  return ScrollablePreview({ children: "content", autoScroll: true });
}
function refNode(node: any, path = ""): { node: any; path: string } | undefined {
  if (!node || typeof node !== "object") return;
  if (node.props?.ref) return { node, path };
  for (const [i, child] of [node.props?.children].flat().entries()) {
    const found = refNode(child, `${path}/${i}`);
    if (found) return found;
  }
}
function commit() {
  for (const fn of h.pending.splice(0)) fn();
}
function flush() {
  const batch = [...frames.values()];
  frames.clear();
  for (const fn of batch) fn(0);
}
function cleanup() {
  for (const slot of h.slots) slot?.cleanup?.();
}
function mount() {
  const tree = render();
  refNode(tree)!.node.props.ref.current = el;
  commit();
  return tree;
}
beforeEach(() => {
  h.slots = [];
  h.pending = [];
  h.index = 0;
  frames = new Map();
  nextFrame = 1;
  mutations = [];
  el = {
    scrollHeight: 500,
    clientHeight: 160,
    scrollTop: 0,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.set(id, fn);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "MutationObserver",
    class {
      constructor(fn: () => void) {
        mutations.push(fn);
      }
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("overflow transition keeps the observed scroll element at the same React tree position", () => {
  const before = mount();
  const after = render();
  expect(refNode(after)!.path).toBe(refNode(before)!.path);
  expect(refNode(after)!.node.props.style.maxHeight).toBe(160);
});

test("several streamed mutations schedule only one bottom-follow write per frame", () => {
  mount();
  flush();
  for (let i = 0; i < 20; i++) mutations[0]();
  expect(frames.size).toBe(1);
  flush();
  expect(el.scrollTop).toBe(500);
  el.scrollHeight = 700;
  mutations[0]();
  flush();
  expect(el.scrollTop).toBe(700);
});

test("closing a preview cancels pending follow and scroll-indicator frames", () => {
  mount();
  render();
  commit();
  expect(frames.size).toBeGreaterThan(0);
  cleanup();
  expect(frames.size).toBe(0);
  flush();
  expect(el.scrollTop).toBe(0);
});

test("manual upward scrolling stops queued following and bottom scroll resumes it", () => {
  mount();
  const active = refNode(render())!.node;
  active.props.onWheelCapture({ deltaY: -1 });
  flush();
  expect(el.scrollTop).toBe(0);
  mutations[0]();
  expect(frames.size).toBe(0);
  el.scrollTop = 340;
  active.props.onScroll({ currentTarget: el });
  mutations[0]();
  flush();
  expect(el.scrollTop).toBe(500);
});

test("active preview uses its React scroll handler without a duplicate native listener", () => {
  mount();
  render();
  commit();
  expect(el.addEventListener).not.toHaveBeenCalledWith(
    "scroll",
    expect.any(Function),
    expect.anything(),
  );
});
