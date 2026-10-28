import { afterEach, expect, test, vi } from "vitest";
import { trackCanvasCandidates } from "../src/lib/workbook/canvas-candidates";

afterEach(() => vi.unstubAllGlobals());
function setup() {
  let notify!: () => void;
  const disconnect = vi.fn();
  vi.stubGlobal(
    "MutationObserver",
    class {
      constructor(callback: () => void) {
        notify = callback;
      }
      observe = vi.fn();
      disconnect = disconnect;
    },
  );
  const small = { clientHeight: 30 },
    large = { clientHeight: 600 };
  let canvases = [small, large];
  const querySelectorAll = vi.fn(() => canvases);
  const tracker = trackCanvasCandidates({ querySelectorAll } as unknown as HTMLElement);
  return {
    tracker,
    small,
    large,
    querySelectorAll,
    disconnect,
    notify: () => notify(),
    replace: (next: typeof canvases) => {
      canvases = next;
    },
  };
}

test("stationary frames reuse the canvas list while dimensions still choose the largest", () => {
  const s = setup();
  for (let i = 0; i < 120; i++) expect(s.tracker.current()).toBe(s.large);
  expect(s.querySelectorAll).toHaveBeenCalledTimes(1);
  s.small.clientHeight = 700;
  expect(s.tracker.current()).toBe(s.small);
  expect(s.querySelectorAll).toHaveBeenCalledTimes(1);
  s.tracker.dispose();
});
test("DOM changes coalesce discovery and canvas replacement is visible on the next frame", () => {
  const s = setup();
  s.tracker.current();
  const replacement = { clientHeight: 800 };
  s.replace([replacement]);
  s.notify();
  s.notify();
  s.notify();
  expect(s.querySelectorAll).toHaveBeenCalledTimes(1);
  expect(s.tracker.current()).toBe(replacement);
  expect(s.querySelectorAll).toHaveBeenCalledTimes(2);
  s.replace([]);
  s.notify();
  expect(s.tracker.current()).toBeUndefined();
  s.replace([s.large]);
  s.notify();
  expect(s.tracker.current()).toBe(s.large);
  s.tracker.dispose();
});
test("disposal disconnects observation and releases the old canvas list", () => {
  const s = setup();
  s.tracker.current();
  s.tracker.dispose();
  s.notify();
  expect(s.tracker.current()).toBeUndefined();
  expect(s.disconnect).toHaveBeenCalledTimes(1);
  expect(s.querySelectorAll).toHaveBeenCalledTimes(1);
});
