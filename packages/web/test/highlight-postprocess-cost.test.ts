import { expect, test, vi } from "vitest";
import { colorizeBracketsHtml } from "../src/lib/hljs-utils";

const painted = (text: string, color: string) =>
  `<span style="color:${color};font-weight:bold">${text}</span>`;

test("long ordinary runs do not perform per-character entity probes", () => {
  const source = "ordinary text &amp; no brackets\n".repeat(1000);
  const startsWith = vi.spyOn(String.prototype, "startsWith");
  let result = "";
  let probes = 0;
  try {
    result = colorizeBracketsHtml(source);
    probes = startsWith.mock.calls.length;
  } finally {
    startsWith.mockRestore();
  }
  expect(result).toBe(source);
  // Only entity boundaries need inspection, not every letter of the source.
  expect(probes).toBeLessThanOrEqual(2100);
});

test("bracket depth, unmatched closes and entities preserve their exact markup", () => {
  expect(colorizeBracketsHtml("x{a{b}c}&lbrace;y&rbrace;]")).toBe(
    "x" +
      painted("{", "#e5a100") +
      "a" +
      painted("{", "#d7ba7d") +
      "b" +
      painted("}", "#d7ba7d") +
      "c" +
      painted("}", "#e5a100") +
      painted("&lbrace;", "#e5a100") +
      "y" +
      painted("&rbrace;", "#e5a100") +
      painted("]", "#c586c0"),
  );
});

test("nested string and regexp spans remain unpainted without affecting surrounding depth", () => {
  const literal = '<span class="hljs-string">"a{<span class="nested">[b]</span>}"</span>';
  const regexp = '<span class="hljs-regexp">/[(){}]/</span>';
  expect(colorizeBracketsHtml(`(${literal}${regexp})`)).toBe(
    painted("(", "#569cd6") + literal + regexp + painted(")", "#569cd6"),
  );
});

test("ordinary tags and escaped text are preserved while adjacent code is painted", () => {
  const tag = '<em data-text="[{}]">';
  expect(colorizeBracketsHtml(`${tag}&lt;你好&gt;[value]</em>`)).toBe(
    tag + "&lt;你好&gt;" + painted("[", "#c586c0") + "value" + painted("]", "#c586c0") + "</em>",
  );
});
