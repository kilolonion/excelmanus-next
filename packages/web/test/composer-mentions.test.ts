import { expect, test } from "vitest";
import {
  applyDisplayReplacements,
  mentionOccurrences,
  restoreMentionDraft,
  toDisplayMentionTokens,
} from "../src/components/chat/chat-input-insert";

test("each occurrence is addressable and replacements respect token boundaries", () => {
  const map = new Map([["@sales.xlsx", "@reports/sales.xlsx"]]);
  const text = "@sales.xlsx 对比 @sales.xlsx，不改 @sales.xlsx.bak";
  expect(mentionOccurrences(text, map.keys()).map((p) => p.start)).toEqual([0, 15]);
  expect(applyDisplayReplacements(text, map)).toBe(
    "@reports/sales.xlsx 对比 @reports/sales.xlsx，不改 @sales.xlsx.bak",
  );
});
test("same basename keeps distinct paths through draft restoration", () => {
  const map = new Map<string, string>();
  const labels = toDisplayMentionTokens(["@one/sales.xlsx", "@two/sales.xlsx"], map);
  expect(new Set(labels).size).toBe(2);
  const saved = applyDisplayReplacements(labels.join(" "), map);
  const restored = restoreMentionDraft(saved);
  expect(restored.tokens.size).toBe(2);
  expect(applyDisplayReplacements(restored.text, restored.map)).toBe(saved);
});

test("root and nested files with same basename stay distinct across separate selections", () => {
 const map = new Map<string, string>();
 const first = toDisplayMentionTokens(["@sales.xlsx"], map)[0]!;
 const second = toDisplayMentionTokens(["@nested/sales.xlsx"], map)[0]!;
 expect(first).not.toBe(second);
 expect(applyDisplayReplacements(`${first} ${second}`, map)).toBe("@sales.xlsx @nested/sales.xlsx");
});
