export const AXIS_ACTIONS = [
  { id: "rows.before", label: "在选区上方插入行" },
  { id: "rows.after", label: "在选区下方插入行" },
  { id: "rows.delete", label: "删除选区所在行" },
  { id: "cols.before", label: "在选区左侧插入列" },
  { id: "cols.after", label: "在选区右侧插入列" },
  { id: "cols.delete", label: "删除选区所在列" },
] as const;
export type AxisAction = (typeof AXIS_ACTIONS)[number]["id"];
interface AxisSheet {
  getSelection():
    | {
        getActiveRangeList(): {
          getRange(): { startRow: number; endRow: number; startColumn: number; endColumn: number };
        }[];
      }
    | null
    | undefined;
  getMaxRows(): number;
  getMaxColumns(): number;
  insertRowsBefore(at: number, count: number): unknown;
  insertRowsAfter(at: number, count: number): unknown;
  deleteRows(at: number, count: number): unknown;
  insertColumnsBefore(at: number, count: number): unknown;
  insertColumnsAfter(at: number, count: number): unknown;
  deleteColumns(at: number, count: number): unknown;
}
/** Use Univer commands so structural changes retain the existing mutation/undo path. */
export function editSelectionAxis(sheet: AxisSheet, action: AxisAction): void {
  const ranges = sheet.getSelection()?.getActiveRangeList() ?? [];
  if (ranges.length !== 1) throw new Error("请先选择一个连续区域");
  const range = ranges[0]!.getRange();
  const rows = action.startsWith("rows.");
  const start = rows ? range.startRow : range.startColumn;
  const end = rows ? range.endRow : range.endColumn;
  const count = end - start + 1;
  const max = rows ? sheet.getMaxRows() : sheet.getMaxColumns();
  if (action.endsWith("delete") && count >= max) throw new Error("工作表至少需要保留一行和一列");
  switch (action) {
    case "rows.before":
      sheet.insertRowsBefore(start, count);
      break;
    case "rows.after":
      sheet.insertRowsAfter(end, count);
      break;
    case "rows.delete":
      sheet.deleteRows(start, count);
      break;
    case "cols.before":
      sheet.insertColumnsBefore(start, count);
      break;
    case "cols.after":
      sheet.insertColumnsAfter(end, count);
      break;
    case "cols.delete":
      sheet.deleteColumns(start, count);
      break;
  }
}
