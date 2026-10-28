import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { PreviewMatches } from "../src/lib/preview-line-search";

const h = vi.hoisted(() => ({ slots: [] as any[], index: 0, pending: [] as Array<() => void> }));
vi.mock("react", async (original) => {
  const r = await original<typeof import("react")>();
  return {
    ...r,
    useRef: (initial: unknown) => (h.slots[h.index++] ??= { current: initial }),
    useState: (initial: unknown) => {
      const i = h.index++;
      if (!(i in h.slots)) h.slots[i] = initial;
      return [
        h.slots[i],
        (v: unknown) => {
          h.slots[i] = v;
        },
      ];
    },
    useMemo: (fn: () => unknown, deps: unknown[]) => {
      const i = h.index++,
        old = h.slots[i];
      if (old && deps.every((d, j) => Object.is(d, old.deps[j]))) return old.value;
      const value = fn();
      h.slots[i] = { deps, value };
      return value;
    },
    useEffect: (fn: () => void | (() => void), deps: unknown[]) => {
      const i = h.index++,
        old = h.slots[i];
      if (old && deps.every((d, j) => Object.is(d, old.deps[j]))) return;
      h.pending.push(() => {
        old?.cleanup?.();
        h.slots[i] = { deps, cleanup: fn() };
      });
    },
  };
});

import { usePreviewSearch } from "../src/lib/use-preview-search";

