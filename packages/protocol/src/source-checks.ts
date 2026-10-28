import { z } from "zod";

const name = z.string().min(1).max(200);
const scalar = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const names = z
  .array(name)
  .max(100)
  .refine((items) => new Set(items).size === items.length);
const domain = {
  id: name,
  path: z.string().min(1),
  sheet: name,
  range: z.string().min(1),
  headerRows: z
    .array(z.int().positive())
    .max(100)
    .refine((rows) => new Set(rows).size === rows.length),
  blankPolicy: z.enum(["all_cells_blank", "none"]).optional(),
};
export const SourceDomainDeclaration = z.strictObject(domain);
export const OutputDomainDeclaration = z.strictObject(domain);
export type SourceDomainDeclaration = z.infer<typeof SourceDomainDeclaration>;
export type OutputDomainDeclaration = z.infer<typeof OutputDomainDeclaration>;

const common = {
  obligationId: name,
  requirement: z.string().min(1).max(4000),
  purpose: z.enum(["diagnostic", "required_output"]),
};
const mapping = z.strictObject({ sourceColumn: name, targetColumn: name });
const mappings = z
  .array(mapping)
  .min(1)
  .max(100)
  .refine((items) => new Set(items.map((item) => item.targetColumn)).size === items.length);
const lineageColumns = {
  sourceReferenceColumn: name,
  sourceReference: z.enum(["path", "domain_id"]),
  sourceSheetColumn: name.optional(),
  sourceRowColumn: name,
};
const anchors = z
  .array(
    z.strictObject({
      sourceColumn: name,
      targetColumn: name,
      sourceId: name.optional(),
    }),
  )
  .min(1)
  .max(100)
  .refine(
    (items) =>
      new Set(
        items.map((item) =>
          JSON.stringify([item.sourceId ?? null, item.sourceColumn, item.targetColumn]),
        ),
      ).size === items.length,
  );
const eventScope = z
  .strictObject({
    universeSourceIds: names.refine((items) => items.length > 0),
    sourceIds: names.refine((items) => items.length > 0),
    lineage: z.strictObject(lineageColumns),
    keys: mappings.refine((items) => items.length <= 10),
  })
  .refine((scope) => scope.sourceIds.every((id) => scope.universeSourceIds.includes(id)));
const legacy = {
  ...common,
  sourceIds: names,
  target: name,
};

const legacyRule = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("required"), column: name }),
  z.strictObject({ kind: z.literal("unique"), column: name }),
  z.strictObject({
    kind: z.literal("range"),
    column: name,
    min: z.union([z.number().finite(), z.string()]),
    max: z.union([z.number().finite(), z.string()]),
  }),
  z.strictObject({ kind: z.literal("pattern"), column: name, pattern: z.string().max(500) }),
  z.strictObject({
    kind: z.literal("foreign_key"),
    column: name,
    source: name,
    referenceColumn: name,
  }),
  z.strictObject({ kind: z.literal("row_expression"), expression: z.string().min(1).max(2000) }),
  z.strictObject({
    kind: z.literal("cell"),
    column: name,
    row: z.int().positive(),
    expected: scalar,
    tolerance: z.number().finite().nonnegative().optional(),
  }),
  z.strictObject({
    kind: z.literal("total"),
    column: name,
    expected: z.number().finite(),
    tolerance: z.number().finite().nonnegative().optional(),
  }),
  z.strictObject({ kind: z.literal("formula_errors"), column: name.optional() }),
]);
const alignmentBinding = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("cell"),
    column: name,
    source: name,
    referenceColumn: name,
    scale: z.number().finite().optional(),
    mergeAnchor: z.boolean().optional(),
    rowColumn: name.optional(),
    sameColumnAs: name.optional(),
  }),
  z.strictObject({
    kind: z.literal("period"),
    column: name,
    source: name,
    yearReferenceColumn: name,
    monthReferenceColumn: name,
    valueReferenceColumn: name,
  }),
  z.strictObject({
    kind: z.literal("lookup"),
    column: name,
    source: name,
    keys: mappings.refine((v) => v.length <= 10),
    valueColumn: name,
    where: z
      .array(z.strictObject({ column: name, equals: scalar }))
      .max(10)
      .optional(),
    duplicatePolicy: z.enum(["reject", "identical_rows"]).optional(),
    duplicateColumns: names.optional(),
    conflictPolicy: z.enum(["unverified", "expect_blank"]).optional(),
  }),
]);
const legacyConfig = z.strictObject({ checks: z.array(legacyRule).min(1).max(100) });
const alignmentConfig = z.strictObject({
  alignment: z.strictObject({
    requiredColumns: names.refine((v) => v.length > 0),
    bindings: z.array(alignmentBinding).min(1).max(100),
  }),
});

