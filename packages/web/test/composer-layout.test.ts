import { afterEach, beforeEach, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({ slots: [] as any[], index: 0, pending: [] as (() => void)[] }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const effect = (run: () => (() => void) | undefined, deps: unknown[]) => {
    const i = h.index++,
      old = h.slots[i];
    if (old && deps.every((d, j) => Object.is(d, old.deps[j]))) return;
    h.pending.push(() => {
      old?.cleanup?.();
      h.slots[i] = { deps, cleanup: run() };
    });
  };
  return {
    ...react,
    useRef: (value: unknown) => {
      const i = h.index++;
      h.slots[i] ??= { current: value };
      return h.slots[i];
    },
    useCallback: (fn: unknown, deps: unknown[]) => {
      const i = h.index++,
        old = h.slots[i];
      if (old && deps.every((d, j) => Object.is(d, old.deps[j]))) return old.fn;
      h.slots[i] = { deps, fn };
      return fn;
    },
    useEffect: effect,
    useLayoutEffect: effect,
  };
});

import { useComposerLayout } from "../src/lib/use-composer-layout";

let resizeNotice: (entries: ResizeObserverEntry[]) => void;
let fontReady: () => void;
let frames: Map<number, FrameRequestCallback>, id: number;
let height: number, width: number;
const reads = vi.fn(),
  writes = vi.fn(),
  disconnected = vi.fn(),
  removeFont = vi.fn();
let textarea: { current: HTMLTextAreaElement | null }, backdrop: { current: HTMLDivElement | null };
function LayoutProbe({ text }: { text: string }) {
  return useComposerLayout(text, textarea, backdrop);
}
function render(text = "text") {
  h.index = 0;
  const sync = LayoutProbe({ text });
  for (const run of h.pending.splice(0)) run();
  return sync;
}
function notify(next: number) {
  width = next;
  resizeNotice([{ contentRect: { width: next } }] as unknown as ResizeObserverEntry[]);
}
function flush() {
  const batch = [...frames.values()];
  frames.clear();
  for (const run of batch) run(0);
}
function close() {
  for (const slot of h.slots) slot?.cleanup?.();
}
beforeEach(() => {
  h.slots = [];
  h.index = 0;
  h.pending = [];
  frames = new Map();
  id = 0;
  height = 60;
  width = 600;
  reads.mockClear();
  writes.mockClear();
  disconnected.mockClear();
  removeFont.mockClear();
  textarea = {
    current: {
      get scrollHeight() {
        reads();
        return height;
      },
      get clientWidth() {
        return width;
      },
      scrollTop: 0,
      scrollLeft: 0,
      style: { height: "", overflow: "" },
      parentElement: { getBoundingClientRect: () => ({ width }) },
    } as unknown as HTMLTextAreaElement,
  };
  let mirrorWidth = "";
  backdrop = {
    current: {
      style: {
        get width() {
          return mirrorWidth;
        },
        set width(value: string) {
          mirrorWidth = value;
          writes(value);
        },
      },
      scrollTop: 0,
      scrollLeft: 0,
    } as unknown as HTMLDivElement,
  };
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
    frames.set(++id, fn);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (frame: number) => frames.delete(frame));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(fn: typeof resizeNotice) {
        resizeNotice = fn;
      }
      observe() {}
      disconnect() {
        disconnected();
      }
    },
  );
  vi.stubGlobal("document", {
    fonts: {
      addEventListener: (_name: string, fn: () => void) => {
        fontReady = fn;
      },
      removeEventListener: removeFont,
    },
  });
});
afterEach(() => {
  close();
  vi.unstubAllGlobals();
});
test("text commits measure once and parent height notifications do not cause another pass", () => {
  render();
  expect(reads).toHaveBeenCalledTimes(1);
  notify(600);
  flush();
  render();
  expect(reads).toHaveBeenCalledTimes(1);
  render("longer");
  notify(600);
  flush();
  expect(reads).toHaveBeenCalledTimes(2);
});
test("width changes coalesce and a newer text commit consumes the pending resize", () => {
  render();
  notify(500);
  notify(400);
  expect(frames.size).toBe(1);
  flush();
  expect(reads).toHaveBeenCalledTimes(2);
  expect(backdrop.current?.style.width).toBe("400px");
  notify(300);
  render("latest");
  expect(frames.size).toBe(0);
  flush();
  expect(reads).toHaveBeenCalledTimes(3);
});
test("font readiness remeasures and preserves the 180px cap and shrinking behavior", () => {
  render();
  height = 300;
  fontReady();
  flush();
  expect(textarea.current?.style.height).toBe("180px");
  expect(textarea.current?.style.overflow).toBe("auto");
  height = 40;
  render("");
  expect(textarea.current?.style.height).toBe("40px");
  expect(textarea.current?.style.overflow).toBe("hidden");
});
test("scroll synchronization skips unchanged styles and cleanup cancels delayed layout", () => {
  const sync = render();
  sync();
  sync();
  expect(writes).toHaveBeenCalledTimes(1);
  textarea.current!.scrollTop = 20;
  textarea.current!.scrollLeft = 5;
  sync();
  expect(backdrop.current?.scrollTop).toBe(20);
  expect(backdrop.current?.scrollLeft).toBe(5);
  notify(300);
  close();
  expect(frames.size).toBe(0);
  flush();
  expect(reads).toHaveBeenCalledTimes(1);
  expect(disconnected).toHaveBeenCalled();
  expect(removeFont).toHaveBeenCalled();
});
