import { expect, test, vi } from "vitest";
import { createPreviewLineSearch } from "../src/lib/preview-line-search";
import { createTextLines } from "../src/lib/text-lines";

test("large line indexing scans newline positions once across offset blocks", () => {
  const content = `${"😀中文\r\n".repeat(180000)}tail\n`;
  const expected = content.split("\n");
  const indexOf = vi.spyOn(String.prototype, "indexOf");
  let lines: ReturnType<typeof createTextLines>;
  let scans: number;
  try {
    lines = createTextLines(content);
    scans = indexOf.mock.contexts.filter((value) => String(value) === content).length;
  } finally {
    indexOf.mockRestore();
  }
  expect(scans).toBe(expected.length);
  expect(lines.length).toBe(expected.length);
  for (const i of [0, 4095, 4096, 8191, 8192, expected.length - 2, expected.length - 1])
    expect(lines.get(i)).toBe(expected[i]);
  for (const i of [-1, 0.5, NaN, Infinity, expected.length]) expect(lines.get(i)).toBeUndefined();
});

test.each(["", "one", "\n", "\n\n", "a\r\nb\n", "😀中文\n\n尾部", "first\nlast\n"])(
  "line offsets preserve split semantics for %j at both sizes",
  (tail) => {
    for (const prefix of ["", "x".repeat(1_000_000) + "\n"]) {
      const content = prefix + tail,
        expected = content.split("\n"),
        lines = createTextLines(content);
      expect(lines.length).toBe(expected.length);
      expect(Array.from({ length: lines.length }, (_, i) => lines.get(i))).toEqual(expected);
      expect(lines.get(-1)).toBeUndefined();
      expect(lines.get(lines.length)).toBeUndefined();
    }
  },
);
test("large previews materialize only requested lines", () => {
  const content = "a line 😀\n".repeat(100000);
  const split = vi.spyOn(String.prototype, "split"),
    slice = vi.spyOn(String.prototype, "slice");
  try {
    const lines = createTextLines(content);
    expect(lines.length).toBe(100001);
    expect(split).not.toHaveBeenCalled();
    expect(slice).not.toHaveBeenCalled();
    expect(lines.get(50000)).toBe("a line 😀");
    expect(lines.get(100000)).toBe("");
    expect(slice).toHaveBeenCalledTimes(2);
  } finally {
    split.mockRestore();
    slice.mockRestore();
  }
});
test("indexed text and array search have the same case, space and backspace behavior", () => {
  const content = "padding".repeat(150000) + "\nAlpha\n中文 ALPINE\r\n beta \n";
  const indexed = createPreviewLineSearch(createTextLines(content));
  const original = createPreviewLineSearch(content.split("\n"));
  for (const query of ["al", "ALPHA", "a", " beta ", "中文", "", "\r", "padding"])
    expect(indexed(query)).toEqual(original(query));
});

test("search worker initialization avoids a second large raw-line array", async () => {
  const host = {
    onmessage: null as null | ((event: { data: unknown }) => void),
    postMessage: vi.fn(),
  };
  vi.stubGlobal("self", host);
  const content = "plain\n".repeat(200000) + "needle";
  const split = vi.spyOn(String.prototype, "split");
  try {
    await import("../src/lib/preview-search.worker");
    split.mockClear();
    host.onmessage?.({ data: { type: "init", content } });
    expect(split.mock.contexts.filter((value) => String(value) === content)).toHaveLength(0);
    host.onmessage?.({ data: { type: "search", id: 9, query: "needle" } });
    expect(host.postMessage.mock.calls.at(-1)?.[0]).toEqual({
      id: 9,
      matches: Uint32Array.from([200000]),
    });
  } finally {
    split.mockRestore();
    vi.unstubAllGlobals();
  }
});
