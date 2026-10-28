import { afterEach, beforeEach, expect, test, vi } from "vitest";

beforeEach(() => vi.resetModules());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("explicit plaintext does not initialize language grammars", async () => {
  const { ensureHljs, getHljs } = await import("../src/lib/hljs-utils");
  await ensureHljs("plaintext");
  expect(getHljs()).toBeNull();
  await ensureHljs("TXT");
  expect(getHljs()).toBeNull();
});
test("plaintext remains escaped and bracket-colored before optional grammar loading", async () => {
  const { highlightCode, highlightCodeLines, getHljs } = await import("../src/lib/hljs-utils");
  const html = highlightCode(`<tag title="x" other='y'>& (ok)`, "plaintext");
  expect(html).toContain("&lt;tag title=&quot;x&quot; other=&#x27;y&#x27;&gt;&amp;");
  expect(html).toContain('style="color:');
  expect(highlightCodeLines("first\n\nlast\n", "text")).toEqual(["first", "", "last", ""]);
  expect(getHljs()).toBeNull();
});
test("plaintext aliases match the registered grammar exactly", async () => {
  const { ensureHljs, getHljs, highlightCode, colorizeBracketsHtml } = await import(
    "../src/lib/hljs-utils"
  );
  await ensureHljs();
  const core = getHljs()!;
  for (const value of [
    "",
    `<x a="b" c='d'>&amp; &lbrace;`,
    "{[(中文😀)]}\nnext",
    '"(quoted)" <script>()</script>',
  ]) {
    const expected = colorizeBracketsHtml(core.highlight(value, { language: "plaintext" }).value);
    for (const alias of ["plaintext", "text", "txt", "PLAINTEXT", "TXT"])
      expect(highlightCode(value, alias)).toBe(expected);
  }
});
test("a later code language still initializes and highlights normally", async () => {
  const { ensureHljs, getHljs, highlightCode } = await import("../src/lib/hljs-utils");
  await ensureHljs("plaintext");
  await ensureHljs("javascript");
  expect(getHljs()).not.toBeNull();
  expect(highlightCode("const answer = 42;", "javascript")).toContain("hljs-keyword");
});
test("plaintext worker produces both output formats without grammar initialization", async () => {
  const post = vi.fn();
  vi.stubGlobal("postMessage", post);
  vi.stubGlobal("onmessage", null);
  const { getHljs } = await import("../src/lib/hljs-utils");
  await import("../src/lib/preview-highlight.worker");
  const send = globalThis.onmessage as unknown as (e: MessageEvent) => Promise<void>;
  await send({ data: { code: "<x>\nlast", language: "plaintext" } } as MessageEvent);
  expect(post).toHaveBeenLastCalledWith(["&lt;x&gt;", "last"]);
  await send({ data: { code: "<x>\nlast", language: "text", output: "html" } } as MessageEvent);
  expect(post).toHaveBeenLastCalledWith("&lt;x&gt;\nlast");
  expect(getHljs()).toBeNull();
});
