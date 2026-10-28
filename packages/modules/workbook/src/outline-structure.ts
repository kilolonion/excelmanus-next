import type { StructuralOp } from "@excelmanus/core";
import { FileOperationError } from "@excelmanus/kernel";
import { AXIS_GROUP_MUTATION, PRINT_STATE_MUTATION, printSettingsOf } from "@excelmanus/protocol";
import type { IWorkbookData, IWorksheetData } from "@univerjs/core";
import { namesOf } from "./defined-names.ts";
import type { DocMutation } from "./engine.ts";
import type { ChangeOp } from "./ops.ts";

type AxisData = Record<number, { custom?: Record<string, unknown> | null | void }>;
type Outline = { rows: AxisData; cols: AxisData; below: boolean; right: boolean };
function reject(reason: string): never {
  throw new FileOperationError("UNSUPPORTED_FEATURE", reason);
}
function outline(sheet: Partial<IWorksheetData> | undefined): Outline {
  const settings = (sheet?.custom?.excelmanusOutlineSettings ?? {}) as Record<string, unknown>;
  const direction = (key: string) => {
    const value = settings[key];
    if (value === undefined || value === "1" || value === "true") return true;
    if (value === "0" || value === "false") return false;
    reject("分组汇总方向无法确定，拒绝结构编辑");
  };
  return {
    rows: structuredClone(sheet?.rowData ?? {}),
    cols: structuredClone(sheet?.columnData ?? {}),
    below: direction("summaryBelow"),
    right: direction("summaryRight"),
  };
}
function groups(
  data: AxisData,
  after: boolean,
): Array<{ start: number; end: number; summary: number }> {
  const result: Array<{ start: number; end: number; summary: number }> = [];
  const levels = new Map<number, number>();
  for (const [key, meta] of Object.entries(data)) {
    const level = Number(meta?.custom?.excelmanusOutlineLevel ?? 0);
    if (!Number.isInteger(level) || level < 0 || level > 7)
      reject("分组层级无法确定，拒绝结构编辑");
    if (level) levels.set(Number(key), level);
  }
  for (let level = 1; level <= 7; level++) {
    const indexes = [...levels]
      .filter(([, value]) => value >= level)
      .map(([key]) => key)
      .sort((a, b) => a - b);
    for (let i = 0; i < indexes.length; i++) {
      const start = indexes[i]!;
      let end = start;
      while (indexes[i + 1] === end + 1) end = indexes[++i]!;
      result.push({ start, end, summary: after ? end + 1 : start - 1 });
    }
  }
  return result;
}
function move(data: AxisData, op: StructuralOp): AxisData {
  const result: AxisData = {};
  const inserting = op.kind.startsWith("insert");
  for (const [key, value] of Object.entries(data)) {
    const index = Number(key);
    if (!inserting && index >= op.index && index < op.index + op.count) continue;
    result[index >= op.index ? index + (inserting ? op.count : -op.count) : index] = value;
  }
  return result;
}
function check(state: Outline, op: StructuralOp) {
  const rows = op.kind.endsWith("Rows");
  const data = rows ? state.rows : state.cols;
  const bounds = groups(data, rows ? state.below : state.right);
  const collapsed = Object.entries(data)
    .filter(([, value]) => value?.custom?.excelmanusCollapsed)
    .map(([key]) => Number(key));
  // Only whole-group row shifts are supported. Column group editing remains metadata-only.
  if (
    !rows &&
    (bounds.length ||
      collapsed.length ||
      groups(state.rows, state.below).length ||
      Object.values(state.rows).some((meta) => meta.custom?.excelmanusCollapsed))
  )
    reject("含分组或折叠标记的工作表暂不支持插删列；不会改动原分组");
  const inserting = op.kind.startsWith("insert");
  for (const group of bounds) {
    const first = Math.min(group.start, group.summary);
    const last = Math.max(group.end, group.summary);
    if (
      inserting
        ? op.index > first && op.index <= last
        : op.index <= last && op.index + op.count > first
    )
      reject("仅支持整组之外插删行；不能在组内插入或删除分组成员、汇总行");
  }
  if (!inserting && collapsed.some((index) => index >= op.index && index < op.index + op.count))
    reject("不能删除折叠汇总标记所在行");
}
const hasBreaks = (sheet: Partial<IWorksheetData> | undefined) => {
  const settings = printSettingsOf(sheet);
  return Boolean(
    settings.rowBreaks?.breaks.length ||
      settings.colBreaks?.breaks.length ||
      settings.unsupported?.length,
  );
};

