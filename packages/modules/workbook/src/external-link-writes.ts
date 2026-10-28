import { indexToCol, parseRange, type RangeRef } from "@excelmanus/core";
import { FileOperationError } from "@excelmanus/kernel";
import { arraysOf } from "@excelmanus/protocol";
import type { ICellData, IWorkbookData, IWorksheetData } from "@univerjs/core";
import { namesOf } from "./defined-names.ts";
import type { DocMutation } from "./engine.ts";
import { isExternalFormula } from "./external-links.ts";
import { findReplacePattern } from "./find-replace.ts";
import { type ChangeOp, type CompiledOps, changeOpTarget } from "./ops.ts";
import { deriveWriteSet } from "./writeset.ts";

type P = Record<string, unknown>;
type ExternalCell = { sheetId: string; r: number; c: number };
const record = (value: unknown): P => (value && typeof value === "object" ? (value as P) : {});
const cellData = (sheet: Partial<IWorksheetData> | undefined) =>
  (sheet?.cellData ?? {}) as Record<string, Record<string, ICellData | undefined>>;
function reject(where = ""): never {
  throw new FileOperationError(
    "UNSUPPORTED_FEATURE",
    `暂不支持新增、改写、覆盖、移动或重算外部引用公式${where ? `（${where}）` : ""}；本批修改未执行，原公式、保存缓存和外链部件保持不变。`,
  );
}
export function externalCells(snapshot: IWorkbookData): ExternalCell[] {
  const found: ExternalCell[] = [];
  for (const [sheetId, sheet] of Object.entries(snapshot.sheets)) {
    const shared = new Set<string>();
    for (const row of Object.values(cellData(sheet)))
      for (const cell of Object.values(row ?? {}))
        if (isExternalFormula(cell?.f) && cell?.si) shared.add(cell.si);
    const arrays = arraysOf(sheet).filter((a) => isExternalFormula(a.formula));
    for (const [r, row] of Object.entries(cellData(sheet)))
      for (const [c, cell] of Object.entries(row ?? {}))
        if (
          isExternalFormula(cell?.f) ||
          (cell?.si && shared.has(cell.si)) ||
          arrays.some(
            (a) =>
              Number(r) >= a.range.startRow &&
              Number(r) <= a.range.endRow &&
              Number(c) >= a.range.startColumn &&
              Number(c) <= a.range.endColumn,
          )
        )
          found.push({ sheetId, r: Number(r), c: Number(c) });
  }
  return found;
}
const externalNames = (snapshot: IWorkbookData) =>
  Object.values(namesOf(snapshot)).filter((n) => isExternalFormula(n.formulaOrRefString));
export function assertExternalRecalculation(snapshot: IWorkbookData): void {
  if (externalCells(snapshot).length || externalNames(snapshot).length)
    reject("外链缓存不能在本地重算");
}
function introducedFormula(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, v]) =>
      (["f", "formula", "formulaOrRefString"].includes(key) &&
        typeof v === "string" &&
        isExternalFormula(v)) ||
      introducedFormula(v),
  );
}
/** Reject unsupported formula syntax before a compiler attempts formula translation. */
export function assertNoExternalFormulaInputs(
  ops: ChangeOp[] | undefined,
  mutations: DocMutation[] = [],
): void {
  for (const op of ops ?? []) {
    if (
      op.op === "cells.set" &&
      op.values.some((row) =>
        row.some((v) => typeof v === "string" && v.startsWith("=") && isExternalFormula(v)),
      )
    )
      reject(op.range);
    if (op.op === "name.set" && isExternalFormula(op.range)) reject(op.name);
    if (introducedFormula(op)) reject();
  }
  if (mutations.some((m) => introducedFormula(m.params))) reject();
}

const inRange = (cell: ExternalCell, range: RangeRef) =>
  (range.sheetId === "*" || range.sheetId === cell.sheetId) &&
  cell.r >= range.r0 &&
  cell.r <= range.r1 &&
  cell.c >= range.c0 &&
  cell.c <= range.c1;

