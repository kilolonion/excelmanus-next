import { expect, test, vi } from "vitest";
import { editDiff, writeDiff } from "../src/lib/text-diff";

test("write diffs count lines without eagerly splitting or decorating the whole file", () => {
  const split = vi.spyOn(String.prototype, "split");
  try {
    const diff = writeDiff({ path: "qa.txt", content: "row\n".repeat(10000) })!;
    expect(split).not.toHaveBeenCalled();
    expect(diff.additions).toBe(10001);
    expect(Array.isArray(diff.hunks)).toBe(false);
    const iterator = diff.hunks[Symbol.iterator]();
    expect(iterator.next().value).toBe("@@ -0,0 +1,10001 @@");
    expect(iterator.next().value).toBe("+row");
  } finally {
    split.mockRestore();
  }
});
test("edit diffs stream replacements in original order and remain repeatable", () => {
  const split = vi.spyOn(String.prototype, "split");
  let diff: NonNullable<ReturnType<typeof editDiff>>;
  try {
    diff = editDiff({
      path: "qa.txt",
      edits: [
        { oldText: "a\nb\n", newText: "x", all: true },
        { oldText: "", newText: "y\nz" },
      ],
    })!;
    expect(split).not.toHaveBeenCalled();
  } finally {
    split.mockRestore();
  }
  expect(diff.additions).toBe(3);
  expect(diff.deletions).toBe(4);
  const expected = [
    "@@ 第 1 处替换（全部匹配） @@",
    "-a",
    "-b",
    "-",
    "+x",
    "@@ 第 2 处替换 @@",
    "-",
    "+y",
    "+z",
  ];
  expect([...diff.hunks]).toEqual(expected);
  expect([...diff.hunks]).toEqual(expected);
  expect([...writeDiff({ path: "empty.txt", content: "" })!.hunks]).toEqual([
    "@@ -0,0 +1,1 @@",
    "+",
  ]);
});
