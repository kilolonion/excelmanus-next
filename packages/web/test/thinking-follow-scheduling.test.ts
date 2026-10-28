import { afterEach, beforeEach, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  refs: [] as { current: any }[],
  index: 0,
  pending: undefined as undefined | (() => (() => void) | undefined),
  cleanup: undefined as undefined | (() => void),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: (value: unknown) => {
    const index = h.index++;
    h.refs[index] ??= { current: value };
    return h.refs[index];
  },
  useState: (value: unknown) => [value, vi.fn()],
  useMemo: (fn: () => unknown) => fn(),
  useEffect: () => {},
  useLayoutEffect: (fn: typeof h.pending) => {
    h.pending = fn;
  },
}));

import { ThinkingBlock } from "../src/components/chat/ThinkingBlock";

let frames: Map<number, FrameRequestCallback>, id: number;
const height = vi.fn(() => 800);
let el: { scrollTop: number; readonly scrollHeight: number; clientHeight: number };
function find(node: any): any {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) return node.map(find).find(Boolean);
  return node.props?.onWheelCapture ? node : find(node.props?.children);
}
function render(content = "thinking", active = true) {
  h.index = 0;
  const tree = ThinkingBlock({ content, isActive: active });
  const box = find(tree);
  if (box) box.props.ref.current = el;
  h.cleanup?.();
  h.cleanup = h.pending?.();
  return box;
}
function flush() {
  const batch = [...frames.values()];
  frames.clear();
  for (const fn of batch) fn(0);
}
beforeEach(() => {
  h.refs = [];
  h.index = 0;
  h.cleanup = undefined;
  h.pending = undefined;
  frames = new Map();
  id = 0;
  height.mockClear();
  el = {
    scrollTop: 0,
    get scrollHeight() {
      return height();
    },
    clientHeight: 100,
  };
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
    frames.set(++id, fn);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (frame: number) => frames.delete(frame));
});
afterEach(() => {
  h.cleanup?.();
  vi.unstubAllGlobals();
});
test("thinking deltas coalesce height reads until the next paint", () => {
  for (let i = 0; i < 30; i++) render(`thinking ${i}`);
  expect(height).not.toHaveBeenCalled();
  expect(frames.size).toBe(1);
  flush();
  expect(height).toHaveBeenCalledTimes(1);
  expect(el.scrollTop).toBe(800);
});
test("upward browsing cancels queued follow and reaching bottom resumes it", () => {
  const box = render();
  box.props.onWheelCapture({ deltaY: -1 });
  flush();
  expect(el.scrollTop).toBe(0);
  expect(height).not.toHaveBeenCalled();
  el.scrollTop = 700;
  box.props.onScroll({ currentTarget: el });
  render("more");
  flush();
  expect(el.scrollTop).toBe(800);
});
test.each(["finish", "unmount"])("%s prevents late thinking scroll work", (mode) => {
  render();
  if (mode === "finish") render("done", false);
  else h.cleanup?.();
  expect(frames.size).toBe(0);
  flush();
  expect(height).not.toHaveBeenCalled();
});
