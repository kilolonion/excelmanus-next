import { extname } from "node:path";
import { indexToCol } from "@excelmanus/core";
import type { BackupPreviewResponse } from "@excelmanus/protocol";
import { buildLayout, importCsv, importXlsx } from "@excelmanus/workbook";

// Inspect the archived bytes directly: never open an actor or restore a workspace file.
export function previewBackup(
  name: string,
  bytes: Uint8Array,
  options: { sheetId?: string; row?: number; column?: number },
): BackupPreviewResponse {
  const ext = extname(name).toLowerCase();
  if ([".xlsx", ".xlsm", ".csv", ".tsv"].includes(ext)) {
    const { snapshot } =
      ext === ".csv" || ext === ".tsv" ? importCsv(bytes, name) : importXlsx(bytes, name);
    const sheets = snapshot.sheetOrder.map((id) => {
      const sheet = snapshot.sheets[id];
      if (!sheet) throw new Error("备份工作表数据缺失");
      let rows = 1,
        columns = 1;
      for (const [r, cells] of Object.entries(sheet.cellData ?? {})) {
        for (const c of Object.keys(cells ?? {})) {
          rows = Math.max(rows, +r + 1);
          columns = Math.max(columns, +c + 1);
        }
      }
      for (const m of sheet.mergeData ?? []) {
        rows = Math.max(rows, m.endRow + 1);
        columns = Math.max(columns, m.endColumn + 1);
      }
      return { id, name: sheet.name ?? id, rows, columns };
    });
    const meta = options.sheetId ? sheets.find((s) => s.id === options.sheetId) : sheets[0];
    if (!meta) throw new Error("备份中没有该工作表");
    const row = Math.min(Math.max(0, options.row ?? 0), meta.rows - 1);
    const column = Math.min(Math.max(0, options.column ?? 0), meta.columns - 1);
    const range = `${indexToCol(column + 1)}${row + 1}:${indexToCol(Math.min(column + 30, meta.columns))}${Math.min(row + 80, meta.rows)}`;
    const original = snapshot.sheets[meta.id] as Parameters<typeof buildLayout>[1];
    const preview = {
      ...original,
      cellData: { ...original.cellData },
      mergeData: [] as typeof original.mergeData,
    };
    // Clip only the preview projection. A page starting inside a merge still shows
    // the original anchor; the archived workbook itself is never changed.
    for (const m of original.mergeData ?? []) {
      let startRow = Math.max(row, m.startRow),
        startColumn = Math.max(column, m.startColumn);
      const endRow = Math.min(row + 79, meta.rows - 1, m.endRow);
      const endColumn = Math.min(column + 29, meta.columns - 1, m.endColumn);
      while (startRow <= endRow && original.rowData?.[startRow]?.hd) startRow++;
      while (startColumn <= endColumn && original.columnData?.[startColumn]?.hd) startColumn++;
      if (startRow > endRow || startColumn > endColumn) continue;
      preview.mergeData.push({ startRow, endRow, startColumn, endColumn });
      if (startRow !== m.startRow || startColumn !== m.startColumn) {
        preview.cellData[startRow] = {
          ...preview.cellData[startRow],
          [startColumn]: original.cellData?.[m.startRow]?.[m.startColumn] ?? {},
        };
      }
    }
    const rendered = buildLayout(snapshot, preview, range);
    return {
      kind: "spreadsheet",
      sheets,
      sheetId: meta.id,
      row,
      column,
      range: rendered.range,
      layout: rendered.layout,
      limitations: [...rendered.limitations, "公式显示备份中的缓存值，不重新计算"],
    };
  }
  const mime: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
  };
  if (mime[ext]) return { kind: "image", mime: mime[ext] };
  if ([".xls", ".xlsb", ".pdf", ".zip", ".docx"].includes(ext))
    return { kind: "unsupported", reason: "该格式暂不支持内联预览，请下载备份查看。" };
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\u0000")) throw new Error("binary");
    return { kind: "text", text: text.slice(0, 100_000), truncated: text.length > 100_000 };
  } catch {
    return { kind: "unsupported", reason: "无法作为 UTF-8 文本预览，请下载备份查看。" };
  }
}
