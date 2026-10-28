import { expect, test, vi } from "vitest";
import {
  applyDisplayReplacements,
  mentionOccurrences,
  restoreMentionDraft,
} from "../src/components/chat/chat-input-insert";
import { extractMentions } from "../src/components/chat/mention-tokens";

test("bare references do not rescan all previously accepted ranges", () => {
  const text = Array.from({ length: 500 }, (_, i) => `file${i}.xlsx`).join(" ");
  const some = vi.spyOn(Array.prototype, "some");
  let tokens: ReturnType<typeof extractMentions> = [];
  let calls = 0;
  try {
    tokens = extractMentions(text);
    calls = some.mock.calls.length;
  } finally {
    some.mockRestore();
  }
  expect(tokens).toHaveLength(500);
  expect(tokens[499].value).toBe("file499.xlsx");
  expect(calls).toBe(0);
});
test("display matching uses shared prefixes instead of trying every token", () => {
  const tokens = Array.from({ length: 500 }, (_, i) => `@sales${i}.xlsx`);
  const startsWith = vi.spyOn(String.prototype, "startsWith");
  let matches: ReturnType<typeof mentionOccurrences> = [];
  let calls = 0;
  try {
    matches = mentionOccurrences(tokens.join(" "), tokens);
    calls = startsWith.mock.calls.length;
  } finally {
    startsWith.mockRestore();
  }
  expect(matches.map((m) => m.token)).toEqual(tokens);
  expect(calls).toBeLessThanOrEqual(500);
});
test("draft restoration builds its occupied-label set once for the whole batch", () => {
  const raw = Array.from({ length: 500 }, (_, i) => `@dir${i}/sales.xlsx`).join(" ");
  const keys = vi.spyOn(Map.prototype, "keys");
  let draft: ReturnType<typeof restoreMentionDraft> | undefined;
  let calls = 0;
  try {
    draft = restoreMentionDraft(raw);
    calls = keys.mock.calls.length;
  } finally {
    keys.mockRestore();
  }
  expect(calls).toBe(1);
  expect(draft?.tokens.size).toBe(500);
  expect(applyDisplayReplacements(draft?.text ?? "", draft?.map ?? new Map())).toBe(raw);
});
test("mixed overlapping file syntax retains explicit, quoted then bare priority", () => {
  const text = 'first.csv "@dir/inside.xlsx" "folder/sales report.csv" @dir/next.xlsx last.txt';
  const tokens = extractMentions(text);
  expect(tokens.map((t) => [t.kind, t.value])).toEqual([
    ["path", "first.csv"],
    ["file", "dir/inside.xlsx"],
    ["path", "folder/sales report.csv"],
    ["file", "dir/next.xlsx"],
    ["path", "last.txt"],
  ]);
  for (const t of tokens) expect(text.slice(t.start, t.end)).toBe(t.raw);
  for (let i = 1; i < tokens.length; i++)
    expect(tokens[i - 1].end).toBeLessThanOrEqual(tokens[i].start);
});
test("longest valid tokens still respect punctuation, prefixes and repeated occurrences", () => {
  const text = "@a.xlsx.bak @a.xlsx：(@a.xlsx extra) x@a.xlsx @a.xlsx";
  expect(
    mentionOccurrences(text, ["@a.xlsx", "@a.xlsx extra", "", "@a.xlsx"]).map((m) => m.token),
  ).toEqual(["@a.xlsx", "@a.xlsx extra", "@a.xlsx"]);
  expect(mentionOccurrences("ordinary text".repeat(1000), [])).toEqual([]);
});
test("draft round-trip keeps repeated references and same basenames distinct", () => {
  const raw = "@sales.xlsx @nested/sales.xlsx @other/sales.xlsx @sales.xlsx";
  const d = restoreMentionDraft(raw);
  expect(d.tokens.size).toBe(3);
  expect(applyDisplayReplacements(d.text, d.map)).toBe(raw);
});
