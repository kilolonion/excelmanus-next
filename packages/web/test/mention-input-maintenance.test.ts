import { expect, test, vi } from "vitest";
import { reconcileMentionTokens } from "../src/components/chat/chat-input-insert";

test("one input change does not scan the entire text separately for every confirmed label", () => {
  const labels = Array.from({ length: 100 }, (_, i) => `@sales${i}.xlsx`);
  const previous = new Set(labels),
    map = new Map(labels.map((t) => [t, `@dir/${t.slice(1)}`]));
  const text = labels.join(" ");
  const get = vi.spyOn(Map.prototype, "get");
  let count = 0;
  let next = previous;
  try {
    next = reconcileMentionTokens(text, previous, map);
    count = get.mock.calls.length;
  } finally {
    get.mockRestore();
  }
  expect(next).toBe(previous);
  expect(map.size).toBe(100);
  expect(count).toBeLessThan(10000);
});
test("independent overlapping labels remain confirmed, including a shorter valid prefix", () => {
  const labels = new Set(["@report.xlsx", "@report.xlsx · Sheet!A1", "@other.csv"]);
  const map = new Map([...labels].map((t) => [t, `original:${t}`]));
  const next = reconcileMentionTokens("@report.xlsx · Sheet!A1", labels, map);
  expect([...next]).toEqual(["@report.xlsx", "@report.xlsx · Sheet!A1"]);
  expect(map.has("@other.csv")).toBe(false);
  expect(map.get("@report.xlsx")).toBe("original:@report.xlsx");
  expect(labels.size).toBe(3);
});
test("invalid filename suffixes drop labels, while repeated remaining occurrences retain paths", () => {
  const labels = new Set(["@a.xlsx", "@b.xlsx"]);
  const map = new Map([
    ["@a.xlsx", "@one/a.xlsx"],
    ["@b.xlsx", "@two/b.xlsx"],
  ]);
  expect([...reconcileMentionTokens("@a.xlsx.bak @b.xlsx，@b.xlsx", labels, map)]).toEqual([
    "@b.xlsx",
  ]);
  expect(map.has("@a.xlsx")).toBe(false);
  expect(map.get("@b.xlsx")).toBe("@two/b.xlsx");
});
test("no confirmed labels keeps identity and leaves unrelated mappings untouched", () => {
  const empty = new Set<string>(),
    map = new Map([["other", "value"]]);
  expect(reconcileMentionTokens("plain text", empty, map)).toBe(empty);
  expect([...map]).toEqual([["other", "value"]]);
});
