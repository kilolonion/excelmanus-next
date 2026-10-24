import { describe, expect, it } from "vitest";
import { SourceCheckDeclaration } from "@excelmanus/protocol";
import { runSourceChecks, type SheetDomain } from "../src/source-checks.ts";

function domain(id: string, columns: string[], data: unknown[][], firstRow = 1): SheetDomain {
  return {
    id,
    path: `${id}.xlsx`,
    sheet: "Data",
    range: `A${firstRow}:${String.fromCharCode(64 + columns.length)}${firstRow + data.length}`,
    headerRows: [firstRow],
    columnNames: [...columns],
    rows: [[...columns], ...data].map((cells, i) => ({
      worksheetRow: firstRow + i,
      cells,
    })),
    complete: true,
  };
}
const common = {
  obligationId: "obligation-1",
  requirement: "原始明细逐行保留",
  purpose: "required_output" as const,
};
const coverage = {
  ...common,
  kind: "row_coverage" as const,
  sourceIds: ["raw"],
  target: "out",
  lineage: {
    sourceReferenceColumn: "file",
    sourceReference: "path" as const,
    sourceSheetColumn: "sheet",
    sourceRowColumn: "row",
    anchors: [{ sourceColumn: "id", targetColumn: "id" }],
  },
};
const lookup = {
  ...common,
  kind: "typed_lookup" as const,
  version: 1 as const,
  dictionary: "master",
  target: "out",
  keys: [{ sourceColumn: "key", targetColumn: "key" }],
  values: [{ sourceColumn: "customer", targetColumn: "customer" }],
  duplicatePolicy: "equivalent_rows" as const,
  duplicateColumns: ["key", "customer", "status"],
  conflictPolicy: "expect_blank" as const,
  eligibility: [{ column: "status", equals: "DONE" }],
  order: "classify_then_filter" as const,
  missingPolicy: "expect_blank" as const,
  blankKeyPolicy: "match" as const,
  blankValue: null,
};
function check(declaration: unknown, sources: SheetDomain[], outputs: SheetDomain[]) {
  return runSourceChecks({
    checks: [SourceCheckDeclaration.parse(declaration)],
    sources,
    outputs,
  })[0]!;
}
function codes(result: ReturnType<typeof check>) {
  return result.findings.map((finding) => finding.code);
}

function partitionFixture() {
  const orders = domain(
    "orders",
    ["key", "customer", "status", "event_id"],
    [
      ["K", "C-cancel", "CANCELLED", "O1"],
      ["J", "C-main", "DONE", "O2"],
      ["X", "C-one", "DONE", "O3"],
      ["X", "C-two", "DONE", "O4"],
    ],
  );
  const refunds = domain(
    "refunds",
    ["order_fk", "event_id", "status"],
    [
      ["J", "R1", "REJECTED"],
      ["X", "R2", "DONE"],
    ],
  );
  const payments = domain("payments", ["order_fk", "event_id", "status"], [["J", "P1", "PENDING"]]);
  const out = domain(
    "out",
    ["file", "sheet", "row", "key", "customer", "label", "event_id"],
    [
      ["orders.xlsx", "Data", 2, "K", "C-cancel", "EXCLUDED", "O1"],
      ["orders.xlsx", "Data", 3, "J", "C-main", "INCLUDED", "O2"],
      ["orders.xlsx", "Data", 4, "X", "C-one", "CONFLICT", "O3"],
      ["orders.xlsx", "Data", 5, "X", "C-two", "CONFLICT", "O4"],
      ["refunds.xlsx", "Data", 2, "J", "C-main", "EXCLUDED", "R1"],
      ["refunds.xlsx", "Data", 3, "X", null, "INCLUDED", "R2"],
      ["payments.xlsx", "Data", 2, "J", "C-main", "EXCLUDED", "P1"],
    ],
  );
  const eventScope = {
    universeSourceIds: ["orders", "refunds", "payments"],
    sourceIds: ["refunds", "payments"],
    lineage: {
      sourceReferenceColumn: "file",
      sourceReference: "path" as const,
      sourceSheetColumn: "sheet",
      sourceRowColumn: "row",
    },
    keys: [{ sourceColumn: "order_fk", targetColumn: "key" }],
  };
  const declaration = { ...lookup, dictionary: "orders", eventScope };
  const copy = {
    ...coverage,
    sourceIds: eventScope.universeSourceIds,
    lineage: {
      ...coverage.lineage,
      anchors: [
        { sourceColumn: "event_id", targetColumn: "event_id" },
        { sourceColumn: "key", targetColumn: "key", sourceId: "orders" },
        { sourceColumn: "customer", targetColumn: "customer", sourceId: "orders" },
        { sourceColumn: "order_fk", targetColumn: "key", sourceId: "refunds" },
        { sourceColumn: "order_fk", targetColumn: "key", sourceId: "payments" },
      ],
    },
  };
  return {
    orders,
    refunds,
    payments,
    out,
    declaration,
    copy,
    sources: [orders, refunds, payments],
  };
}
function uncheckedCheck(declaration: unknown, sources: SheetDomain[], out: SheetDomain) {
  return runSourceChecks({
    checks: [declaration as SourceCheckDeclaration],
    sources,
    outputs: [out],
  })[0]!;
}
function coveredRows(result: ReturnType<typeof check>, column: string): number[] {
  return (
    (
      result as unknown as {
        coveredCells?: { domainId: string; column: string; worksheetRows: number[] }[];
      }
    ).coveredCells?.find((entry) => entry.domainId === "out" && entry.column === column)
      ?.worksheetRows ?? []
  );
}

