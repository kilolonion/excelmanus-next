import { MAX_C, MAX_R, type RangeRef, rangeRefToA1, type StructuralOp } from "@excelmanus/core";
import type { ICellData, IWorkbookData, IWorksheetData } from "@univerjs/core";

export interface WorkbookChanges {
  cellsBySheet: Record<string, number>;
  ranges: string[];
  structural: string[];
  added: string[];
}

const STRUCTURAL_LABELS: Record<StructuralOp["kind"], string> = {
  insertRows: "插入行",
  deleteRows: "删除行",
  insertCols: "插入列",
  deleteCols: "删除列",
  insertSheet: "新增工作表",
  removeSheet: "删除工作表",
  renameSheet: "重命名工作表",
  moveRange: "移动区域",
};

/** 冲突用的整行/整列/整表哨兵不能当成实际修改格；边界上的单格仍须计数。 */
export function boundedWriteRanges(ranges: RangeRef[]): RangeRef[] {
  return ranges.filter(
    (r) => r.sheetId !== "*" && !(r.r0 === 0 && r.r1 === MAX_R) && !(r.c0 === 0 && r.c1 === MAX_C),
  );
}

/** 按列边界切条，条内合并行区间，重复或重叠写入只计一次。 */
export function unionArea(rects: RangeRef[]): number {
  const xs = [...new Set(rects.flatMap((r) => [r.c0, r.c1 + 1]))].sort((a, b) => a - b);
  let total = 0;
  for (let i = 0; i + 1 < xs.length; i++) {
    const x0 = xs[i] as number;
    const x1 = xs[i + 1] as number;
    const spans = rects
      .filter((r) => r.c0 <= x0 && r.c1 + 1 >= x1)
      .map((r) => [r.r0, r.r1 + 1] as const)
      .sort((a, b) => a[0] - b[0]);
    let covered = 0;
    let end = -1;
    for (const [s, e] of spans) {
      if (e <= end) continue;
      covered += e - Math.max(s, end);
      end = e;
    }
    total += covered * (x1 - x0);
  }
  return total;
}

export function sheetNamesOf(...snapshots: IWorkbookData[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const snapshot of snapshots)
    for (const [id, sheet] of Object.entries(snapshot.sheets ?? {}))
      names.set(id, sheet.name ?? id);
  return names;
}

export function summarizeWriteSet(
  writeSet: { ranges: RangeRef[]; structural: StructuralOp[] },
  names: Map<string, string>,
): WorkbookChanges {
  const nameOf = (id: string) => names.get(id) ?? id;
  const rectsBySheet = new Map<string, RangeRef[]>();
  const ranges = new Set<string>();
  for (const r of boundedWriteRanges(writeSet.ranges)) {
    const name = nameOf(r.sheetId);
    rectsBySheet.set(name, [...(rectsBySheet.get(name) ?? []), r]);
    ranges.add(rangeRefToA1(r, name));
  }
  return {
    cellsBySheet: Object.fromEntries(
      [...rectsBySheet].map(([name, rects]) => [name, unionArea(rects)]),
    ),
    ranges: [...ranges],
    structural: writeSet.structural.map((s) => {
      const where =
        s.count > 0 ? `${nameOf(s.sheetId)} 第 ${s.index + 1} 起 ${s.count} 个` : nameOf(s.sheetId);
      return `${STRUCTURAL_LABELS[s.kind]}（${where}）`;
    }),
    added: writeSet.structural
      .filter((s) => s.kind === "insertSheet")
      .map((s) => `工作表 ${nameOf(s.sheetId)}`),
  };
}

/** 总览和创建回执读取当前快照，计数不使用导入时的缓存。 */
export function workbookSheets(snapshot: Pick<IWorkbookData, "sheets" | "sheetOrder">) {
  return snapshot.sheetOrder.map((id) => {
    const s = snapshot.sheets[id] as IWorksheetData | undefined;
    let cells = 0;
    let formulas = 0;
    for (const row of Object.values(
      (s?.cellData ?? {}) as Record<number, Record<number, ICellData>>,
    ))
      for (const cell of Object.values(row ?? {})) {
        if (cell?.f) formulas++;
        if (cell?.f || (cell?.v !== undefined && cell.v !== null && cell.v !== "")) cells++;
      }
    return {
      id,
      name: s?.name ?? id,
      rows: s?.rowCount ?? 0,
      cols: s?.columnCount ?? 0,
      cells,
      formulas,
      hidden: !!s?.hidden,
    };
  });
}