/** Must run before backup and before the first command, for every authoring route. */
export function assertExternalLinkWrites(
  before: IWorkbookData,
  ops: ChangeOp[] | undefined,
  mutations: DocMutation[],
  compiled?: CompiledOps,
): void {
  assertNoExternalFormulaInputs(ops, mutations);
  const names = externalNames(before);
  if (names.length) reject(`外部定义名 ${names[0]!.name} 的间接引用暂仅支持读取`);
  if (
    Object.values(before.sheets).some((s) => arraysOf(s).some((a) => isExternalFormula(a.formula)))
  )
    reject("外部数组公式暂仅支持读取");
  const cells = externalCells(before);
  const sheetIdOf = (name?: string) =>
    name === undefined
      ? before.sheetOrder[0]
      : before.sheets[name]
        ? name
        : Object.entries(before.sheets).find(([, s]) => s.name === name)?.[0];
  const hit = (range: RangeRef | undefined) => {
    const cell = range && cells.find((c) => inRange(c, range));
    if (cell)
      reject(
        `${before.sheets[cell.sheetId]?.name ?? cell.sheetId}!${indexToCol(cell.c + 1)}${cell.r + 1}`,
      );
  };
  const rangeOf = (text: string): RangeRef => {
    const p = parseRange(text);
    return {
      sheetId: sheetIdOf(p.sheet) ?? "*",
      r0: p.startRow - 1,
      c0: p.startCol - 1,
      r1: p.endRow - 1,
      c1: p.endCol - 1,
    };
  };
  for (const [opIndex, op] of (ops ?? []).entries()) {
    if (op.op === "recalculate") assertExternalRecalculation(before);
    if (op.op === "cells.fill") hit(rangeOf(op.source));
    if (op.op === "find_replace" && op.formulas) {
      // Earlier content/structure edits can change the formulas scanned at execution time.
      // Known format-only edits cannot, so do not unnecessarily reject those batches.
      if (
        (ops ?? [])
          .slice(0, opIndex)
          .some(
            (previous) =>
              previous.op !== "style.set" &&
              !(previous.op === "cells.clear" && previous.what === "formats"),
          )
      )
        reject("公式查找替换前含内容或结构操作，请单独提交以确认外部引用边界");
      const range = rangeOf(op.range),
        pattern = findReplacePattern(op.find, op.regex, op.caseSensitive);
      const sheet = before.sheets[range.sheetId];
      for (const [r, row] of Object.entries(cellData(sheet)))
        for (const [c, cell] of Object.entries(row ?? {})) {
          if (!cell?.f || !inRange({ sheetId: range.sheetId, r: Number(r), c: Number(c) }, range))
            continue;
          const next = op.regex
            ? cell.f.replace(pattern, op.replacement)
            : cell.f.replace(pattern, () => op.replacement);
          if (next !== cell.f && (isExternalFormula(cell.f) || isExternalFormula(next)))
            reject(op.range);
        }
      continue;
    }
    if (
      ["cells.set", "cells.fill", "sort", "merge", "table.add", "table.column_formula"].includes(
        op.op,
      ) ||
      (op.op === "cells.clear" && op.what !== "formats") ||
      (op.op === "hyperlink.set" && op.label !== undefined)
    )
      hit(changeOpTarget(op, sheetIdOf)?.ref);
    if (
      /^(?:rows|cols)\.(?:insert|delete)$|^sheet\.(?:delete|copy|rename|move)$/.test(op.op) &&
      "sheet" in op
    ) {
      const sid = sheetIdOf(op.sheet);
      const cell = cells.find((c) => c.sheetId === sid);
      if (cell) reject(before.sheets[cell.sheetId]?.name);
    }
  }
  // Compilers can introduce formulas (e.g. table calculated columns); inspect their actual payloads.
  if (compiled?.commands.some((c) => introducedFormula(c.params))) reject();
  for (const mutation of mutations) {
    const p = record(mutation.params);
    if (introducedFormula(p)) reject();
    if (mutation.id === "sheet.mutation.set-range-values") {
      for (const [r, row] of Object.entries(record(p.cellValue)))
        for (const [c, patch] of Object.entries(record(row))) {
          const content =
            patch === null ||
            ["f", "v", "p", "t", "si"].some((key) => Object.hasOwn(record(patch), key));
          if (content)
            hit({
              sheetId: String(p.subUnitId ?? "*"),
              r0: Number(r),
              r1: Number(r),
              c0: Number(c),
              c1: Number(c),
            });
        }
    } else if (
      /move-range|move-rows|move-columns|reorder-range|(?:insert|remove|copy)-(?:row|col|sheet)|add-worksheet-merge/.test(
        mutation.id,
      )
    ) {
      for (const range of deriveWriteSet(mutation).ranges) hit(range);
    } else if (
      mutation.id === "sheet.mutation.set-worksheet-name" &&
      cells.some((c) => c.sheetId === p.subUnitId)
    )
      reject();
  }
}

/** Engine output is not permission to overwrite a saved external cache. */
export function filterExternalEngineResults(
  results: DocMutation[],
  current: IWorkbookData,
  baseline: IWorkbookData,
) {
  const blocked = new Set(
    [...externalCells(current), ...externalCells(baseline)].map(
      (c) => `${c.sheetId}:${c.r}:${c.c}`,
    ),
  );
  const indirect = externalNames(current).length > 0 || externalNames(baseline).length > 0;
  let filtered = false;
  const allowed = results.flatMap((m) => {
    const p = record(m.params),
      value = record(p.cellValue);
    if (!p.cellValue) return [m];
    const cellValue: Record<string, Record<string, unknown>> = {};
    for (const [r, row] of Object.entries(value))
      for (const [c, cell] of Object.entries(record(row))) {
        if (indirect || blocked.has(`${String(p.subUnitId)}:${r}:${c}`)) {
          filtered = true;
          continue;
        }
        cellValue[r] ??= {};
        cellValue[r][c] = cell;
      }
    return Object.keys(cellValue).length ? [{ ...m, params: { ...p, cellValue } }] : [];
  });
  return { results: allowed, filtered };
}

/** Persist only the cache actually exported, not an unpersisted live-engine external value. */
export function restoreSavedExternalCaches(checkpoint: IWorkbookData, saved: IWorkbookData): void {
  for (const { sheetId, r, c } of externalCells(checkpoint)) {
    const sheet = checkpoint.sheets[sheetId];
    const matches = saved.sheetOrder.filter((id) => saved.sheets[id]?.name === sheet?.name);
    if (matches.length !== 1)
      throw new FileOperationError("INTERNAL", "外链缓存检查点工作表映射不唯一");
    const actual = saved.sheets[matches[0]!]!.cellData?.[r]?.[c];
    const cell = sheet?.cellData?.[r]?.[c];
    if (!cell) continue;
    // Missing caches are not empty strings or zero, and stale type tags must not survive.
    delete cell.v;
    delete cell.t;
    if (actual && Object.hasOwn(actual, "v")) cell.v = actual.v;
    if (actual && Object.hasOwn(actual, "t")) cell.t = actual.t;
  }
}
