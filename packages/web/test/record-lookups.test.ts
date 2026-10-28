import type { SessionSummary } from "@excelmanus/protocol";
import { expect, test } from "vitest";
import { createFileTimeFormatter, formatTime } from "../src/components/sidebar/file-tree-helpers";
import { findSessionSummary } from "../src/lib/session-list-index";

test("source-session indexes preserve first match and refresh after rename or removal", () => {
  const first = { id: "id", title: "First" } as SessionSummary;
  const sessions = [first, { id: "id", title: "Duplicate" } as SessionSummary];
  expect(findSessionSummary(sessions, "id")).toBe(first);
  const renamed = { ...first, title: "Renamed" };
  expect(findSessionSummary([renamed], "id")).toBe(renamed);
  expect(findSessionSummary([], "id")).toBeUndefined();
  expect(findSessionSummary(sessions, "missing")).toBeUndefined();
});
test("records without a source session do not build an unused lookup", () => {
  let reads = 0;
  const sessions = [
    {
      get id() {
        reads++;
        return "id";
      },
    } as SessionSummary,
  ];
  expect(findSessionSummary(sessions, null)).toBeUndefined();
  expect(findSessionSummary(sessions, undefined)).toBeUndefined();
  expect(reads).toBe(0);
  findSessionSummary(sessions, "id");
  findSessionSummary(sessions, "missing");
  expect(reads).toBe(1);
});
test("shared file-time formatting keeps valid dates and missing or invalid fallbacks", () => {
  const format = createFileTimeFormatter();
  for (const value of [undefined, "", "bad date", "2026-10-18T00:01:00Z", "2025-12-31T23:59:00Z"])
    expect(format(value)).toBe(formatTime(value));
});
