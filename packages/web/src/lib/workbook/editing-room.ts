import { normalizeDataValidationRule } from "@excelmanus/core";
// 工作台在数据区域右侧与下方留出空白行列，用户可以继续往外输入；服务端按实际写入的单元格
// 写回并在重新导入时扩展表格尺寸。只影响本地视图，不提交任何尺寸修改。

import type { IWorkbookData } from "@univerjs/core";
import type { FWorkbook } from "@univerjs/sheets/facade";

const MIN_ROWS = 100;
const MIN_COLS = 26;
const PAD_ROWS = 50;
const PAD_COLS = 10;

export function withEditingRoom(snapshot: unknown): IWorkbookData {
  const data = structuredClone(snapshot) as IWorkbookData;
  for (const resource of data.resources ?? []) {
    if (resource.name !== "SHEET_DATA_VALIDATION_PLUGIN") continue;
    const rules = JSON.parse(resource.data) as Record<string, Record<string, unknown>[]>;
    for (const key of Object.keys(rules)) rules[key] = rules[key]!.map(normalizeDataValidationRule);
    resource.data = JSON.stringify(rules);
  }
  for (const sheet of Object.values(data.sheets ?? {})) {
    let lastRow = (sheet.rowCount ?? 0) - 1;
    let lastCol = (sheet.columnCount ?? 0) - 1;
    for (const [r, row] of Object.entries(sheet.cellData ?? {})) {
      lastRow = Math.max(lastRow, Number(r));
      for (const c of Object.keys(row ?? {})) lastCol = Math.max(lastCol, Number(c));
    }
    sheet.rowCount = Math.max(MIN_ROWS, lastRow + 1 + PAD_ROWS);
    sheet.columnCount = Math.max(MIN_COLS, lastCol + 1 + PAD_COLS);
  }
  return data;
}

/** 服务端只在写到尺寸之外时下发行列数；本地已留出更多空白时不缩回。 */
export function keepEditingRoom(wb: FWorkbook, id: string, params: unknown): object {
  if (id === "data-validation.mutation.addRule" && params && typeof params === "object") {
    const p = params as { rule?: Record<string, unknown> | Record<string, unknown>[] };
    if (p.rule)
      return {
        ...p,
        rule: Array.isArray(p.rule)
          ? p.rule.map(normalizeDataValidationRule)
          : normalizeDataValidationRule(p.rule),
      };
  }
  const p = (params ?? {}) as { subUnitId?: string; rowCount?: number; columnCount?: number };
  if (
    id !== "sheet.mutation.set-worksheet-row-count" &&
    id !== "sheet.mutation.set-worksheet-column-count"
  )
    return p;
  const sheet = p.subUnitId ? wb.getSheetBySheetId(p.subUnitId) : null;
  if (!sheet) return p;
  if (id === "sheet.mutation.set-worksheet-row-count" && typeof p.rowCount === "number")
    return { ...p, rowCount: Math.max(p.rowCount, sheet.getMaxRows()) };
  if (id === "sheet.mutation.set-worksheet-column-count" && typeof p.columnCount === "number")
    return { ...p, columnCount: Math.max(p.columnCount, sheet.getMaxColumns()) };
  return p;
}
