import { parseRange } from "@excelmanus/core";
import { WorkbookObjects } from "@excelmanus/protocol";
import type { IWorksheetData } from "@univerjs/core";
import { type PrintRange, printRange } from "./print";

export const rowSize = (sheet: Partial<IWorksheetData>, r: number) =>
  sheet.rowData?.[r]?.hd ? 0 : (sheet.rowData?.[r]?.h ?? sheet.defaultRowHeight ?? 24);
export const colSize = (sheet: Partial<IWorksheetData>, c: number) =>
  sheet.columnData?.[c]?.hd ? 0 : (sheet.columnData?.[c]?.w ?? sheet.defaultColumnWidth ?? 88);
function offset(end: number, size: (i: number) => number) {
  let total = 0;
  for (let i = 0; i < end; i++) total += size(i);
  return total;
}
function endIndex(start: number, length: number, size: (i: number) => number, limit: number) {
  let i = start;
  while (i < limit - 1 && length > size(i)) {
    length -= size(i);
    i++;
  }
  return i;
}
/** Work from workbook coordinates, independent of viewport scroll and zoom. */
export function printObjectLayout(sheet: Partial<IWorksheetData>, selection?: PrintRange) {
  const parsed = WorkbookObjects.safeParse(sheet.custom?.excelmanusObjects);
  const all = parsed.success
    ? [...parsed.data.charts, ...parsed.data.images, ...(parsed.data.shapes ?? [])]
    : [];
  let range = printRange(sheet, selection);
  const row = (r: number) => rowSize(sheet, r),
    col = (c: number) => colSize(sheet, c);
  if (!selection)
    for (const o of all) {
      const a = parseRange(o.anchor);
      range.endRow = Math.max(
        range.endRow,
        endIndex(a.startRow - 1, o.height + ("offsetY" in o ? (o.offsetY ?? 0) : 0), row, 1048576),
      );
      range.endColumn = Math.max(
        range.endColumn,
        endIndex(a.startCol - 1, o.width + ("offsetX" in o ? (o.offsetX ?? 0) : 0), col, 16384),
      );
    }
  // Keep the same cell-budget check after including the drawings.
  range = printRange(sheet, range);
  const x = offset(range.startColumn, col),
    y = offset(range.startRow, row);
  const width = offset(range.endColumn + 1, col) - x,
    height = offset(range.endRow + 1, row) - y;
  const objects = all.flatMap((object) => {
    const a = parseRange(object.anchor);
    const left =
        offset(a.startCol - 1, col) + ("offsetX" in object ? (object.offsetX ?? 0) : 0) - x,
      top = offset(a.startRow - 1, row) + ("offsetY" in object ? (object.offsetY ?? 0) : 0) - y;
    if (left >= width || top >= height || left + object.width <= 0 || top + object.height <= 0)
      return [];
    // A selected-area export must not embed values from outside the selected cells.
    if (selection && "range" in object) {
      const data = parseRange(object.range);
      if (
        data.startRow - 1 < range.startRow ||
        data.endRow - 1 > range.endRow ||
        data.startCol - 1 < range.startColumn ||
        data.endCol - 1 > range.endColumn
      )
        return [];
    }
    return [{ object, left, top }];
  });
  return { range, objects };
}
