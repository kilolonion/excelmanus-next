import * as core from "@excelmanus/core";
import { afterEach, expect, test, vi } from "vitest";
import type { ChangeEntry } from "../src/lib/session/types";
import { changeHighlights } from "../src/lib/workbook/change-highlights";

vi.mock("@excelmanus/core", async (original) => {
  const actual = await original<typeof import("@excelmanus/core")>();
  return {
    ...actual,
    subtractRanges: vi.fn(actual.subtractRanges),
    parseRange: vi.fn(actual.parseRange),
  };
});
afterEach(() => vi.clearAllMocks());
const entry = (seq: number, ranges: string[]): ChangeEntry => ({
  seq,
  ranges,
  toolCallId: `t${seq}`,
  docId: "doc",
  path: "book.xlsx",
  rev: seq,
  cells: 1,
  structural: [],
  agentId: "main",
  at: "2026-10-18T20:00:00Z",
});

test("ordered disjoint changes skip subtraction against every preceding range", () => {
  const changes = Array.from({ length: 2000 }, (_, i) => entry(i, [`Sheet1!A${i + 1}`]));
  const marks = changeHighlights(changes, "Sheet1");
  expect(marks).toHaveLength(2000);
  expect(marks[0].entry.seq).toBe(1999);
  expect(vi.mocked(core.subtractRanges).mock.calls.length).toBe(0);
});

test("repeated identical ranges are parsed once and belong to their newest change", () => {
  const changes = Array.from({ length: 2000 }, (_, i) => entry(i, ["Sheet1!A1:B2"]));
  const marks = changeHighlights(changes, "Sheet1");
  expect(marks).toHaveLength(1);
  expect(marks[0].entry.seq).toBe(1999);
  expect(core.parseRange).toHaveBeenCalledTimes(1);
});

test("overlaps, holes, aliases, invalid references and other sheets retain exact ownership", () => {
  const changes = [
    entry(1, ["Sheet1!A1:E5", "Sheet2!A1", "invalid!"]),
    entry(2, ["Sheet1!B2:D4"]),
    entry(3, ["C3", "Sheet1!C3"]),
  ];
  const marks = changeHighlights(changes, "Sheet1");
  const owners = new Map<string, number>();
  for (const mark of marks) {
    const r = core.parseRange(mark.range);
    for (let row = r.startRow; row <= r.endRow; row++)
      for (let col = r.startCol; col <= r.endCol; col++) {
        const key = `${row}:${col}`;
        expect(owners.has(key)).toBe(false);
        owners.set(key, mark.entry.seq);
      }
  }
  expect(owners.size).toBe(25);
  for (let row = 1; row <= 5; row++)
    for (let col = 1; col <= 5; col++)
      expect(owners.get(`${row}:${col}`)).toBe(
        row === 3 && col === 3 ? 3 : row >= 2 && row <= 4 && col >= 2 && col <= 4 ? 2 : 1,
      );
});

test("a revision's rectangles share paint calculations and expiry, while later frames refresh", async () => {
  const { createChangeHighlightFrames } = await import("../src/lib/workbook/change-highlights");
  const timestamp = Date.parse("2026-10-18T20:00:00Z");
  const parse = vi.spyOn(Date, "parse");
  try {
    const frameFor = createChangeHighlightFrames();
    const change = entry(1, ["A1:A2"]);
    const first = frameFor(change, timestamp + 100, false);
    for (let i = 0; i < 2000; i++) expect(frameFor(change, timestamp + 100, false)).toBe(first);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(first.age).toBe(100);
    const later = frameFor(change, timestamp + 300, false);
    expect(later).not.toBe(first);
    expect(later.frame.width).toBeLessThan(first.frame.width);
    expect(frameFor(change, timestamp + 300, true).frame.fill).toBe(0);
    expect(frameFor(change, timestamp + 6000, false).frame.stroke).toBe(0);
    expect(parse).toHaveBeenCalledTimes(1);
    const newer = entry(2, ["A1"]);
    newer.at = new Date(timestamp + 1000).toISOString();
    expect(frameFor(newer, timestamp + 6000, false).frame.stroke).toBeGreaterThan(0);
    expect(parse).toHaveBeenCalledTimes(2);
  } finally {
    parse.mockRestore();
  }
});
