import { expect, test } from "vitest";
import { rankQuickOpenItems } from "../src/lib/quick-open-search";

test("late best matches displace early candidates while ties retain input order", () => {
  const list = Array.from({ length: 5000 }, (_, item) => ({ item, text: "folder/report.xlsx" }));
  list.push({ item: 5000, text: "report.xlsx" });
  expect(rankQuickOpenItems(list, "report", 12)).toEqual([
    5000,
    ...Array.from({ length: 11 }, (_, i) => i),
  ]);
  expect(rankQuickOpenItems(list, "not-in-any-path", 12)).toEqual([]);
});

test("prefix, substring and subsequence ranking preserve the existing scoring and category limits", () => {
  const texts = ["alpha report", "report", "folder/report", "r-e-p-o-r-t", "unrelated", "report"];
  const list = texts.map((text, item) => ({ item, text }));
  expect(rankQuickOpenItems(list, "report", 6)).toEqual([1, 5, 0, 2, 3]);
  expect(rankQuickOpenItems(list, "report", 2)).toEqual([1, 5]);
  expect(rankQuickOpenItems(list, "", 3)).toEqual([0, 1, 2]);
  expect(rankQuickOpenItems(list, "report", 0)).toEqual([]);
  expect(list.map(({ text }) => text)).toEqual(texts);
});
