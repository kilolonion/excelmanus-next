import type { MouseEvent as ReactMouseEvent } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  slots: [] as unknown[],
  index: 0,
  effects: [] as (() => void)[],
  writes: 0,
}));
vi.mock("react", () => ({
  useState: (initial: unknown) => {
    const i = h.index++;
    if (!(i in h.slots)) h.slots[i] = typeof initial === "function" ? initial() : initial;
    return [
      h.slots[i],
      (value: unknown) => {
        h.writes++;
        h.slots[i] = typeof value === "function" ? value(h.slots[i]) : value;
      },
    ];
  },
  useRef: (value: unknown) => {
    const i = h.index++;
    if (h.slots[i] === undefined) h.slots[i] = { current: value };
    return h.slots[i];
  },
  useCallback: (fn: unknown) => fn,
  useEffect: (fn: () => undefined | (() => void), deps: unknown[]) => {
    const i = h.index++,
      old = h.slots[i] as { deps: unknown[]; cleanup?: () => void } | undefined;
    if (!old || deps.some((d, j) => !Object.is(d, old.deps[j])))
      h.effects.push(() => {
        old?.cleanup?.();
        h.slots[i] = { deps, cleanup: fn() };
      });
  },
}));

import { useResizablePanel } from "../src/hooks/use-resizable-panel";

let events: Map<string, EventListener>, frames: Map<number, FrameRequestCallback>, serial: number;
let win: {
  innerWidth: number;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
};
const save = vi.fn();
beforeEach(() => {
  h.slots = [];
  h.index = 0;
  h.effects = [];
  h.writes = 0;
  events = new Map();
  frames = new Map();
  serial = 0;
  save.mockClear();
  win = {
    innerWidth: 1600,
    addEventListener: vi.fn((key, fn) => events.set(key, fn)),
    removeEventListener: vi.fn((key) => events.delete(key)),
  };
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", { body: { style: { cursor: "default", userSelect: "text" } } });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: save });
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
    frames.set(++serial, fn);
    return serial;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});
afterEach(() => vi.unstubAllGlobals());
function Panel(enabled = true, visible = true) {
  h.index = 0;
  const result = useResizablePanel(enabled, visible);
  const effects = h.effects.splice(0);
  for (const run of effects) run();
  return result;
}
function emit(type: string, event: Record<string, unknown> = {}) {
  events.get(type)?.(event as unknown as Event);
}
function flush() {
  const pending = [...frames.values()];
  frames.clear();
  for (const run of pending) run(0);
}
function begin() {
  const panel = Panel();
  panel.handleProps.onMouseDown({
    clientX: 1000,
    preventDefault() {},
    stopPropagation() {},
  } as unknown as ReactMouseEvent);
  Panel();
  h.writes = 0;
}

test("drag bursts update layout once per frame and mouseup flushes the final width", () => {
  begin();
  for (let i = 0; i < 100; i++) emit("mousemove", { clientX: 999 - i });
  expect(h.writes).toBe(0);
  expect(frames.size).toBe(1);
  flush();
  expect(Panel().panelWidth).toBe(620);
  emit("mousemove", { clientX: 850 });
  emit("mouseup");
  expect(Panel().panelWidth).toBe(670);
  expect(frames.size).toBe(0);
  expect(save).toHaveBeenCalledExactlyOnceWith("excel-panel-width", "670");
  expect(document.body.style.cursor).toBe("default");
  expect(document.body.style.userSelect).toBe("text");
});
test("disabling or unmounting a drag cancels deferred updates and restores body styles", () => {
  begin();
  emit("mousemove", { clientX: 800 });
  Panel(false);
  const writes = h.writes;
  flush();
  expect(h.writes).toBe(writes);
  expect(events.has("mousemove")).toBe(false);
  expect(save).not.toHaveBeenCalled();
  Panel(false);
  expect(document.body.style.cursor).toBe("default");
  begin();
  emit("mousemove", { clientX: 750 });
  for (const slot of h.slots) (slot as { cleanup?: () => void } | undefined)?.cleanup?.();
  expect(frames.size).toBe(0);
  expect(document.body.style.userSelect).toBe("text");
});
test("window resize bursts use the latest viewport once and stop after cleanup", () => {
  Panel();
  h.writes = 0;
  for (let i = 0; i < 100; i++) {
    win.innerWidth = 800 - i;
    emit("resize");
  }
  expect(h.writes).toBe(0);
  expect(frames.size).toBe(1);
  flush();
  expect(h.writes).toBe(2);
  expect(Panel().panelWidth).toBe(520);
  expect(Panel().isFloatingByResize).toBe(true);
  win.innerWidth = 600;
  emit("resize");
  Panel(false);
  const writes = h.writes;
  flush();
  expect(h.writes).toBe(writes);
});

test("closing a still-mounted panel cancels drag work but keeps viewport tracking", () => {
  begin();
  emit("mousemove", { clientX: 800 });
  Panel(true, false);
  const writes = h.writes;
  flush();
  expect(h.writes).toBe(writes);
  expect(events.has("mousemove")).toBe(false);
  expect(events.has("resize")).toBe(true);
  expect(save).not.toHaveBeenCalled();
  expect(document.body.style.cursor).toBe("default");
  win.innerWidth = 900;
  emit("resize");
  flush();
  expect(Panel(true, true).isFloatingByResize).toBe(true);
});