/** Check the live state and checkpoint state in current coordinates, before executing any mutation. */
export function assertOutlineStructure(
  baseline: IWorkbookData,
  before: IWorkbookData,
  ops: ChangeOp[] | undefined,
  mutations: DocMutation[],
  prior: StructuralOp[],
): void {
  const structures = ops
    ? ops.some((op) => /^(rows|cols)\.(insert|delete)$/.test(op.op))
    : mutations.some((mutation) =>
        /(?:insert-row|remove-rows|insert-col|remove-col)$/.test(mutation.id),
      );
  if (!structures) return;
  if (
    ops
      ? ops.some(
          (op) => op.op === "sheet.rename" || op.op === "sheet.copy" || op.op === "sheet.add",
        )
      : mutations.some((mutation) =>
          [
            "sheet.mutation.set-worksheet-name",
            "sheet.mutation.insert-sheet",
            "sheet.mutation.copy-sheet",
          ].includes(mutation.id),
        )
  )
    reject("同批工作表新增、重命名或复制与行列插删尚不能安全组合；请分别提交");
  const original = new Map<string, Outline>();
  const current = new Map<string, Outline>();
  const printed = new Set<string>();
  const objects = new Set<string>();
  for (const id of before.sheetOrder) {
    original.set(id, outline(baseline.sheets[id]));
    current.set(id, outline(before.sheets[id]));
    if (hasBreaks(baseline.sheets[id]) || hasBreaks(before.sheets[id])) printed.add(id);
  }
  for (const op of prior) {
    if (!/^(insert|delete)(Rows|Cols)$/.test(op.kind)) continue;
    const state = original.get(op.sheetId);
    if (state) {
      const axis = op.kind.endsWith("Rows") ? "rows" : "cols";
      state[axis] = move(state[axis], op);
    }
  }
  let named = Object.keys(namesOf(before)).length > 0;
  const resolve = (name: string) =>
    before.sheetOrder.find((id) => id === name || before.sheets[id]?.name === name) ?? name;
  const apply = (op: StructuralOp) => {
    if (printed.has(op.sheetId) || named)
      reject("打印区域、重复标题、分页或定义名称尚不能安全随结构平移");
    if (objects.has(op.sheetId)) reject("对象锚点尚不能安全随结构平移");
    for (const state of [original.get(op.sheetId), current.get(op.sheetId)]) {
      if (!state) continue;
      check(state, op);
      const axis = op.kind.endsWith("Rows") ? "rows" : "cols";
      state[axis] = move(state[axis], op);
    }
  };
  const change = (
    id: string,
    axis: "rows" | "cols",
    values: Record<string, unknown>,
    key: string,
  ) => {
    const state = current.get(id);
    if (!state) return;
    for (const [index, value] of Object.entries(values)) {
      const meta = state[axis][Number(index)] ?? {};
      state[axis][Number(index)] = { ...meta, custom: { ...meta.custom, [key]: value } };
    }
  };
  if (ops) {
    for (const op of ops) {
      const id = "sheet" in op ? resolve(op.sheet) : "";
      if (op.op === "axis.group" || op.op === "axis.collapse")
        change(
          id,
          op.axis,
          Object.fromEntries(
            Array.from({ length: op.count }, (_, n) => [
              op.at - 1 + n,
              op.op === "axis.group" ? op.level : op.collapsed,
            ]),
          ),
          op.op === "axis.group" ? "excelmanusOutlineLevel" : "excelmanusCollapsed",
        );
      else if (op.op === "print.set") {
        if (op.afterRows?.length || op.afterColumns?.length) printed.add(id);
        if (op.printArea || op.repeatRows) named = true;
      } else if (op.op === "name.set") named = true;
      else if (/^(chart|image|shape)\./.test(op.op)) objects.add(id);
      else if (
        op.op === "rows.insert" ||
        op.op === "rows.delete" ||
        op.op === "cols.insert" ||
        op.op === "cols.delete"
      )
        apply({
          sheetId: id,
          kind: `${op.op.endsWith("insert") ? "insert" : "delete"}${op.op.startsWith("rows") ? "Rows" : "Cols"}`,
          index: op.at - 1,
          count: op.count,
        });
    }
  } else {
    for (const mutation of mutations) {
      const p = mutation.params as Record<string, unknown>;
      const id = String(p.subUnitId ?? "");
      if (mutation.id === AXIS_GROUP_MUTATION) {
        if (p.levels)
          change(
            id,
            p.axis as "rows" | "cols",
            p.levels as Record<string, unknown>,
            "excelmanusOutlineLevel",
          );
        if (p.collapsed)
          change(
            id,
            p.axis as "rows" | "cols",
            p.collapsed as Record<string, unknown>,
            "excelmanusCollapsed",
          );
      } else if (
        mutation.id === PRINT_STATE_MUTATION &&
        hasBreaks({ custom: { excelmanusPrintSettings: p.settings } })
      )
        printed.add(id);
      else if (mutation.id === "formula.mutation.set-defined-name") named = true;
      else if (mutation.id === "excelmanus.mutation.set-sheet-objects") objects.add(id);
      else if (
        /sheet\.mutation\.(insert-row|remove-rows|insert-col|remove-col)$/.test(mutation.id)
      ) {
        const range = p.range as {
          startRow: number;
          endRow: number;
          startColumn: number;
          endColumn: number;
        };
        const rows = /row/.test(mutation.id);
        const inserting = /insert/.test(mutation.id);
        if (
          inserting &&
          p.rowInfo &&
          Object.values(p.rowInfo as object).some(
            (value) => value != null && Object.keys(value).length,
          )
        )
          reject("结构插入仅支持完全空白、可见、未分组的行");
        apply({
          sheetId: id,
          kind: `${inserting ? "insert" : "delete"}${rows ? "Rows" : "Cols"}`,
          index: rows ? range.startRow : range.startColumn,
          count: (rows ? range.endRow - range.startRow : range.endColumn - range.startColumn) + 1,
        });
      }
    }
  }
}
