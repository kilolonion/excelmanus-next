import { expect, test } from "vitest";
import { isWorkbookFormatShortcut } from "../src/lib/workbook/shortcuts.ts";

const key = (value: string, extra = {}) => ({
  key: value,
  ctrlKey: true,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...extra,
});
test("recognizes sheet formatting shortcuts on Windows and Mac", () => {
  for (const value of ["b", "i", "u"]) {
    expect(isWorkbookFormatShortcut(key(value))).toBe(true);
    expect(
      isWorkbookFormatShortcut(key(value.toUpperCase(), { ctrlKey: false, metaKey: true })),
    ).toBe(true);
  }
  for (const value of ["X", ">", "<", ".", ","])
    expect(isWorkbookFormatShortcut(key(value, { shiftKey: true }))).toBe(true);
});
test("does not block typing, clipboard, undo, find or app commands", () => {
  for (const value of ["c", "v", "x", "z", "y", "f", "n", ".", ","])
    expect(isWorkbookFormatShortcut(key(value))).toBe(false);
  expect(isWorkbookFormatShortcut(key("b", { ctrlKey: false }))).toBe(false);
  expect(isWorkbookFormatShortcut(key("b", { altKey: true }))).toBe(false);
});