describe("raw-origin partitions and exact cell evidence", () => {
  it("accepts only source-bound scopes and source-scoped anchors", () => {
    const f = partitionFixture();
    expect(SourceCheckDeclaration.safeParse(f.declaration).success).toBe(true);
    expect(SourceCheckDeclaration.safeParse(f.copy).success).toBe(true);
    for (const eventScope of [
      { ...f.declaration.eventScope, filter: [{ column: "label", equals: "INCLUDED" }] },
      { ...f.declaration.eventScope, sourceIds: [] },
      { ...f.declaration.eventScope, sourceIds: ["missing"] },
      { ...f.declaration.eventScope, keys: [] },
      {
        ...f.declaration.eventScope,
        keys: [{ sourceColumn: "order_fk", targetColumn: "customer" }],
      },
      {
        ...f.declaration.eventScope,
        keys: [...f.declaration.eventScope.keys, ...f.declaration.eventScope.keys],
      },
    ])
      expect(SourceCheckDeclaration.safeParse({ ...f.declaration, eventScope }).success).toBe(
        false,
      );
  });

  it("keeps cancelled/conflicted origin identities and maps excluded child events independently", () => {
    const f = partitionFixture();
    const copy = uncheckedCheck(f.copy, f.sources, f.out);
    const mapped = uncheckedCheck(f.declaration, f.sources, f.out);
    expect(copy.status).toBe("passed");
    expect(mapped.status).toBe("passed");
    expect(coveredRows(copy, "customer")).toEqual([2, 3, 4, 5]);
    expect(coveredRows(mapped, "customer")).toEqual([6, 7, 8]);
    expect(coveredRows(mapped, "key")).toEqual([6, 7, 8]);
    expect(coveredRows(mapped, "file")).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(coveredRows(copy, "key")).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(mapped.uncoveredFields).toContain("out.customer");
    expect(copy.uncoveredFields).toContain("out.customer");
  });

  it("never lets target status labels suppress selected lookup checks", () => {
    const f = partitionFixture();
    f.out.rows[5]!.cells[4] = null;
    f.out.rows[5]!.cells[5] = "NOT_AN_EVENT";
    const result = uncheckedCheck(f.declaration, f.sources, f.out);
    expect(result.status).toBe("failed");
    expect(codes(result)).toContain("LOOKUP_VALUE_MISMATCH");
    expect(coveredRows(result, "file")).toEqual([]);
    expect(result.coveredDomains).toEqual([]);
  });

  it("anchors raw foreign keys before dictionary lookup even when a forged key would match", () => {
    const f = partitionFixture();
    f.out.rows[5]!.cells[3] = "K";
    f.out.rows[5]!.cells[4] = null;
    const result = uncheckedCheck(f.declaration, f.sources, f.out);
    expect(result.status).toBe("failed");
    expect(codes(result)).toContain("LINEAGE_ANCHOR_MISMATCH");
    expect(codes(result)).not.toContain("LOOKUP_VALUE_MISMATCH");
    expect(coveredRows(result, "key")).toEqual([]);
  });

  it("validates full universe multiplicity before selecting a raw-origin subset", () => {
    const f = partitionFixture();
    f.out.rows[1]!.cells = [...f.out.rows[2]!.cells];
    const result = uncheckedCheck(f.declaration, f.sources, f.out);
    expect(result.status).toBe("failed");
    expect(codes(result)).toEqual(expect.arrayContaining(["LINEAGE_DUPLICATE", "LINEAGE_MISSING"]));
    expect(coveredRows(result, "customer")).toEqual([]);
  });

  it("rejects invalid lineage types and rows outside the full raw universe", () => {
    for (const bad of ["2", 99]) {
      const f = partitionFixture();
      f.out.rows[5]!.cells[2] = bad;
      const result = uncheckedCheck(f.declaration, f.sources, f.out);
      expect(result.status).toBe("failed");
      expect(coveredRows(result, "customer")).toEqual([]);
    }
  });

  it("refuses incomplete, overlapping and blank-filtered event universes", () => {
    const f = partitionFixture();
    const alias = { ...f.refunds, id: "refund-alias" };
    const overlapping = {
      ...f.declaration,
      eventScope: {
        ...f.declaration.eventScope,
        universeSourceIds: [...f.declaration.eventScope.universeSourceIds, alias.id],
      },
    };
    for (const [declaration, sources, out] of [
      [f.declaration, [f.orders, { ...f.refunds, complete: false }, f.payments], f.out],
      [overlapping, [...f.sources, alias], f.out],
      [
        f.declaration,
        [f.orders, { ...f.refunds, blankPolicy: "all_cells_blank" }, f.payments],
        f.out,
      ],
      [f.declaration, f.sources, { ...f.out, blankPolicy: "all_cells_blank" }],
    ] as [unknown, SheetDomain[], SheetDomain][]) {
      const result = uncheckedCheck(declaration, sources, out);
      expect(result.status).toBe("unverified");
      expect(coveredRows(result, "file")).toEqual([]);
    }
  });

  it("does not let scoped anchors override global anchors", () => {
    const f = partitionFixture();
    const declaration = {
      ...f.copy,
      lineage: {
        ...f.copy.lineage,
        anchors: [
          ...f.copy.lineage.anchors,
          { sourceId: "orders", sourceColumn: "key", targetColumn: "event_id" },
        ],
      },
    };
    const result = uncheckedCheck(declaration, f.sources, f.out);
    expect(result.status).toBe("failed");
    expect(codes(result)).toContain("LINEAGE_ANCHOR_MISMATCH");
    expect(coveredRows(result, "event_id")).toEqual([]);
  });

  it("fails a scoped anchor on its own raw rows and refuses undeclared anchor scope", () => {
    const f = partitionFixture();
    f.out.rows[1]!.cells[4] = null;
    const result = uncheckedCheck(f.copy, f.sources, f.out);
    expect(result.status).toBe("failed");
    expect(codes(result)).toContain("LINEAGE_ANCHOR_MISMATCH");
    expect(
      uncheckedCheck(
        {
          ...f.copy,
          lineage: {
            ...f.copy.lineage,
            anchors: [{ sourceColumn: "key", targetColumn: "key", sourceId: "outside" }],
          },
        },
        f.sources,
        f.out,
      ).status,
    ).toBe("unverified");
  });

  it("keeps typed event foreign keys distinct from numeric dictionary keys", () => {
    const f = partitionFixture();
    f.refunds.rows[1]!.cells[0] = "001";
    f.out.rows[5]!.cells[3] = 1;
    f.out.rows[5]!.cells[4] = null;
    expect(uncheckedCheck(f.declaration, f.sources, f.out).status).toBe("failed");
    f.out.rows[5]!.cells[3] = "001";
    expect(uncheckedCheck(f.declaration, f.sources, f.out).status).toBe("passed");
  });

  it("supports domain-id lineage without relying on output event labels", () => {
    const f = partitionFixture();
    for (const row of f.out.rows.slice(1))
      row.cells[0] = (row.cells[0] as string).replace(".xlsx", "");
    const declaration = {
      ...f.declaration,
      eventScope: {
        ...f.declaration.eventScope,
        lineage: { ...f.declaration.eventScope.lineage, sourceReference: "domain_id" },
      },
    };
    expect(uncheckedCheck(declaration, f.sources, f.out).status).toBe("passed");
  });

  it("does not claim unanchored lookup keys as cell evidence even through self-value mapping", () => {
    const master = domain("master", ["key", "customer", "status"], [["A", "C", "DONE"]]);
    const out = domain("out", ["key", "customer"], [["A", "C"]]);
    const result = check(
      { ...lookup, values: [...lookup.values, { sourceColumn: "key", targetColumn: "key" }] },
      [master],
      [out],
    );
    expect(result.status).toBe("passed");
    expect(coveredRows(result, "customer")).toEqual([2]);
    expect(coveredRows(result, "key")).toEqual([]);
    expect(result.uncoveredFields).toContain("out.key");
  });

  it("reports exact physical rows for aggregate and ordinary lineage coverage", () => {
    const raw = domain("raw", ["g"], [["A"], ["B"]]);
    const out = domain(
      "out",
      ["g", "n", "memo"],
      [
        ["A", 1, null],
        ["B", 1, null],
      ],
      8,
    );
    const result = aggregateResult(aggregate, raw, out);
    expect(result.status).toBe("passed");
    expect(coveredRows(result, "n")).toEqual([9, 10]);
    expect(coveredRows(result, "g")).toEqual([9, 10]);
    expect(coveredRows(result, "memo")).toEqual([]);
    const copied = check(
      coverage,
      [domain("raw", ["id"], [["A"]])],
      [domain("out", ["file", "sheet", "row", "id"], [["raw.xlsx", "Data", 2, "A"]], 8)],
    );
    expect(coveredRows(copied, "id")).toEqual([9]);
  });
});

