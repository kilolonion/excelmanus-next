import { afterEach, beforeEach, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  slots: [] as any[],
  index: 0,
  pending: [] as Array<() => void>,
  updates: 0,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: (initial: unknown) => (h.slots[h.index++] ??= { current: initial }),
  useState: (initial: unknown) => {
    const i = h.index++;
    if (!(i in h.slots)) h.slots[i] = initial;
    return [
      h.slots[i],
      (v: unknown) => {
        h.updates++;
        h.slots[i] = v;
      },
    ];
  },
  useEffect: (fn: () => void | (() => void), deps: unknown[]) => {
    const i = h.index++,
      old = h.slots[i];
    if (old && deps.length === old.deps.length && deps.every((d, j) => Object.is(d, old.deps[j])))
      return;
    h.pending.push(() => {
      old?.cleanup?.();
      h.slots[i] = { deps, cleanup: fn() };
    });
  },
}));

import { useStreamingMarkdownText } from "../src/lib/use-streaming-markdown-text";

function render(content: string, streaming = true) {
  h.index = 0;
  // biome-ignore lint/correctness/useHookAtTopLevel: Controlled harness invokes the real hook with stable mocked slots.
  const result = useStreamingMarkdownText(content, streaming);
  for (const effect of h.pending.splice(0)) effect();
  return result;
}
function unmount() {
  for (const slot of h.slots) slot?.cleanup?.();
}
const long = "x".repeat(20001);
beforeEach(() => {
  h.slots = [];
  h.index = 0;
  h.pending = [];
  h.updates = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  unmount();
  vi.useRealTimers();
});
test("short streaming text stays immediate without timers or extra state updates", () => {
  for (let i = 0; i < 20; i++) expect(render(`text${i}`)).toBe(`text${i}`);
  expect(vi.getTimerCount()).toBe(0);
  expect(h.updates).toBe(0);
});
test("crossing 20000 characters keeps the last visible text until the first batch", () => {
  const boundary = "x".repeat(20000);
  expect(render(boundary)).toBe(boundary);
  expect(render(long)).toBe(boundary);
  vi.advanceTimersByTime(149);
  expect(render(long + "a")).toBe(boundary);
  vi.advanceTimersByTime(1);
  expect(render(long + "a")).toBe(long + "a");
});
test("continuous input coalesces without postponing the scheduled update", () => {
  expect(render(long)).toBe(long);
  let current = long;
  for (let i = 0; i < 14; i++) {
    current += "a";
    expect(render(current)).toBe(long);
    vi.advanceTimersByTime(10);
  }
  current += "b";
  render(current);
  vi.advanceTimersByTime(10);
  expect(render(current)).toBe(current);
  expect(h.updates).toBe(1);
  expect(vi.getTimerCount()).toBe(0);
});
test("completion immediately publishes the whole body and cancels the pending batch", () => {
  render(long);
  render(long + " pending");
  expect(vi.getTimerCount()).toBe(1);
  const final = long + " final";
  expect(render(final, false)).toBe(final);
  expect(vi.getTimerCount()).toBe(0);
  const count = h.updates;
  vi.runAllTimers();
  expect(h.updates).toBe(count);
  expect(render(final, false)).toBe(final);
});
test("replacement or shortened content does not display the previous stream", () => {
  render(long);
  render(long + " pending");
  const other = "y".repeat(24000);
  expect(render(other)).toBe(other);
  expect(vi.getTimerCount()).toBe(0);
  expect(render(other + " next")).toBe(other);
  vi.advanceTimersByTime(150);
  expect(render(other + " next")).toBe(other + " next");
  expect(render("new short")).toBe("new short");
  expect(vi.getTimerCount()).toBe(0);
});
test("unmount cancels the old view's scheduled update", () => {
  render(long);
  render(long + " pending");
  unmount();
  const count = h.updates;
  vi.runAllTimers();
  expect(h.updates).toBe(count);
  expect(vi.getTimerCount()).toBe(0);
});
test("a finished stream can start again without reusing a stale batch", () => {
  render(long);
  render(long + "A");
  vi.advanceTimersByTime(150);
  render(long + "A");
  expect(render(long + "FINAL", false)).toBe(long + "FINAL");
  expect(render("new")).toBe("new");
  const next = "new".repeat(7000);
  expect(render(next)).toBe("new");
  vi.advanceTimersByTime(150);
  expect(render(next)).toBe(next);
});

test("a replacement sharing the displayed prefix is still immediate", () => {
  render(long);
  render(long + " old pending");
  const replacement = long + " replacement";
  expect(render(replacement)).toBe(replacement);
  expect(vi.getTimerCount()).toBe(0);
});

test("100 rapid long-text deltas produce bounded display changes with exact final content", () => {
  let content = long;
  const displayed = new Set([render(content)]);
  for (let i = 0; i < 100; i++) {
    content += `-${i}`;
    displayed.add(render(content));
    vi.advanceTimersByTime(10);
  }
  expect(displayed.size).toBeLessThanOrEqual(8);
  expect(displayed.size).toBeGreaterThan(1);
  expect(render(content, false)).toBe(content);
  expect(vi.getTimerCount()).toBe(0);
});
