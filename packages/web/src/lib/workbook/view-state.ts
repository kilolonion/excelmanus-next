// 表格实例因快照重读而重建时（例如提交被拒绝后撤回本地编辑），保住用户的位置：
// 激活的工作表、选区与滚动位置。

import type { FWorkbook } from "@univerjs/sheets/facade";

export interface ViewState {
  docId: string;
  sheetId: string;
  selection: { row: number; col: number; rows: number; cols: number } | null;
  scroll: { row: number; col: number };
  zoom: number;
  at: number;
}

/** 同一标签页中切换文档仍保留视图位置。 */
const FRESH_MS = 24 * 60 * 60 * 1000;

export function captureView(docId: string, wb: FWorkbook): ViewState | null {
  try {
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
      zoom: sheet.getZoom(),
      at: Date.now(),
    };
  } catch {
    // Unmount may dispose render services before React runs this final view capture.
    // Keep the last saved view and let the remaining editor cleanup complete.
    return null;
  }
}

export function isFreshView(view: ViewState | null, docId: string): view is ViewState {
  return view !== null && view.docId === docId && Date.now() - view.at < FRESH_MS;
}

export function restoreView(wb: FWorkbook, view: ViewState): void {
  const sheet = wb.getSheetBySheetId(view.sheetId);
  if (!sheet) return;
  wb.setActiveSheet(sheet);
  if (Number.isFinite(view.zoom)) sheet.zoom(Math.min(4, Math.max(0.1, view.zoom)));
  const maxRows = sheet.getMaxRows(),
    maxCols = sheet.getMaxColumns();
  const clampRow = (n: number) => Math.max(0, Math.min(maxRows - 1, Math.floor(n)));
  const clampCol = (n: number) => Math.max(0, Math.min(maxCols - 1, Math.floor(n)));
  if (view.selection) {
    const row = clampRow(view.selection.row),
      col = clampCol(view.selection.col);
    const rows = Math.max(1, Math.min(maxRows - row, Math.floor(view.selection.rows)));
    const cols = Math.max(1, Math.min(maxCols - col, Math.floor(view.selection.cols)));
    sheet.getRange(row, col, rows, cols).activate();
  }
  sheet.scrollToCell(clampRow(view.scroll.row), clampCol(view.scroll.col));
}

const views = new Map<string, ViewState>();
export function saveView(view: ViewState | null): void {
  if (!view) return;
  views.set(view.docId, view);
  try {
    sessionStorage.setItem(`excelmanus.view.${view.docId}`, JSON.stringify(view));
  } catch {
    /* storage may be unavailable */
  }
}
export function loadView(docId: string): ViewState | null {
  if (views.has(docId)) return views.get(docId)!;
  try {
    const value = JSON.parse(sessionStorage.getItem(`excelmanus.view.${docId}`) ?? "null");
    if (
      value &&
      value.docId === docId &&
      typeof value.sheetId === "string" &&
      typeof value.at === "number" &&
      Number.isFinite(value.scroll?.row) &&
      Number.isFinite(value.scroll?.col) &&
      (value.selection === null ||
        [
          value.selection?.row,
          value.selection?.col,
          value.selection?.rows,
          value.selection?.cols,
        ].every(Number.isFinite))
    )
      return value;
  } catch {
    /* ignore malformed saved state */
  }
  return null;
}