const aggregate = {
  ...common,
  kind: "typed_aggregate",
  version: 1,
  sourceId: "raw",
  target: "out",
  groupBy: [{ sourceColumn: "g", targetColumn: "g" }],
  metrics: [{ op: "count_rows", targetColumn: "n" }],
  filter: [],
  nullPolicy: "ignore",
};
function aggregateResult(declaration: unknown, raw: SheetDomain, out: SheetDomain) {
  return runSourceChecks({
    checks: [declaration as SourceCheckDeclaration],
    sources: [raw],
    outputs: [out],
  })[0]!;
}

describe("bounded typed aggregate", () => {
  it("accepts only the frozen strict whitelist and distinct output fields", () => {
    expect(SourceCheckDeclaration.safeParse(aggregate).success).toBe(true);
    for (const declaration of [
      { ...aggregate, sql: "SELECT 1" },
      { ...aggregate, kind: "source_query" },
      { ...aggregate, metrics: [{ op: "constant", targetColumn: "n", value: 1 }] },
      { ...aggregate, metrics: [{ op: "count_rows", targetColumn: "n", sourceColumn: "g" }] },
      { ...aggregate, metrics: [{ op: "count_rows", targetColumn: "g" }] },
      { ...aggregate, groupBy: [{ sourceColumn: "g", targetColumn: 1 }] },
      { ...aggregate, filter: [{ column: "g", op: "gt", value: "1" }] },
    ])
      expect(SourceCheckDeclaration.safeParse(declaration).success).toBe(false);
  });

  it("preserves typed group keys and duplicate source multiplicity", () => {
    const raw = domain("raw", ["g"], [["001"], ["1"], [1], [1], [null], [""], [false]]);
    const out = domain(
      "out",
      ["g", "n"],
      [
        [1, 2],
        ["1", 1],
        ["001", 1],
        [null, 1],
        ["", 1],
        [false, 1],
      ],
    );
    const result = aggregateResult(aggregate, raw, out);
    expect(result.status).toBe("passed");
    expect(result.assurance).toBe("declared_expression");
    expect(result.coveredFields).toEqual(["out.g", "out.n"]);
    expect(result.coveredDomains).toEqual(["raw", "out"]);
  });

  it("compares a full multiset, not equal output counts or deduplicated groups", () => {
    const raw = domain("raw", ["g"], [["A"], ["B"]]);
    const result = aggregateResult(
      aggregate,
      raw,
      domain(
        "out",
        ["g", "n"],
        [
          ["A", 1],
          ["A", 1],
        ],
      ),
    );
    expect(result.status).toBe("failed");
    expect(codes(result)).toContain("AGGREGATE_UNEXPECTED_ROW");
    expect(codes(result)).toContain("AGGREGATE_MISSING_ROW");
    expect(result.coveredFields).toEqual([]);
    expect(result.coveredDomains).toEqual([]);
    expect(result.uncoveredFields).toEqual(["out.g", "out.n"]);
  });

  const metrics = [
    { op: "count_rows", targetColumn: "n" },
    { op: "count_non_null", sourceColumn: "v", targetColumn: "nn" },
    { op: "sum", sourceColumn: "v", targetColumn: "sum" },
    { op: "min", sourceColumn: "v", targetColumn: "min" },
    { op: "max", sourceColumn: "v", targetColumn: "max" },
  ];
  it("distinguishes all-null aggregates from real zero", () => {
    const raw = domain(
      "raw",
      ["g", "v"],
      [
        ["A", null],
        ["A", 0],
        ["A", 2],
        ["B", null],
        ["C", 0],
      ],
    );
    const out = domain(
      "out",
      ["g", "n", "nn", "sum", "min", "max"],
      [
        ["A", 3, 2, 2, 0, 2],
        ["B", 1, 0, null, null, null],
        ["C", 1, 1, 0, 0, 0],
      ],
    );
    expect(aggregateResult({ ...aggregate, metrics }, raw, out).status).toBe("passed");
    out.rows[2]!.cells[3] = 0;
    expect(aggregateResult({ ...aggregate, metrics }, raw, out).status).toBe("failed");
  });

  it("defines empty global aggregates and empty grouped output explicitly", () => {
    const raw = domain("raw", ["g", "v"], []);
    expect(
      aggregateResult(
        { ...aggregate, groupBy: [], metrics },
        raw,
        domain("out", ["n", "nn", "sum", "min", "max"], [[0, 0, null, null, null]]),
      ).status,
    ).toBe("passed");
    expect(aggregateResult(aggregate, raw, domain("out", ["g", "n"], [])).status).toBe("passed");
    expect(
      aggregateResult(
        { ...aggregate, groupBy: [], metrics },
        raw,
        domain("out", ["n", "nn", "sum", "min", "max"], []),
      ).status,
    ).toBe("failed");
  });

  it("counts every nonnull scalar without treating blank text false or zero as null", () => {
    const declaration = {
      ...aggregate,
      groupBy: [],
      metrics: [{ op: "count_non_null", sourceColumn: "v", targetColumn: "nn" }],
    };
    expect(
      aggregateResult(
        declaration,
        domain("raw", ["v"], [[null], [""], [false], [0]]),
        domain("out", ["nn"], [[3]]),
      ).status,
    ).toBe("passed");
  });

  it("accumulates safe integers exactly and rejects overflow decimals and coercion", () => {
    const declaration = {
      ...aggregate,
      groupBy: [],
      metrics: [{ op: "sum", sourceColumn: "v", targetColumn: "sum" }],
    };
    const max = Number.MAX_SAFE_INTEGER;
    expect(
      aggregateResult(
        declaration,
        domain("raw", ["v"], [[max], [max], [-max]]),
        domain("out", ["sum"], [[max]]),
      ).status,
    ).toBe("passed");
    for (const values of [[[max], [1]], [[0.1]], [["2"]], [[false]]]) {
      const result = aggregateResult(
        declaration,
        domain("raw", ["v"], values),
        domain("out", ["sum"], [[0]]),
      );
      expect(result.status).toBe("unverified");
      expect(result.coveredFields).toEqual([]);
    }
  });

  it("permits finite numeric min/max without admitting nonnumeric operands", () => {
    const declaration = { ...aggregate, groupBy: [], metrics: metrics.slice(3) };
    const out = domain("out", ["min", "max"], [[-1.5, 2.5]]);
    expect(
      aggregateResult(declaration, domain("raw", ["v"], [[null], [2.5], [-1.5]]), out).status,
    ).toBe("passed");
    expect(aggregateResult(declaration, domain("raw", ["v"], [[false]]), out).status).toBe(
      "unverified",
    );
  });

  it("filters only raw source rows with exact typed equality and conjunction", () => {
    const declaration = {
      ...aggregate,
      filter: [
        { column: "g", op: "eq", value: 1 },
        { column: "s", op: "ne", value: null },
      ],
    };
    const raw = domain(
      "raw",
      ["g", "s"],
      [
        [1, "keep"],
        ["1", "keep"],
        [1, null],
        [1, ""],
      ],
    );
    expect(aggregateResult(declaration, raw, domain("out", ["g", "n"], [[1, 2]])).status).toBe(
      "passed",
    );
    expect(
      aggregateResult(
        declaration,
        raw,
        domain(
          "out",
          ["g", "n", "label"],
          [
            [1, 2, "keep"],
            ["1", 1, "excluded"],
          ],
        ),
      ).status,
    ).toBe("failed");
  });

  it("checks numeric predicates without coercion or order-dependent type hiding", () => {
    const declaration = {
      ...aggregate,
      filter: [
        { column: "v", op: "gte", value: 2 },
        { column: "v", op: "lt", value: 4 },
      ],
    };
    const out = domain("out", ["g", "n"], [["A", 1]]);
    expect(
      aggregateResult(
        declaration,
        domain(
          "raw",
          ["g", "v"],
          [
            ["A", null],
            ["A", 2],
            ["A", 4],
          ],
        ),
        out,
      ).status,
    ).toBe("passed");
    const invalid = {
      ...declaration,
      filter: [{ column: "g", op: "eq", value: "never" }, ...declaration.filter],
    };
    expect(aggregateResult(invalid, domain("raw", ["g", "v"], [["A", "2"]]), out).status).toBe(
      "unverified",
    );
  });

  it("rejects clipped domains, blank-row erasure and ambiguous target names", () => {
    const raw = domain("raw", ["g"], [[null], ["A"]]);
    const out = domain(
      "out",
      ["g", "n"],
      [
        [null, 1],
        ["A", 1],
      ],
    );
    expect(aggregateResult(aggregate, raw, out).status).toBe("passed");
    expect(aggregateResult(aggregate, { ...raw, complete: false }, out).status).toBe("unverified");
    expect(aggregateResult(aggregate, { ...raw, rows: raw.rows.slice(0, 2) }, out).status).toBe(
      "unverified",
    );
    expect(aggregateResult(aggregate, { ...raw, blankPolicy: "all_cells_blank" }, out).status).toBe(
      "unverified",
    );
    expect(aggregateResult(aggregate, raw, { ...out, blankPolicy: "all_cells_blank" }).status).toBe(
      "unverified",
    );
    expect(aggregateResult(aggregate, raw, domain("out", ["g", "g"], [["A", 1]])).status).toBe(
      "unverified",
    );
  });

  it("rejects a source bound to the same canonical file as an output", () => {
    const raw = domain("raw", ["g"], [["A"]]);
    const out = domain("out", ["g", "n"], [["A", 1]]);
    expect(aggregateResult(aggregate, raw, { ...out, path: raw.path }).status).toBe("unverified");
  });

  it("covers only mapped fields and counts every persisted target row", () => {
    const raw = domain("raw", ["g"], [["A"]]);
    const out = domain("out", ["g", "n", "memo"], [["A", 1, "unchecked"]]);
    const result = aggregateResult({ ...aggregate, purpose: "diagnostic" }, raw, out);
    expect(result.status).toBe("passed");
    expect(result.purpose).toBe("required_output");
    expect(result.coveredFields).toEqual(["out.g", "out.n"]);
    expect(result.uncoveredFields).toEqual(["out.memo"]);
    expect(
      aggregateResult(
        aggregate,
        raw,
        domain(
          "out",
          ["g", "n", "memo"],
          [
            ["A", 1, "ok"],
            [null, null, "extra"],
          ],
        ),
      ).status,
    ).toBe("failed");
  });

  it("does not rely on physical row iteration order", () => {
    const raw = domain("raw", ["g"], [["A"], ["B"]]);
    raw.rows.reverse();
    expect(
      aggregateResult(
        aggregate,
        raw,
        domain(
          "out",
          ["g", "n"],
          [
            ["B", 1],
            ["A", 1],
          ],
        ),
      ).status,
    ).toBe("passed");
  });

  it("keeps an existing failed source-derived obligation separate", () => {
    const raw = domain("raw", ["g", "id"], [["A", "a"]]);
    const out = domain("out", ["g", "n"], [["A", 1]]);
    const missing = domain("missing", ["file", "sheet", "row", "id"], []);
    const results = runSourceChecks({
      checks: [{ ...coverage, target: "missing" }, aggregate as SourceCheckDeclaration],
      sources: [raw],
      outputs: [missing, out],
    });
    expect(results[0]!.status).toBe("failed");
    expect(results[0]!.assurance).toBe("source_derived");
    expect(results[1]!.status).toBe("passed");
    expect(results[1]!.assurance).toBe("declared_expression");
  });
});

