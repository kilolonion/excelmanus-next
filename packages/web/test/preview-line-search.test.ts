import { afterEach, expect, test, vi } from "vitest";
import { createPreviewLineSearch } from "../src/lib/preview-line-search";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
test("search normalizes each line once and narrows prefixes without losing backspace matches", () => {
  const lines = ["Alpha one", "ALPINE two", "beta", "中文 Alpha"];
  const lower = vi.spyOn(String.prototype, "toLowerCase");
  const search = createPreviewLineSearch(lines);
  expect(lower).not.toHaveBeenCalled();
  expect(search("al")).toEqual([0, 1, 3]);
  expect(search("alpha")).toEqual([0, 3]);
  expect(search("a")).toEqual([0, 1, 2, 3]);
  expect(search("   ")).toEqual([]);
  expect(search("中文")).toEqual([3]);
  for (const line of lines)
    expect(lower.mock.contexts.filter((v) => String(v) === line)).toHaveLength(1);
});
test("worker keeps its index across queries and returns the matching request id", async () => {
  const host = { onmessage: null as null | ((e: { data: unknown }) => void), postMessage: vi.fn() };
  vi.stubGlobal("self", host);
  await import("../src/lib/preview-search.worker");
  host.onmessage?.({ data: { type: "init", content: "Alpha\nbeta\nALPINE" } });
  host.onmessage?.({ data: { type: "search", id: 1, query: "al" } });
  host.onmessage?.({ data: { type: "search", id: 2, query: "alpha" } });
  expect(host.postMessage.mock.calls.map(([data]) => data)).toEqual([
    { id: 1, matches: Uint32Array.from([0, 2]) },
    { id: 2, matches: Uint32Array.from([0]) },
  ]);
});

test("visible-line membership works with array and transferred sorted results", async () => {
  const { hasPreviewMatch } = await import("../src/lib/preview-line-search");
  for (const matches of [[0, 2, 5, 500000], Uint32Array.from([0, 2, 5, 500000])])
    for (const line of [-1, 0, 1, 2, 4, 5, 499999, 500000, 500001])
      expect(hasPreviewMatch(matches, line)).toBe(Array.from(matches).includes(line));
  expect(hasPreviewMatch(new Uint32Array(), 0)).toBe(false);
});

test("checking a visible row reads logarithmically many hit indices", async () => {
  const { hasPreviewMatch } = await import("../src/lib/preview-line-search");
  let reads = 0;
  const matches = new Proxy(
    Array.from({ length: 100000 }, (_, i) => i * 2),
    {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) reads++;
        return Reflect.get(target, key, receiver);
      },
    },
  );
  expect(hasPreviewMatch(matches, 199998)).toBe(true);
  expect(reads).toBeLessThan(30);
});
