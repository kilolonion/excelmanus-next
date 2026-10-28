import { expect, test } from "vitest";
import { createThinkingLineReader, parseThinkingLines } from "../src/lib/thinking";

test("thinking append parsing matches full parsing across bold markers and newlines", () => {
  const read = createThinkingLineReader();
  const content = "**A****B**\ntext **bold**\n\n***tail****more***** end\n";
  for (let i = 0; i <= content.length; i++)
    expect(read(content.slice(0, i))).toEqual(parseThinkingLines(content.slice(0, i)));
});
test("thinking appends retain completed raw lines and reset on replacement or truncation", () => {
  const read = createThinkingLineReader();
  const first = read("**done**\nlast");
  const next = read("**done**\nlast **bold");
  expect(next[0]).toBe(first[0]);
  expect(next).toEqual(parseThinkingLines("**done**\nlast **bold"));
  for (const content of [
    "short",
    "",
    "**other****heading**\nnew",
    "**other****heading**\nnew\nnext",
    "**other****heading**\n",
  ])
    expect(read(content)).toEqual(parseThinkingLines(content));
});

test("cached thinking segments preserve escapes and UTF-16 fragments", () => {
  const read = createThinkingLineReader();
  const content = '**\\"quoted"**\n\ud800\nemoji \ud83d\ude00\nlast';
  for (let i = 0; i <= content.length; i++)
    expect(read(content.slice(0, i))).toEqual(parseThinkingLines(content.slice(0, i)));
});
