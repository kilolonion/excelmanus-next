import { describe, expect, it } from "vitest";
import { WorkbookEditInput } from "../../modules/workbook/src/edit-input.ts";
import { classifyWorkbookEffect, WORKBOOK_EFFECT_REGISTRY } from "../src/workbook-effects.ts";

const formatOps = [
  "style.set",
  "rows.height",
  "cols.width",
  "axis.size",
  "freeze",
  "image.add",
  "image.update",
  "image.delete",
  "shape.add",
  "shape.update",
  "shape.delete",
  "chart.add",
  "chart.update",
  "chart.delete",
  "note.set",
  "cf.add",
  "cf.remove",
  "dv.add",
  "dv.remove",
];
const dataOps = [
  "print.set",
  "name.set",
  "pivot.mark_refresh_on_load",
  "table.add",
  "table.column_formula",
  "filter.set",
  "hyperlink.set",
  "sheet.copy",
  "sheet.move",
  "sheet.hide",
  "cells.fill",
  "find_replace",
  "axis.hide",
  "axis.group",
  "axis.collapse",
  "sort",
  "sheet.add",
  "sheet.rename",
  "sheet.delete",
  "cells.set",
  "cells.clear",
  "merge",
  "unmerge",
  "rows.insert",
  "rows.delete",
  "cols.insert",
  "cols.delete",
  "recalculate",
];

describe("native workbook effect registry", () => {
  it("covers exactly the47 discriminants accepted by the actual edit schema", () => {
    const native = WorkbookEditInput.shape.ops.element.options.map(
      (schema) => schema.shape.op.value,
    );
    expect(native).toHaveLength(47);
    expect(Object.keys(WORKBOOK_EFFECT_REGISTRY).sort()).toEqual([...native].sort());
    expect([...formatOps, ...dataOps].sort()).toEqual([...native].sort());
  });

  for (const [category, operations] of [
    ["format", formatOps],
    ["data", dataOps],
  ] as const) {
    for (const op of operations) {
      it(`${op} is ${category} with an auditable native anchor`, () => {
        expect(WORKBOOK_EFFECT_REGISTRY[op]?.category).toBe(category);
        expect(WORKBOOK_EFFECT_REGISTRY[op]?.rationale.length).toBeGreaterThan(10);
        expect(WORKBOOK_EFFECT_REGISTRY[op]?.nativeSourceAnchor).toMatch(/^packages\/.+\.ts:\d+/);
        expect(classifyWorkbookEffect([{ op }])).toBe(category);
      });
    }
  }

  it("freezes both the registry and every classification entry", () => {
    expect(Object.isFrozen(WORKBOOK_EFFECT_REGISTRY)).toBe(true);
    expect(Object.values(WORKBOOK_EFFECT_REGISTRY)).toHaveLength(47);
    for (const entry of Object.values(WORKBOOK_EFFECT_REGISTRY))
      expect(Object.isFrozen(entry)).toBe(true);
  });

  it("requires a nonempty all-format batch and never mutates input", () => {
    const batch = Object.freeze([
      Object.freeze({ op: "style.set" }),
      Object.freeze({ op: "image.add" }),
    ]);
    expect(classifyWorkbookEffect(batch)).toBe("format");
    expect(classifyWorkbookEffect([...batch, { op: "cells.set" }])).toBe("data");
    expect(classifyWorkbookEffect([])).toBe("data");
  });

  it("treats unknown, malformed, inherited and sparse operations as data", () => {
    for (const op of [
      null,
      undefined,
      1,
      "style.set",
      [],
      {},
      { op: "unknown" },
      { op: "__proto__" },
      { op: "constructor" },
      Object.create({ op: "style.set" }),
    ]) {
      expect(classifyWorkbookEffect([op])).toBe("data");
    }
    expect(classifyWorkbookEffect(new Array(1))).toBe("data");
  });

  it("does not invoke an operation getter or coerce an object to a discriminant", () => {
    let touched = false;
    const accessor = Object.defineProperty({}, "op", {
      get: () => {
        touched = true;
        return "style.set";
      },
    });
    const coercible = {
      op: {
        toString: () => {
          touched = true;
          return "style.set";
        },
      },
    };
    expect(classifyWorkbookEffect([accessor])).toBe("data");
    expect(classifyWorkbookEffect([coercible])).toBe("data");
    expect(touched).toBe(false);
  });

  it("does not downgrade effect-bearing payload variants to format", () => {
    for (const op of [
      { op: "hyperlink.set", url: "https://example.com", label: "999" },
      { op: "hyperlink.set", url: "https://example.com" },
      { op: "axis.hide", axis: "rows", hidden: true },
      { op: "axis.collapse", collapsed: false },
      { op: "print.set", printArea: "A1:B2" },
      { op: "print.set", orientation: "landscape" },
      { op: "cells.clear", what: "formats" },
      { op: "sheet.rename", name: "Renamed" },
    ])
      expect(classifyWorkbookEffect([op])).toBe("data");
  });
});
