import { expect, test, vi } from "vitest";
import { AXIS_ACTIONS, editSelectionAxis } from "../src/lib/workbook/axis-actions";

test("axis actions use the selected span and the correct before/after index", () => {
  const sheet = {
    getSelection: () => ({
      getActiveRangeList: () => [
        { getRange: () => ({ startRow: 1, endRow: 3, startColumn: 2, endColumn: 3 }) },
      ],
    }),
    getMaxRows: () => 10,
    getMaxColumns: () => 8,
    insertRowsBefore: vi.fn(),
    insertRowsAfter: vi.fn(),
    deleteRows: vi.fn(),
    insertColumnsBefore: vi.fn(),
    insertColumnsAfter: vi.fn(),
    deleteColumns: vi.fn(),
  };
  for (const action of AXIS_ACTIONS) editSelectionAxis(sheet, action.id);
  expect(sheet.insertRowsBefore).toHaveBeenCalledWith(1, 3);
  expect(sheet.insertRowsAfter).toHaveBeenCalledWith(3, 3);
  expect(sheet.deleteRows).toHaveBeenCalledWith(1, 3);
  expect(sheet.insertColumnsBefore).toHaveBeenCalledWith(2, 2);
  expect(sheet.insertColumnsAfter).toHaveBeenCalledWith(3, 2);
  expect(sheet.deleteColumns).toHaveBeenCalledWith(2, 2);
});
