import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ register: vi.fn(), highlight: vi.fn() }));
vi.mock("highlight.js/lib/core", () => ({
  default: {
    registerLanguage: mocks.register,
    registerAliases: vi.fn(),
    getLanguage: () => true,
    highlight: mocks.highlight,
  },
}));
beforeEach(() => {
  vi.resetModules();
  mocks.register.mockReset();
  mocks.highlight.mockReset();
});
test("failed highlighter initialization falls back and a later opening retries", async () => {
  mocks.register.mockImplementationOnce(() => {
    throw new Error("chunk unavailable");
  });
  const { ensureHljs, getHljs } = await import("../src/lib/hljs-utils");
  await expect(ensureHljs()).resolves.toBeUndefined();
  expect(getHljs()).toBeNull();
  await ensureHljs();
  expect(getHljs()).not.toBeNull();
});
test("plain preview lines are visible before highlighting and preserve markup as text", async () => {
  const { highlightCodeLines } = await import("../src/lib/hljs-utils");
  expect(highlightCodeLines('<div title="x">&</div>\nnext', "html")).toEqual([
    '&lt;div title="x"&gt;&amp;&lt;/div&gt;',
    "next",
  ]);
});
test("concurrent highlighter requests share initialization and successful results are cached", async () => {
  const { ensureHljs, highlightCodeLines } = await import("../src/lib/hljs-utils");
  const first = ensureHljs();
  expect(ensureHljs()).toBe(first);
  await first;
  const calls = mocks.register.mock.calls.length;
  await ensureHljs();
  expect(mocks.register).toHaveBeenCalledTimes(calls);
  mocks.highlight.mockReturnValue({ value: '<span class="hljs-keyword">const</span>' });
  expect(highlightCodeLines("const", "javascript")).toEqual([
    '<span class="hljs-keyword">const</span>',
  ]);
});
test("plain lines stay escaped and skip highlighting even after initialization", async () => {
  const { ensureHljs, plainCodeLines } = await import("../src/lib/hljs-utils");
  await ensureHljs();
  expect(plainCodeLines("<x>&\nlast")).toEqual(["&lt;x&gt;&amp;", "last"]);
  expect(mocks.highlight).not.toHaveBeenCalled();
});