const aggregateMetric = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("count_rows"), targetColumn: name }),
  z.strictObject({
    op: z.enum(["sum", "count_non_null", "min", "max"]),
    sourceColumn: name,
    targetColumn: name,
  }),
]);
const aggregatePredicate = z.discriminatedUnion("op", [
  z.strictObject({ column: name, op: z.enum(["eq", "ne"]), value: scalar }),
  z.strictObject({
    column: name,
    op: z.enum(["lt", "lte", "gt", "gte"]),
    value: z.number().finite(),
  }),
]);
const typedAggregate = z
  .strictObject({
    ...common,
    kind: z.literal("typed_aggregate"),
    version: z.literal(1),
    sourceId: name,
    target: name,
    groupBy: z.array(mapping).max(100),
    metrics: z.array(aggregateMetric).min(1).max(100),
    filter: z.array(aggregatePredicate).max(20),
    nullPolicy: z.literal("ignore"),
  })
  .refine((check) => {
    const targets = [...check.groupBy, ...check.metrics].map((field) => field.targetColumn);
    return new Set(targets).size === targets.length;
  });

export const SourceCheckDeclaration = z.discriminatedUnion("kind", [
  typedAggregate,
  z
    .strictObject({
      ...common,
      kind: z.literal("row_coverage"),
      sourceIds: names.refine((items) => items.length > 0),
      target: name,
      lineage: z.strictObject({ ...lineageColumns, anchors }),
      expansion: z
        .strictObject({
          kind: z.literal("row_period"),
          targetPeriodColumn: name,
          periods: z
            .array(scalar)
            .min(1)
            .max(1000)
            .refine(
              (items) =>
                new Set(items.map((item) => JSON.stringify([typeof item, item]))).size ===
                items.length,
            ),
        })
        .optional(),
    })
    .refine((check) =>
      check.lineage.anchors.every(
        (anchor) => anchor.sourceId === undefined || check.sourceIds.includes(anchor.sourceId),
      ),
    ),
  z
    .strictObject({
      ...common,
      kind: z.literal("typed_lookup"),
      version: z.literal(1),
      dictionary: name,
      target: name,
      keys: mappings.refine((items) => items.length <= 10),
      values: mappings,
      duplicatePolicy: z.enum(["reject", "equivalent_rows"]),
      duplicateColumns: names,
      conflictPolicy: z.enum(["expect_blank", "unverified"]),
      eligibility: z.array(z.strictObject({ column: name, equals: scalar })).max(10),
      order: z.enum(["classify_then_filter", "filter_then_classify"]),
      missingPolicy: z.enum(["expect_blank", "unverified"]),
      blankKeyPolicy: z.enum(["match", "expect_blank", "unverified"]),
      blankValue: z.union([z.null(), z.literal("")]),
      eventScope: eventScope.optional(),
    })
    .refine(
      (check) =>
        !check.eventScope ||
        (check.eventScope.keys.length === check.keys.length &&
          check.keys.every((key) =>
            check.eventScope!.keys.some((eventKey) => eventKey.targetColumn === key.targetColumn),
          )),
    ),
  z.strictObject({ ...legacy, kind: z.literal("legacy_rules"), config: legacyConfig }),
  z.strictObject({ ...legacy, kind: z.literal("source_alignment"), config: alignmentConfig }),
]);
export type SourceCheckDeclaration = z.infer<typeof SourceCheckDeclaration>;

export interface SourceCheckLocation {
  domainId: string;
  path: string;
  sheet: string;
  worksheetRow?: number;
  column?: string;
}
export interface SourceCheckFinding {
  code: string;
  message: string;
  location?: SourceCheckLocation;
  sourceLocation?: SourceCheckLocation;
  actual?: unknown;
  expected?: unknown;
}
export interface SourceCheckResult {
  kind: SourceCheckDeclaration["kind"];
  obligationId: string;
  requirement: string;
  purpose: "diagnostic" | "required_output";
  status: "passed" | "failed" | "unverified";
  assurance: "source_derived" | "structural" | "declared_expression" | "unsupported";
  findings: SourceCheckFinding[];
  coveredDomains: string[];
  /** Only typed_aggregate currently returns exact, full-pass qualified output field coverage. */
  coveredFields?: string[];
  /** Host-computed physical output cells proved only by a full-pass check. */
  coveredCells?: { domainId: string; column: string; worksheetRows: number[] }[];
  uncoveredFields: string[];
  failedCount: number;
  unverifiedCount: number;
  findingsTruncated: boolean;
}
