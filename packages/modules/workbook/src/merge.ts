import { newId, parseRange } from "@excelmanus/core";
import { FileOperationError } from "@excelmanus/kernel";
import type { MergeDocsBody } from "@excelmanus/protocol";
import {
  type ICellData,
  type IWorkbookData,
  mergeWorksheetSnapshotWithDefault,
} from "@univerjs/core";
import type { DocMutation } from "./engine.ts";

/** 只合并明确选中的值/公式；沿用目标样式，不搬移源工作簿资源。 */
export function mergeMutations(
  source: IWorkbookData,
  target: IWorkbookData,
  cells: MergeDocsBody["cells"],
): DocMutation[] {
  const out: DocMutation[] = [];
  const groups = new Map<string, Set<string>>();
  for (const item of cells) {
    const group = groups.get(item.sheet) ?? new Set<string>();
    group.add(item.cell);
    groups.set(item.sheet, group);
  }
  let added = 0;
  for (const [name, addresses] of groups) {
    const src = Object.values(source.sheets).find((s) => s.name === name);
    let dst = Object.values(target.sheets).find((s) => s.name === name);
    if (!src && !dst) throw new FileOperationError("INVALID_ARGUMENT", `工作表不存在：${name}`);
    const fresh = !dst;
    if (!dst)
      dst = mergeWorksheetSnapshotWithDefault({
        id: newId("sheet"),
        name,
        rowCount: 1000,
        columnCount: 26,
        cellData: {},
      });
    const cellValue: Record<number, Record<number, ICellData>> = {};
    let rows = dst.rowCount ?? 1000,
      cols = dst.columnCount ?? 26;
    for (const address of addresses) {
      const range = parseRange(address),
        r = range.startRow - 1,
        c = range.startCol - 1;
      const cell = src?.cellData?.[r]?.[c];
      if (cell?.si && !cell.f)
        throw new FileOperationError("UNSUPPORTED_FEATURE", "共享公式须先转成独立公式后合并");
      if (cell?.p)
        throw new FileOperationError("UNSUPPORTED_FEATURE", "富文本单元格暂不支持值合并");
      const row = cellValue[r] ?? {};
      cellValue[r] = row;
      row[c] = {
        v: cell?.f ? null : (cell?.v ?? null),
        f: cell?.f ?? null,
        t: cell?.t ?? null,
        p: null,
        si: null,
      };
      rows = Math.max(rows, r + 1);
      cols = Math.max(cols, c + 1);
    }
    if (fresh)
      out.push({
        id: "sheet.mutation.insert-sheet",
        params: {
          unitId: target.id,
          index: target.sheetOrder.length + added++,
          sheet: { ...dst, rowCount: rows, columnCount: cols },
        },
      });
    else {
      if (rows > (dst.rowCount ?? 1000))
        out.push({
          id: "sheet.mutation.set-worksheet-row-count",
          params: { unitId: target.id, subUnitId: dst.id, rowCount: rows },
        });
      if (cols > (dst.columnCount ?? 26))
        out.push({
          id: "sheet.mutation.set-worksheet-column-count",
          params: { unitId: target.id, subUnitId: dst.id, columnCount: cols },
        });
    }
    out.push({
      id: "sheet.mutation.set-range-values",
      params: {
        unitId: target.id,
        subUnitId: dst.id,
        trigger: "excelmanus.compare-merge",
        cellValue,
      },
    });
  }
  return out;
}
