import { expect, test } from "vitest";
import { extractMentions } from "../src/components/chat/mention-tokens";

test("bare filenames do not absorb the preceding request", () => {
  const text = "只检查 qa-dot-20261012-receipt-flat-v1.xlsx 的合计";
  const tokens = extractMentions(text);
  expect(tokens.map((t) => t.value)).toEqual(["qa-dot-20261012-receipt-flat-v1.xlsx"]);
  expect(text.slice(tokens[0].start, tokens[0].end)).toBe(tokens[0].value);
  expect(extractMentions("Open reports/sales.csv please").map((t) => t.value)).toEqual(["reports/sales.csv"]);
});

test("quoted paths preserve spaces and Chinese names without consuming surrounding prose", () => {
  for (const [text, path] of [
    ['请打开 "reports/销售 最终版.xlsx" 查看', "reports/销售 最终版.xlsx"],
    ["请打开 `sales report.csv` 查看", "sales report.csv"],
    ["请打开“销售 最终版.xlsx”查看", "销售 最终版.xlsx"],
  ]) expect(extractMentions(text).map((t) => t.value)).toEqual([path]);
  expect(extractMentions("请看 @目录/收款收据.xlsx").map((t) => t.value)).toEqual(["目录/收款收据.xlsx"]);
});