describe("source-derived row coverage", () => {
  it("retains physical rows after interior blanks and includes excluded events", () => {
    const raw = domain(
      "raw",
      ["id", "status"],
      [
        ["A", "DONE"],
        [null, null],
        ["B", "EXCLUDED"],
      ],
      5,
    );
    raw.blankPolicy = "all_cells_blank";
    const out = domain(
      "out",
      ["file", "sheet", "row", "id", "reason"],
      [
        ["raw.xlsx", "Data", 6, "A", null],
        ["raw.xlsx", "Data", 8, "B", "excluded"],
      ],
    );
    const result = check(coverage, [raw], [out]);
    expect(result.status).toBe("passed");
    expect(result.assurance).toBe("source_derived");
    expect(result.uncoveredFields).toContain("out.reason");
  });

  it("detects equal-count missing plus duplicate lineage", () => {
    const raw = domain("raw", ["id"], [["A"], ["B"]]);
    const out = domain(
      "out",
      ["file", "sheet", "row", "id"],
      [
        ["raw.xlsx", "Data", 2, "A"],
        ["raw.xlsx", "Data", 2, "A"],
      ],
    );
    const result = check(coverage, [raw], [out]);
    expect(result.status).toBe("failed");
    expect(codes(result)).toEqual(expect.arrayContaining(["LINEAGE_MISSING", "LINEAGE_DUPLICATE"]));
  });

  it("distinguishes invalid, out-of-universe and fabricated anchor references", () => {
    const raw = domain("raw", ["id"], [["001"], ["B"]]);
    const out = domain(
      "out",
      ["file", "sheet", "row", "id"],
      [
        ["raw.xlsx", "Data", "2", "001"],
        ["elsewhere.xlsx", "Data", 3, "B"],
        ["raw.xlsx", "Data", 2, 1],
      ],
    );
    const result = check(coverage, [raw], [out]);
    expect(result.status).toBe("failed");
    expect(codes(result)).toEqual(
      expect.arrayContaining([
        "LINEAGE_INVALID",
        "LINEAGE_OUT_OF_UNIVERSE",
        "LINEAGE_ANCHOR_MISMATCH",
        "LINEAGE_MISSING",
      ]),
    );
  });

  it("does not drop blank raw rows unless policy explicitly allows it", () => {
    const raw = domain("raw", ["id"], [["A"], [null], ["B"]]);
    const out = domain(
      "out",
      ["file", "sheet", "row", "id"],
      [
        ["raw.xlsx", "Data", 2, "A"],
        ["raw.xlsx", "Data", 4, "B"],
      ],
    );
    expect(check(coverage, [raw], [out]).status).toBe("failed");
    raw.blankPolicy = "all_cells_blank";
    expect(check(coverage, [raw], [out]).status).toBe("passed");
  });

  it("reports missing, partial and clipped domains unverified without shrinking denominator", () => {
    const raw = domain("raw", ["id"], [["A"], ["B"]]);
    const out = domain("out", ["file", "sheet", "row", "id"], [["raw.xlsx", "Data", 2, "A"]]);
    expect(check(coverage, [], [out]).status).toBe("unverified");
    expect(check(coverage, [{ ...raw, complete: false }], [out]).status).toBe("unverified");
    expect(check(coverage, [{ ...raw, rows: raw.rows.slice(0, 2) }], [out]).status).toBe(
      "unverified",
    );
    expect(check(coverage, [raw], [{ ...out, complete: false }]).status).toBe("unverified");
  });

  it("checks explicit row by period multiplicity instead of total count", () => {
    const raw = domain("raw", ["id"], [["A"], ["B"]]);
    const out = domain(
      "out",
      ["file", "sheet", "row", "id", "period"],
      [
        ["raw.xlsx", "Data", 2, "A", "Jan"],
        ["raw.xlsx", "Data", 2, "A", "Feb"],
        ["raw.xlsx", "Data", 3, "B", "Jan"],
        ["raw.xlsx", "Data", 3, "B", "Jan"],
      ],
    );
    const declaration = {
      ...coverage,
      expansion: {
        kind: "row_period",
        targetPeriodColumn: "period",
        periods: ["Jan", "Feb"],
      },
    };
    const result = check(declaration, [raw], [out]);
    expect(result.status).toBe("failed");
    expect(codes(result)).toEqual(expect.arrayContaining(["LINEAGE_MISSING", "LINEAGE_DUPLICATE"]));
    out.rows[4]!.cells[4] = "Feb";
    expect(check(declaration, [raw], [out]).status).toBe("passed");
  });

  it("rejects ambiguous physical identities across overlapping source domains", () => {
    const raw = domain("raw", ["id"], [["A"]]);
    const alias = { ...raw, id: "raw-alias" };
    const out = domain("out", ["file", "sheet", "row", "id"], [["raw.xlsx", "Data", 2, "A"]]);
    const result = check({ ...coverage, sourceIds: ["raw", "raw-alias"] }, [raw, alias], [out]);
    expect(result.status).toBe("unverified");
    expect(codes(result)).toContain("SOURCE_DOMAIN_OVERLAP");
    expect(result.failedCount).toBe(0);
  });

  it("forces output-bound checks to required_output even if labeled diagnostic", () => {
    const raw = domain("raw", ["id"], [["A"]]);
    const out = domain("out", ["file", "sheet", "row", "id"], []);
    const result = check({ ...coverage, purpose: "diagnostic" }, [raw], [out]);
    expect(result.purpose).toBe("required_output");
    expect(result.status).toBe("failed");
  });
});

