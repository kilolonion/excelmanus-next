import { expect, test, vi } from "vitest";
import { EditTracker, resolveDraftInput } from "../src/lib/workbook/edit-session";

const draft = { sheetId: "s", row: 1, col: 1, text: "9", theirs: { v: 7 } };
test("resolving a draft cancels the stale editor before writing the retained input", async () => {
  const calls: unknown[] = [];
  const wb = {
    endEditingAsync: async (save?: boolean) => {
      calls.push(["end", save]);
      return true;
    },
    getSheetBySheetId: () => ({
      getRange: () => ({
        setValue: (value: string) => {
          calls.push(["write", value]);
        },
      }),
    }),
  };
  await resolveDraftInput(wb, draft, "mine");
  expect(calls).toEqual([
    ["end", false],
    ["write", "9"],
  ]);
  calls.length = 0;
  await resolveDraftInput(wb, draft, "theirs");
  expect(calls).toEqual([["end", false]]);
});

test("failure to close an editor does not write or silently discard a draft", async () => {
  const getSheetBySheetId = vi.fn();
  await expect(
    resolveDraftInput({ endEditingAsync: async () => false, getSheetBySheetId }, draft, "mine"),
  ).rejects.toThrow();
  expect(getSheetBySheetId).not.toHaveBeenCalled();
});

test("cancelled editing does not lend its stale revision to a new explicit write", () => {
  const tracker = new EditTracker();
  tracker.start("s", 1, 1, 3);
  tracker.typed("9");
  tracker.end(false);
  expect(
    tracker.baseRevFor({
      id: "sheet.mutation.set-range-values",
      params: { subUnitId: "s", cellValue: { 1: { 1: { v: 9 } } } },
    }),
  ).toBeUndefined();
  tracker.start("s", 1, 1, 4);
  tracker.end(true);
  expect(
    tracker.baseRevFor({
      id: "sheet.mutation.set-range-values",
      params: { subUnitId: "s", cellValue: { 1: { 1: { v: 9 } } } },
    }),
  ).toBe(4);
});
