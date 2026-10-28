import { afterEach, expect, test, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});
test("search results transfer a compact buffer without detaching the worker's cached candidates", async () => {
  const received: Array<{ id: number; matches: Uint32Array }> = [];
  const sent: Array<{ id: number; matches: Uint32Array }> = [];
  const host = {
    onmessage: null as null | ((e: { data: unknown }) => void),
    postMessage: vi.fn((data: { id: number; matches: Uint32Array }, transfer?: Transferable[]) => {
      sent.push(data);
      received.push(structuredClone(data, { transfer: transfer ?? [] }));
    }),
  };
  vi.stubGlobal("self", host);
  await import("../src/lib/preview-search.worker");
  host.onmessage?.({ data: { type: "init", content: "Alpha\nbeta\nALPINE\n" } });
  for (const [id, query] of [
    [1, "al"],
    [2, "alpha"],
    [3, "a"],
    [4, "missing"],
  ] as const)
    host.onmessage?.({ data: { type: "search", id, query } });
  expect(received.map((r) => ({ id: r.id, matches: Array.from(r.matches) }))).toEqual([
    { id: 1, matches: [0, 2] },
    { id: 2, matches: [0] },
    { id: 3, matches: [0, 1, 2] },
    { id: 4, matches: [] },
  ]);
  expect(received.every((r) => r.matches instanceof Uint32Array)).toBe(true);
  expect(sent.every((r) => r.matches.byteLength === 0)).toBe(true);
  expect(host.postMessage.mock.calls.every(([, transfer]) => transfer?.length === 1)).toBe(true);
});