let workers: FakeWorker[];
class FakeWorker {
  onmessage: ((e: MessageEvent<{ id: number; matches: PreviewMatches }>) => void) | null = null;
  onerror: (() => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() {
    workers.push(this);
  }
}
const content = "Alpha\n".repeat(200000),
  lines = content.split("\n");
function PreviewSearchHarness(query: string, text = content, raw = lines) {
  h.index = 0;
  // biome-ignore lint/correctness/useHookAtTopLevel: Controlled harness runs the real hook with mocked React state.
  return usePreviewSearch(text, query, raw);
}
function commit() {
  for (const run of h.pending.splice(0)) run();
}
function reply(worker: FakeWorker, matches: PreviewMatches, id?: number) {
  const message = worker.postMessage.mock.calls.at(-1)![0];
  worker.onmessage?.({ data: { id: id ?? message.id, matches } } as MessageEvent<{
    id: number;
    matches: PreviewMatches;
  }>);
}
beforeEach(() => {
  h.slots = [];
  h.index = 0;
  h.pending = [];
  workers = [];
  vi.stubGlobal("Worker", FakeWorker);
});
afterEach(() => {
  for (const slot of h.slots) slot?.cleanup?.();
  vi.unstubAllGlobals();
});
test("large queries reuse one worker and hide the old query's results immediately", () => {
  expect(PreviewSearchHarness("al")).toMatchObject({ pending: true, matches: [] });
  commit();
  expect(workers).toHaveLength(1);
  reply(workers[0], [0, 1]);
  expect(PreviewSearchHarness("al").matches).toEqual([0, 1]);
  expect(PreviewSearchHarness("alpha")).toMatchObject({ pending: true, matches: [] });
  commit();
  expect(workers).toHaveLength(1);
  expect(workers[0].postMessage.mock.calls.filter(([m]) => m.type === "init")).toHaveLength(1);
  reply(workers[0], [9], 1);
  expect(PreviewSearchHarness("alpha").matches).toEqual([]);
  reply(workers[0], [2]);
  expect(PreviewSearchHarness("alpha").matches).toEqual([2]);
});
test("clearing search terminates its worker and ignores a late result", () => {
  PreviewSearchHarness("al");
  commit();
  const worker = workers[0];
  expect(PreviewSearchHarness("")).toMatchObject({ pending: false, matches: [] });
  commit();
  expect(worker.terminate).toHaveBeenCalledOnce();
  reply(worker, [9]);
  expect(PreviewSearchHarness("").matches).toEqual([]);
});
test("changing file content replaces the worker and cannot show the previous content's matches", () => {
  PreviewSearchHarness("al");
  commit();
  const old = workers[0];
  const changed = "Beta\n".repeat(250000),
    raw = changed.split("\n");
  expect(PreviewSearchHarness("al", changed, raw)).toMatchObject({ pending: true, matches: [] });
  commit();
  expect(old.terminate).toHaveBeenCalledOnce();
  expect(workers).toHaveLength(2);
  reply(old, [9]);
  expect(PreviewSearchHarness("al", changed, raw).matches).toEqual([]);
  reply(workers[1], []);
  expect(PreviewSearchHarness("al", changed, raw).pending).toBe(false);
});
test("small files keep synchronous matching and worker failure falls back to correct results", () => {
  const small = ["Alpha", "beta", "ALPINE"];
  PreviewSearchHarness("al", small.join("\n"), small);
  commit();
  expect(workers).toHaveLength(0);
  expect(PreviewSearchHarness("al", small.join("\n"), small).matches).toEqual([0, 2]);
  PreviewSearchHarness("missing");
  commit();
  workers[0].onerror?.();
  expect(PreviewSearchHarness("missing")).toMatchObject({ pending: false, matches: [] });
  expect(workers[0].terminate).toHaveBeenCalledOnce();
});

test("unmount terminates active search and ignores completion", () => {
  PreviewSearchHarness("al");
  commit();
  const worker = workers[0];
  for (const slot of h.slots) slot?.cleanup?.();
  expect(worker.terminate).toHaveBeenCalledOnce();
  const before = h.slots[0];
  reply(worker, [9]);
  expect(h.slots[0]).toBe(before);
});

test("transferred search buffers stay compact in the view and late typed results stay isolated", () => {
  PreviewSearchHarness("al");
  commit();
  const matches = Uint32Array.from([0, 2]);
  reply(workers[0], matches);
  expect(PreviewSearchHarness("al").matches).toBe(matches);
  PreviewSearchHarness("beta");
  commit();
  reply(workers[0], Uint32Array.from([8]), 1);
  expect(PreviewSearchHarness("beta").matches).toEqual([]);
  const current = Uint32Array.from([4]);
  reply(workers[0], current);
  expect(PreviewSearchHarness("beta").matches).toBe(current);
});

test("busy search keeps only the latest queued query instead of posting every intermediate scan", () => {
  PreviewSearchHarness("a");
  commit();
  const worker = workers[0];
  for (const query of ["al", "alp", "alph", "alpha"]) {
    PreviewSearchHarness(query);
    commit();
  }
  expect(
    worker.postMessage.mock.calls.filter(([m]) => m.type === "search").map(([m]) => m.query),
  ).toEqual(["a"]);
  reply(worker, [9], 1);
  expect(PreviewSearchHarness("alpha")).toMatchObject({ pending: true, matches: [] });
  expect(
    worker.postMessage.mock.calls.filter(([m]) => m.type === "search").map(([m]) => m.query),
  ).toEqual(["a", "alpha"]);
  reply(worker, [0, 1]);
  expect(PreviewSearchHarness("alpha")).toMatchObject({ pending: false, matches: [0, 1] });
});

test("clearing or changing files drops queued work as well as late results", () => {
  PreviewSearchHarness("a");
  commit();
  const old = workers[0];
  PreviewSearchHarness("alpha");
  commit();
  PreviewSearchHarness("");
  commit();
  reply(old, [7], 1);
  expect(old.postMessage.mock.calls.filter(([m]) => m.type === "search")).toHaveLength(1);
  PreviewSearchHarness("al");
  commit();
  const second = workers[1];
  PreviewSearchHarness("alpha");
  commit();
  PreviewSearchHarness("beta", content + "beta", [...lines, "beta"]);
  commit();
  reply(second, [8]);
  expect(second.postMessage.mock.calls.filter(([m]) => m.type === "search")).toHaveLength(1);
  reply(workers[2], [200000]);
  expect(PreviewSearchHarness("beta", content + "beta", [...lines, "beta"]).matches).toEqual([
    200000,
  ]);
});

test("worker failure while newer query waits falls back to that current query", () => {
  PreviewSearchHarness("a");
  commit();
  PreviewSearchHarness("missing");
  commit();
  workers[0].onerror?.();
  expect(PreviewSearchHarness("missing")).toMatchObject({ pending: false, matches: [] });
  expect(workers[0].terminate).toHaveBeenCalledOnce();
});

test("a queued post failure falls back without leaving the latest query pending", () => {
  PreviewSearchHarness("a");
  commit();
  const worker = workers[0];
  PreviewSearchHarness("missing");
  commit();
  worker.postMessage.mockImplementation(() => {
    throw new Error("worker closed");
  });
  reply(worker, [7], 1);
  expect(PreviewSearchHarness("missing")).toMatchObject({ pending: false, matches: [] });
  expect(worker.terminate).toHaveBeenCalledOnce();
});
