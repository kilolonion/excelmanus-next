import { expect, test } from "vitest";
import { extractMentions } from "../src/components/chat/mention-tokens";

test("all five quote forms preserve names with spaces and their offsets", () => {
  for (const [open, close] of [
    ['"', '"'],
    ["'", "'"],
    ["`", "`"],
    ["“", "”"],
    ["「", "」"],
  ]) {
    const text = `查看 ${open}目录/最终 结果.xlsx${close} 完成`;
    const tokens = extractMentions(text);
    expect(tokens.map((t) => t.value)).toEqual(["目录/最终 结果.xlsx"]);
    expect(text.slice(tokens[0].start, tokens[0].end)).toBe(tokens[0].raw);
  }
});
test("a long unclosed suffix after an earlier valid pair does not hide the next line", () => {
  const text = "“closed.txt” " + "“未闭合".repeat(20000) + '\n"next report.xlsx"';
  expect(extractMentions(text).map((t) => t.value)).toEqual(["closed.txt", "next report.xlsx"]);
});
test("unclosed corner quotes leave subsequent explicit and bare files available", () => {
  const text = "「未闭合".repeat(10000) + "\n@dir/a.csv plain.xlsx";
  expect(extractMentions(text).map((t) => [t.kind, t.value])).toEqual([
    ["file", "dir/a.csv"],
    ["path", "plain.xlsx"],
  ]);
});
test("empty adjacent pairs do not consume a following valid quoted file", () => {
  expect(extractMentions('""a.csv"').map((t) => t.value)).toEqual(["a.csv"]);
  expect(extractMentions("“” “next file.xlsx”").map((t) => t.value)).toEqual(["next file.xlsx"]);
});
test("newline boundaries and nested invalid prose preserve bare-path fallback", () => {
  expect(extractMentions('“broken\nname.xlsx” "ok file.csv"').map((t) => t.value)).toEqual([
    "ok file.csv",
  ]);
  expect(
    extractMentions("\"not a file: 'nested name.xlsx' end\" after.csv").map((t) => t.value),
  ).toEqual(["name.xlsx", "after.csv"]);
});
