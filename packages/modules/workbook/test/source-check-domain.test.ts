import { describe, expect, it } from "vitest";
import { extractSourceCheckDomain, type SourceCheckSnapshot } from "../src/source-check-domain.ts";

const declaration = {
  id: "raw",
  path: "canonical/source.xlsx",
  sheet: "Data",
  range: "B5:C8",
  headerRows: [5],
  blankPolicy: "none" as const,
};
function snapshot(): SourceCheckSnapshot {
  return {
    sheets: {
      s1: {
        id: "s1",
        name: "Data",
        rowCount: 20,
        columnCount: 10,
        cellData: {
          4: { 1: { v: "id", t: 1 }, 2: { v: "value", t: 1 } },
          5: { 1: { v: "001", t: 1 }, 2: { v: 0, t: 2 } },
          7: { 1: { v: "", t: 1 }, 2: { v: false, t: 3 } },
        },
      },
    },
  };
}
const codes = (result: ReturnType<typeof extractSourceCheckDomain>) =>
  result.limitations.map((limitation) => limitation.split(":")[0]);

describe("source-check domain extraction", () => {
  it("enumerates physical rows without clipping or stopping at interior blanks", () => {
    const input = snapshot();
    const before = JSON.stringify(input);
    const result = extractSourceCheckDomain(input, declaration);
    expect(result.limitations).toEqual([]);
    expect(result.domain.complete).toBe(true);
    expect(result.domain.path).toBe("canonical/source.xlsx");
    expect(result.domain.columnNames).toEqual(["id", "value"]);
    expect(result.domain.rows).toEqual([
      { worksheetRow: 5, cells: ["id", "value"] },
      { worksheetRow: 6, cells: ["001", 0] },
      { worksheetRow: 7, cells: [null, null] },
      { worksheetRow: 8, cells: ["", false] },
    ]);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("resolves exact sheet ids and names to the same canonical worksheet", () => {
    const result = extractSourceCheckDomain(snapshot(), {
      ...declaration,
      sheet: "s1",
      range: "Data!B5:C8",
    });
    expect(result.domain.complete).toBe(true);
    expect(result.domain.sheet).toBe("Data");
    expect(result.domain.range).toBe("B5:C8");
  });

  it("rejects conflicting or ambiguous sheet identities", () => {
    const input = snapshot();
    input.sheets.s2 = { ...input.sheets.s1, id: "s2", name: "Other" };
    expect(
      codes(extractSourceCheckDomain(input, { ...declaration, range: "Other!B5:C8" })),
    ).toContain("SHEET_RANGE_MISMATCH");
    input.sheets.s2.name = "Data";
    expect(codes(extractSourceCheckDomain(input, declaration))).toContain(
      "SHEET_MISSING_OR_AMBIGUOUS",
    );
  });

  it("rejects map-key/id mismatches and duplicate canonical names after id lookup", () => {
    const mismatched = snapshot();
    mismatched.sheets.s1!.id = "not-s1";
    const badId = extractSourceCheckDomain(mismatched, declaration);
    expect(badId.domain.complete).toBe(false);
    expect(codes(badId)).toContain("SHEET_IDENTITY_INCONSISTENT");
    const duplicate = snapshot();
    duplicate.sheets.s2 = { ...duplicate.sheets.s1!, id: "s2" };
    const badName = extractSourceCheckDomain(duplicate, { ...declaration, sheet: "s1" });
    expect(badName.domain.complete).toBe(false);
    expect(codes(badName)).toContain("SHEET_CANONICAL_NAME_AMBIGUOUS");
  });

  it("preserves explicit force-string literals but never coerces their raw values", () => {
    const input = snapshot();
    input.sheets.s1!.cellData![4]![1] = { v: "id", t: 4 };
    input.sheets.s1!.cellData![5]![1] = { v: "001", t: 4 };
    const valid = extractSourceCheckDomain(input, declaration);
    expect(valid.domain.complete).toBe(true);
    expect(valid.domain.rows[1]!.cells[0]).toBe("001");
    input.sheets.s1!.cellData![5]![1] = { v: 1, t: 4 };
    const invalid = extractSourceCheckDomain(input, declaration);
    expect(invalid.domain.complete).toBe(false);
    expect(codes(invalid)).toContain("DECLARED_VALUE_TYPE_MISMATCH");
    expect(invalid.domain.rows[1]!.cells[0]).toBe(1);
  });

  it("does not shrink out-of-bounds ranges or synthesize missing sheet dimensions", () => {
    const input = snapshot();
    const result = extractSourceCheckDomain(input, { ...declaration, range: "B5:C21" });
    expect(result.domain.complete).toBe(false);
    expect(result.domain.range).toBe("B5:C21");
    expect(result.domain.rows).toEqual([]);
    expect(codes(result)).toContain("RANGE_OUTSIDE_SHEET");
    input.sheets.s1!.rowCount = undefined;
    expect(codes(extractSourceCheckDomain(input, declaration))).toContain(
      "SHEET_DIMENSIONS_UNAVAILABLE",
    );
  });

  it("refuses oversized ranges rather than returning a clipped successful subset", () => {
    const input = snapshot();
    input.sheets.s1!.rowCount = 200001;
    const result = extractSourceCheckDomain(input, {
      ...declaration,
      range: "B1:C100001",
      headerRows: [1],
    });
    expect(result.domain.complete).toBe(false);
    expect(result.domain.rows).toEqual([]);
    expect(codes(result)).toContain("CELL_BUDGET_EXCEEDED");
  });

  it("requires one in-range physical header with unique nonempty literal strings", () => {
    expect(
      codes(extractSourceCheckDomain(snapshot(), { ...declaration, headerRows: [] })),
    ).toContain("HEADER_LAYOUT_UNSUPPORTED");
    expect(
      codes(extractSourceCheckDomain(snapshot(), { ...declaration, headerRows: [4] })),
    ).toContain("HEADER_OUTSIDE_RANGE");
    expect(
      codes(extractSourceCheckDomain(snapshot(), { ...declaration, headerRows: [5, 6] })),
    ).toContain("HEADER_LAYOUT_UNSUPPORTED");
    const input = snapshot();
    input.sheets.s1!.cellData![4]![2] = { v: "id" };
    expect(codes(extractSourceCheckDomain(input, declaration))).toContain(
      "HEADER_MISSING_DUPLICATE_OR_NONLITERAL",
    );
    input.sheets.s1!.cellData![4]![2] = { v: 1 };
    expect(codes(extractSourceCheckDomain(input, declaration))).toContain(
      "HEADER_MISSING_DUPLICATE_OR_NONLITERAL",
    );
  });

  it("cannot launder formula caches into trusted scalar source values", () => {
    const input = snapshot();
    input.sheets.s1!.cellData![5]![2] = { v: 999, t: 2, f: "=1+1" };
    const result = extractSourceCheckDomain(input, declaration);
    expect(result.domain.complete).toBe(false);
    expect(codes(result)).toContain("FORMULA_CELL_UNSUPPORTED");
    expect(result.limitations.some((value) => value.includes("C6"))).toBe(true);
  });

  it("rejects shared and array formula markers even without a formula string", () => {
    for (const marker of ["ft", "fd", "ref", "xf", "si"]) {
      const input = snapshot();
      input.sheets.s1!.cellData![5]![2] = { v: 999, [marker]: marker === "fd" ? 1 : "marker" };
      expect(codes(extractSourceCheckDomain(input, declaration))).toContain(
        "FORMULA_CELL_UNSUPPORTED",
      );
    }
  });

  it("rejects array spill geometry even when its anchor is outside the selected range", () => {
    const input = snapshot();
    input.sheets.s1!.custom = {
      excelmanusArrays: [
        {
          id: "array",
          mode: "dynamic",
          formula: "=SEQUENCE(10)",
          range: { startRow: 1, endRow: 10, startColumn: 2, endColumn: 2 },
        },
      ],
    };
    expect(codes(extractSourceCheckDomain(input, declaration))).toContain(
      "ARRAY_DOMAIN_UNSUPPORTED",
    );
    input.sheets.s1!.custom = {};
    input.resources = [
      {
        name: "SHEET_EXCELMANUS_ARRAY_PLUGIN",
        data: JSON.stringify({
          ranges: { s1: { 1: { 2: { startRow: 1, endRow: 10, startColumn: 2, endColumn: 2 } } } },
          cells: {},
        }),
      },
    ];
    expect(codes(extractSourceCheckDomain(input, declaration))).toContain(
      "ARRAY_DOMAIN_UNSUPPORTED",
    );
  });

  it("marks malformed metadata and nonfinite/raw-object cell values unverified", () => {
    const input = snapshot();
    input.sheets.s1!.custom = { excelmanusArrays: "malformed" };
    input.sheets.s1!.cellData![5]![1] = 123;
    input.sheets.s1!.cellData![5]![2] = { v: Number.NaN };
    const result = extractSourceCheckDomain(input, declaration);
    expect(result.domain.complete).toBe(false);
    expect(codes(result)).toEqual(
      expect.arrayContaining([
        "ARRAY_METADATA_UNSUPPORTED",
        "CELL_SHAPE_UNSUPPORTED",
        "VALUE_TYPE_UNSUPPORTED",
      ]),
    );
  });

  it("rejects rich-text bodies and unsupported value objects", () => {
    const input = snapshot();
    input.sheets.s1!.cellData![5]![1] = { v: "flattened", p: { body: { dataStream: "real" } } };
    input.sheets.s1!.cellData![5]![2] = { v: { unknown: 1 } };
    const result = extractSourceCheckDomain(input, declaration);
    expect(result.domain.complete).toBe(false);
    expect(codes(result)).toEqual(
      expect.arrayContaining(["RICH_TEXT_UNSUPPORTED", "VALUE_TYPE_UNSUPPORTED"]),
    );
  });

  it("does not coerce numeric text or encoded booleans contrary to raw v type", () => {
    const input = snapshot();
    input.sheets.s1!.cellData![5]![1] = { v: "1", t: 2 };
    input.sheets.s1!.cellData![5]![2] = { v: 1, t: 3 };
    const result = extractSourceCheckDomain(input, declaration);
    expect(result.domain.complete).toBe(false);
    expect(codes(result)).toContain("DECLARED_VALUE_TYPE_MISMATCH");
    expect(result.domain.rows[1]!.cells).toEqual(["1", 1]);
  });

  it("rejects merged geometry intersecting headers or data without implicit fill", () => {
    const input = snapshot();
    input.sheets.s1!.mergeData = [{ startRow: 5, endRow: 6, startColumn: 1, endColumn: 1 }];
    const result = extractSourceCheckDomain(input, declaration);
    expect(result.domain.complete).toBe(false);
    expect(codes(result)).toContain("MERGED_DOMAIN_UNSUPPORTED");
    expect(result.domain.rows[2]!.cells[0]).toBeNull();
    input.sheets.s1!.mergeData = [{ startRow: 0, endRow: 1, startColumn: 0, endColumn: 1 }];
    expect(extractSourceCheckDomain(input, declaration).domain.complete).toBe(true);
  });

  it("preserves null versus explicit empty text and does not apply row filters", () => {
    const result = extractSourceCheckDomain(snapshot(), {
      ...declaration,
      blankPolicy: "all_cells_blank",
    });
    expect(result.domain.complete).toBe(true);
    expect(result.domain.rows).toHaveLength(4);
    expect(result.domain.rows[2]!.cells).toEqual([null, null]);
    expect(result.domain.rows[3]!.cells).toEqual(["", false]);
  });
});