describe("typed dictionary lookup", () => {
  it("separates typed keys without trim or coercion, including blank and zero", () => {
    const keys = ["001", "1", 1, " ", "", null, 0, false];
    const master = domain(
      "master",
      ["key", "customer", "status"],
      keys.map((key, i) => [key, `C${i}`, "DONE"]),
    );
    const out = domain(
      "out",
      ["key", "customer"],
      keys.map((key, i) => [key, `C${i}`]),
    );
    expect(check(lookup, [master], [out]).status).toBe("passed");
    out.rows[1]!.cells[1] = "C2";
    expect(codes(check(lookup, [master], [out]))).toContain("LOOKUP_VALUE_MISMATCH");
  });

  it("uses collision-free composite keys rather than delimiter concatenation", () => {
    const master = domain(
      "master",
      ["a", "b", "customer", "status"],
      [
        ["a|b", "c", "One", "DONE"],
        ["a", "b|c", "Two", "DONE"],
      ],
    );
    const out = domain(
      "out",
      ["a", "b", "customer"],
      [
        ["a|b", "c", "One"],
        ["a", "b|c", "Two"],
      ],
    );
    expect(
      check(
        {
          ...lookup,
          keys: [
            { sourceColumn: "a", targetColumn: "a" },
            { sourceColumn: "b", targetColumn: "b" },
          ],
          duplicateColumns: ["a", "b", "customer", "status"],
        },
        [master],
        [out],
      ).status,
    ).toBe("passed");
  });

  it("classifies raw conflicts before filtering unless filter-first is explicit", () => {
    const master = domain(
      "master",
      ["key", "customer", "status"],
      [
        ["K", "Alice", "DONE"],
        ["K", "Alice", "CANCELLED"],
      ],
    );
    const out = domain("out", ["key", "customer"], [["K", "Alice"]]);
    expect(check(lookup, [master], [out]).status).toBe("failed");
    expect(check({ ...lookup, order: "filter_then_classify" }, [master], [out]).status).toBe(
      "passed",
    );
    out.rows[1]!.cells[1] = null;
    expect(check(lookup, [master], [out]).status).toBe("passed");
  });

  it("never selects a first match from conflicting master values", () => {
    const master = domain(
      "master",
      ["key", "customer", "status"],
      [
        ["K", "Alice", "DONE"],
        ["K", "Bob", "DONE"],
      ],
    );
    const out = domain("out", ["key", "customer"], [["K", "Alice"]]);
    expect(check(lookup, [master], [out]).status).toBe("failed");
    expect(check({ ...lookup, conflictPolicy: "unverified" }, [master], [out]).status).toBe(
      "unverified",
    );
    expect(check({ ...lookup, duplicateColumns: ["key", "status"] }, [master], [out]).status).toBe(
      "unverified",
    );
  });

  it("retains identity on excluded and conflicting events with an unambiguous master", () => {
    const master = domain("master", ["key", "customer", "status"], [["K", "Alice", "DONE"]]);
    const out = domain(
      "out",
      ["key", "customer", "reason", "amount"],
      [
        ["K", "Alice", "EXCLUDED", 0],
        ["K", null, "EVENT_CONFLICT", -1],
      ],
    );
    const result = check(lookup, [master], [out]);
    expect(result.status).toBe("failed");
    expect(result.failedCount).toBe(1);
    expect(result.findings[0]!.location?.worksheetRow).toBe(3);
    out.rows[2]!.cells[1] = "Alice";
    expect(check(lookup, [master], [out]).status).toBe("passed");
  });

  it("uses explicit absent and blank-key policies, never forces identity nonblank", () => {
    const master = domain(
      "master",
      ["key", "customer", "status"],
      [
        ["K", "Alice", "CANCELLED"],
        [null, "Empty", "DONE"],
      ],
    );
    const out = domain(
      "out",
      ["key", "customer"],
      [
        ["K", null],
        ["unknown", null],
        [null, null],
      ],
    );
    expect(check({ ...lookup, blankKeyPolicy: "expect_blank" }, [master], [out]).status).toBe(
      "passed",
    );
    expect(check({ ...lookup, blankKeyPolicy: "unverified" }, [master], [out]).status).toBe(
      "unverified",
    );
    expect(
      check(
        { ...lookup, missingPolicy: "unverified", blankKeyPolicy: "expect_blank" },
        [master],
        [out],
      ).status,
    ).toBe("unverified");
    // A known identity mismatch still wins over other rows' unknown lookup outcomes.
    expect(check({ ...lookup, missingPolicy: "unverified" }, [master], [out]).status).toBe(
      "failed",
    );
  });

  it("distinguishes equivalent duplicates from a reject-all-duplicates policy", () => {
    const master = domain(
      "master",
      ["key", "customer", "status"],
      [
        ["K", "Alice", "DONE"],
        ["K", "Alice", "DONE"],
      ],
    );
    const out = domain("out", ["key", "customer"], [["K", "Alice"]]);
    expect(check(lookup, [master], [out]).status).toBe("passed");
    expect(check({ ...lookup, duplicatePolicy: "reject" }, [master], [out]).status).toBe("failed");
  });

  it("marks unknown values and absent columns unverified instead of normalizing them", () => {
    const master = domain(
      "master",
      ["key", "customer", "status"],
      [["K", { unsupported: 1 }, "DONE"]],
    );
    const out = domain("out", ["key", "customer"], [["K", null]]);
    expect(check(lookup, [master], [out]).status).toBe("unverified");
    expect(
      check(
        {
          ...lookup,
          values: [{ sourceColumn: "absent", targetColumn: "customer" }],
        },
        [master],
        [out],
      ).status,
    ).toBe("unverified");
    master.rows[1]!.cells[1] = Number.NaN;
    expect(check(lookup, [master], [out]).status).toBe("unverified");
  });
});

