import type { FWorkbook } from "@univerjs/sheets/facade";
import { expect, test } from "vitest";
import { captureView, isFreshView, restoreView } from "../src/lib/workbook/view-state.ts";

test("returning to a workbook restores zoom and view even after a long conversation", () => {
  let restoredZoom = 0;
  const sheet = {
    getSheetId: () => "sheet-1",
    getSelection: () => null,
    getScrollState: () => ({ sheetViewStartRow: 12, sheetViewStartColumn: 4 }),
    getZoom: () => 1.5,
    getMaxRows: () => 100,
    getMaxColumns: () => 26,
    zoom: (value: number) => {
      restoredZoom = value;
    },
    scrollToCell: () => {},
  };
  const wb = {
    getActiveSheet: () => sheet,
    getSheetBySheetId: () => sheet,
    setActiveSheet: () => {},
  } as unknown as FWorkbook;
  const view = captureView("doc-1", wb)!;
  view.at = Date.now() - 60_000;
  expect(isFreshView(view, "doc-1")).toBe(true);
  expect(isFreshView(view, "other-doc")).toBe(false);
  restoreView(wb, view);
  expect(restoredZoom).toBe(1.5);
});

test("restoring a view clamps selections after rows or columns were removed", () => {
  let activated: number[] = [];
  let scroll: number[] = [];
  const sheet = {
    zoom: () => {},
    getMaxRows: () => 10,
    getMaxColumns: () => 4,
    getRange: (...range: number[]) => {
      activated = range;
      return { activate: () => {} };
    },
    scrollToCell: (...cell: number[]) => {
      scroll = cell;
    },
  };
  const wb = { getSheetBySheetId: () => sheet, setActiveSheet: () => {} } as unknown as FWorkbook;
  restoreView(wb, {
    docId: "doc",
    sheetId: "sheet",
    at: Date.now(),
    zoom: 1,
    selection: { row: 30, col: 20, rows: 5, cols: 6 },
    scroll: { row: 30, col: 20 },
  });
  expect(activated).toEqual([9, 3, 1, 1]);
  expect(scroll).toEqual([9, 3]);
});

test("view capture skips a workbook whose render services were already disposed", () => {
  const wb = {
    getActiveSheet: () => ({
      getSelection: () => null,
      getScrollState: () => {
        throw new Error("[redi]: Cannot find render service");
      },
    }),
  } as unknown as FWorkbook;
  expect(captureView("disposed-doc", wb)).toBeNull();
});
