// 表格实例因快照重读而重建时（例如提交被拒绝后撤回本地编辑），保住用户的位置：
// 激活的工作表、选区与滚动位置。

import type { FWorkbook } from "@univerjs/sheets/facade";

export interface ViewState {
  docId: string;
  sheetId: string;
  selection: { row: number; col: number; rows: number; cols: number } | null;
  scroll: { row: number; col: number };
  at: number;
}

/** 重建发生在销毁之后的一瞬间；超过这个时间说明是重新打开文件，不再恢复。 */
const FRESH_MS = 3000;

export function captureView(docId: string, wb: FWorkbook): ViewState | null {
  const sheet = wb.getActiveSheet();
  if (!sheet) return null;
  const range = sheet.getSelection()?.getActiveRange()?.getRange();
  const { sheetViewStartRow, sheetViewStartColumn } = sheet.getScrollState();
  return {
    docId,
    sheetId: sheet.getSheetId(),
    selection: range
      ? {
          row: range.startRow,
          col: range.startColumn,
          rows: range.endRow - range.startRow + 1,
          cols: range.endColumn - range.startColumn + 1,
        }
      : null,
    scroll: { row: sheetViewStartRow, col: sheetViewStartColumn },
    at: Date.now(),
  };
}

export function isFreshView(view: ViewState | null, docId: string): view is ViewState {
  return view !== null && view.docId === docId && Date.now() - view.at < FRESH_MS;
}

export function restoreView(wb: FWorkbook, view: ViewState): void {
  const sheet = wb.getSheetBySheetId(view.sheetId);
  if (!sheet) return;
  wb.setActiveSheet(sheet);
  if (view.selection) {
    const { row, col, rows, cols } = view.selection;
    sheet.getRange(row, col, rows, cols).activate();
  }
  sheet.scrollToCell(view.scroll.row, view.scroll.col);
}