describe("source check contract", () => {
  it("requires one physical header and does not trust renamed column metadata", () => {
    const master = domain("master", ["key", "customer", "status"], [["K", "Alice", "DONE"]]);
    const out = domain("out", ["key", "customer"], [["K", "Alice"]]);
    expect(check(lookup, [{ ...master, headerRows: [] }], [out]).status).toBe("unverified");
    expect(check(lookup, [{ ...master, headerRows: [1, 2] }], [out]).status).toBe("unverified");
    master.rows[0]!.cells[1] = "different";
    expect(check(lookup, [master], [out]).status).toBe("unverified");
    expect(codes(check(lookup, [master], [out]))).toContain("HEADER_MISSING_DUPLICATE_OR_RENAMED");
  });

  it("does not treat empty text, whitespace, zero or false as blank rows", () => {
    const raw = domain("raw", ["id"], [[null], [""], [" "], [0], [false]]);
    raw.blankPolicy = "all_cells_blank";
    const out = domain("out", ["file", "sheet", "row", "id"], []);
    expect(check(coverage, [raw], [out]).failedCount).toBe(4);
  });

  it("rejects arbitrary executable checkers and undocumented fields", () => {
    expect(SourceCheckDeclaration.safeParse({ ...coverage, code: "return true" }).success).toBe(
      false,
    );
    expect(
      SourceCheckDeclaration.safeParse({
        ...common,
        kind: "custom_code",
        code: "return true",
      }).success,
    ).toBe(false);
    expect(
      SourceCheckDeclaration.safeParse({
        ...coverage,
        sourceIds: ["raw", "raw"],
      }).success,
    ).toBe(false);
    expect(
      SourceCheckDeclaration.safeParse({
        ...coverage,
        expansion: {
          kind: "row_period",
          targetPeriodColumn: "month",
          periods: [1, 1],
        },
      }).success,
    ).toBe(false);
  });

  it("does not elevate a legacy expression to an independent oracle", () => {
    const result = check(
      {
        ...common,
        kind: "legacy_rules",
        sourceIds: [],
        target: "out",
        config: {
          rules: [{ kind: "row_expression", expression: "amount = amount" }],
        },
      },
      [],
      [],
    );
    expect(result.status).toBe("unverified");
    expect(result.assurance).toBe("unsupported");
    expect(codes(result)).toContain("HOST_ADAPTER_REQUIRED");
  });

  it("retains complete failure counts when examples are truncated", () => {
    const raw = domain(
      "raw",
      ["id"],
      Array.from({ length: 120 }, (_, i) => [i]),
    );
    const out = domain("out", ["file", "sheet", "row", "id"], []);
    const result = check(coverage, [raw], [out]);
    expect(result.status).toBe("failed");
    expect(result.failedCount).toBe(120);
    expect(result.findings).toHaveLength(100);
    expect(result.findingsTruncated).toBe(true);
  });
});
