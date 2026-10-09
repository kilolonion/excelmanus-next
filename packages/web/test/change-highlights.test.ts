import { parseRange } from "@excelmanus/core";
import { expect, test } from "vitest";
import {
  changeDeadline,
  changeHighlightFrame,
  changeHighlights,
} from "../src/change-highlights.ts";
import type { ChangeEntry } from "../src/reduce.ts";

const change = (seq: number, ranges: string[]): ChangeEntry => ({
  toolCallId: `call-${seq}`,
  docId: "doc",
  path: "sales.xlsx",
  rev: seq,
  seq,
  ranges,
  cells: 1,
  structural: [],
  at: "2026-10-01T00:00:00.000Z",
});

test("重复写入同一区域只留下最新修订，工作表互不串色", () => {
  const marks = changeHighlights(
    [change(1, ["销售!D2:D4"]), change(2, ["销售!D2:D4", "销售!D2:D4", "其他!D2:D4"])],
    "销售",
  );
  expect(marks.map((m) => [parseRange(m.range), m.entry.rev])).toEqual([
    [parseRange("销售!D2:D4"), 2],
  ]);
});

test("部分重叠只覆盖一次，L 形空洞仍未修改，旧区域的剩余单元格保留归属", () => {
  const marks = changeHighlights([change(1, ["销售!D2:D4"]), change(2, ["销售!D3:E5"])], "销售");
  const cells = new Map<string, number>();
  for (const mark of marks) {
    const p = parseRange(mark.range);
    for (let r = p.startRow; r <= p.endRow; r++) {
      for (let c = p.startCol; c <= p.endCol; c++) {
        const key = `${r}:${c}`;
        expect(cells.has(key), `${key} stacked`).toBe(false);
        cells.set(key, mark.entry.seq);
      }
    }
  }
  expect(cells.size).toBe(7);
  expect(cells.get("2:4")).toBe(1);
  expect(cells.get("3:4")).toBe(2);
  expect(cells.has("2:5")).toBe(false);
});

test("提交时间限定寿命，减少动效无填充，到期全部归零", () => {
  expect(changeDeadline(change(1, []))).toBe(Date.parse("2026-10-01T00:00:06.000Z"));
  expect(changeDeadline({ ...change(1, []), at: undefined })).toBeNaN();
  expect(changeHighlightFrame(800, false).fill).toBe(0);
  expect(changeHighlightFrame(5700, false).stroke).toBeLessThan(0.7);
  expect(changeHighlightFrame(0, true).fill).toBe(0);
  expect(changeHighlightFrame(6000, true).stroke).toBe(0);
  expect(changeHighlightFrame(6000, false).stroke).toBe(0);
});
