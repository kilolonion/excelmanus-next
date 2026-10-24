export type WorkbookEffectCategory = "data" | "format";
export interface WorkbookEffectEntry {
  readonly category: WorkbookEffectCategory;
  readonly rationale: string;
  readonly nativeSourceAnchor: string;
}

const entry = (
  category: WorkbookEffectCategory,
  rationale: string,
  nativeSourceAnchor: string,
): WorkbookEffectEntry => Object.freeze({ category, rationale, nativeSourceAnchor });

/**
 * Static native effect boundary, not an operation executor or payload validator.
 * Format means only narrow saved structural/presentation assurance, never business correctness.
 * Keep this exact registry aligned with the native ChangeOp schema and source audit.
 */
export const WORKBOOK_EFFECT_REGISTRY: Readonly<Record<string, WorkbookEffectEntry>> =
  Object.freeze({
    "print.set": entry(
      "data",
      "Can set/remove Print_Area and Print_Titles defined-name references.",
      "packages/modules/workbook/src/ops.ts:863,877",
    ),
    "name.set": entry(
      "data",
      "Replaces defined-name references used by formulas.",
      "packages/modules/workbook/src/ops.ts:986",
    ),
    "pivot.mark_refresh_on_load": entry(
      "data",
      "Schedules later pivot-cache refresh; result equivalence not established.",
      "packages/modules/workbook/src/ops.ts:851",
    ),
    "table.add": entry(
      "data",
      "Writes literal headers, calculated-column formulas and table references.",
      "packages/modules/workbook/src/ops.ts:1022",
    ),
    "table.column_formula": entry(
      "data",
      "Writes calculated formulas into every affected data row.",
      "packages/modules/workbook/src/ops.ts:1023",
    ),
    "filter.set": entry(
      "data",
      "Changes filtering and visibility-sensitive formula membership.",
      "packages/modules/workbook/src/ops.ts:1505",
    ),
    "hyperlink.set": entry(
      "data",
      "Label writes v and clears f/si/p; URL-only can populate falsy values.",
      "packages/modules/workbook/src/layout-commands.ts:135,155",
    ),
    "sheet.copy": entry(
      "data",
      "Copies worksheet contents and reference-bearing structure.",
      "packages/modules/workbook/src/ops.ts:1867",
    ),
    "sheet.move": entry(
      "data",
      "Reorders workbook structure; order-sensitive equivalence unproven.",
      "packages/modules/workbook/src/ops.ts:1904",
    ),
    "sheet.hide": entry(
      "data",
      "Changes worksheet visibility; no semantic equivalence proof.",
      "packages/modules/workbook/src/ops.ts:1918",
    ),
    "cells.fill": entry(
      "data",
      "Writes values and shifted formulas through auto-fill.",
      "packages/modules/workbook/src/ops.ts:1550",
    ),
    "axis.size": entry(
      "format",
      "Writes only row-height/column-width geometry; auto-size only reads values.",
      "packages/modules/workbook/src/layout-commands.ts:232",
    ),
    find_replace: entry(
      "data",
      "Replaces cell text and optionally formula strings.",
      "packages/modules/workbook/src/ops.ts:1606",
    ),
    "axis.hide": entry(
      "data",
      "Row visibility affects SUBTOTAL-style calculations.",
      "packages/modules/workbook/src/ops.ts:1406,1419",
    ),
    "axis.group": entry(
      "data",
      "Outline metadata only in this handler; retained conservative visibility category.",
      "packages/modules/workbook/src/ops.ts:1407,1426",
    ),
    "axis.collapse": entry(
      "data",
      "Collapse marker only in this handler; retained conservative visibility category.",
      "packages/modules/workbook/src/ops.ts:1408,1426",
    ),
    "image.add": entry(
      "format",
      "Adds validated drawing-object metadata, not worksheet values.",
      "packages/modules/workbook/src/ops.ts:1241",
    ),
    "image.update": entry(
      "format",
      "Updates image geometry metadata.",
      "packages/modules/workbook/src/ops.ts:1191",
    ),
    "image.delete": entry(
      "format",
      "Removes image-object metadata.",
      "packages/modules/workbook/src/ops.ts:1177",
    ),
    "shape.add": entry(
      "format",
      "Adds validated shape-object metadata.",
      "packages/modules/workbook/src/ops.ts:1192",
    ),
    "shape.update": entry(
      "format",
      "Updates shape geometry metadata.",
      "packages/modules/workbook/src/ops.ts:1193",
    ),
    "shape.delete": entry(
      "format",
      "Removes shape-object metadata.",
      "packages/modules/workbook/src/ops.ts:1194",
    ),
    "note.set": entry(
      "format",
      "Updates cell-addressed note text in object metadata, not the cell value.",
      "packages/modules/workbook/src/ops.ts:1164",
    ),
    "cf.add": entry(
      "format",
      "Changes conditional-format rule resources; rule truth is not certified.",
      "packages/modules/workbook/src/ops.ts:1267",
    ),
    "cf.remove": entry(
      "format",
      "Removes conditional-format rule metadata.",
      "packages/modules/workbook/src/ops.ts:1356",
    ),
    "dv.add": entry(
      "format",
      "Changes validation-rule resources, not current worksheet values; rule correctness unverified.",
      "packages/modules/workbook/src/ops.ts:1268",
    ),
    "dv.remove": entry(
      "format",
      "Removes validation-rule metadata, not cell contents.",
      "packages/modules/workbook/src/ops.ts:1357",
    ),
    "chart.add": entry(
      "format",
      "Adds chart-object/source-range metadata; source results remain unverified.",
      "packages/modules/workbook/src/ops.ts:1376",
    ),
    "chart.update": entry(
      "format",
      "Updates chart representation and its source-range metadata.",
      "packages/modules/workbook/src/ops.ts:1377",
    ),
    "chart.delete": entry(
      "format",
      "Removes chart-object metadata.",
      "packages/modules/workbook/src/ops.ts:1378",
    ),
    "rows.height": entry(
      "format",
      "Writes row-height geometry only.",
      "packages/modules/workbook/src/ops.ts:1448",
    ),
    "cols.width": entry(
      "format",
      "Writes column-width geometry only.",
      "packages/modules/workbook/src/ops.ts:1449",
    ),
    sort: entry(
      "data",
      "Reorders physical data and formula-bearing cells.",
      "packages/modules/workbook/src/ops.ts:1482",
    ),
    "sheet.add": entry(
      "data",
      "Adds worksheet structure and changes the workbook universe.",
      "packages/modules/workbook/src/ops.ts:1934",
    ),
    "sheet.rename": entry(
      "data",
      "Rewrites references; INDIRECT string references are not proven equivalent.",
      "packages/modules/workbook/src/ops.ts:1960",
    ),
    "sheet.delete": entry(
      "data",
      "Removes worksheet contents and reference targets.",
      "packages/modules/workbook/src/ops.ts:1978",
    ),
    "cells.set": entry(
      "data",
      "Writes literal values or formulas.",
      "packages/modules/workbook/src/ops.ts:1625",
    ),
    "cells.clear": entry(
      "data",
      "May erase contents/formulas; no variant-based downgrade.",
      "packages/modules/workbook/src/ops.ts:1666",
    ),
    "style.set": entry(
      "format",
      "Emits style commands only; engine.ts:173 preserves existing typed cells on style patches.",
      "packages/modules/workbook/src/ops.ts:1689",
    ),
    merge: entry(
      "data",
      "Changes cell geometry/meaning and can affect retained contents.",
      "packages/modules/workbook/src/ops.ts:1725",
    ),
    unmerge: entry(
      "data",
      "Changes physical cell geometry and interpretation.",
      "packages/modules/workbook/src/ops.ts:1739",
    ),
    "rows.insert": entry(
      "data",
      "Shifts physical rows and reference-bearing structure.",
      "packages/modules/workbook/src/ops.ts:1748",
    ),
    "rows.delete": entry(
      "data",
      "Removes physical rows and changes references.",
      "packages/modules/workbook/src/ops.ts:1749",
    ),
    "cols.insert": entry(
      "data",
      "Shifts physical columns and reference-bearing structure.",
      "packages/modules/workbook/src/ops.ts:1815",
    ),
    "cols.delete": entry(
      "data",
      "Removes physical columns and changes references.",
      "packages/modules/workbook/src/ops.ts:1816",
    ),
    freeze: entry(
      "format",
      "Changes frozen-pane view state only.",
      "packages/modules/workbook/src/ops.ts:2000",
    ),
    recalculate: entry(
      "data",
      "May commit pending engine-calculated values; compiler no-op is not semantic equivalence.",
      "packages/modules/workbook/src/service.ts:1845",
    ),
  });

/** Unknown, empty, mixed or malformed batches conservatively invalidate semantic data assurance. */
export function classifyWorkbookEffect(ops: readonly unknown[]): WorkbookEffectCategory {
  if (!Array.isArray(ops) || ops.length === 0) return "data";
  try {
    for (const op of ops) {
      if (op === null || typeof op !== "object" || Array.isArray(op)) return "data";
      const descriptor = Object.getOwnPropertyDescriptor(op, "op");
      if (
        !descriptor ||
        !("value" in descriptor) ||
        typeof descriptor.value !== "string" ||
        !Object.hasOwn(WORKBOOK_EFFECT_REGISTRY, descriptor.value) ||
        WORKBOOK_EFFECT_REGISTRY[descriptor.value]?.category !== "format"
      )
        return "data";
    }
  } catch {
    return "data";
  }
  return "format";
}
