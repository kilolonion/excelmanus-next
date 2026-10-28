import type { HarnessPlan, SourceCheckDeclaration } from "@excelmanus/protocol";
import type { SheetDomain } from "@excelmanus/workbook";

export interface PreparationDiagnostic {
  status: "invalid" | "unsupported";
  code: string;
  domainId?: string;
  obligationId?: string;
  column?: string;
}
export function preflightCheckFields(
  plan: Pick<HarnessPlan, "sources" | "outputs" | "checks">,
  domains: SheetDomain[],
): PreparationDiagnostic[] {
  const issues: PreparationDiagnostic[] = [];
  const add = (
    check: SourceCheckDeclaration,
    code: string,
    domainId?: string,
    column?: string,
    status: "invalid" | "unsupported" = "invalid",
  ) =>
    issues.push({
      status,
      code,
      obligationId: check.obligationId,
      ...(domainId ? { domainId } : {}),
      ...(column ? { column } : {}),
    });
  const field = (check: SourceCheckDeclaration, id: string, column: string) => {
    const d = domains.find((d) => d.id === id);
    if (!d) add(check, "DOMAIN_NOT_DECLARED", id);
    else if (!d.columnNames.includes(column)) add(check, "FIELD_NOT_FOUND", id, column);
  };
  const source = (check: SourceCheckDeclaration, id: string) => {
    if (!plan.sources.some((s) => s.id === id)) add(check, "SOURCE_NOT_DECLARED", id);
  };
  for (const check of plan.checks) {
    const target = domains.find((d) => d.id === check.target);
    if (!target) {
      add(check, "TARGET_NOT_DECLARED", check.target);
      continue;
    }
    const targetField = (column: string) => field(check, check.target, column);
    if (check.kind === "typed_aggregate") {
      source(check, check.sourceId);
      for (const m of [...check.groupBy, ...check.metrics]) {
        targetField(m.targetColumn);
        if ("sourceColumn" in m) field(check, check.sourceId, m.sourceColumn);
      }
      for (const f of check.filter) field(check, check.sourceId, f.column);
      const actualColumns = new Set(target.columnNames);
      const declaredColumns = [...check.groupBy, ...check.metrics].map((m) => m.targetColumn);
      if (
        actualColumns.size !== declaredColumns.length ||
        declaredColumns.some((c) => !actualColumns.has(c)) ||
        (!check.groupBy.length &&
          target.rows.filter((r) => !target.headerRows.includes(r.worksheetRow)).length !== 1)
      )
        add(check, "AGGREGATE_OUTPUT_SHAPE", check.target);
    } else if (check.kind === "row_coverage") {
      check.sourceIds.forEach((id) => {
        source(check, id);
      });
      targetField(check.lineage.sourceReferenceColumn);
      targetField(check.lineage.sourceRowColumn);
      if (check.lineage.sourceSheetColumn) targetField(check.lineage.sourceSheetColumn);
      if (check.expansion) targetField(check.expansion.targetPeriodColumn);
      for (const a of check.lineage.anchors) {
        targetField(a.targetColumn);
        for (const id of a.sourceId ? [a.sourceId] : check.sourceIds)
          field(check, id, a.sourceColumn);
      }
    } else if (check.kind === "typed_lookup") {
      source(check, check.dictionary);
      for (const m of [...check.keys, ...check.values]) {
        targetField(m.targetColumn);
        field(check, check.dictionary, m.sourceColumn);
      }
      for (const c of check.duplicateColumns) field(check, check.dictionary, c);
      for (const e of check.eligibility) field(check, check.dictionary, e.column);
      if (check.eventScope) {
        const e = check.eventScope;
        e.universeSourceIds.forEach((id) => {
          source(check, id);
        });
        targetField(e.lineage.sourceReferenceColumn);
        targetField(e.lineage.sourceRowColumn);
        if (e.lineage.sourceSheetColumn) targetField(e.lineage.sourceSheetColumn);
        for (const m of e.keys) {
          targetField(m.targetColumn);
          e.sourceIds.forEach((id) => {
            field(check, id, m.sourceColumn);
          });
        }
      }
    } else if (check.kind === "legacy_rules") {
      check.sourceIds.forEach((id) => {
        source(check, id);
      });
      for (const r of check.config.checks) {
        if ("column" in r && r.column) targetField(r.column);
        if (r.kind === "foreign_key") {
          if (!check.sourceIds.includes(r.source))
            add(check, "SOURCE_NOT_BOUND_TO_CHECK", r.source);
          field(check, r.source, r.referenceColumn);
        }
        if (
          r.kind === "cell" &&
          r.row > target.rows.filter((row) => !target.headerRows.includes(row.worksheetRow)).length
        )
          add(check, "CELL_ROW_OUTSIDE_DOMAIN", check.target);
        if (r.kind === "row_expression")
          add(check, "ARBITRARY_EXPRESSION_UNSUPPORTED", check.target, undefined, "unsupported");
        if (r.kind === "pattern") {
          try {
            new RegExp(r.pattern);
          } catch {
            add(check, "PATTERN_INVALID", check.target);
          }
        }
      }
    } else {
      check.sourceIds.forEach((id) => {
        source(check, id);
      });
      check.config.alignment.requiredColumns.forEach(targetField);
      for (const b of check.config.alignment.bindings) {
        targetField(b.column);
        if (!check.sourceIds.includes(b.source)) add(check, "SOURCE_NOT_BOUND_TO_CHECK", b.source);
        if (b.kind === "lookup") {
          for (const k of b.keys) {
            targetField(k.targetColumn);
            field(check, b.source, k.sourceColumn);
          }
          field(check, b.source, b.valueColumn);
          b.where?.forEach((w) => {
            field(check, b.source, w.column);
          });
          b.duplicateColumns?.forEach((c) => {
            field(check, b.source, c);
          });
        } else if (b.kind === "cell") {
          targetField(b.referenceColumn);
          if (b.rowColumn) targetField(b.rowColumn);
          if (b.sameColumnAs) targetField(b.sameColumnAs);
        } else {
          targetField(b.yearReferenceColumn);
          targetField(b.monthReferenceColumn);
          targetField(b.valueReferenceColumn);
        }
      }
    }
  }
  return issues;
}
