import { indexToCol, parseRange } from "@excelmanus/core";
import { FileOperationError } from "@excelmanus/kernel";
import {
  ARRAY_CACHE_RESOURCE,
  type ArrayCache,
  type ArrayFormula,
  arrayCache,
  arraysOf,
  effectiveArrays,
  fixedArrayCellFormula,
} from "@excelmanus/protocol";
import type { IWorkbookData, IWorksheetData } from "@univerjs/core";
import { dynamicMetadataIndexes, ensureDynamicMetadata } from "./array-metadata.ts";
import { engineArrayFormula, xlsxFormula } from "./formula-compat.ts";
import { bytesOf, elements, escapeXml, setAttribute, textOf, xmlAttrs } from "./xml.ts";

const canonical = (f: string | undefined | null | void) =>
  f
    ?.split(/("(?:[^"]|"")*")/)
    .map((s, i) => (i % 2 ? s : s.toUpperCase()))
    .join("");
const contains = (a: ArrayFormula, r: number, c: number) =>
  r >= a.range.startRow &&
  r <= a.range.endRow &&
  c >= a.range.startColumn &&
  c <= a.range.endColumn;
export function importArrays(
  parts: Record<string, Uint8Array>,
  mapping: Record<string, { path: string }>,
  sheets: Record<string, Partial<IWorksheetData>>,
) {
  const cache: ArrayCache = { ranges: {}, cells: {} };
  for (const [sid, { path }] of Object.entries(mapping)) {
    const sheet = sheets[sid]!,
      arrays: ArrayFormula[] = [],
      dynamicIndexes = dynamicMetadataIndexes(parts);
    for (const cell of elements(textOf(parts[path]!), "c")) {
      const f = elements(cell.inner, "f")[0];
      if (!f) continue;
      const attr = xmlAttrs(f.open);
      if (attr.t !== "array" || !attr.ref) continue;
      const r = parseRange(attr.ref),
        range = {
          startRow: r.startRow - 1,
          endRow: r.endRow - 1,
          startColumn: r.startCol - 1,
          endColumn: r.endCol - 1,
        };
      const formula = sheet.cellData?.[range.startRow]?.[range.startColumn]?.f;
      if (!formula) continue;
      // Fixed array expressions remain one authored block; engine cells calculate indexed results.
      const a: ArrayFormula = {
        id: `array_${range.startRow}_${range.startColumn}`,
        mode: dynamicIndexes.has(Number(xmlAttrs(cell.open).cm)) ? "dynamic" : "fixed",
        formula: engineArrayFormula(formula),
        range,
      };
      const area = (range.endRow - range.startRow + 1) * (range.endColumn - range.startColumn + 1);
      if (area > (a.mode === "fixed" ? 20000 : 200000)) continue;
      arrays.push(a);
      if (a.mode === "dynamic") {
        cache.ranges[sid] ??= {};
        cache.ranges[sid]![range.startRow] ??= {};
        cache.ranges[sid]![range.startRow]![range.startColumn] = range;
        cache.cells[sid] ??= {};
      }
      sheet.cellData ??= {};
      for (let row = range.startRow; row <= range.endRow; row++) {
        sheet.cellData[row] ??= {};
        for (let col = range.startColumn; col <= range.endColumn; col++) {
          const old = sheet.cellData[row]![col] ?? {};
          if (a.mode === "dynamic" && old.v != null) {
            cache.cells[sid]![row] ??= {};
            cache.cells[sid]![row]![col] = { v: old.v, t: old.t };
          }
          sheet.cellData[row]![col] =
            a.mode === "fixed"
              ? { ...old, f: fixedArrayCellFormula(a, row, col) }
              : {
                  ...old,
                  f: row === range.startRow && col === range.startColumn ? a.formula : null,
                  v: null,
                  t: null,
                };
        }
      }
    }
    if (arrays.length) sheet.custom = { ...sheet.custom, excelmanusArrays: arrays };
  }
  return { name: ARRAY_CACHE_RESOURCE, data: JSON.stringify(cache) };
}
export function validateArrays(after: IWorkbookData, before: IWorkbookData) {
  const fail = (message: string): never => {
    throw new FileOperationError("UNSUPPORTED_FEATURE", message);
  };
  for (const [sid, sheet] of Object.entries(after.sheets)) {
    const next = arraysOf(sheet),
      old = effectiveArrays(before, sid);
    for (const a of next) {
      if (a.range.endRow < a.range.startRow || a.range.endColumn < a.range.startColumn)
        fail("数组公式范围无效");
      if (a.mode !== "fixed") continue;
      for (let r = a.range.startRow; r <= a.range.endRow; r++)
        for (let c = a.range.startColumn; c <= a.range.endColumn; c++)
          if (canonical(sheet.cellData?.[r]?.[c]?.f) !== canonical(fixedArrayCellFormula(a, r, c)))
            fail("不能修改数组公式的一部分，请在“数组公式”中编辑整个区域");
    }
    for (const a of old)
      if (a.mode === "dynamic") {
        const anchor = sheet.cellData?.[a.range.startRow]?.[a.range.startColumn];
        if (
          anchor?.f === before.sheets[sid]?.cellData?.[a.range.startRow]?.[a.range.startColumn]?.f
        )
          for (let r = a.range.startRow; r <= a.range.endRow; r++)
            for (let c = a.range.startColumn; c <= a.range.endColumn; c++)
              if (r !== a.range.startRow || c !== a.range.startColumn) {
                const v = sheet.cellData?.[r]?.[c];
                if (v?.f || (v?.v != null && v.v !== ""))
                  fail("不能修改动态数组的结果格，请编辑左上角公式");
              }
      }
    for (const a of old)
      if (!next.some((n) => n.id === a.id))
        for (let r = a.range.startRow; r <= a.range.endRow; r++)
          for (let c = a.range.startColumn; c <= a.range.endColumn; c++) {
            const v = sheet.cellData?.[r]?.[c];
            if (canonical(v?.f) === canonical(fixedArrayCellFormula(a, r, c)))
              fail("清除数组公式时必须清除整个数组区域");
          }
  }
}
export function isManagedArray(sheet: Partial<IWorksheetData> | undefined, r: number, c: number) {
  return arraysOf(sheet).some((a) => contains(a, r, c));
}
export function exportArrays(
  parts: Record<string, Uint8Array>,
  mapping: Record<string, { path: string }>,
  snapshot: IWorkbookData,
) {
  for (const [sid, { path }] of Object.entries(mapping)) {
    const arrays = effectiveArrays(snapshot, sid);
    if (!arrays.length) continue;
    let xml = textOf(parts[path]!);
    for (const cell of elements(xml, "c")) {
      const addr = xmlAttrs(cell.open).r;
      if (!addr) continue;
      const p = parseRange(addr),
        r = p.startRow - 1,
        c = p.startCol - 1,
        a = arrays.find((a) => contains(a, r, c));
      if (!a) continue;
      const isAnchor = r === a.range.startRow && c === a.range.startColumn;
      const originalFormula = elements(cell.inner, "f")[0];
      let inner = cell.inner;
      for (const f of elements(inner, "f")) inner = inner.replace(f.raw, "");
      if (isAnchor) {
        const end = `${indexToCol(a.range.endColumn + 1)}${a.range.endRow + 1}`;
        let fOpen = originalFormula?.open.replace(/\/>$/, ">") ?? "<f>";
        fOpen = setAttribute(setAttribute(fOpen, "t", "array"), "ref", `${addr}:${end}`);
        inner = `${fOpen}${escapeXml(xlsxFormula(a.formula).replace(/^=/, ""))}</f>` + inner;
      }
      let open = cell.open.replace(/\/>$/, ">");
      if (
        isAnchor &&
        a.mode === "dynamic" &&
        !dynamicMetadataIndexes(parts).has(Number(xmlAttrs(open).cm))
      )
        open = setAttribute(open, "cm", String(ensureDynamicMetadata(parts)));
      xml = xml.replace(cell.raw, `${open}${inner}</c>`);
    }
    parts[path] = bytesOf(xml);
  }
}

export function materializeArrays(snapshot: IWorkbookData): IWorkbookData {
  const cache = arrayCache(snapshot),
    copy = structuredClone(snapshot);
  for (const [sid, sheet] of Object.entries(copy.sheets)) {
    const arrays = effectiveArrays(snapshot, sid);
    sheet.custom = { ...sheet.custom, excelmanusArrays: arrays };
    for (const a of arrays)
      if (a.mode === "dynamic")
        for (let r = a.range.startRow; r <= a.range.endRow; r++)
          for (let c = a.range.startColumn; c <= a.range.endColumn; c++) {
            const cell = cache.cells[sid]?.[r]?.[c];
            if (!cell) continue;
            sheet.cellData ??= {};
            sheet.cellData[r] ??= {};
            sheet.cellData[r]![c] = { ...sheet.cellData[r]![c], ...cell };
          }
  }
  return copy;
}
