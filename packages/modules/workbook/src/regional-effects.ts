import { rangeContains, type RangeRef } from "@excelmanus/core";
import { FileOperationError } from "@excelmanus/kernel";
import type { IWorkbookData } from "@univerjs/core";
import { compileOps, type ChangeOp } from "./ops.ts";

const unsupported = (reason = "未知范围") => new FileOperationError("UNSUPPORTED_FEATURE",
  `区域权限目前仅支持普通 XLSX 内不扩行列的 cells.set 字面值和 style.set 有限矩形；${reason} 不能证明局部保存，需单独确认更大权限。`);
const stable = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

/** Host-computed footprint, never a range claimed by a model or saved marker alone. */
export function compileRegionalFootprint(snapshot: IWorkbookData, ops: ChangeOp[]): RangeRef[] {
  if (!ops.length || ops.some((op) => op.op !== "cells.set" && op.op !== "style.set")) throw unsupported("操作不属于窄支持集");
  for (const sheet of Object.values(snapshot.sheets)) {
    if (sheet.mergeData?.length) throw unsupported("存在合并区域");
    if (sheet.custom?.excelmanusObjects) throw unsupported("存在对象资源");
    for (const row of Object.values(sheet.cellData ?? {}))
      for (const cell of Object.values(row ?? {}))
        if (cell && typeof cell === "object" && (("f" in cell && cell.f) || ("si" in cell && cell.si))) throw unsupported("存在公式或共享公式");
  }
  const compiled = compileOps({ unitId: snapshot.id, snapshot: structuredClone(snapshot) }, ops);
  if (compiled.formulas.length || compiled.structural.length || compiled.needsSnapshot ||
      compiled.commands.some((cmd) => !["sheet.command.set-range-values", "sheet.command.set-style"].includes(cmd.id)))
    throw unsupported("编译产生结构、公式或非局部命令");
  if (!compiled.ranges.length) throw unsupported("编译没有有限范围");
  for (const range of compiled.ranges) {
    const sheet = snapshot.sheets[range.sheetId];
    if (!sheet || range.r0 < 0 || range.c0 < 0 || range.r1 < range.r0 || range.c1 < range.c0 ||
        range.r1 >= (sheet.rowCount ?? 1) || range.c1 >= (sheet.columnCount ?? 1) ||
        (range.r1 - range.r0 + 1) * (range.c1 - range.c0 + 1) > 200000)
      throw unsupported("编译范围超出现有行列或大小上限");
  }
  return compiled.ranges;
}
export function assertRegionalFootprint(allowed: readonly RangeRef[], actual: readonly RangeRef[], structural: readonly unknown[] = []): void {
  if (structural.length || actual.some((range) => !allowed.some((outer) => rangeContains(outer, range))))
    throw unsupported("实际发射范围或结构超出已核范围");
}
function inRegion(ranges: readonly RangeRef[], sheetId: string, row: number, col: number): boolean {
  return ranges.some((range) => range.sheetId === sheetId && row >= range.r0 && row <= range.r1 && col >= range.c0 && col <= range.c1);
}
function cellMeaning(snapshot: IWorkbookData, cell: unknown): unknown {
  if (!cell || typeof cell !== "object") return cell;
  const value = cell as Record<string, unknown>;
  const style = typeof value.s === "string" ? snapshot.styles?.[value.s] : value.s;
  return { ...value, ...(style !== undefined ? { s: style } : {}) };
}
/** Semantic invariant: this does not claim byte equivalence of unparsed OOXML extensions. */
export function assertRegionalSnapshot(before: IWorkbookData, after: IWorkbookData, ranges: readonly RangeRef[], serialized = false): void {
  if (stable(before.sheetOrder) !== stable(after.sheetOrder)) throw unsupported("工作表顺序变化");
  const strip = (snapshot: IWorkbookData) => {
    const copy = structuredClone(snapshot) as Omit<IWorkbookData, "styles"> & { styles?: IWorkbookData["styles"] };
    delete copy.styles;
    // Univer materializes an empty per-sheet validation list on first ordinary edit.
    // Only this known no-rule representation is equivalent; nonempty/unknown resources stay exact.
    copy.resources = copy.resources?.map((resource) => {
      if (resource.name !== "SHEET_DATA_VALIDATION_PLUGIN") return resource;
      const rules = JSON.parse(resource.data || "{}") as Record<string, unknown>;
      return { ...resource, data: stable(Object.fromEntries(Object.entries(rules).filter(([, value]) =>
        !Array.isArray(value) || value.length !== 0))) };
    });
    for (const sheet of Object.values(copy.sheets)) delete sheet.cellData;
    // Existing OOXML fidelity guards remain mandatory for unparsed package extensions.
    return copy;
  };
  const leftStructure = strip(before), rightStructure = strip(after);
  if (stable(leftStructure) !== stable(rightStructure)) throw unsupported(`域外结构/资源变化(${serialized ? "序列化" : "执行"}:${Object.keys(leftStructure).filter((key) => stable(leftStructure[key as keyof IWorkbookData]) !== stable(rightStructure[key as keyof IWorkbookData])).join(",")})`);
  for (const [id, sheet] of Object.entries(before.sheets)) {
    const next = after.sheets[id];
    if (!next) throw unsupported();
    const rows = new Set([...Object.keys(sheet.cellData ?? {}), ...Object.keys(next.cellData ?? {})]);
    for (const r of rows) {
      const left = sheet.cellData?.[Number(r)] ?? {}, right = next.cellData?.[Number(r)] ?? {};
      for (const c of new Set([...Object.keys(left), ...Object.keys(right)]))
        if (!inRegion(ranges, id, Number(r), Number(c)) &&
            stable(cellMeaning(before, left[Number(c)])) !== stable(cellMeaning(after, right[Number(c)])))
          throw unsupported(`域外单元格变化(${serialized ? "序列化" : "执行"})`);
    }
  }
  if (!serialized) {
    for (const [id, style] of Object.entries(before.styles ?? {}))
      if (stable(style) !== stable(after.styles?.[id])) throw unsupported("已有共享样式变化");
  }
}
