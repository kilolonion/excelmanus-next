import { expect, test, vi } from "vitest";
import { thinkingPreview } from "../src/lib/thinking";

const original = (text: string, max = 48) => {
  const normalized = text.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
};

test("a short collapsed preview does not normalize the complete long reasoning text", () => {
  const content = `**Heading** ${"long reasoning text\n".repeat(50000)}`;
  const expected = original(content);
  const replace = vi.spyOn(String.prototype, "replace");
  let result = "",
    calls = 0;
  try {
    result = thinkingPreview(content);
    calls = replace.mock.calls.length;
  } finally {
    replace.mockRestore();
  }
  expect(result).toBe(expected);
  expect(calls).toBe(0);
});

test("preview normalization keeps bold removal, whitespace and truncation semantics", () => {
  const inputs = [
    "",
    "  \n\t ",
    "**A****B**",
    "***A*****B*",
    " ** A ** \t **B** ",
    "alpha ** ** beta",
    "🙂中\ud800文\u00a0下\ufeff一行\n",
    "x".repeat(48),
    `${"x".repeat(48)}  **  **`,
    `${"x".repeat(48)}\n y`,
    "*".repeat(50000),
    `${" ".repeat(100000)}tail`,
  ];
  for (const text of inputs)
    for (const max of [0, 1, 4, 48, 48.5, -1, Infinity, NaN])
      expect(thinkingPreview(text, max)).toBe(original(text, max));
});

test("seeded mixed markers and whitespace match the original preview", () => {
  const chunks = ["**", "*", " ", "\n", "\r\n", "\t", "标题", "word", "🙂", "\u00a0"];
  let seed = 42;
  for (let i = 0; i < 1000; i++) {
    let text = "";
    for (let j = 0; j < 40; j++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      text += chunks[seed % chunks.length];
    }
    expect(thinkingPreview(text, i % 50)).toBe(original(text, i % 50));
  }
});
